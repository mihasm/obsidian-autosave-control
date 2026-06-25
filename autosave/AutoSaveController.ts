import { App, EditorPosition, EventRef, FileSystemAdapter, Hotkey, MarkdownView, Platform, Tasks, TextFileView, TFile, WorkspaceLeaf } from "obsidian";
import { dlog } from "../debug";
import type { AutoSaveControlSettings } from "../settings/AutoSaveSettings";
import { EditActivityTracker } from "./EditActivityTracker";
import { PendingSaveQueue } from "./PendingSaveQueue";
import { WorkspaceLayoutSaveController } from "./WorkspaceLayoutSaveController";

type SaveFn = (this: MarkdownView, ...args: unknown[]) => Promise<void> | void;
type RequestSaveFn = (this: TextFileView, ...args: unknown[]) => void;
type OpenFileFn = (this: WorkspaceLeaf, ...args: unknown[]) => Promise<unknown>;
type OnUnloadFileFn = (this: TextFileView, file: TFile) => Promise<void>;
type SetViewStateFn = (this: WorkspaceLeaf, ...args: unknown[]) => Promise<unknown>;
type DetachFn = (this: WorkspaceLeaf) => void;
type DeleteFileFn = (this: unknown, ...args: unknown[]) => unknown;
type CommandCallback = (...args: unknown[]) => unknown;
type SaveCommandCheckCallback = (checking: boolean) => boolean | void;
type CommandDefinition = {
  name?: string;
  callback?: CommandCallback;
};
type WrappedFunctionMetadata<T> = { __ascOriginal?: T; __ascOwner?: AutoSaveController };
type FileManagerWithTrashFile = {
  trashFile?: DeleteFileFn;
};
type WindowWithConfirm = Window & {
  confirm: (message?: string) => boolean;
};
const MANUAL_SAVE_REQUEST_TTL_MS = 5000;
const QUIT_SHORTCUT_INTENT_TTL_MS = 2000;
// Cap how many unsaved-note names are spelled out in the close/quit confirm
// dialog. A native confirm() does not scroll, so an unbounded list would grow
// taller than the screen and push the OK/Cancel buttons out of reach; anything
// beyond the cap is summarised as "…and N more".
const MAX_LISTED_UNSAVED_NOTES = 5;

type BeforeUnloadListener = (event: BeforeUnloadEvent) => void;
type ElectronCloseEvent = { preventDefault: () => void };
type ElectronCloseListener = (event: ElectronCloseEvent) => void;
type ElectronBrowserWindow = {
  on: (event: "close", listener: ElectronCloseListener) => void;
  removeListener: (event: "close", listener: ElectronCloseListener) => void;
  close?: () => void;
  destroy?: () => void;
  focus?: () => void;
  show?: () => void;
  id?: number;
};
type ElectronBrowserWindowStatic = {
  getAllWindows?: () => ElectronBrowserWindow[];
};
type ElectronAppQuitListener = () => void;
type ElectronApp = {
  exit?: (exitCode: number) => void;
  quit?: () => void;
  on?: (event: "before-quit", listener: ElectronAppQuitListener) => void;
  removeListener?: (event: "before-quit", listener: ElectronAppQuitListener) => void;
};
type ElectronModule = {
  remote?: {
    app?: ElectronApp;
    getCurrentWindow?: () => ElectronBrowserWindow | null;
    BrowserWindow?: ElectronBrowserWindowStatic;
    process?: { pid?: number };
  };
};
type ElectronRequireHost = Window & {
  require?: (module: "electron") => ElectronModule;
};
// Minimal Node built-ins available in the Obsidian (Electron) renderer; used to
// coordinate a multi-window app quit across separate vault renderers via a temp
// file (issue #28).
type NodeFsModule = {
  readFileSync: (path: string, encoding: string) => string;
  writeFileSync: (path: string, data: string) => void;
  rmSync?: (path: string, options: { force: boolean }) => void;
};
type NodePathModule = { join: (...parts: string[]) => string };
type NodeOsModule = { tmpdir: () => string };
type NodeRequireHost = Window & {
  require?: (module: string) => unknown;
};

function callWithArgs<TThis, TArgs extends unknown[], TResult>(
  fn: (this: TThis, ...args: TArgs) => TResult,
  thisArg: TThis,
  ...args: TArgs
): TResult {
  return (fn.bind(thisArg) as (...boundArgs: TArgs) => TResult)(...args);
}

function hasRequestSave(value: unknown): value is TextFileView {
  return typeof value === "object"
    && value !== null
    && typeof (value as { requestSave?: unknown }).requestSave === "function";
}

function isWindowWithConfirm(targetWindow: Window | null): targetWindow is WindowWithConfirm {
  return targetWindow !== null && typeof targetWindow.confirm === "function";
}

export class AutoSaveController {
  private originalSave: SaveFn | null = null;
  private originalRequestSave: RequestSaveFn | null = null;
  private originalOpenFile: OpenFileFn | null = null;
  private originalOnUnloadFile: OnUnloadFileFn | null = null;
  private originalSetViewState: SetViewStateFn | null = null;
  private originalDetach: DetachFn | null = null;
  private originalVaultTrash: DeleteFileFn | null = null;
  private originalVaultDelete: DeleteFileFn | null = null;
  private originalFileManagerTrashFile: DeleteFileFn | null = null;
  private originalSaveCommandCheckCallback: SaveCommandCheckCallback | null = null;
  private originalReloadWithoutSavingCommandCallback: CommandCallback | null = null;
  private installedSaveWrapper: SaveFn | null = null;
  private installedRequestSaveWrapper: RequestSaveFn | null = null;
  private installedOpenFileWrapper: OpenFileFn | null = null;
  private installedOnUnloadFileWrapper: OnUnloadFileFn | null = null;
  private installedSetViewStateWrapper: SetViewStateFn | null = null;
  private installedDetachWrapper: DetachFn | null = null;
  private installedVaultTrashWrapper: DeleteFileFn | null = null;
  private installedVaultDeleteWrapper: DeleteFileFn | null = null;
  private installedFileManagerTrashFileWrapper: DeleteFileFn | null = null;
  private installedSaveCommandCheckCallback: SaveCommandCheckCallback | null = null;
  private installedReloadWithoutSavingCommandCallback: CommandCallback | null = null;
  private isUnloading = false;
  private workspaceLeafChangeEventRef?: EventRef;
  private workspaceQuitEventRef?: EventRef;
  private vaultRenameEventRef?: EventRef;
  private onPendingSaveCountChange?: (pendingSaveCount: number) => void;

  private readonly editActivityTracker: EditActivityTracker;
  private readonly pendingSaveQueue: PendingSaveQueue;
  private readonly workspaceLayoutSaveController: WorkspaceLayoutSaveController;
  private readonly beforeUnloadListenersByWindow = new Map<Window, BeforeUnloadListener>();
  private readonly quitShortcutListenersByWindow = new Map<Window, (event: KeyboardEvent) => void>();
  private readonly electronCloseListenersByWindow = new Map<
    Window,
    { browserWindow: ElectronBrowserWindow; listener: ElectronCloseListener }
  >();
  private readonly fileSwitchingLeaves = new WeakSet<WorkspaceLeaf>();
  private readonly pendingRestoreCountsByPath = new Map<string, number>();
  private readonly manualSaveRequestTimeoutsByPath = new Map<string, number>();
  private readonly discardedViews = new WeakSet<TextFileView>();
  private readonly lastSavedDataByPath = new Map<string, string>();
  private readonly cursorPositionByPath = new Map<string, EditorPosition>();
  private readonly confirmedDeletionPaths = new Set<string>();
  private readonly liveRequestSaveOverrides = new Map<TextFileView, { original: RequestSaveFn; installed: RequestSaveFn }>();
  private quitShortcutIntentTimestampMs = 0;
  private isHandlingWindowCloseRequest = false;
  private bypassNextWindowCloseInterception = false;
  // Set when Electron fires "before-quit" — i.e. the whole application is
  // quitting (Cmd+Q / menu Quit), as opposed to a single window being closed.
  private appIsQuitting = false;
  private electronApp: ElectronApp | null = null;
  private electronAppQuitListener: ElectronAppQuitListener | null = null;
  // Obsidian's own one-shot window.onbeforeunload quit hook, captured so we can
  // re-arm it after the user picks "keep editing" (issue #26 close dialog).
  private obsidianOnBeforeUnload: ((event: BeforeUnloadEvent) => unknown) | null = null;

  constructor(private readonly app: App, private readonly getSettings: () => AutoSaveControlSettings) {
    this.editActivityTracker = new EditActivityTracker(
      () => this.app.workspace.getActiveViewOfType(MarkdownView),
      (view, filePath) => {
        if (this.isRestoringPendingData(filePath)) {
          return;
        }

        this.pendingSaveQueue.schedule(filePath, view);
      },
      (event) => this.isManualSaveShortcut(event),
      (view, filePath, event) => this.handleManualSaveShortcut(view, filePath, event),
    );
    this.pendingSaveQueue = new PendingSaveQueue(
      this.app,
      () => this.getSettings().disableAutoSave,
      () => this.getSettings().saveDelaySeconds,
      () => this.originalSave,
      () => this.isUnloading,
      (pendingSaveCount) => this.onPendingSaveCountChange?.(pendingSaveCount),
      async () => this.workspaceLayoutSaveController.flush(),
    );
    this.workspaceLayoutSaveController = new WorkspaceLayoutSaveController(
      this.app,
      () => this.getSettings().deferWorkspaceLayoutSaves,
      () => this.getSettings().workspaceLayoutSaveDelaySeconds,
    );
  }

