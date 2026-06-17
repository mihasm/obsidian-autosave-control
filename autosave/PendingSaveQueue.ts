import { App, FileSystemAdapter, MarkdownView, TextFileView, TFile } from "obsidian";
import { dlog } from "../debug";

type SaveFn = (this: MarkdownView, ...args: unknown[]) => Promise<void> | void;
const PENDING_RAM_REFRESH_INTERVAL_MS = 2000;

type PendingSaveEntry = {
  view: TextFileView;
  timeoutId: number | null;
  ramRefreshIntervalId: number | null;
  latestData: string;
};

export class PendingSaveQueue {
  private readonly pendingSavesByPath = new Map<string, PendingSaveEntry>();

  constructor(
    private readonly app: App,
    private readonly isAutoSaveDisabled: () => boolean,
    private readonly getSaveDelaySeconds: () => number,
    private readonly getOriginalSave: () => SaveFn | null,
    private readonly shouldWriteDirectlyToVault: () => boolean,
    private readonly onPendingSaveCountChange: (pendingSaveCount: number) => void,
    private readonly onFlushComplete?: (filePath: string) => Promise<void> | void,
  ) {}

  schedule(filePath: string, view: TextFileView) {
    if (!view.file) {
      return;
    }

    const existingPendingSave = this.pendingSavesByPath.get(filePath);
    if (existingPendingSave) {
      existingPendingSave.view = view;

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
    });
    this.refreshLatestData(filePath);
    this.emitPendingSaveCount();
  }

  has(filePath: string): boolean {
    return this.pendingSavesByPath.has(filePath);
  }

  hasAny(): boolean {
    return this.pendingSavesByPath.size > 0;
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

    if (pendingSave.timeoutId !== null) {
      window.clearTimeout(pendingSave.timeoutId);
    }
    if (pendingSave.ramRefreshIntervalId !== null) {
      window.clearInterval(pendingSave.ramRefreshIntervalId);
    }

    this.refreshLatestData(filePath);
    this.pendingSavesByPath.delete(filePath);
    this.emitPendingSaveCount();

    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) {
      return;
    }

    const attachedViewFilePath = pendingSave.view.file?.path;
    if (!this.shouldWriteDirectlyToVault() && attachedViewFilePath === filePath) {
      await originalSave.call(pendingSave.view as unknown as MarkdownView);
      await this.onFlushComplete?.(filePath);
      return;
    }

    const fileSystemAdapter = this.app.vault.adapter;
    if (fileSystemAdapter instanceof FileSystemAdapter) {
      await fileSystemAdapter.write(filePath, pendingSave.latestData);
      dlog("Pending save flushed via filesystem", filePath);
      await this.onFlushComplete?.(filePath);
      return;
    }

    await this.app.vault.modify(file, pendingSave.latestData);
    await this.onFlushComplete?.(filePath);

    dlog("Pending save flushed", filePath);
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

  private getPendingViewData(filePath: string, pendingSave: PendingSaveEntry): string | null {
    if (pendingSave.view.file?.path !== filePath) {
      return null;
    }

    // Edit events only mark the note as dirty; the queue refreshes buffered text from the live view separately.
    return pendingSave.view.getViewData();
  }
}
