import { App, FileSystemAdapter, MarkdownView, TextFileView, TFile } from "obsidian";
import { dlog } from "../debug";

type SaveFn = (this: MarkdownView, ...args: unknown[]) => Promise<void> | void;
const PENDING_RAM_REFRESH_INTERVAL_MS = 2000;

type PendingSaveEntry = {
  view: TextFileView;
  timeoutId: number | null;
  ramRefreshIntervalId: number | null;
  latestData: string;
  // True once a genuine user edit (keystroke / input / paste / cut in the editor)
  // has fed this pending cycle. Used to tell a real "the user emptied this note"
  // from a stale/blank snapshot taken off a not-yet-loaded view (issue #18).
  hadUserEdit: boolean;
};

export class PendingSaveQueue {
  private readonly pendingSavesByPath = new Map<string, PendingSaveEntry>();
  private readonly flushingPaths = new Set<string>();

  constructor(
    private readonly app: App,
    private readonly isAutoSaveDisabled: () => boolean,
    private readonly getSaveDelaySeconds: () => number,
    private readonly getOriginalSave: () => SaveFn | null,
    private readonly shouldWriteDirectlyToVault: () => boolean,
    private readonly onPendingSaveCountChange: (pendingSaveCount: number) => void,
    private readonly onFlushComplete?: (filePath: string) => Promise<void> | void,
  ) {}

  schedule(filePath: string, view: TextFileView, fromUserEdit = false) {
    if (!view.file) {
      return;
    }

    const existingPendingSave = this.pendingSavesByPath.get(filePath);
    if (existingPendingSave) {
      existingPendingSave.view = view;
      existingPendingSave.hadUserEdit ||= fromUserEdit;

      if (existingPendingSave.timeoutId != null) {
        window.clearTimeout(existingPendingSave.timeoutId);
      }

      existingPendingSave.timeoutId = this.createTimeout(filePath);
      if (existingPendingSave.ramRefreshIntervalId === null) {
        existingPendingSave.ramRefreshIntervalId = this.createRamRefreshInterval(filePath);
      }
      this.refreshLatestData(filePath);
      this.emitPendingSaveCount();
      return;
    }

    this.pendingSavesByPath.set(filePath, {
      view,
      timeoutId: this.createTimeout(filePath),
      ramRefreshIntervalId: this.createRamRefreshInterval(filePath),
      latestData: view.getViewData(),
      hadUserEdit: fromUserEdit,
    });
    this.refreshLatestData(filePath);
    this.emitPendingSaveCount();
  }

  // Whether the note at this path has a pending save that a real user edit fed.
  wasUserEdited(filePath: string): boolean {
    return this.pendingSavesByPath.get(filePath)?.hadUserEdit ?? false;
  }

  has(filePath: string): boolean {
    return this.pendingSavesByPath.has(filePath);
  }

  hasAny(): boolean {
    return this.pendingSavesByPath.size > 0;
  }

  getPaths(): string[] {
    return Array.from(this.pendingSavesByPath.keys());
  }

  getLatestData(filePath: string): string | null {
    return this.pendingSavesByPath.get(filePath)?.latestData ?? null;
  }

  refreshLatestData(filePath: string): boolean {
    const pendingSave = this.pendingSavesByPath.get(filePath);
    if (!pendingSave) {
      return false;
    }

    const latestViewData = this.getPendingViewData(filePath, pendingSave);
    if (latestViewData === null || latestViewData === pendingSave.latestData) {
      return false;
    }

    pendingSave.latestData = latestViewData;
    dlog("Pending save RAM snapshot refreshed", filePath);
    return true;
  }

  refreshAllLatestData() {
    for (const filePath of this.pendingSavesByPath.keys()) {
      this.refreshLatestData(filePath);
    }
  }

  touchView(filePath: string, view: TextFileView) {
    const pendingSave = this.pendingSavesByPath.get(filePath);
    if (!pendingSave) {
      return;
    }

    pendingSave.view = view;
    this.refreshLatestData(filePath);
  }

  renamePendingSave(oldPath: string, newPath: string) {
    const pendingSave = this.pendingSavesByPath.get(oldPath);
    if (!pendingSave) {
      return;
    }

    if (pendingSave.timeoutId !== null) {
      window.clearTimeout(pendingSave.timeoutId);
    }

    this.pendingSavesByPath.delete(oldPath);
    this.pendingSavesByPath.set(newPath, {
      ...pendingSave,
      timeoutId: this.createTimeout(newPath),
    });
  }

  refreshScheduling() {
    for (const [filePath, pendingSave] of this.pendingSavesByPath.entries()) {
      if (pendingSave.timeoutId !== null) {
        window.clearTimeout(pendingSave.timeoutId);
      }

      pendingSave.timeoutId = this.createTimeout(filePath);
    }
  }

  clear(filePath: string) {
    const pendingSave = this.pendingSavesByPath.get(filePath);
    if (!pendingSave) {
      return;
    }

    if (pendingSave.timeoutId !== null) {
      window.clearTimeout(pendingSave.timeoutId);
    }
    if (pendingSave.ramRefreshIntervalId !== null) {
      window.clearInterval(pendingSave.ramRefreshIntervalId);
    }
    this.pendingSavesByPath.delete(filePath);
    this.emitPendingSaveCount();
  }

