import { browser } from "@wdio/globals";

const PLUGIN_ID = "autosave-control";
const SIMPLE_VAULT_PATH = "./test/vaults/simple";

type RuntimeSnapshot = {
  activeFilePath: string | null;
  configDir: string | null;
  isMobile: boolean;
  pendingSaveCount: number;
  pluginLoaded: boolean;
  workspaceReady: boolean;
};

type PluginSettings = {
  disableAutoSave?: boolean;
  saveDelaySeconds?: number;
  deferWorkspaceLayoutSaves?: boolean;
  workspaceLayoutSaveDelaySeconds?: number;
  savedStatusColor?: string;
  pendingStatusColor?: string;
  statusIconSizePx?: number;
};

class AndroidObsidianApp {
  async prepareCurrentSession() {
    await this.switchToObsidianWebView();
    await this.waitForWorkspaceReady();
    await this.enablePlugin();
    await this.waitForPluginReady();
  }

  async reloadWithFreshVault() {
    await browser.reloadObsidian({ vault: SIMPLE_VAULT_PATH });
    await this.prepareCurrentSession();
  }

  async switchToObsidianWebView() {
    await browser.waitUntil(async () => {
      const contexts = await this.getContexts();
      return contexts.some((context) => this.getContextName(context).includes("WEBVIEW"));
    }, {
      timeout: 30000,
      timeoutMsg: "Obsidian WEBVIEW context did not become available in time.",
    });

    const contexts = await this.getContexts();
    const webViewContext = contexts.find((context) => this.getContextName(context).includes("WEBVIEW"));
    if (!webViewContext) {
      throw new Error("Obsidian WEBVIEW context was not found.");
    }

    await browser.switchContext(this.getContextName(webViewContext));
  }

  async waitForWorkspaceReady() {
    await browser.waitUntil(async () => {
      return browser.execute(() => {
        const app = (window as typeof window & { app?: any }).app;
        return Boolean(app?.workspace?.containerEl?.isConnected);
      });
    }, {
      timeout: 30000,
      timeoutMsg: "Obsidian workspace did not become ready on Android in time.",
    });
  }

  async enablePlugin() {
    await browser.execute(async (pluginId: string) => {
      const app = (window as typeof window & { app: any }).app;

      if (!app?.plugins?.plugins?.[pluginId]) {
        app.plugins.setEnable(true);
        await app.plugins.enablePlugin(pluginId);
      }
    }, PLUGIN_ID);
  }

  async waitForPluginReady() {
    await browser.waitUntil(async () => {
      return browser.execute((pluginId: string) => {
        const app = (window as typeof window & { app: any }).app;
        return Boolean(app?.plugins?.plugins?.[pluginId]);
      }, PLUGIN_ID);
    }, {
      timeout: 30000,
      timeoutMsg: `Plugin '${PLUGIN_ID}' did not load on Android in time.`,
    });
  }

  async createAndOpenNote(notePath: string, initialContent = "") {
    await browser.execute(async (nextNotePath: string, nextInitialContent: string) => {
      const app = (window as typeof window & { app: any }).app;
      const parentPath = nextNotePath.includes("/") ? nextNotePath.split("/").slice(0, -1).join("/") : "";

      if (parentPath && !app.vault.getAbstractFileByPath(parentPath)) {
        await app.vault.createFolder(parentPath);
      }

      let file = app.vault.getAbstractFileByPath(nextNotePath);
      if (!file) {
        file = await app.vault.create(nextNotePath, nextInitialContent);
      } else {
        await app.vault.modify(file, nextInitialContent);
      }

      const leaf = app.workspace.getMostRecentLeaf() ?? app.workspace.getLeaf(true);
      await leaf.openFile(file);
    }, notePath, initialContent);

    await browser.waitUntil(async () => {
      return (await this.getRuntimeSnapshot()).activeFilePath === notePath;
    }, {
      timeout: 15000,
      timeoutMsg: `Android note '${notePath}' did not become active in time.`,
    });
  }

  async getPluginSettings() {
    return browser.execute((pluginId: string) => {
      const app = (window as typeof window & { app: any }).app;
      return { ...app.plugins.plugins[pluginId].settings };
    }, PLUGIN_ID);
  }

