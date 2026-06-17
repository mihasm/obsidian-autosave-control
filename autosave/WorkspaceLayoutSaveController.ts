import { App } from "obsidian";
import { dlog } from "../debug";

type AdapterWriteFn = (normalizedPath: string, data: string, options?: unknown) => Promise<void>;
type WrappedWriteMetadata<T> = { __ascOriginal?: T };

type PendingWorkspaceWrite = {
  normalizedPath: string;
  data: string;
  options?: unknown;
};

function callAdapterWrite(
  fn: AdapterWriteFn,
  thisArg: unknown,
  normalizedPath: string,
  data: string,
  options?: unknown,
): Promise<void> {
  const boundFn: (normalizedPath: string, data: string, options?: unknown) => Promise<void> = fn.bind(thisArg);
  return boundFn(normalizedPath, data, options);
}

export class WorkspaceLayoutSaveController {
  private originalAdapterWrite: AdapterWriteFn | null = null;
  private installedAdapterWriteWrapper: AdapterWriteFn | null = null;
  private flushTimeoutId: number | null = null;
  private pendingWrite: PendingWorkspaceWrite | null = null;
  private allowImmediateWrite = false;

  constructor(
    private readonly app: App,
    private readonly isEnabled: () => boolean,
    private readonly getDelaySeconds: () => number,
  ) {}

  enable() {
    const adapterWithWrite = this.app.vault.adapter as typeof this.app.vault.adapter & { write?: AdapterWriteFn };
    if (typeof adapterWithWrite.write !== "function") {
      return;
    }

    this.originalAdapterWrite = this.unwrapWrappedFunction(adapterWithWrite.write);
    this.installedAdapterWriteWrapper = this.createAdapterWriteWrapper(this.originalAdapterWrite);
    adapterWithWrite.write = this.installedAdapterWriteWrapper;
  }

  disable() {
    const adapterWithWrite = this.app.vault.adapter as typeof this.app.vault.adapter & { write?: AdapterWriteFn };
    if (this.originalAdapterWrite && adapterWithWrite.write === this.installedAdapterWriteWrapper) {
      adapterWithWrite.write = this.originalAdapterWrite;
    }

    this.originalAdapterWrite = null;
    this.installedAdapterWriteWrapper = null;
    this.cancel();
  }

  refreshScheduling() {
    if (!this.pendingWrite) {
      return;
    }

    if (!this.isEnabled()) {
      void this.flush();
      return;
    }

    this.schedule();
  }

  hasPending(): boolean {
    return this.pendingWrite !== null;
  }

  schedule() {
    if (!this.pendingWrite) {
      return;
    }

    if (!this.isEnabled()) {
      void this.flush();
      return;
    }

    if (this.flushTimeoutId !== null) {
      window.clearTimeout(this.flushTimeoutId);
    }

    this.flushTimeoutId = window.setTimeout(() => {
      void this.flush();
    }, this.getDelaySeconds() * 1000);
  }

  cancel() {
    if (this.flushTimeoutId !== null) {
      window.clearTimeout(this.flushTimeoutId);
      this.flushTimeoutId = null;
    }

    this.pendingWrite = null;
  }

  async flush() {
    if (!this.pendingWrite || !this.originalAdapterWrite) {
      return;
    }

    const pendingWrite = this.pendingWrite;
    this.pendingWrite = null;

    if (this.flushTimeoutId !== null) {
      window.clearTimeout(this.flushTimeoutId);
      this.flushTimeoutId = null;
    }

    this.allowImmediateWrite = true;
    try {
      await callAdapterWrite(
        this.originalAdapterWrite,
        this.app.vault.adapter,
        pendingWrite.normalizedPath,
        pendingWrite.data,
        pendingWrite.options,
      );
      dlog("Workspace layout flushed", pendingWrite.normalizedPath);
    } finally {
      this.allowImmediateWrite = false;
    }
  }

  private createAdapterWriteWrapper(originalAdapterWrite: AdapterWriteFn): AdapterWriteFn {
    const isEnabled = this.isEnabled;
    const isWorkspaceLayoutPath = (normalizedPath: string) => this.isWorkspaceLayoutPath(normalizedPath);
    const schedule = () => this.schedule();
    const allowImmediateWrite = () => this.allowImmediateWrite;
    const setPendingWrite = (pendingWrite: PendingWorkspaceWrite) => {
      this.pendingWrite = pendingWrite;
    };

    const wrappedAdapterWrite = async function wrappedAdapterWrite(
      this: unknown,
      normalizedPath: string,
      data: string,
      options?: unknown,
    ) {
      if (
        allowImmediateWrite() ||
        !isEnabled() ||
        !isWorkspaceLayoutPath(normalizedPath)
      ) {
        await callAdapterWrite(originalAdapterWrite, this, normalizedPath, data, options);
        return;
      }

      setPendingWrite({ normalizedPath, data, options });
      schedule();
      dlog("Deferred workspace layout write", normalizedPath);
    };

    return this.markWrappedFunction(wrappedAdapterWrite, originalAdapterWrite);
  }

  private isWorkspaceLayoutPath(normalizedPath: string): boolean {
    const normalizedConfigDirPath = `${this.app.vault.configDir}/`;
    const candidatePath = normalizedPath.replace(/\\/gu, "/");
    return candidatePath === "workspace.json"
      || candidatePath === "workspace-mobile.json"
      || candidatePath === `${normalizedConfigDirPath}workspace.json`
      || candidatePath === `${normalizedConfigDirPath}workspace-mobile.json`
      || candidatePath.endsWith("/workspace.json")
      || candidatePath.endsWith("/workspace-mobile.json");
  }

  private markWrappedFunction<T>(wrapper: T, original: T): T {
    const wrappedFunction = wrapper as T & WrappedWriteMetadata<T>;
    wrappedFunction.__ascOriginal = original;
    return wrapper;
  }

  private unwrapWrappedFunction<T>(fn: T): T {
    return (fn as T & WrappedWriteMetadata<T>).__ascOriginal ?? fn;
  }
}