  clearAll() {
    for (const filePath of Array.from(this.pendingSavesByPath.keys())) {
      this.clear(filePath);
    }
  }

  async flush(filePath: string) {
    const pendingSave = this.pendingSavesByPath.get(filePath);
    const originalSave = this.getOriginalSave();
    if (!pendingSave || !originalSave) {
      return;
    }

    // Re-entrancy guard: the auto-save timer and an unload/quit flush can race on
    // the same path. The entry now survives until the write resolves, so without
    // this guard both callers would pass the check above and write twice.
    if (this.flushingPaths.has(filePath)) {
      return;
    }

    this.refreshLatestData(filePath);

    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) {
      // Can't resolve the file (e.g. mid-rename) — leave it queued as pending
      // rather than reporting it saved. A later edit/flush will retry.
      return;
    }

    // Data-loss guard (issue #18): refuse to blank a note that still has content
    // on disk when no genuine user edit fed this pending cycle. Such a blank
    // snapshot comes from a view that had not actually loaded the file yet
    // (vault still opening, or a deferred/unloading tab), which is how notes were
    // silently cleared on startup. A note the user really emptied always carries a
    // recorded edit (a keystroke/input/cut), so this never blocks a real change,
    // and an explicit Ctrl/Cmd+S bypasses the queue entirely.
    if (await this.wouldBlankNonEmptyFileWithoutEdit(filePath, file, pendingSave)) {
      dlog("Refusing to overwrite non-empty note with blank content (issue #18)", filePath);
      this.clear(filePath);
      return;
    }

    this.flushingPaths.add(filePath);
    try {
      // Write FIRST. Only retire the entry once the bytes actually land, so the
      // status indicator never reports "saved" while changes are still pending.
      const attachedViewFilePath = pendingSave.view.file?.path;
      if (!this.shouldWriteDirectlyToVault() && attachedViewFilePath === filePath) {
        await originalSave.call(pendingSave.view);
      } else {
        const fileSystemAdapter = this.app.vault.adapter;
        if (fileSystemAdapter instanceof FileSystemAdapter) {
          await fileSystemAdapter.write(filePath, pendingSave.latestData);
          dlog("Pending save flushed via filesystem", filePath);
        } else {
          await this.app.vault.modify(file, pendingSave.latestData);
          dlog("Pending save flushed", filePath);
        }
      }
    } catch (error) {
      // Write failed — keep the entry pending so the indicator stays truthful and
      // a later edit/flush retries. Do not delete or emit "saved".
      dlog("Pending save flush failed", filePath, error);
      return;
    } finally {
      this.flushingPaths.delete(filePath);
    }

    // Write succeeded — now retire the entry and report "all saved".
    if (pendingSave.timeoutId !== null) {
      window.clearTimeout(pendingSave.timeoutId);
    }
    if (pendingSave.ramRefreshIntervalId !== null) {
      window.clearInterval(pendingSave.ramRefreshIntervalId);
    }
    this.pendingSavesByPath.delete(filePath);
    this.emitPendingSaveCount();

    await this.onFlushComplete?.(filePath);
  }

  async flushAll() {
    this.refreshAllLatestData();

    for (const filePath of Array.from(this.pendingSavesByPath.keys())) {
      await this.flush(filePath);
    }
  }

  private emitPendingSaveCount() {
    this.onPendingSaveCountChange(this.pendingSavesByPath.size);
  }

  private createTimeout(filePath: string): number | null {
    if (this.isAutoSaveDisabled()) {
      return null;
    }

    const saveDelayMilliseconds = this.getSaveDelaySeconds() * 1000;
    return window.setTimeout(() => {
      void this.flush(filePath);
    }, saveDelayMilliseconds);
  }

  private createRamRefreshInterval(filePath: string): number {
    return window.setInterval(() => {
      this.refreshLatestData(filePath);
    }, PENDING_RAM_REFRESH_INTERVAL_MS);
  }

  private async wouldBlankNonEmptyFileWithoutEdit(
    filePath: string,
    file: TFile,
    pendingSave: PendingSaveEntry,
  ): Promise<boolean> {
    // A real user edit backs this write, or the write is not a blanking one.
    if (pendingSave.hadUserEdit || pendingSave.latestData.trim().length > 0) {
      return false;
    }

    // About to write empty content for a note nobody actively edited. Only a
    // problem if the note still holds content on disk — then blanking it loses
    // data. If the bytes can't be read we cannot prove it is safe, so block.
    const diskData = await this.readCurrentDiskData(file, filePath);
    return diskData === null || diskData.trim().length > 0;
  }

  private async readCurrentDiskData(file: TFile, filePath: string): Promise<string | null> {
    try {
      const adapter = this.app.vault.adapter;
      if (adapter instanceof FileSystemAdapter) {
        return await adapter.read(filePath);
      }

      return await this.app.vault.read(file);
    } catch {
      return null;
    }
  }

  private getPendingViewData(filePath: string, pendingSave: PendingSaveEntry): string | null {
    if (pendingSave.view.file?.path !== filePath) {
      return null;
    }

    // Edit events only mark the note as dirty; the queue refreshes buffered text from the live view separately.
    return pendingSave.view.getViewData();
  }
}
