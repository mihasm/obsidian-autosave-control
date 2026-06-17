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
type DeleteFileFn = (this: unknown, ...args: unknown[]) => Promise<unknown> | unknown;
type CommandCallback = (...args: unknown[]) => unknown;
type SaveCommandCheckCallback = (checking: boolean) => boolean | void;
type CommandDefinition = {
  name?: string;
  callback?: CommandCallback;
};
type WrappedFunction<T extends Function> = T & { __ascOriginal?: T; __ascOwner?: AutoSaveController };
const MANUAL_SAVE_REQUEST_TTL_MS = 5000;
const QUIT_SHORTCUT_INTENT_TTL_MS = 2000;

type BeforeUnloadListener = (event: BeforeUnloadEvent) => void;
type ElectronCloseEvent = { preventDefault: () => void };
type ElectronCloseListener = (event: ElectronCloseEvent) => void;
type ElectronBrowserWindow = {
  on: (event: "close", listener: ElectronCloseListener) => void;
  removeListener: (event: "close", listener: ElectronCloseListener) => void;
  close?: () => void;
  destroy?: () => void;
};

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

  constructor(private readonly app: App, private readonly getSettings: () => AutoSaveControlSettings) {
    this.editActivityTracker = new EditActivityTracker(
      () => this.app.workspace.getActiveViewOfType(MarkdownView),
      (view, filePath) => {
        if (this.isRestoringPendingData(filePath)) {
          return;
        }

        this.pendingSaveQueue.schedule(filePath, view as unknown as TextFileView);
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
    const fileManagerWithTrashFile = (this.app as App & {
      fileManager?: { trashFile?: DeleteFileFn };
    }).fileManager;
    const writableVaultWithDeleteMethods = vaultWithDeleteMethods as {
      trash?: DeleteFileFn;
      delete?: DeleteFileFn;
    };
    const writableFileManagerWithTrashFile = fileManagerWithTrashFile as {
      trashFile?: DeleteFileFn;
    } | undefined;

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

    if (typeof fileManagerWithTrashFile?.trashFile === "function") {
      this.originalFileManagerTrashFile = this.unwrapWrappedFunction(fileManagerWithTrashFile.trashFile);
      this.installedFileManagerTrashFileWrapper = this.createDeleteWrapper(this.originalFileManagerTrashFile);
      writableFileManagerWithTrashFile!.trashFile = this.installedFileManagerTrashFileWrapper;
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
      this.scheduleLiveRequestSaveWrap(leaf.view as unknown as TextFileView);
    });

    if (!Platform.isMobileApp) {
      this.workspaceQuitEventRef = this.app.workspace.on("quit", (tasks: Tasks) => {
        this.pendingSaveQueue.refreshAllLatestData();
        const quitWasRequestedWithShortcut = this.wasQuitShortcutIntentRecentlyMarked();

        tasks.add(async () => {
          const hasPendingSaves = this.pendingSaveQueue.hasAny();
          if (
            hasPendingSaves
            && (!quitWasRequestedWithShortcut || !this.getSettings().disableAutoSave)
          ) {
            await this.pendingSaveQueue.flushAll();
          }

          await this.workspaceLayoutSaveController.flush();
          this.isUnloading = true;
          this.clearQuitShortcutIntent();
          this.exitApplicationAfterFlush();
        });
      });
    }

    this.attachWindowObservers(window);

    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      if (leaf.view instanceof MarkdownView) {
        this.attachWindowObservers(this.getViewWindow(leaf.view));
        this.scheduleLiveRequestSaveWrap(leaf.view as unknown as TextFileView);
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
    const fileManagerWithTrashFile = (this.app as App & {
      fileManager?: { trashFile?: DeleteFileFn };
    }).fileManager;
    const writableVaultWithDeleteMethods = vaultWithDeleteMethods as {
      trash?: DeleteFileFn;
      delete?: DeleteFileFn;
    };
    const writableFileManagerWithTrashFile = fileManagerWithTrashFile as {
      trashFile?: DeleteFileFn;
    } | undefined;

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

    if (this.originalFileManagerTrashFile && fileManagerWithTrashFile?.trashFile === this.installedFileManagerTrashFileWrapper) {
      writableFileManagerWithTrashFile!.trashFile = this.originalFileManagerTrashFile;
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

    this.detachAllWindowObservers();
    this.restoreLiveRequestSaveOverrides();
    this.clearManualSaveRequests();
    this.clearQuitShortcutIntent();
    this.pendingSaveQueue.clearAll();
    this.isUnloading = false;

    dlog("Autosave wrapper disabled");
  }

  private createSaveWrapper(originalSave: SaveFn): SaveFn {
    const controller = this;

    const wrappedSave = function wrappedSave(this: MarkdownView, ...args: unknown[]) {
      const filePath = this.file?.path;
      if (!filePath) {
        return originalSave.apply(this, args);
      }

      if (controller.discardedViews.has(this as unknown as TextFileView)) {
        dlog("Suppressing save for discarded file", { filePath, args });
        return;
      }

      if (controller.consumeManualSaveRequest(filePath)) {
        dlog("Allowing manual save", { filePath, args });
        const saveResult = originalSave.apply(this, args);

        if (saveResult instanceof Promise) {
          return saveResult.then(() => {
            controller.pendingSaveQueue.clear(filePath);
            controller.captureCurrentViewData(filePath, this as unknown as TextFileView);
            return controller.workspaceLayoutSaveController.flush();
          });
        }

        controller.pendingSaveQueue.clear(filePath);
        controller.captureCurrentViewData(filePath, this as unknown as TextFileView);
        void controller.workspaceLayoutSaveController.flush();
        return saveResult;
      }

      if (controller.shouldHoldSave(this as unknown as TextFileView, filePath)) {
        controller.pendingSaveQueue.schedule(filePath, this as unknown as TextFileView);
        dlog("Suppressing non-manual save", { filePath, args });
        return;
      }

      return originalSave.apply(this, args);
    };

    return this.markWrappedFunction(wrappedSave, originalSave);
  }

  private createOnUnloadFileWrapper(originalOnUnloadFile: OnUnloadFileFn): OnUnloadFileFn {
    const controller = this;

    const wrappedOnUnloadFile = async function wrappedOnUnloadFile(this: TextFileView, file: TFile) {
      if (controller.discardedViews.has(this)) {
        controller.discardedViews.delete(this);
        return;
      }

      controller.syncPendingDataForFile(file.path);

      if (controller.getSettings().disableAutoSave) {
        await originalOnUnloadFile.call(this, file);
        return;
      }

      if (controller.pendingSaveQueue.has(file.path) && !controller.fileSwitchingLeaves.has(this.leaf)) {
        dlog("Flushing pending save on file unload", { filePath: file.path });
        await controller.pendingSaveQueue.flush(file.path);
      }

      await originalOnUnloadFile.call(this, file);
    };

    return this.markWrappedFunction(wrappedOnUnloadFile, originalOnUnloadFile);
  }

  private createRequestSaveWrapper(originalRequestSave: RequestSaveFn): RequestSaveFn {
    const controller = this;

    const wrappedRequestSave = function wrappedRequestSave(this: TextFileView, ...args: unknown[]) {
      const filePath = this.file?.path;
      if (!filePath) {
        return originalRequestSave.apply(this, args);
      }

      if (controller.discardedViews.has(this)) {
        dlog("Suppressing requestSave for discarded file", { filePath, args });
        return;
      }

      if (controller.isRestoringPendingData(filePath)) {
        dlog("Suppressing requestSave during pending-data restore", { filePath, args });
        return;
      }

      if (controller.hasManualSaveRequest(filePath)) {
        dlog("Allowing manual requestSave", { filePath, args });
        controller.markManualSaveRequested(filePath);
        return originalRequestSave.apply(this, args);
      }

      if (!controller.shouldHoldSave(this, filePath)) {
        dlog("Ignoring requestSave for clean file", { filePath, args });
        return;
      }

      controller.pendingSaveQueue.schedule(filePath, this);
    };

    return this.markWrappedFunction(wrappedRequestSave, originalRequestSave);
  }

  private createOpenFileWrapper(originalOpenFile: OpenFileFn): OpenFileFn {
    const controller = this;

    const wrappedOpenFile = async function wrappedOpenFile(this: WorkspaceLeaf, ...args: unknown[]) {
      const shouldRestoreCursor = !controller.hasSubpathNavigationInOpenArgs(args);

      controller.syncLeafPendingData(this);
      if (!controller.confirmLeafSwitchIfNeeded(this, controller.getTargetFilePathFromOpenArgs(args))) {
        return;
      }

      controller.fileSwitchingLeaves.add(this);

      try {
        return await originalOpenFile.apply(this, args);
      } finally {
        controller.scheduleLiveRequestSaveWrap(this.view as unknown as TextFileView);
        void controller.captureLeafSavedData(this);
        controller.schedulePendingDataRestoreInLeaf(this);
        controller.scheduleLeafCursorRestore(this, shouldRestoreCursor);
        controller.clearLeafSwitchingState(this);
      }
    };

    return this.markWrappedFunction(wrappedOpenFile, originalOpenFile);
  }

  private createSetViewStateWrapper(originalSetViewState: SetViewStateFn): SetViewStateFn {
    const controller = this;

    const wrappedSetViewState = async function wrappedSetViewState(this: WorkspaceLeaf, ...args: unknown[]) {
      const shouldRestoreCursor = !controller.hasSubpathNavigationInViewStateArgs(args);

      controller.syncLeafPendingData(this);
      if (!controller.confirmLeafSwitchIfNeeded(this, controller.getTargetFilePathFromViewStateArgs(args))) {
        return;
      }

      controller.fileSwitchingLeaves.add(this);

      try {
        return await originalSetViewState.apply(this, args);
      } finally {
        controller.scheduleLiveRequestSaveWrap(this.view as unknown as TextFileView);
        void controller.captureLeafSavedData(this);
        controller.schedulePendingDataRestoreInLeaf(this);
        controller.scheduleLeafCursorRestore(this, shouldRestoreCursor);
        controller.clearLeafSwitchingState(this);
      }
    };

    return this.markWrappedFunction(wrappedSetViewState, originalSetViewState);
  }

  private createDetachWrapper(originalDetach: DetachFn): DetachFn {
    const controller = this;

    const wrappedDetach = function wrappedDetach(this: WorkspaceLeaf) {
      const filePath = controller.getLeafMarkdownFilePath(this);
      if (filePath) {
        controller.syncPendingDataForFile(filePath);
      }

      if (
        filePath &&
        controller.getSettings().disableAutoSave &&
        controller.pendingSaveQueue.has(filePath)
      ) {
        const targetWindow = controller.getLeafWindow(this) ?? window;
        const shouldDiscardUnsavedChanges = targetWindow.confirm(
          "This note has unsaved changes. Close it and discard those changes?"
        );

        if (!shouldDiscardUnsavedChanges) {
          return;
        }

        controller.discardPendingChangesInLeaf(this, filePath);
      }

      originalDetach.call(this);
    };

    return this.markWrappedFunction(wrappedDetach, originalDetach);
  }

  private createDeleteWrapper(originalDelete: DeleteFileFn): DeleteFileFn {
    const controller = this;

    const wrappedDelete = async function wrappedDelete(this: unknown, ...args: unknown[]) {
      const filePath = controller.getTargetFilePathFromDeleteArgs(args);
      if (!filePath) {
        return originalDelete.apply(this, args);
      }

      if (!controller.confirmDeleteIfNeeded(filePath)) {
        return;
      }

      if (controller.confirmedDeletionPaths.has(filePath)) {
        return originalDelete.apply(this, args);
      }

      controller.confirmedDeletionPaths.add(filePath);
      controller.discardPendingChangesForDeletedFile(filePath);

      try {
        return await originalDelete.apply(this, args);
      } finally {
        controller.confirmedDeletionPaths.delete(filePath);
      }
    };

    return this.markWrappedFunction(wrappedDelete, originalDelete);
  }

  private markWrappedFunction<T extends Function>(wrapper: T, original: T): T {
    const wrappedFunction = wrapper as WrappedFunction<T>;
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

  private unwrapWrappedFunction<T extends Function>(fn: T): T {
    return (fn as WrappedFunction<T>).__ascOriginal ?? fn;
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
      if (this.isUnloading) {
        return;
      }

      this.pendingSaveQueue.refreshAllLatestData();

      if (!this.wasQuitShortcutIntentRecentlyMarked() && this.pendingSaveQueue.hasAny()) {
        event.preventDefault();
        event.returnValue = false;
        void this.handleWindowCloseRequest();
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
      if (!this.wasQuitShortcutIntentRecentlyMarked() && this.pendingSaveQueue.hasAny()) {
        event.preventDefault();
        void this.handleWindowCloseRequest();
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
      targetWindow.removeEventListener("beforeunload", beforeUnload, { capture: true } as AddEventListenerOptions);
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

  private discardPendingChangesInLeaf(leaf: WorkspaceLeaf, filePath: string): void {
    const siblingLeaf = this.findSiblingLeafForFilePath(leaf, filePath);
    this.markLeafViewDiscarded(leaf);

    if (siblingLeaf && siblingLeaf.view instanceof TextFileView) {
      this.pendingSaveQueue.touchView(filePath, siblingLeaf.view);
      this.syncPendingDataForFile(filePath);
      return;
    }

    this.restoreSavedDataIntoLeaf(leaf, filePath);
    this.pendingSaveQueue.clear(filePath);
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

  private findSiblingLeafForFilePath(currentLeaf: WorkspaceLeaf, filePath: string): WorkspaceLeaf | null {
    for (const leaf of this.findLeavesForFilePath(filePath)) {
      if (leaf !== currentLeaf && this.getLeafMarkdownFilePath(leaf) === filePath) {
        return leaf;
      }
    }

    return null;
  }

  private confirmLeafSwitchIfNeeded(leaf: WorkspaceLeaf, targetFilePath: string | null): boolean {
    const currentFilePath = this.getLeafMarkdownFilePath(leaf);
    if (
      !this.getSettings().disableAutoSave
      || !currentFilePath
      || !this.pendingSaveQueue.has(currentFilePath)
      || targetFilePath === currentFilePath
    ) {
      return true;
    }

    const targetWindow = this.getLeafWindow(leaf) ?? window;
    const shouldDiscardUnsavedChanges = targetWindow.confirm(
      "This note has unsaved changes. Switch notes and discard those changes?"
    );
    if (!shouldDiscardUnsavedChanges) {
      return false;
    }

    this.discardPendingChangesInLeaf(leaf, currentFilePath);
    return true;
  }

  private confirmDeleteIfNeeded(filePath: string): boolean {
    if (!this.getSettings().disableAutoSave || !this.pendingSaveQueue.has(filePath)) {
      return true;
    }

    const leaf = this.findLeavesForFilePath(filePath)[0] ?? null;
    const targetWindow = (leaf && this.getLeafWindow(leaf)) ?? window;
    return targetWindow.confirm("This note has unsaved changes. Delete the file and discard those changes?");
  }

  private getTargetFilePathFromOpenArgs(args: unknown[]): string | null {
    const target = args[0] as { path?: unknown } | undefined;
    return typeof target?.path === "string" ? target.path : null;
  }

  private hasSubpathNavigationInOpenArgs(args: unknown[]): boolean {
    const openState = args[1] as {
      subpath?: unknown;
      eState?: { subpath?: unknown };
    } | undefined;

    return typeof openState?.subpath === "string" || typeof openState?.eState?.subpath === "string";
  }

  private getTargetFilePathFromViewStateArgs(args: unknown[]): string | null {
    const state = args[0] as {
      type?: unknown;
      state?: { file?: unknown };
    } | undefined;

    if (state?.type !== "markdown") {
      return null;
    }

    return typeof state.state?.file === "string" ? state.state.file : null;
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

      this.restorePendingDataIntoLeaf(leaf.view as unknown as TextFileView & { data?: string }, filePath);
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

    const shouldDiscardUnsavedChanges = targetWindow.confirm(
      "You have unsaved changes. Quit Obsidian and discard those changes?"
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

  private exitApplicationAfterFlush(): boolean {
    const globalState = window as typeof window & { require?: any };
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

  private getElectronBrowserWindow(targetWindow: Window): ElectronBrowserWindow | null {
    const globalState = targetWindow as typeof window & { require?: any };
    const electron = globalState.require?.("electron");
    const browserWindow = electron?.remote?.getCurrentWindow?.();
    if (!browserWindow || typeof browserWindow.on !== "function" || typeof browserWindow.removeListener !== "function") {
      return null;
    }

    return browserWindow as ElectronBrowserWindow;
  }

  private async handleWindowCloseRequest(): Promise<void> {
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
      this.isUnloading = true;
      this.clearQuitShortcutIntent();
      this.bypassNextWindowCloseInterception = true;
      if (!this.exitApplicationAfterFlush()) {
        this.bypassNextWindowCloseInterception = false;
        this.isUnloading = false;
      }
    } finally {
      this.isHandlingWindowCloseRequest = false;
    }
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

  private wrapSaveCommand(): void {
    const controller = this;
    const saveCommandDefinition = this.getSaveCommandDefinition();
    if (!saveCommandDefinition || typeof saveCommandDefinition.checkCallback !== "function") {
      return;
    }

    const checkCallback = this.unwrapWrappedFunction(saveCommandDefinition.checkCallback);
    this.originalSaveCommandCheckCallback = checkCallback;
    const wrappedCheckCallback = function (this: unknown, checking: boolean) {
      if (!checking) {
        controller.markActiveFileManualSaveRequested();
      }

      return checkCallback.call(this, checking);
    };

    this.installedSaveCommandCheckCallback = this.markWrappedFunction(wrappedCheckCallback, checkCallback);
    saveCommandDefinition.checkCallback = this.installedSaveCommandCheckCallback;
  }

  private wrapReloadWithoutSavingCommand(): void {
    const controller = this;
    const reloadWithoutSavingCommandDefinition = this.getReloadWithoutSavingCommandDefinition();
    if (!reloadWithoutSavingCommandDefinition || typeof reloadWithoutSavingCommandDefinition.callback !== "function") {
      return;
    }

    const callback = this.unwrapWrappedFunction(reloadWithoutSavingCommandDefinition.callback);
    this.originalReloadWithoutSavingCommandCallback = callback;
    const wrappedCallback = function (this: unknown, ...args: unknown[]) {
      controller.prepareForReloadWithoutSaving();
      return callback.apply(this, args);
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