  async setPluginSettings(settings: PluginSettings) {
    await browser.execute(async (pluginId: string, nextSettings: PluginSettings) => {
      const app = (window as typeof window & { app: any }).app;
      const plugin = app.plugins.plugins[pluginId];

      Object.assign(plugin.settings, nextSettings);
      await plugin.saveSettings();

      if (
        typeof nextSettings.savedStatusColor === "string"
        || typeof nextSettings.pendingStatusColor === "string"
      ) {
        plugin.applyStatusColors();
      }

      if (typeof nextSettings.statusIconSizePx === "number") {
        plugin.applyStatusIconSize();
      }
    }, PLUGIN_ID, settings);
  }

  async getPendingStatusCount() {
    return (await this.getRuntimeSnapshot()).pendingSaveCount;
  }

  async waitForPendingCount(expectedCount: number) {
    await browser.waitUntil(async () => {
      return (await this.getPendingStatusCount()) === expectedCount;
    }, {
      timeout: 10000,
      timeoutMsg: `Pending save count did not become ${expectedCount} on Android in time.`,
    });
  }

  /**
   * Edit the active note through the editor API (not vault.modify, which writes
   * straight to disk). This dirties the view exactly like a user keystroke would
   * and drives the plugin's held requestSave path — keystroke synthesis is
   * unreliable on the emulator, so we change the value programmatically and then
   * request a save explicitly.
   */
  async editActiveNoteContent(content: string) {
    await browser.execute((nextContent: string) => {
      const app = (window as typeof window & { app: any }).app;
      const view = app.workspace.activeLeaf?.view;
      const editor = view?.editor;
      if (!editor) {
        throw new Error("No active editor is available to edit on Android.");
      }

      editor.setValue(nextContent);
      if (typeof view.requestSave === "function") {
        view.requestSave();
      }
    }, content);
  }

  /** Read a note straight from disk via the vault adapter (works inside the emulator). */
  async readNoteFromDisk(notePath: string): Promise<string> {
    return browser.execute(async (path: string) => {
      const app = (window as typeof window & { app: any }).app;
      return app.vault.adapter.read(path) as Promise<string>;
    }, notePath);
  }

  async waitForDiskContent(notePath: string, expectedContent: string, timeout = 10000) {
    await browser.waitUntil(async () => {
      return (await this.readNoteFromDisk(notePath)) === expectedContent;
    }, {
      timeout,
      timeoutMsg: `Disk content of '${notePath}' did not become the expected value on Android in time.`,
    });
  }

  /**
   * Simulate the app being minimized/backgrounded by forcing
   * document.visibilityState to "hidden" and firing visibilitychange — the same
   * signal the OS sends when the user leaves Obsidian. The handler reads
   * visibilityState synchronously during dispatch, so we restore it right after.
   */
  async simulateAppBackgrounded() {
    await browser.execute(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
      delete (document as unknown as { visibilityState?: unknown }).visibilityState;
    });
  }

  async getRuntimeSnapshot(): Promise<RuntimeSnapshot> {
    return browser.execute((pluginId: string) => {
      const app = (window as typeof window & { app?: any }).app;
      const plugin = app?.plugins?.plugins?.[pluginId] as {
        autosaveController?: { pendingSaveQueue?: { pendingSavesByPath?: Map<string, unknown> } };
      } | undefined;

      return {
        activeFilePath: app?.workspace?.getActiveFile?.()?.path ?? null,
        configDir: app?.vault?.configDir ?? null,
        isMobile: Boolean(app?.isMobile),
        pendingSaveCount: plugin?.autosaveController?.pendingSaveQueue?.pendingSavesByPath?.size ?? 0,
        pluginLoaded: Boolean(plugin),
        workspaceReady: Boolean(app?.workspace?.containerEl?.isConnected),
      };
    }, PLUGIN_ID);
  }

  private getContextName(context: string | { id?: string | null }) {
    if (typeof context === "string") {
      return context;
    }

    return String(context.id ?? "");
  }

  private async getContexts(): Promise<Array<string | { id?: string | null }>> {
    return (await browser.getContexts()) as Array<string | { id?: string | null }>;
  }
}

export default new AndroidObsidianApp();