  setPendingSaveCountChangeHandler(handler: (pendingSaveCount: number) => void) {
    this.onPendingSaveCountChange = handler;
  }

  refreshScheduling() {
    this.pendingSaveQueue.refreshScheduling();
    this.workspaceLayoutSaveController.refreshScheduling();
  }

  enable() {
    if (this.originalSave) {
      return;
    }

    const markdownViewPrototype = MarkdownView.prototype as unknown as { save: SaveFn };
    const textFileViewPrototype = TextFileView.prototype as unknown as {
      requestSave?: RequestSaveFn;
      onUnloadFile: OnUnloadFileFn;
    };
    const workspaceLeafPrototype = WorkspaceLeaf.prototype as unknown as { openFile: OpenFileFn };
    const workspaceLeafViewStatePrototype = WorkspaceLeaf.prototype as unknown as {
      setViewState: SetViewStateFn;
      detach: DetachFn;
    };
    const vaultWithDeleteMethods = this.app.vault as typeof this.app.vault & {
      trash?: DeleteFileFn;
      delete?: DeleteFileFn;
    };
    const fileManagerWithTrashFile = this.getFileManagerWithTrashFile();
    const writableVaultWithDeleteMethods = vaultWithDeleteMethods as {
      trash?: DeleteFileFn;
      delete?: DeleteFileFn;
    };
    const writableFileManagerWithTrashFile = fileManagerWithTrashFile;

    this.originalSave = this.unwrapWrappedFunction(markdownViewPrototype.save);
    this.installedSaveWrapper = this.createSaveWrapper(this.originalSave);
    markdownViewPrototype.save = this.installedSaveWrapper;

    if (typeof textFileViewPrototype.requestSave === "function") {
      this.originalRequestSave = this.unwrapWrappedFunction(textFileViewPrototype.requestSave);
      this.installedRequestSaveWrapper = this.createRequestSaveWrapper(this.originalRequestSave);
      textFileViewPrototype.requestSave = this.installedRequestSaveWrapper;
    }

    this.originalOnUnloadFile = this.unwrapWrappedFunction(textFileViewPrototype.onUnloadFile);
    this.installedOnUnloadFileWrapper = this.createOnUnloadFileWrapper(this.originalOnUnloadFile);
    textFileViewPrototype.onUnloadFile = this.installedOnUnloadFileWrapper;

    this.originalOpenFile = this.unwrapWrappedFunction(workspaceLeafPrototype.openFile);
    this.installedOpenFileWrapper = this.createOpenFileWrapper(this.originalOpenFile);
    workspaceLeafPrototype.openFile = this.installedOpenFileWrapper;

    this.originalSetViewState = this.unwrapWrappedFunction(workspaceLeafViewStatePrototype.setViewState);
    this.installedSetViewStateWrapper = this.createSetViewStateWrapper(this.originalSetViewState);
    workspaceLeafViewStatePrototype.setViewState = this.installedSetViewStateWrapper;

    this.originalDetach = this.unwrapWrappedFunction(workspaceLeafViewStatePrototype.detach);
    this.installedDetachWrapper = this.createDetachWrapper(this.originalDetach);
    workspaceLeafViewStatePrototype.detach = this.installedDetachWrapper;

    if (typeof vaultWithDeleteMethods.trash === "function") {
      this.originalVaultTrash = this.unwrapWrappedFunction(vaultWithDeleteMethods.trash);
      this.installedVaultTrashWrapper = this.createDeleteWrapper(this.originalVaultTrash);
      writableVaultWithDeleteMethods.trash = this.installedVaultTrashWrapper;
    }

    if (typeof vaultWithDeleteMethods.delete === "function") {
      this.originalVaultDelete = this.unwrapWrappedFunction(vaultWithDeleteMethods.delete);
      this.installedVaultDeleteWrapper = this.createDeleteWrapper(this.originalVaultDelete);
      writableVaultWithDeleteMethods.delete = this.installedVaultDeleteWrapper;
    }

    if (writableFileManagerWithTrashFile && typeof fileManagerWithTrashFile?.trashFile === "function") {
      this.originalFileManagerTrashFile = this.unwrapWrappedFunction(fileManagerWithTrashFile.trashFile);
      this.installedFileManagerTrashFileWrapper = this.createDeleteWrapper(this.originalFileManagerTrashFile);
      writableFileManagerWithTrashFile.trashFile = this.installedFileManagerTrashFileWrapper;
    }

    this.wrapSaveCommand();
    this.wrapReloadWithoutSavingCommand();
    this.workspaceLayoutSaveController.enable();

    this.isUnloading = false;
    this.vaultRenameEventRef = this.app.vault.on("rename", (file, oldPath) => {
      if (!(file instanceof TFile)) {
        return;
      }

      this.pendingSaveQueue.renamePendingSave(oldPath, file.path);
      this.editActivityTracker.renameTrackedFile(oldPath, file.path);
    });

    this.workspaceLeafChangeEventRef = this.app.workspace.on("active-leaf-change", (leaf) => {
      if (!leaf || !(leaf.view instanceof MarkdownView)) {
        return;
      }

      this.attachWindowObservers(this.getViewWindow(leaf.view));
      this.scheduleLiveRequestSaveWrap(leaf.view);
    });

    if (!Platform.isMobileApp) {
      this.registerAppQuitObserver();

      // Capture Obsidian's own window.onbeforeunload quit hook (set during app
      // startup). It is one-shot — it nulls itself when a close begins — so we
      // re-install it after the user chooses "keep editing". This is only a
      // best-effort capture: Obsidian registers the hook late (registerQuitHook
      // runs after the workspace layout is ready), so when the plugin loads first
      // window.onbeforeunload is still null here. The reliable capture happens on
      // each close in the beforeunload capturing listener below.
      this.captureObsidianQuitHook();

      this.workspaceQuitEventRef = this.app.workspace.on("quit", (tasks: Tasks) => {
        this.pendingSaveQueue.refreshAllLatestData();
        const shortcut = this.wasQuitShortcutIntentRecentlyMarked();
        const manual = this.getSettings().disableAutoSave;
        const hasPending = this.pendingSaveQueue.hasAny();

        // MANUAL mode (issue #26): plain window close (the X button, not the
        // Cmd+Q/menu quit shortcut) with unsaved changes. Prompt exactly like the
        // Cmd+Q dialog — OK = discard & close, Cancel/Esc = keep editing. Obsidian
        // awaits this task before calling window.close(), and the close listener
        // disabled its 3s force-destroy, so the prompt holds the close as long as
        // needed.
        if (manual && !shortcut && hasPending) {
          tasks.add(async () => {
            const decision = await this.askManualCloseDecision();
            if (decision === "discard") {
              this.discardAllPendingChanges();
              await this.workspaceLayoutSaveController.flush();
              // On a real app quit (Cmd+Q / menu Quit) a background vault's close
              // was preventDefault'd to give its prompt unlimited time, which
              // cancels Electron's app quit; once every vault has answered nothing
              // would re-quit, so the app would just sit with all windows closed
              // (issue #28). Record this vault's decision; the last vault to
              // answer completes the set and exits the whole app.
              if (this.appIsQuitting) {
                this.finalizeQuitFromThisWindow();
              }
              // Otherwise: task resolves -> Obsidian closes this window / quits.
            } else {
              // Cancel / Esc -> keep editing. Obsidian calls window.close() once
              // this task resolves, so we must NOT resolve it — hang it so the
              // window stays open. Remove the orphaned "Saving…" overlay and
              // re-arm Obsidian's one-shot quit hook for the next close.
              this.removeOrphanedSavingOverlay();
              this.reArmObsidianQuitHook();
              await new Promise<void>(() => { /* never resolves: window stays open */ });
            }
          });
          return;
        }

        // Only add a task when there is real work to do — flushing pending saves
        // (auto-save mode / shortcut quit), flushing a deferred workspace layout
        // write, or exiting on a real app quit. With nothing to do we add no task,
        // so Obsidian closes the window immediately (no "Saving…" overlay, no 3s
        // wait).
        const needsFlush = hasPending && (!shortcut || !manual);
        const needsLayoutFlush = this.workspaceLayoutSaveController.hasPending();
        if (needsFlush || needsLayoutFlush || this.appIsQuitting) {
          tasks.add(async () => {
            if (needsFlush) {
              await this.pendingSaveQueue.flushAll();
            }
            await this.workspaceLayoutSaveController.flush();
            this.clearQuitShortcutIntent();
            // A real app quit (Cmd+Q / menu Quit). With multiple vaults open,
            // each vault is a separate window in the SAME Electron process, and a
            // global app.exit() from THIS window would hard-kill every other vault
            // before it could prompt and flush (issue #28). Record this vault's
            // decision instead; the last vault to settle completes the set and
            // exits the whole app (single vault exits immediately).
            if (this.appIsQuitting) {
              this.finalizeQuitFromThisWindow();
            }
          });
          return;
        }

        this.clearQuitShortcutIntent();
      });
    }

    this.attachWindowObservers(window);

    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      if (leaf.view instanceof MarkdownView) {
        this.attachWindowObservers(this.getViewWindow(leaf.view));
        this.scheduleLiveRequestSaveWrap(leaf.view);
        void this.captureLeafSavedData(leaf);
      }
    }

    dlog("Autosave wrapper enabled");
  }

  disable() {
    const markdownViewPrototype = MarkdownView.prototype as unknown as { save: SaveFn };
    const textFileViewPrototype = TextFileView.prototype as unknown as {
      requestSave?: RequestSaveFn;
      onUnloadFile: OnUnloadFileFn;
    };
    const workspaceLeafPrototype = WorkspaceLeaf.prototype as unknown as { openFile: OpenFileFn };
    const workspaceLeafViewStatePrototype = WorkspaceLeaf.prototype as unknown as {
      setViewState: SetViewStateFn;
      detach: DetachFn;
    };
    const vaultWithDeleteMethods = this.app.vault as typeof this.app.vault & {
      trash?: DeleteFileFn;
      delete?: DeleteFileFn;
    };
    const fileManagerWithTrashFile = this.getFileManagerWithTrashFile();
    const writableVaultWithDeleteMethods = vaultWithDeleteMethods as {
      trash?: DeleteFileFn;
      delete?: DeleteFileFn;
    };
    const writableFileManagerWithTrashFile = fileManagerWithTrashFile;

    if (this.originalSave && markdownViewPrototype.save === this.installedSaveWrapper) {
      markdownViewPrototype.save = this.originalSave;
    }
    this.originalSave = null;
    this.installedSaveWrapper = null;

    if (this.originalRequestSave && textFileViewPrototype.requestSave === this.installedRequestSaveWrapper) {
      textFileViewPrototype.requestSave = this.originalRequestSave;
    }
    this.originalRequestSave = null;
    this.installedRequestSaveWrapper = null;

    if (this.originalOnUnloadFile && textFileViewPrototype.onUnloadFile === this.installedOnUnloadFileWrapper) {
      textFileViewPrototype.onUnloadFile = this.originalOnUnloadFile;
    }
    this.originalOnUnloadFile = null;
    this.installedOnUnloadFileWrapper = null;

    if (this.originalOpenFile && workspaceLeafPrototype.openFile === this.installedOpenFileWrapper) {
      workspaceLeafPrototype.openFile = this.originalOpenFile;
    }
    this.originalOpenFile = null;
    this.installedOpenFileWrapper = null;

    if (
      this.originalSetViewState &&
      workspaceLeafViewStatePrototype.setViewState === this.installedSetViewStateWrapper
    ) {
      workspaceLeafViewStatePrototype.setViewState = this.originalSetViewState;
    }
    this.originalSetViewState = null;
    this.installedSetViewStateWrapper = null;

    if (this.originalDetach && workspaceLeafViewStatePrototype.detach === this.installedDetachWrapper) {
      workspaceLeafViewStatePrototype.detach = this.originalDetach;
    }
    this.originalDetach = null;
    this.installedDetachWrapper = null;

    if (this.originalVaultTrash && vaultWithDeleteMethods.trash === this.installedVaultTrashWrapper) {
      writableVaultWithDeleteMethods.trash = this.originalVaultTrash;
    }
    this.originalVaultTrash = null;
    this.installedVaultTrashWrapper = null;

    if (this.originalVaultDelete && vaultWithDeleteMethods.delete === this.installedVaultDeleteWrapper) {
      writableVaultWithDeleteMethods.delete = this.originalVaultDelete;
    }
    this.originalVaultDelete = null;
    this.installedVaultDeleteWrapper = null;

    if (
      writableFileManagerWithTrashFile &&
      this.originalFileManagerTrashFile &&
      fileManagerWithTrashFile?.trashFile === this.installedFileManagerTrashFileWrapper
    ) {
      writableFileManagerWithTrashFile.trashFile = this.originalFileManagerTrashFile;
    }
    this.originalFileManagerTrashFile = null;
    this.installedFileManagerTrashFileWrapper = null;

    this.restoreSaveCommand();
    this.restoreReloadWithoutSavingCommand();
    this.workspaceLayoutSaveController.disable();

    if (this.workspaceLeafChangeEventRef) {
      this.app.workspace.offref(this.workspaceLeafChangeEventRef);
      this.workspaceLeafChangeEventRef = undefined;
    }

    if (this.vaultRenameEventRef) {
      this.app.vault.offref(this.vaultRenameEventRef);
      this.vaultRenameEventRef = undefined;
    }

    if (this.workspaceQuitEventRef) {
      this.app.workspace.offref(this.workspaceQuitEventRef);
      this.workspaceQuitEventRef = undefined;
    }

    this.unregisterAppQuitObserver();
    this.detachAllWindowObservers();
    this.restoreLiveRequestSaveOverrides();
    this.clearManualSaveRequests();
    this.clearQuitShortcutIntent();
    this.pendingSaveQueue.clearAll();
    this.isUnloading = false;

    dlog("Autosave wrapper disabled");
  }

  private createSaveWrapper(originalSave: SaveFn): SaveFn {
    const consumeManualSaveRequest = (filePath: string) => this.consumeManualSaveRequest(filePath);
    const captureCurrentViewData = (filePath: string, view: TextFileView) => this.captureCurrentViewData(filePath, view);
    const shouldHoldSave = (view: TextFileView, filePath: string) => this.shouldHoldSave(view, filePath);
    const { discardedViews, pendingSaveQueue, workspaceLayoutSaveController } = this;

    const wrappedSave = function wrappedSave(this: MarkdownView, ...args: unknown[]) {
      const filePath = this.file?.path;
      if (!filePath) {
        return callWithArgs(originalSave, this, ...args);
      }

      if (discardedViews.has(this)) {
        dlog("Suppressing save for discarded file", { filePath, args });
        return;
      }

      if (consumeManualSaveRequest(filePath)) {
        dlog("Allowing manual save", { filePath, args });
        const saveResult = callWithArgs(originalSave, this, ...args);

        if (saveResult instanceof Promise) {
          return saveResult.then(() => {
            pendingSaveQueue.clear(filePath);
            captureCurrentViewData(filePath, this);
            return workspaceLayoutSaveController.flush();
          });
        }

        pendingSaveQueue.clear(filePath);
        captureCurrentViewData(filePath, this);
        void workspaceLayoutSaveController.flush();
        return saveResult;
      }

      if (shouldHoldSave(this, filePath)) {
        pendingSaveQueue.schedule(filePath, this);
        dlog("Suppressing non-manual save", { filePath, args });
        return;
      }

      return callWithArgs(originalSave, this, ...args);
    };

    return this.markWrappedFunction(wrappedSave, originalSave);
  }

  private createOnUnloadFileWrapper(originalOnUnloadFile: OnUnloadFileFn): OnUnloadFileFn {
    const syncPendingDataForFile = (filePath: string) => this.syncPendingDataForFile(filePath);
    const getSettings = this.getSettings;
    const { discardedViews, pendingSaveQueue, fileSwitchingLeaves } = this;

    const wrappedOnUnloadFile = async function wrappedOnUnloadFile(this: TextFileView, file: TFile) {
      if (discardedViews.has(this)) {
        discardedViews.delete(this);
        return;
      }

      syncPendingDataForFile(file.path);

      if (getSettings().disableAutoSave) {
        await callWithArgs(originalOnUnloadFile, this, file);
        return;
      }

      if (pendingSaveQueue.has(file.path) && !fileSwitchingLeaves.has(this.leaf)) {
        dlog("Flushing pending save on file unload", { filePath: file.path });
        await pendingSaveQueue.flush(file.path);
      }

      await callWithArgs(originalOnUnloadFile, this, file);
    };

    return this.markWrappedFunction(wrappedOnUnloadFile, originalOnUnloadFile);
  }

  private createRequestSaveWrapper(originalRequestSave: RequestSaveFn): RequestSaveFn {
    const isRestoringPendingData = (filePath: string) => this.isRestoringPendingData(filePath);
    const hasManualSaveRequest = (filePath: string) => this.hasManualSaveRequest(filePath);
    const markManualSaveRequested = (filePath: string) => this.markManualSaveRequested(filePath);
    const shouldHoldSave = (view: TextFileView, filePath: string) => this.shouldHoldSave(view, filePath);
    const { discardedViews, pendingSaveQueue } = this;

    const wrappedRequestSave = function wrappedRequestSave(this: TextFileView, ...args: unknown[]) {
      const filePath = this.file?.path;
      if (!filePath) {
        return callWithArgs(originalRequestSave, this, ...args);
      }

      if (discardedViews.has(this)) {
        dlog("Suppressing requestSave for discarded file", { filePath, args });
        return;
      }

      if (isRestoringPendingData(filePath)) {
        dlog("Suppressing requestSave during pending-data restore", { filePath, args });
        return;
      }

      if (hasManualSaveRequest(filePath)) {
        dlog("Allowing manual requestSave", { filePath, args });
        markManualSaveRequested(filePath);
        return callWithArgs(originalRequestSave, this, ...args);
      }

      if (!shouldHoldSave(this, filePath)) {
        dlog("Ignoring requestSave for clean file", { filePath, args });
        return;
      }

      pendingSaveQueue.schedule(filePath, this);
    };

    return this.markWrappedFunction(wrappedRequestSave, originalRequestSave);
  }

  private createOpenFileWrapper(originalOpenFile: OpenFileFn): OpenFileFn {
    const hasSubpathNavigationInOpenArgs = (args: unknown[]) => this.hasSubpathNavigationInOpenArgs(args);
    const syncLeafPendingData = (leaf: WorkspaceLeaf) => this.syncLeafPendingData(leaf);
    const scheduleLiveRequestSaveWrap = (view: TextFileView) => this.scheduleLiveRequestSaveWrap(view);
    const captureLeafSavedData = (leaf: WorkspaceLeaf) => this.captureLeafSavedData(leaf);
    const schedulePendingDataRestoreInLeaf = (leaf: WorkspaceLeaf) => this.schedulePendingDataRestoreInLeaf(leaf);
    const scheduleLeafCursorRestore = (leaf: WorkspaceLeaf, shouldRestoreCursor: boolean) => this.scheduleLeafCursorRestore(leaf, shouldRestoreCursor);
    const clearLeafSwitchingState = (leaf: WorkspaceLeaf) => this.clearLeafSwitchingState(leaf);
    const { fileSwitchingLeaves } = this;

    const wrappedOpenFile = async function wrappedOpenFile(this: WorkspaceLeaf, ...args: unknown[]) {
      const shouldRestoreCursor = !hasSubpathNavigationInOpenArgs(args);

      // Switching notes in the same tab no longer prompts in manual mode.
      // syncLeafPendingData snapshots the outgoing note's edits into the
      // pending-save queue, so they survive the switch and are restored when the
      // user comes back to it (see schedulePendingDataRestoreInLeaf).
      syncLeafPendingData(this);

      fileSwitchingLeaves.add(this);

      try {
        return await callWithArgs(originalOpenFile, this, ...args);
      } finally {
        if (hasRequestSave(this.view)) {
          scheduleLiveRequestSaveWrap(this.view);
        }
        void captureLeafSavedData(this);
        schedulePendingDataRestoreInLeaf(this);
        scheduleLeafCursorRestore(this, shouldRestoreCursor);
        clearLeafSwitchingState(this);
      }
    };

    return this.markWrappedFunction(wrappedOpenFile, originalOpenFile);
  }

  private createSetViewStateWrapper(originalSetViewState: SetViewStateFn): SetViewStateFn {
    const hasSubpathNavigationInViewStateArgs = (args: unknown[]) => this.hasSubpathNavigationInViewStateArgs(args);
    const syncLeafPendingData = (leaf: WorkspaceLeaf) => this.syncLeafPendingData(leaf);
    const scheduleLiveRequestSaveWrap = (view: TextFileView) => this.scheduleLiveRequestSaveWrap(view);
    const captureLeafSavedData = (leaf: WorkspaceLeaf) => this.captureLeafSavedData(leaf);
    const schedulePendingDataRestoreInLeaf = (leaf: WorkspaceLeaf) => this.schedulePendingDataRestoreInLeaf(leaf);
    const scheduleLeafCursorRestore = (leaf: WorkspaceLeaf, shouldRestoreCursor: boolean) => this.scheduleLeafCursorRestore(leaf, shouldRestoreCursor);
    const clearLeafSwitchingState = (leaf: WorkspaceLeaf) => this.clearLeafSwitchingState(leaf);
    const { fileSwitchingLeaves } = this;

    const wrappedSetViewState = async function wrappedSetViewState(this: WorkspaceLeaf, ...args: unknown[]) {
      const shouldRestoreCursor = !hasSubpathNavigationInViewStateArgs(args);

      // As in wrappedOpenFile: no switch prompt in manual mode. The outgoing
      // note's edits are snapshotted into the pending-save queue and restored on
      // return.
      syncLeafPendingData(this);

      fileSwitchingLeaves.add(this);

      try {
        return await callWithArgs(originalSetViewState, this, ...args);
      } finally {
        if (hasRequestSave(this.view)) {
          scheduleLiveRequestSaveWrap(this.view);
        }
        void captureLeafSavedData(this);
        schedulePendingDataRestoreInLeaf(this);
        scheduleLeafCursorRestore(this, shouldRestoreCursor);
        clearLeafSwitchingState(this);
      }
    };

    return this.markWrappedFunction(wrappedSetViewState, originalSetViewState);
  }

  private createDetachWrapper(originalDetach: DetachFn): DetachFn {
    const getLeafMarkdownFilePath = (leaf: WorkspaceLeaf) => this.getLeafMarkdownFilePath(leaf);
    const syncPendingDataForFile = (filePath: string) => this.syncPendingDataForFile(filePath);

    const wrappedDetach = function wrappedDetach(this: WorkspaceLeaf) {
      // Closing a tab no longer prompts in manual mode. We snapshot the latest
      // editor text into the pending-save queue before the leaf is torn down, so
      // the unsaved changes survive: reopening the note restores them into the
      // editor (see schedulePendingDataRestoreInLeaf) and they keep counting
      // toward the status indicator and the quit/close confirm list. Nothing is
      // written to disk and nothing is discarded.
      const filePath = getLeafMarkdownFilePath(this);
      if (filePath) {
        syncPendingDataForFile(filePath);
      }

      callWithArgs(originalDetach, this);
    };

    return this.markWrappedFunction(wrappedDetach, originalDetach);
  }

  private createDeleteWrapper(originalDelete: DeleteFileFn): DeleteFileFn {
    const getTargetFilePathFromDeleteArgs = (args: unknown[]) => this.getTargetFilePathFromDeleteArgs(args);
    const confirmDeleteIfNeeded = (filePath: string) => this.confirmDeleteIfNeeded(filePath);
    const discardPendingChangesForDeletedFile = (filePath: string) => this.discardPendingChangesForDeletedFile(filePath);
    const { confirmedDeletionPaths } = this;

    const wrappedDelete = async function wrappedDelete(this: unknown, ...args: unknown[]) {
      const filePath = getTargetFilePathFromDeleteArgs(args);
      if (!filePath) {
        return callWithArgs(originalDelete, this, ...args);
      }

      if (!confirmDeleteIfNeeded(filePath)) {
        return;
      }

      if (confirmedDeletionPaths.has(filePath)) {
        return callWithArgs(originalDelete, this, ...args);
      }

      confirmedDeletionPaths.add(filePath);
      discardPendingChangesForDeletedFile(filePath);

      try {
        return await Promise.resolve(callWithArgs(originalDelete, this, ...args));
      } finally {
        confirmedDeletionPaths.delete(filePath);
      }
    };

    return this.markWrappedFunction(wrappedDelete, originalDelete);
  }

  private markWrappedFunction<T>(wrapper: T, original: T): T {
    const wrappedFunction = wrapper as T & WrappedFunctionMetadata<T>;
    wrappedFunction.__ascOriginal = original;
    wrappedFunction.__ascOwner = this;
    return wrapper;
  }

  private wrapLiveRequestSave(view: TextFileView): void {
    const requestSaveDescriptor = Object.getOwnPropertyDescriptor(view, "requestSave");
    if (!requestSaveDescriptor || typeof requestSaveDescriptor.value !== "function") {
      return;
    }

    const existingOverride = this.liveRequestSaveOverrides.get(view);
    if (existingOverride && requestSaveDescriptor.value === existingOverride.installed) {
      return;
    }

    const originalRequestSave = this.unwrapWrappedFunction(requestSaveDescriptor.value as RequestSaveFn);
    const installedRequestSave = this.createRequestSaveWrapper(originalRequestSave);
    Object.defineProperty(view, "requestSave", {
      ...requestSaveDescriptor,
      value: installedRequestSave,
    });
    this.liveRequestSaveOverrides.set(view, {
      original: requestSaveDescriptor.value as RequestSaveFn,
      installed: installedRequestSave,
    });
  }

  private scheduleLiveRequestSaveWrap(view: TextFileView): void {
    this.wrapLiveRequestSave(view);

    window.setTimeout(() => {
      this.wrapLiveRequestSave(view);
    }, 0);
  }

  private restoreLiveRequestSaveOverrides(): void {
    for (const [view, override] of this.liveRequestSaveOverrides.entries()) {
      const requestSaveDescriptor = Object.getOwnPropertyDescriptor(view, "requestSave");
      if (!requestSaveDescriptor || requestSaveDescriptor.value !== override.installed) {
        continue;
      }

      Object.defineProperty(view, "requestSave", {
        ...requestSaveDescriptor,
        value: override.original,
      });
    }

    this.liveRequestSaveOverrides.clear();
  }

  private unwrapWrappedFunction<T>(fn: T): T {
    return (fn as T & WrappedFunctionMetadata<T>).__ascOriginal ?? fn;
  }

  private getFileManagerWithTrashFile(): FileManagerWithTrashFile | undefined {
    const appWithOptionalFileManager = this.app as App & { fileManager?: unknown };
    const candidate = appWithOptionalFileManager.fileManager;
    if (typeof candidate !== "object" || candidate === null) {
      return undefined;
    }

    return candidate;
  }

  private attachWindowObservers(targetWindow: Window | null) {
    if (!targetWindow || this.beforeUnloadListenersByWindow.has(targetWindow)) {
      return;
    }

    this.editActivityTracker.attachToWindow(targetWindow);

    const quitShortcutListener = (event: KeyboardEvent) => {
      this.handleQuitShortcut(targetWindow, event);
    };
    targetWindow.addEventListener("keydown", quitShortcutListener, true);
    this.quitShortcutListenersByWindow.set(targetWindow, quitShortcutListener);

    const beforeUnload = () => {
      this.isUnloading = true;
    };

    const beforeUnloadWithPrompt = (event: BeforeUnloadEvent) => {
      // This listener is attached with { capture: true }, so it runs before
      // Obsidian's window.onbeforeunload property handler — which nulls itself as
      // its very first action. Capture the live hook here so we can re-arm it
      // after a "keep editing" cancel; otherwise the SECOND window close finds a
      // null hook and closes silently with no prompt (issue #26 follow-up).
      this.captureObsidianQuitHook();

      if (this.isUnloading) {
        return;
      }

      this.pendingSaveQueue.refreshAllLatestData();

      const shortcut = this.wasQuitShortcutIntentRecentlyMarked();
      const hasPending = this.pendingSaveQueue.hasAny();
      const manual = this.getSettings().disableAutoSave;

      if (!shortcut && hasPending) {
        if (manual) {
          // Manual mode (issue #26) is handled by the awaited workspace 'quit'
          // task. Do NOT mark isUnloading here: if the user picks "keep editing"
          // the window stays open and the next close must still be intercepted.
          return;
        }
        event.preventDefault();
        void this.handleWindowCloseRequest(targetWindow);
        return;
      }

      beforeUnload();
    };

    targetWindow.addEventListener("beforeunload", beforeUnloadWithPrompt, { capture: true });
    this.beforeUnloadListenersByWindow.set(targetWindow, beforeUnloadWithPrompt);

    const electronBrowserWindow = this.getElectronBrowserWindow(targetWindow);
    if (!electronBrowserWindow) {
      return;
    }

    const electronCloseListener: ElectronCloseListener = (event) => {
      if (this.isUnloading || this.bypassNextWindowCloseInterception) {
        this.bypassNextWindowCloseInterception = false;
        return;
      }

      this.pendingSaveQueue.refreshAllLatestData();
      const shortcut = this.wasQuitShortcutIntentRecentlyMarked();
      const hasPending = this.pendingSaveQueue.hasAny();
      const manual = this.getSettings().disableAutoSave;

      if (!shortcut && hasPending) {
        // CRITICAL (issue #26): Obsidian's main process force-destroys the window
        // 3s after the close event UNLESS the close event's defaultPrevented is
        // set ( obsidian.asar main.js: setTimeout(() => !h.defaultPrevented &&
        // !win.isDestroyed() && win.destroy(), 3000) ). Calling preventDefault
        // here disables that 3s watchdog, giving the manual-mode dialog (awaited
        // by Obsidian's "quit" task) unlimited time. The async @electron/remote
        // forwarding lands well within the 3s, so defaultPrevented is set in time.
        event.preventDefault();

        if (!manual) {
          // AUTO-save mode: silently flush via the async re-close path.
          void this.handleWindowCloseRequest(targetWindow);
        }
        // MANUAL mode: the workspace 'quit' task prompts and Obsidian awaits it.
      }
    };

    electronBrowserWindow.on("close", electronCloseListener);
    this.electronCloseListenersByWindow.set(targetWindow, {
      browserWindow: electronBrowserWindow,
      listener: electronCloseListener,
    });
  }

  private detachAllWindowObservers() {
    this.editActivityTracker.detachAll();

    for (const [targetWindow, beforeUnload] of this.beforeUnloadListenersByWindow.entries()) {
      targetWindow.removeEventListener("beforeunload", beforeUnload, { capture: true });
    }

    for (const [targetWindow, quitShortcutListener] of this.quitShortcutListenersByWindow.entries()) {
      targetWindow.removeEventListener("keydown", quitShortcutListener, true);
    }

    for (const { browserWindow, listener } of this.electronCloseListenersByWindow.values()) {
      browserWindow.removeListener("close", listener);
    }

    this.beforeUnloadListenersByWindow.clear();
    this.quitShortcutListenersByWindow.clear();
    this.electronCloseListenersByWindow.clear();
  }

  private getViewWindow(view: MarkdownView): Window | null {
    return view.containerEl.ownerDocument.defaultView;
  }

  private getLeafWindow(leaf: WorkspaceLeaf): Window | null {
    return leaf.view.containerEl.ownerDocument.defaultView;
  }

  private async captureLeafSavedData(leaf: WorkspaceLeaf): Promise<void> {
    const view = leaf.view;
    if (!(view instanceof MarkdownView) || !view.file) {
      return;
    }

    const savedData = await this.app.vault.cachedRead(view.file);
    this.lastSavedDataByPath.set(view.file.path, savedData);
  }

  private captureCurrentViewData(filePath: string, view: TextFileView): void {
    this.lastSavedDataByPath.set(filePath, view.getViewData());
  }

  private syncPendingDataForFile(filePath: string): void {
    this.pendingSaveQueue.refreshLatestData(filePath);
  }

  private syncLeafPendingData(leaf: WorkspaceLeaf): void {
    const filePath = this.getLeafMarkdownFilePath(leaf);
    if (!filePath) {
      return;
    }

    this.captureLeafCursorPosition(leaf, filePath);
    this.syncPendingDataForFile(filePath);
  }

  private captureLeafCursorPosition(leaf: WorkspaceLeaf, filePath: string): void {
    const view = leaf.view;
    if (!(view instanceof MarkdownView)) {
      return;
    }

    this.cursorPositionByPath.set(filePath, view.editor.getCursor());
  }

  private restoreSavedDataIntoLeaf(leaf: WorkspaceLeaf, filePath: string): void {
    const savedData = this.lastSavedDataByPath.get(filePath);
    if (savedData === undefined) {
      return;
    }

    const textFileView = leaf.view as TextFileView & { data?: string };
    textFileView.setViewData(savedData, false);
    textFileView.data = savedData;
  }

  private discardPendingChangesForDeletedFile(filePath: string): void {
    for (const leaf of this.findLeavesForFilePath(filePath)) {
      this.markLeafViewDiscarded(leaf);
    }

    this.pendingSaveQueue.clear(filePath);
    this.clearTrackedFileState(filePath);
  }

  private markLeafViewDiscarded(leaf: WorkspaceLeaf): void {
    if (leaf.view instanceof TextFileView) {
      this.discardedViews.add(leaf.view);
    }
  }

  private confirmDeleteIfNeeded(filePath: string): boolean {
    if (!this.getSettings().disableAutoSave || !this.pendingSaveQueue.has(filePath)) {
      return true;
    }

    const leaf = this.findLeavesForFilePath(filePath)[0] ?? null;
    const targetWindow = leaf ? this.getLeafWindow(leaf) : null;
    const confirmWindow = isWindowWithConfirm(targetWindow) ? targetWindow : window;
    return confirmWindow.confirm("This note has unsaved changes. Delete the file and discard those changes?");
  }

  private hasSubpathNavigationInOpenArgs(args: unknown[]): boolean {
    const openState = args[1] as {
      subpath?: unknown;
      eState?: { subpath?: unknown };
    } | undefined;

    return typeof openState?.subpath === "string" || typeof openState?.eState?.subpath === "string";
  }

  private hasSubpathNavigationInViewStateArgs(args: unknown[]): boolean {
    const state = args[0] as {
      state?: { subpath?: unknown };
      eState?: { subpath?: unknown };
    } | undefined;

    return typeof state?.state?.subpath === "string" || typeof state?.eState?.subpath === "string";
  }

  private getTargetFilePathFromDeleteArgs(args: unknown[]): string | null {
    const target = args[0] as { path?: unknown } | undefined;
    return typeof target?.path === "string" ? target.path : null;
  }

  private restorePendingDataIntoLeaf(view: TextFileView & { data?: string }, filePath: string): void {
    if (this.isUnloading) {
      return;
    }

    const pendingData = this.pendingSaveQueue.getLatestData(filePath);
    if (pendingData === null) {
      return;
    }

    this.markPendingDataRestoreStarted(filePath);

    view.setViewData(pendingData, false);
    view.data = pendingData;
    this.pendingSaveQueue.touchView(filePath, view);
    this.markPendingDataRestoreFinished(filePath);
  }

  private schedulePendingDataRestoreInLeaf(leaf: WorkspaceLeaf): void {
    window.setTimeout(() => {
      if (this.isUnloading) {
        return;
      }

      const filePath = this.getLeafMarkdownFilePath(leaf);
      if (!filePath || !this.pendingSaveQueue.has(filePath)) {
        return;
      }

      if (!(leaf.view instanceof MarkdownView)) {
        return;
      }

      this.restorePendingDataIntoLeaf(leaf.view, filePath);
    }, 0);
  }

  private scheduleLeafCursorRestore(leaf: WorkspaceLeaf, shouldRestoreCursor = true): void {
    window.setTimeout(() => {
      if (this.isUnloading || !shouldRestoreCursor) {
        return;
      }

      const filePath = this.getLeafMarkdownFilePath(leaf);
      if (!filePath || !(leaf.view instanceof MarkdownView)) {
        return;
      }

      const cursorPosition = this.cursorPositionByPath.get(filePath);
      if (!cursorPosition) {
        return;
      }

      leaf.view.editor.setCursor(cursorPosition);
    }, 0);
  }

  private handleQuitShortcut(targetWindow: Window, event: KeyboardEvent): void {
    if (!this.isQuitShortcut(event)) {
      return;
    }

    this.markQuitShortcutIntent();

    if (!this.getSettings().disableAutoSave || !this.pendingSaveQueue.hasAny()) {
      return;
    }

    this.pendingSaveQueue.refreshAllLatestData();

    const confirmWindow = isWindowWithConfirm(targetWindow) ? targetWindow : window;
    const shouldDiscardUnsavedChanges = confirmWindow.confirm(
      this.composeUnsavedChangesMessage("Quit Obsidian and discard those changes?")
    );
    if (!shouldDiscardUnsavedChanges) {
      event.preventDefault();
      event.stopPropagation();
      this.clearQuitShortcutIntent();
      return;
    }

    this.discardAllPendingChanges();
  }

  private discardAllPendingChanges(): void {
    const pendingFilePaths = new Set<string>();

    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const filePath = this.getLeafMarkdownFilePath(leaf);
      if (!filePath || !this.pendingSaveQueue.has(filePath)) {
        continue;
      }

      this.restoreSavedDataIntoLeaf(leaf, filePath);
      this.markLeafViewDiscarded(leaf);
      pendingFilePaths.add(filePath);
    }

    for (const filePath of pendingFilePaths) {
      this.pendingSaveQueue.clear(filePath);
    }
  }

  private getLeafMarkdownFilePath(leaf: WorkspaceLeaf): string | null {
    const view = leaf.view;
    if (!(view instanceof MarkdownView)) {
      return null;
    }

    return view.file?.path ?? null;
  }

  private findLeavesForFilePath(filePath: string): WorkspaceLeaf[] {
    return this.app.workspace.getLeavesOfType("markdown")
      .filter((leaf) => this.getLeafMarkdownFilePath(leaf) === filePath);
  }

  private clearTrackedFileState(filePath: string): void {
    const manualSaveRequestTimeoutId = this.manualSaveRequestTimeoutsByPath.get(filePath);
    if (manualSaveRequestTimeoutId !== undefined) {
      window.clearTimeout(manualSaveRequestTimeoutId);
      this.manualSaveRequestTimeoutsByPath.delete(filePath);
    }

    this.lastSavedDataByPath.delete(filePath);
    this.cursorPositionByPath.delete(filePath);
    this.pendingRestoreCountsByPath.delete(filePath);
  }

  private clearLeafSwitchingState(leaf: WorkspaceLeaf) {
    window.setTimeout(() => {
      this.fileSwitchingLeaves.delete(leaf);
    }, 0);
  }

  private isRestoringPendingData(filePath: string): boolean {
    return (this.pendingRestoreCountsByPath.get(filePath) ?? 0) > 0;
  }

  private markPendingDataRestoreStarted(filePath: string): void {
    this.pendingRestoreCountsByPath.set(filePath, (this.pendingRestoreCountsByPath.get(filePath) ?? 0) + 1);
  }

  private markPendingDataRestoreFinished(filePath: string): void {
    window.setTimeout(() => {
      const pendingRestoreCount = this.pendingRestoreCountsByPath.get(filePath);
      if (pendingRestoreCount === undefined) {
        return;
      }

      if (pendingRestoreCount <= 1) {
        this.pendingRestoreCountsByPath.delete(filePath);
        return;
      }

      this.pendingRestoreCountsByPath.set(filePath, pendingRestoreCount - 1);
    }, 0);
  }

  private isManualSaveShortcut(event: KeyboardEvent): boolean {
    return this.getSaveHotkeys().some((hotkey) => this.matchesHotkey(event, hotkey));
  }

  private isQuitShortcut(event: KeyboardEvent): boolean {
    return this.getQuitHotkeys().some((hotkey) => this.matchesHotkey(event, hotkey));
  }

  private handleManualSaveShortcut(_view: MarkdownView, filePath: string, event: KeyboardEvent): boolean {
    this.markManualSaveRequested(filePath);
    dlog("Allowing manual save shortcut to continue through Obsidian save command", {
      filePath,
      key: event.key,
    });
    return false;
  }

  private shouldHoldSave(view: TextFileView, filePath: string): boolean {
    if (this.pendingSaveQueue.has(filePath)) {
      return true;
    }

    const textFileView = view as TextFileView & { data?: string };
    const currentData = textFileView.getViewData?.();
    if (typeof currentData !== "string") {
      return false;
    }

    const lastSavedData = this.lastSavedDataByPath.get(filePath);
    if (typeof lastSavedData === "string") {
      return lastSavedData !== currentData;
    }

    return textFileView.data !== currentData;
  }

  private markManualSaveRequested(filePath: string): void {
    const existingTimeoutId = this.manualSaveRequestTimeoutsByPath.get(filePath);
    if (existingTimeoutId !== undefined) {
      window.clearTimeout(existingTimeoutId);
    }

    const timeoutId = window.setTimeout(() => {
      this.manualSaveRequestTimeoutsByPath.delete(filePath);
    }, MANUAL_SAVE_REQUEST_TTL_MS);

    this.manualSaveRequestTimeoutsByPath.set(filePath, timeoutId);
  }

  private consumeManualSaveRequest(filePath: string): boolean {
    const timeoutId = this.manualSaveRequestTimeoutsByPath.get(filePath);
    if (timeoutId === undefined) {
      return false;
    }

    window.clearTimeout(timeoutId);
    this.manualSaveRequestTimeoutsByPath.delete(filePath);
    return true;
  }

  private hasManualSaveRequest(filePath: string): boolean {
    return this.manualSaveRequestTimeoutsByPath.has(filePath);
  }

  private clearManualSaveRequests(): void {
    for (const timeoutId of this.manualSaveRequestTimeoutsByPath.values()) {
      window.clearTimeout(timeoutId);
    }

    this.manualSaveRequestTimeoutsByPath.clear();
  }

  private registerAppQuitObserver(): void {
    const globalState = window as ElectronRequireHost;
    const electron = globalState.require?.("electron");
    const app = electron?.remote?.app;
    if (!app || typeof app.on !== "function") {
      return;
    }

    const listener: ElectronAppQuitListener = () => {
      this.appIsQuitting = true;
      // Start a fresh multi-window quit-coordination round (issue #28). Each
      // vault renderer clears the shared file here, at "before-quit" time — long
      // before any per-window quit task records its decision — so a stale set
      // from a previously cancelled quit can never trigger a premature exit.
      this.resetQuitCoordination();
    };
    app.on("before-quit", listener);
    this.electronApp = app;
    this.electronAppQuitListener = listener;
  }

  private unregisterAppQuitObserver(): void {
    if (
      this.electronApp
      && this.electronAppQuitListener
      && typeof this.electronApp.removeListener === "function"
    ) {
      this.electronApp.removeListener("before-quit", this.electronAppQuitListener);
    }
    this.electronApp = null;
    this.electronAppQuitListener = null;
    this.appIsQuitting = false;
  }

  private exitApplicationAfterFlush(): boolean {
    const globalState = window as ElectronRequireHost;
    const electron = globalState.require?.("electron");

    try {
      if (typeof electron?.remote?.app?.exit === "function") {
        electron.remote.app.exit(0);
        return true;
      }
    } catch {
      // fall through to softer quit path
    }

    try {
      if (typeof electron?.remote?.app?.quit === "function") {
        electron.remote.app.quit();
        return true;
      }
    } catch {
      // no supported explicit quit path available
    }

    const browserWindow = this.getElectronBrowserWindow(window);
    try {
      if (typeof browserWindow?.close === "function") {
        browserWindow.close();
        return true;
      }
    } catch {
      // fall through to harder close path
    }

    try {
      if (typeof browserWindow?.destroy === "function") {
        browserWindow.destroy();
        return true;
      }
    } catch {
      // no supported explicit close path available
    }

    return false;
  }

  // ---------------------------------------------------------------------------
  // Multi-window app-quit coordination (issue #28)
  //
  // Each open vault is a separate renderer in the SAME Electron process. On a
  // real app quit Obsidian runs every window's "quit" task and only closes the
  // windows once they have all settled, so at task time getAllWindows() always
  // still reports every window — no single window can tell whether it is "last".
  // We also cannot quit from a main-process hook (e.g. window-all-closed): by the
  // time it fires every renderer is gone, so no plugin code is left to run.
  //
  // Instead the windows agree through a temp file (keyed by the shared main pid):
  // each records its window id once its quit decision is made, and the window
  // that completes the set — i.e. observes every currently-open window as done —
  // exits the whole app while it is still alive. If any vault chooses "keep
  // editing" it never records itself, so the set never completes and the app
  // stays open, which is exactly the cancel-the-quit behaviour we want.
  // ---------------------------------------------------------------------------
  private getElectronModule(): ElectronModule | undefined {
    return (window as ElectronRequireHost).require?.("electron");
  }

  private getNodeModule<T>(moduleName: string): T | undefined {
    try {
      return (window as NodeRequireHost).require?.(moduleName) as T | undefined;
    } catch {
      return undefined;
    }
  }

  private getQuitCoordinationFilePath(): string | null {
    const pathModule = this.getNodeModule<NodePathModule>("path");
    const osModule = this.getNodeModule<NodeOsModule>("os");
    if (!pathModule || !osModule) {
      return null;
    }

    const mainProcessPid = this.getElectronModule()?.remote?.process?.pid ?? "unknown";
    return pathModule.join(osModule.tmpdir(), `asc-quit-coordination-${mainProcessPid}.json`);
  }

  private resetQuitCoordination(): void {
    const filePath = this.getQuitCoordinationFilePath();
    const fsModule = this.getNodeModule<NodeFsModule>("fs");
    if (!filePath || !fsModule) {
      return;
    }

    try {
      fsModule.writeFileSync(filePath, JSON.stringify({ done: [] }));
    } catch {
      // best-effort: a missing coordination file just falls back to a fresh set
    }
  }

  // Record this window's quit decision and, if every currently-open window has
  // now recorded one, exit the whole application. Falls back to a direct exit
  // when window coordination is unavailable (single window / non-Electron),
  // preserving the original single-vault quit behaviour.
  private finalizeQuitFromThisWindow(): void {
    const electron = this.getElectronModule();
    const myWindowId = electron?.remote?.getCurrentWindow?.()?.id;
    const openWindows = electron?.remote?.BrowserWindow?.getAllWindows?.();
    const filePath = this.getQuitCoordinationFilePath();
    const fsModule = this.getNodeModule<NodeFsModule>("fs");

    const openWindowIds = Array.isArray(openWindows)
      ? openWindows.map((openWindow) => openWindow.id).filter((id): id is number => typeof id === "number")
      : [];

    if (openWindowIds.length <= 1 || typeof myWindowId !== "number" || !filePath || !fsModule) {
      this.isUnloading = true;
      this.exitApplicationAfterFlush();
      return;
    }

    const doneWindowIds = this.readQuitCoordinationDoneIds(fsModule, filePath);
    if (!doneWindowIds.includes(myWindowId)) {
      doneWindowIds.push(myWindowId);
    }
    try {
      fsModule.writeFileSync(filePath, JSON.stringify({ done: doneWindowIds }));
    } catch {
      // best-effort
    }

    const everyOpenWindowIsDone = openWindowIds.every((id) => doneWindowIds.includes(id));
    if (everyOpenWindowIsDone) {
      try {
        fsModule.rmSync?.(filePath, { force: true });
      } catch {
        // best-effort cleanup
      }
      this.isUnloading = true;
      this.exitApplicationAfterFlush();
    }
    // Otherwise another vault still has to answer; this window's task resolves and
    // it waits. The last vault to answer completes the set and exits the app.
  }

  private readQuitCoordinationDoneIds(fsModule: NodeFsModule, filePath: string): number[] {
    try {
      const parsed = JSON.parse(fsModule.readFileSync(filePath, "utf8")) as { done?: unknown };
      if (Array.isArray(parsed.done)) {
        return parsed.done.filter((id): id is number => typeof id === "number");
      }
    } catch {
      // missing or corrupt -> start a fresh set
    }

    return [];
  }

  // Bring this renderer's window to the front before showing a blocking dialog.
  // During an app quit a background vault window cannot surface a native
  // confirm() unless it is focused first, so without this its prompt is invisible
  // even though its quit task is running (issue #28).
  private focusCurrentWindow(): void {
    const browserWindow = this.getElectronBrowserWindow(window);
    try {
      browserWindow?.show?.();
      browserWindow?.focus?.();
    } catch {
      // best-effort: focusing is only to make the prompt visible
    }
  }

  private getElectronBrowserWindow(targetWindow: Window): ElectronBrowserWindow | null {
    const globalState = targetWindow as ElectronRequireHost;
    const electron = globalState.require?.("electron");
    const browserWindow = electron?.remote?.getCurrentWindow?.();
    if (!browserWindow || typeof browserWindow.on !== "function" || typeof browserWindow.removeListener !== "function") {
      return null;
    }

    return browserWindow;
  }

  private async handleWindowCloseRequest(targetWindow: Window): Promise<void> {
    if (this.isHandlingWindowCloseRequest) {
      return;
    }

    this.isHandlingWindowCloseRequest = true;

    try {
      this.pendingSaveQueue.refreshAllLatestData();
      await this.forceFlushOpenMarkdownLeaves();
      if (this.pendingSaveQueue.hasAny()) {
        await this.pendingSaveQueue.flushAll();
      }

      await this.workspaceLayoutSaveController.flush();
      this.clearQuitShortcutIntent();
      // Close only the window the user is closing. Re-issuing the close lets the
      // window go through, so bypass our own interception for that one event.
      // Crucially this must NOT quit the whole application: with multiple vaults
      // open, each vault is a separate window in the same Electron process, and
      // quitting here would tear them all down (issue #29).
      this.bypassNextWindowCloseInterception = true;
      const reclosed = this.closeWindowAfterFlush(targetWindow);
      if (!reclosed) {
        this.bypassNextWindowCloseInterception = false;
      }
    } finally {
      this.isHandlingWindowCloseRequest = false;
    }
  }

  private closeWindowAfterFlush(targetWindow: Window): boolean {
    // Prefer the BrowserWindow reference captured when the close listener was
    // attached: after a blocking confirm dialog, remote.getCurrentWindow() can
    // return null, but the stored reference stays valid (issue #26).
    const browserWindow = this.electronCloseListenersByWindow.get(targetWindow)?.browserWindow
      ?? this.getElectronBrowserWindow(targetWindow);

    try {
      if (typeof browserWindow?.close === "function") {
        browserWindow.close();
        return true;
      }
    } catch {
      // fall through to harder close path
    }

    try {
      if (typeof browserWindow?.destroy === "function") {
        browserWindow.destroy();
        return true;
      }
    } catch {
      // no supported explicit close path available
    }

    return false;
  }

  private async forceFlushOpenMarkdownLeaves(): Promise<void> {
    const fileSystemAdapter = this.app.vault.adapter;

    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      if (!(leaf.view instanceof MarkdownView) || !leaf.view.file) {
        continue;
      }

      const filePath = leaf.view.file.path;
      const textFileView = leaf.view as unknown as TextFileView;
      const latestData = textFileView.getViewData();

      if (fileSystemAdapter instanceof FileSystemAdapter) {
        await fileSystemAdapter.write(filePath, latestData);
      } else {
        await this.app.vault.modify(leaf.view.file, latestData);
      }

      this.pendingSaveQueue.clear(filePath);
      this.captureCurrentViewData(filePath, textFileView);
    }
  }

  // Human-readable note names for everything that still has unsaved changes,
  // sorted so the dialog is stable between opens. The vault-relative path is kept
  // (so notes with the same name in different folders stay distinguishable) but
  // the ".md" extension is dropped to match how Obsidian shows note titles.
  // Also consumed by the status-bar hover tooltip (see SaveStatusIndicator).
  getPendingNoteNames(): string[] {
    return this.pendingSaveQueue.getPaths()
      .map((filePath) => filePath.replace(/\.md$/i, ""))
      .sort((a, b) => a.localeCompare(b));
  }

  // Build the close/quit confirm text with the list of unsaved notes embedded.
  // The list is capped (see MAX_LISTED_UNSAVED_NOTES) because a native confirm()
  // cannot scroll, and `question` is the trailing call to action that differs
  // between closing a window and quitting the whole app.
  private composeUnsavedChangesMessage(question: string): string {
    const noteNames = this.getPendingNoteNames();
    const count = noteNames.length;
    const heading = count === 1
      ? "You have 1 note with unsaved changes:"
      : `You have ${count} notes with unsaved changes:`;

    const listedNames = noteNames.slice(0, MAX_LISTED_UNSAVED_NOTES);
    const lines = listedNames.map((name) => `• ${name}`);
    const hiddenCount = count - listedNames.length;
    if (hiddenCount > 0) {
      lines.push(`…and ${hiddenCount} more`);
    }

    return `${heading}\n\n${lines.join("\n")}\n\n${question}`;
  }

  // Ask the user (manual mode, issue #26) whether to save before closing, AFTER
  // beforeunload has reliably blocked the close. Runs in a deferred task so that
  // window.confirm is not suppressed (it is, while a beforeunload handler is on
  // the call stack). The user's choice then re-issues the close on the still-open
  // window, which closes it and quits the app if it was the last one.
  // Ask the user (manual mode, issue #26) whether to save before closing, as a
  // NON-BLOCKING Obsidian Modal that resolves a promise. This is awaited from the
  // workspace "quit" task, the one hook Obsidian genuinely blocks on (it is what
  // the "Saving…" screen represents), so the window stays open until the user
  // chooses. window.confirm is unusable here: it freezes the renderer, which
  // Electron force-closes after ~3s. Esc / click-away defaults to "save" so a
  // dismissed dialog can never lose data.
  private askManualCloseDecision(): Promise<"discard" | "cancel"> {
    // Same NATIVE dialog as the Cmd+Q path: OK = discard & close, Cancel / Esc =
    // keep editing (window stays open).
    //
    // Obsidian shows a full-screen "Saving…" overlay before it awaits this task,
    // which would sit behind the dialog. Its progress bar show() prepends
    // div.progress-bar-container AND adds body.in-progress (which un-hides the
    // frameless titlebar on macOS). Hide BOTH via the asc-hide-saving-overlay body
    // class (rules in styles.css) while the user decides — a body class is immune
    // to the timing race where Obsidian re-adds in-progress a frame after we'd
    // remove it. confirm() freezes the renderer, so the hide must actually PAINT
    // first — two animation frames guarantee a paint before we block.
    //
    // Multi-vault (issue #28): during an app quit this task can run in a vault
    // window that is not the focused one, where a native confirm would never be
    // shown. Bring our own window forward first so the prompt is actually visible.
    this.focusCurrentWindow();

    const body = activeDocument.body;
    body.addClass("asc-hide-saving-overlay");
    const confirmWindow = isWindowWithConfirm(activeWindow) ? activeWindow : window;

    return new Promise((resolve) => {
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        const proceed = confirmWindow.confirm(
          this.composeUnsavedChangesMessage("Close and discard those changes?"),
        );
        body.removeClass("asc-hide-saving-overlay");
        resolve(proceed ? "discard" : "cancel");
      }));
    });
  }

  private removeOrphanedSavingOverlay(): void {
    activeDocument.querySelectorAll(".progress-bar-container").forEach((element) => element.remove());
    // Obsidian's progress bar show() both prepends .progress-bar-container AND adds
    // body.in-progress; hide() removes both. When the user picks "keep editing" the
    // window stays open, so Obsidian never calls hide() and the class leaks. On a
    // frameless macOS window, body.is-frameless.in-progress un-hides the titlebar
    // (Obsidian app.css), so the "Obsidian — vault" bar appears. Mirror hide() by
    // dropping the class too, otherwise it stays stuck after an X-button cancel.
    activeDocument.body.removeClass("in-progress");
  }

  private captureObsidianQuitHook(): void {
    if (typeof window.onbeforeunload === "function") {
      this.obsidianOnBeforeUnload = window.onbeforeunload as (event: BeforeUnloadEvent) => unknown;
    }
  }

  private reArmObsidianQuitHook(): void {
    if (this.obsidianOnBeforeUnload && !window.onbeforeunload) {
      window.onbeforeunload = this.obsidianOnBeforeUnload;
    }
  }

  private wrapSaveCommand(): void {
    const markActiveFileManualSaveRequested = () => this.markActiveFileManualSaveRequested();
    const saveCommandDefinition = this.getSaveCommandDefinition();
    if (!saveCommandDefinition || typeof saveCommandDefinition.checkCallback !== "function") {
      return;
    }

    const checkCallback = this.unwrapWrappedFunction(saveCommandDefinition.checkCallback);
    this.originalSaveCommandCheckCallback = checkCallback;
    const wrappedCheckCallback = function (this: unknown, checking: boolean) {
      if (!checking) {
        markActiveFileManualSaveRequested();
      }

      return callWithArgs(checkCallback, this, checking);
    };

    this.installedSaveCommandCheckCallback = this.markWrappedFunction(wrappedCheckCallback, checkCallback);
    saveCommandDefinition.checkCallback = this.installedSaveCommandCheckCallback;
  }

  private wrapReloadWithoutSavingCommand(): void {
    const prepareForReloadWithoutSaving = () => this.prepareForReloadWithoutSaving();
    const reloadWithoutSavingCommandDefinition = this.getReloadWithoutSavingCommandDefinition();
    if (!reloadWithoutSavingCommandDefinition || typeof reloadWithoutSavingCommandDefinition.callback !== "function") {
      return;
    }

    const callback = this.unwrapWrappedFunction(reloadWithoutSavingCommandDefinition.callback);
    this.originalReloadWithoutSavingCommandCallback = callback;
    const wrappedCallback = function (this: unknown, ...args: unknown[]) {
      prepareForReloadWithoutSaving();
      return callWithArgs(callback, this, ...args);
    };

    this.installedReloadWithoutSavingCommandCallback = this.markWrappedFunction(wrappedCallback, callback);
    reloadWithoutSavingCommandDefinition.callback = this.installedReloadWithoutSavingCommandCallback;
  }

  private restoreSaveCommand(): void {
    const saveCommandDefinition = this.getSaveCommandDefinition();
    if (!saveCommandDefinition || !this.originalSaveCommandCheckCallback) {
      this.originalSaveCommandCheckCallback = null;
      this.installedSaveCommandCheckCallback = null;
      return;
    }

    if (saveCommandDefinition.checkCallback === this.installedSaveCommandCheckCallback) {
      saveCommandDefinition.checkCallback = this.originalSaveCommandCheckCallback;
    }

    this.originalSaveCommandCheckCallback = null;
    this.installedSaveCommandCheckCallback = null;
  }

  private restoreReloadWithoutSavingCommand(): void {
    const reloadWithoutSavingCommandDefinition = this.getReloadWithoutSavingCommandDefinition();
    if (
      reloadWithoutSavingCommandDefinition
      && this.originalReloadWithoutSavingCommandCallback
      && reloadWithoutSavingCommandDefinition.callback === this.installedReloadWithoutSavingCommandCallback
    ) {
      reloadWithoutSavingCommandDefinition.callback = this.originalReloadWithoutSavingCommandCallback;
    }

    this.originalReloadWithoutSavingCommandCallback = null;
    this.installedReloadWithoutSavingCommandCallback = null;
  }

  private markActiveFileManualSaveRequested(): void {
    const activeMarkdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const filePath = activeMarkdownView?.file?.path;
    if (!filePath) {
      return;
    }

    this.markManualSaveRequested(filePath);
  }

  private getSaveCommandDefinition(): { checkCallback?: SaveCommandCheckCallback } | null {
    const appWithInternals = this.app as App & {
      commands?: { commands?: Record<string, { checkCallback?: SaveCommandCheckCallback }> };
    };

    return appWithInternals.commands?.commands?.["editor:save-file"] ?? null;
  }

  private getReloadWithoutSavingCommandDefinition(): CommandDefinition | null {
    const appWithInternals = this.app as App & {
      commands?: { commands?: Record<string, CommandDefinition> };
    };

    const commands = appWithInternals.commands?.commands;
    if (!commands) {
      return null;
    }

    return commands["app:reload"]
      ?? Object.values(commands).find((command) => command.name === "Reload app without saving")
      ?? null;
  }

  private prepareForReloadWithoutSaving(): void {
    this.restorePendingDataForReloadWithoutSaving();
    this.pendingSaveQueue.clearAll();
    this.disable();
  }

  private restorePendingDataForReloadWithoutSaving(): void {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const filePath = this.getLeafMarkdownFilePath(leaf);
      if (!filePath || !this.pendingSaveQueue.has(filePath)) {
        continue;
      }

      this.restoreSavedDataIntoLeaf(leaf, filePath);
    }
  }

  private getSaveHotkeys(): Hotkey[] {
    const appWithInternals = this.app as App & {
      hotkeyManager?: { customKeys?: Record<string, Hotkey[]> };
      commands?: { commands?: Record<string, { hotkeys?: Hotkey[] }> };
    };

    const commandId = "editor:save-file";
    const customHotkeys = appWithInternals.hotkeyManager?.customKeys?.[commandId];
    if (customHotkeys && customHotkeys.length > 0) {
      return customHotkeys;
    }

    const defaultHotkeys = appWithInternals.commands?.commands?.[commandId]?.hotkeys;
    if (defaultHotkeys && defaultHotkeys.length > 0) {
      return defaultHotkeys;
    }

    return [{ modifiers: ["Mod"], key: "s" }];
  }

  private getQuitHotkeys(): Hotkey[] {
    const appWithInternals = this.app as App & {
      hotkeyManager?: { customKeys?: Record<string, Hotkey[]> };
      commands?: { commands?: Record<string, { hotkeys?: Hotkey[] }> };
    };

    const commandId = "app:quit";
    const customHotkeys = appWithInternals.hotkeyManager?.customKeys?.[commandId];
    if (customHotkeys && customHotkeys.length > 0) {
      return customHotkeys;
    }

    const defaultHotkeys = appWithInternals.commands?.commands?.[commandId]?.hotkeys;
    if (defaultHotkeys && defaultHotkeys.length > 0) {
      return defaultHotkeys;
    }

    return [{ modifiers: ["Mod"], key: "q" }];
  }

  private matchesHotkey(event: KeyboardEvent, hotkey: Hotkey): boolean {
    if (event.key.toLowerCase() !== hotkey.key.toLowerCase()) {
      return false;
    }

    const normalizedModifiers = new Set(hotkey.modifiers);
    const expectsMod = normalizedModifiers.has("Mod");
    const expectsCtrl = normalizedModifiers.has("Ctrl") || (!Platform.isMacOS && expectsMod);
    const expectsMeta = normalizedModifiers.has("Meta") || (Platform.isMacOS && expectsMod);
    const expectsShift = normalizedModifiers.has("Shift");
    const expectsAlt = normalizedModifiers.has("Alt");

    return (
      event.ctrlKey === expectsCtrl &&
      event.metaKey === expectsMeta &&
      event.shiftKey === expectsShift &&
      event.altKey === expectsAlt
    );
  }

  private markQuitShortcutIntent(): void {
    this.quitShortcutIntentTimestampMs = Date.now();
  }

  private clearQuitShortcutIntent(): void {
    this.quitShortcutIntentTimestampMs = 0;
  }

  private wasQuitShortcutIntentRecentlyMarked(): boolean {
    if (this.quitShortcutIntentTimestampMs === 0) {
      return false;
    }

    return Date.now() - this.quitShortcutIntentTimestampMs <= QUIT_SHORTCUT_INTENT_TTL_MS;
  }
}
