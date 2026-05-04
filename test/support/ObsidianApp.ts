import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $, browser } from "@wdio/globals";

const PLUGIN_ID = "autosave-control";
const SIMPLE_VAULT_PATH = "./test/vaults/simple";

type PluginSettings = {
  disableAutoSave?: boolean;
  saveDelaySeconds?: number;
  savedStatusColor?: string;
  pendingStatusColor?: string;
  statusIconSizePx?: number;
};

class ObsidianApp {
  async reloadWithFreshVault() {
    await browser.reloadObsidian({ vault: SIMPLE_VAULT_PATH });
    await this.closeModalIfPresent();
    await this.waitForWorkspaceReady();
    await this.enablePlugin();
    await this.waitForPluginReady();
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

  async disablePlugin() {
    await browser.execute(async (pluginId: string) => {
      const app = (window as typeof window & { app: any }).app;
      if (app?.plugins?.plugins?.[pluginId]) {
        await app.plugins.disablePlugin(pluginId);
      }
    }, PLUGIN_ID);
  }

  async reloadPlugin() {
    await this.disablePlugin();
    await browser.waitUntil(async () => {
      return browser.execute((pluginId: string) => {
        const app = (window as typeof window & { app: any }).app;
        return !app?.plugins?.plugins?.[pluginId];
      }, PLUGIN_ID);
    }, {
      timeout: 10000,
      timeoutMsg: `Plugin '${PLUGIN_ID}' did not unload in time.`,
    });

    await this.enablePlugin();
    await this.waitForPluginReady();
  }

  async clearPluginData() {
    const vaultBasePath = await this.getVaultBasePath();
    await fs.rm(path.join(vaultBasePath, ".obsidian", "plugins", PLUGIN_ID, "data.json"), { force: true });
  }

  async waitForPluginReady() {
    await browser.waitUntil(async () => {
      return browser.execute((pluginId: string) => {
        const app = (window as typeof window & { app: any }).app;
        return Boolean(app?.plugins?.plugins?.[pluginId]);
      }, PLUGIN_ID);
    }, {
      timeout: 15000,
      timeoutMsg: `Plugin '${PLUGIN_ID}' did not load in time.`,
    });
  }

  async closeModalIfPresent() {
    const closeButton = await $(".modal .modal-close-button");
    if (await closeButton.isExisting()) {
      await closeButton.click();
    }
  }

  async waitForWorkspaceReady() {
    await browser.waitUntil(async () => {
      return browser.execute(() => {
        const app = (window as typeof window & { app: any }).app;
        return Boolean(app?.workspace?.containerEl?.isConnected);
      });
    }, {
      timeout: 15000,
      timeoutMsg: "Obsidian workspace did not become ready in time.",
    });
  }

  async setPluginSettings(settings: PluginSettings) {
    await browser.execute(async (pluginId: string, nextSettings: PluginSettings) => {
      const app = (window as typeof window & { app: any }).app;
      const plugin = app.plugins.plugins[pluginId];

      Object.assign(plugin.settings, nextSettings);
      await plugin.saveSettings();

      if (
        typeof nextSettings.savedStatusColor === "string" ||
        typeof nextSettings.pendingStatusColor === "string"
      ) {
        plugin.applyStatusColors();
      }

      if (typeof nextSettings.statusIconSizePx === "number") {
        plugin.applyStatusIconSize();
      }
    }, PLUGIN_ID, settings);
  }

  async getPluginSettings(): Promise<Required<PluginSettings>> {
    return browser.execute((pluginId: string) => {
      const app = (window as typeof window & { app: any }).app;
      return { ...app.plugins.plugins[pluginId].settings };
    }, PLUGIN_ID);
  }

  async getPendingStatusCount() {
    return browser.execute((pluginId: string) => {
      const app = (window as typeof window & { app: any }).app;
      const plugin = app.plugins.plugins[pluginId] as { autosaveController?: { pendingSaveQueue?: { pendingSavesByPath?: Map<string, unknown> } } };
      return plugin.autosaveController?.pendingSaveQueue?.pendingSavesByPath?.size ?? 0;
    }, PLUGIN_ID);
  }

  async createAndOpenNote(notePath: string, initialContent = "", options: { preserveCursor?: boolean } = {}) {
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

    await this.waitForActiveFile(notePath);
    await this.focusEditor(options);
  }

  async openExistingNote(notePath: string, options: { preserveCursor?: boolean } = {}) {
    await browser.execute(async (nextNotePath: string) => {
      const app = (window as typeof window & { app: any }).app;
      const file = app.vault.getAbstractFileByPath(nextNotePath);

      if (!file) {
        throw new Error(`Note '${nextNotePath}' does not exist.`);
      }

      const leaf = app.workspace.getMostRecentLeaf() ?? app.workspace.getLeaf(true);
      await leaf.openFile(file);
    }, notePath);

    await this.waitForActiveFile(notePath);
    await this.focusEditor(options);
  }

  async clickSidebarNote(notePath: string, options: { preserveCursor?: boolean } = {}) {
    const folderParts = notePath.split("/").slice(0, -1);
    let currentFolderPath = "";

    for (const folderPart of folderParts) {
      currentFolderPath = currentFolderPath ? `${currentFolderPath}/${folderPart}` : folderPart;

      await browser.execute((targetFolderPath: string) => {
        const explorer = document.querySelector(".workspace-leaf-content[data-type='file-explorer']");
        if (!explorer) {
          throw new Error("File explorer was not found.");
        }

        const folderElement = explorer.querySelector(
          `.tree-item-self[data-path="${targetFolderPath}"], .nav-folder-title[data-path="${targetFolderPath}"]`
        ) as HTMLElement | null;
        if (!folderElement) {
          const availablePaths = Array.from(explorer.querySelectorAll("[data-path]"))
            .map((element) => element.getAttribute("data-path"))
            .filter((value): value is string => Boolean(value));
          throw new Error(
            `Sidebar folder '${targetFolderPath}' was not found. Visible paths: ${availablePaths.join(", ")}`
          );
        }

        const treeItem = folderElement.closest(".tree-item");
        if (treeItem?.classList.contains("is-collapsed")) {
          folderElement.click();
        }
      }, currentFolderPath);
    }

    await browser.waitUntil(async () => {
      return browser.execute((targetNotePath: string) => {
        const explorer = document.querySelector(".workspace-leaf-content[data-type='file-explorer']");
        if (!explorer) {
          return false;
        }

        return Boolean(
          explorer.querySelector(
            `.tree-item-self[data-path="${targetNotePath}"], .nav-file-title[data-path="${targetNotePath}"]`
          )
        );
      }, notePath);
    }, {
      timeout: 10000,
      timeoutMsg: `Sidebar note '${notePath}' did not appear in time.`,
    });

    await browser.execute((targetNotePath: string) => {
      const explorer = document.querySelector(".workspace-leaf-content[data-type='file-explorer']");
      if (!explorer) {
        throw new Error("File explorer was not found.");
      }

      const noteElement = explorer.querySelector(
        `.tree-item-self[data-path="${targetNotePath}"], .nav-file-title[data-path="${targetNotePath}"]`
      ) as HTMLElement | null;
      if (!noteElement) {
        throw new Error(`Sidebar note '${targetNotePath}' was not found.`);
      }

      noteElement.click();
    }, notePath);

    await this.waitForActiveFile(notePath);
    await this.focusEditor(options);
  }

  async openExistingNoteViaQuickSwitcher(notePath: string, options: { preserveCursor?: boolean; focusEditor?: boolean } = {}) {
    const noteQuery = path.posix.basename(notePath, ".md");

    await browser.execute(async () => {
      const app = (window as typeof window & { app: any }).app;
      const commands = app?.commands?.commands ?? {};
      const quickSwitcherCommandId = (
        ["switcher:open", "quick-switcher:open", "workspace:open-quick-switcher"].find((commandId) => commandId in commands)
        ?? Object.entries(commands).find(([, command]) => {
          const commandWithHotkeys = command as { hotkeys?: Array<{ modifiers?: string[]; key?: string }> };
          const hotkeys = Array.isArray(commandWithHotkeys.hotkeys)
            ? commandWithHotkeys.hotkeys
            : [];

          return hotkeys.some((hotkey) => {
            const modifiers = new Set(hotkey.modifiers ?? []);
            return modifiers.has("Mod") && String(hotkey.key ?? "").toLowerCase() === "o";
          });
        })?.[0]
      );

      if (!quickSwitcherCommandId) {
        throw new Error("Quick switcher command was not found.");
      }

      app.commands.executeCommandById(quickSwitcherCommandId);
    });

    await browser.waitUntil(async () => {
      return browser.execute(() => {
        const input = document.querySelector(".prompt-input, .modal input[type='text'], .modal input") as HTMLElement | null;
        return Boolean(input);
      });
    }, {
      timeout: 10000,
      timeoutMsg: "Quick switcher input did not appear in time.",
    });

    const quickSwitcherInput = await $(".prompt-input, .modal input[type='text'], .modal input");
    await quickSwitcherInput.waitForExist({ timeout: 10000 });
    await quickSwitcherInput.click();
    await browser.keys(Array.from(noteQuery));

    await browser.waitUntil(async () => {
      return browser.execute((expectedPath: string, expectedQuery: string) => {
        const items = Array.from(document.querySelectorAll(".suggestion-item"));
        return items.some((item) => {
          const text = item.textContent?.toLowerCase() ?? "";
          return text.includes(expectedPath.toLowerCase()) || text.includes(expectedQuery.toLowerCase());
        });
      }, notePath, noteQuery);
    }, {
      timeout: 10000,
      timeoutMsg: `Quick switcher did not list note '${notePath}' in time.`,
    });

    await browser.keys(["Enter"]);
    await browser.waitUntil(async () => {
      return browser.execute(() => {
        const input = document.querySelector(".prompt-input, .modal input[type='text'], .modal input");
        return !input;
      });
    }, {
      timeout: 10000,
      timeoutMsg: "Quick switcher modal did not close in time.",
    });

    await this.waitForActiveFile(notePath);
    if (options.focusEditor !== false) {
      await this.focusEditor(options);
    }
  }

  async waitForActiveFile(notePath: string) {
    await browser.waitUntil(async () => {
      return browser.execute((expectedPath: string) => {
        const app = (window as typeof window & { app: any }).app;
        return app.workspace.getActiveFile()?.path === expectedPath;
      }, notePath);
    }, {
      timeout: 10000,
      timeoutMsg: `Note '${notePath}' did not become active in time.`,
    });
  }

  async focusEditor(options: { preserveCursor?: boolean } = {}) {
    const editor = await $(".workspace-leaf.mod-active .cm-content");
    await editor.waitForExist({ timeout: 10000 });
    await browser.execute((preserveCursor: boolean) => {
      const app = (window as typeof window & { app: any }).app;
      const editorInstance = app.workspace.activeLeaf?.view?.editor;
      window.focus();
      editorInstance?.focus?.();

      if (preserveCursor || !editorInstance) {
        return;
      }

      const value = editorInstance.getValue?.() ?? "";
      const lines = value.split("\n");
      const lastLineIndex = Math.max(lines.length - 1, 0);
      const lastLine = lines[lastLineIndex] ?? "";
      editorInstance.setCursor?.({ line: lastLineIndex, ch: lastLine.length });
    }, options.preserveCursor ?? false);
  }

  async typeText(text: string) {
    await this.focusEditor();
    await browser.keys(Array.from(text));
  }

  async pressKey(key: string, count = 1) {
    await this.focusEditor();
    for (let i = 0; i < count; i += 1) {
      await browser.keys([key]);
    }
  }

  async moveCursorToStart() {
    await browser.execute(() => {
      const app = (window as typeof window & { app: any }).app;
      const view = app.workspace.activeLeaf?.view;
      view?.editor?.setCursor?.({ line: 0, ch: 0 });
    });
  }

  async setCursor(line: number, ch: number) {
    await browser.execute((nextLine: number, nextCh: number) => {
      const app = (window as typeof window & { app: any }).app;
      const view = app.workspace.activeLeaf?.view;
      view?.editor?.setCursor?.({ line: nextLine, ch: nextCh });
    }, line, ch);
  }

  async getCursor() {
    return browser.execute(() => {
      const app = (window as typeof window & { app: any }).app;
      const view = app.workspace.activeLeaf?.view;
      const cursor = view?.editor?.getCursor?.();
      return cursor ? { line: cursor.line, ch: cursor.ch } : null;
    });
  }

  async selectAllEditorContent() {
    await browser.execute(() => {
      const app = (window as typeof window & { app: any }).app;
      const view = app.workspace.activeLeaf?.view;
      const editor = view?.editor;
      const value = editor?.getValue?.() ?? "";
      const lines = value.split("\n");
      const lastLine = lines[lines.length - 1] ?? "";
      editor?.setSelection?.({ line: 0, ch: 0 }, { line: lines.length - 1, ch: lastLine.length });
    });
  }

  async pasteText(text: string) {
    await browser.execute((nextText: string) => {
      const app = (window as typeof window & { app: any }).app;
      const view = app.workspace.activeLeaf?.view;
      window.dispatchEvent(new Event("paste", { bubbles: true, cancelable: true }));
      view?.editor?.replaceSelection?.(nextText);
    }, text);
  }

  async deleteFromStart(count = 1) {
    await browser.execute((nextCount: number) => {
      const app = (window as typeof window & { app: any }).app;
      const view = app.workspace.activeLeaf?.view;
      const editor = view?.editor;
      if (!editor) {
        throw new Error("Active editor not found.");
      }

      for (let i = 0; i < nextCount; i += 1) {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }));
        const currentValue = editor.getValue();
        editor.setValue(currentValue.slice(1));
      }
    }, count);
  }

  async cutSelection() {
    await browser.execute(() => {
      const app = (window as typeof window & { app: any }).app;
      const view = app.workspace.activeLeaf?.view;
      window.dispatchEvent(new Event("cut", { bubbles: true, cancelable: true }));
      view?.editor?.replaceSelection?.("");
    });
  }

  async runSaveCommand() {
    await browser.executeObsidianCommand("editor:save-file");
  }

  async runActiveViewSave() {
    await browser.execute(async () => {
      const app = (window as typeof window & { app: any }).app;
      const view = app.workspace.activeLeaf?.view;
      await view?.save?.();
    });
  }

  async getActiveFilePath() {
    return browser.execute(() => {
      const app = (window as typeof window & { app: any }).app;
      return app.workspace.getActiveFile()?.path ?? null;
    });
  }

  async getActiveEditorContent() {
    return browser.execute(() => {
      const app = (window as typeof window & { app: any }).app;
      const view = app.workspace.activeLeaf?.view;
      return view?.editor?.getValue?.() ?? null;
    });
  }

  async getVaultBasePath() {
    return browser.execute(() => {
      const app = (window as typeof window & { app: any }).app;
      return app.vault.adapter.basePath as string;
    });
  }

  async getRendererPid() {
    return browser.execute(() => process.pid);
  }

  async getAppProcessPid() {
    return browser.execute(() => {
      const electron = (window as typeof window & { require?: any }).require?.("electron");
      return electron?.remote?.process?.pid ?? process.ppid ?? process.pid;
    });
  }

  async quitApp() {
    await browser.execute(() => {
      const app = (window as typeof window & { app: any; require?: any }).app;
      const electron = (window as typeof window & { require?: any }).require?.("electron");

      try {
        window.close();
      } catch {
        // ignore and continue to stronger quit paths below
      }

      try {
        electron?.remote?.app?.quit?.();
      } catch {
        // ignore and continue
      }

      try {
        electron?.ipcRenderer?.send?.("app:quit");
      } catch {
        // ignore and continue
      }

      app?.commands?.executeCommandById?.("app:quit");
    });
  }

  async readVaultFile(notePath: string) {
    const vaultBasePath = await this.getVaultBasePath();
    return fs.readFile(path.join(vaultBasePath, notePath), "utf8");
  }

  async getVaultFileMtimeMs(notePath: string) {
    const vaultBasePath = await this.getVaultBasePath();
    const stats = await fs.stat(path.join(vaultBasePath, notePath));
    return stats.mtimeMs;
  }

  async getWorkspaceFileMtimeMs() {
    const vaultBasePath = await this.getVaultBasePath();
    const obsidianConfigPath = path.join(vaultBasePath, ".obsidian");
    const workspaceFileName = (await fs.readdir(obsidianConfigPath))
      .find((fileName) => /^workspace.*\.json$/u.test(fileName));

    if (!workspaceFileName) {
      return null;
    }

    const stats = await fs.stat(path.join(obsidianConfigPath, workspaceFileName));
    return stats.mtimeMs;
  }

  async waitForWorkspaceFileMtimeChange(previousMtimeMs: number | null, timeout = 10000) {
    await browser.waitUntil(async () => {
      try {
        const currentMtimeMs = await this.getWorkspaceFileMtimeMs();
        if (currentMtimeMs === null) {
          return false;
        }

        return previousMtimeMs === null || currentMtimeMs > previousMtimeMs;
      } catch {
        return false;
      }
    }, {
      timeout,
      interval: 200,
      timeoutMsg: ".obsidian/workspace*.json did not change in time.",
    });
  }

  async waitForVaultFileContent(notePath: string, expectedContent: string, timeout = 10000) {
    await browser.waitUntil(async () => {
      try {
        const fileContent = await this.readVaultFile(notePath);
        return fileContent === expectedContent;
      } catch {
        return false;
      }
    }, {
      timeout,
      interval: 200,
      timeoutMsg: `Vault file '${notePath}' did not match expected content in time.`,
    });
  }

  async waitForPendingStatus() {
    const statusIndicator = await $(".save-status-icon");
    await browser.waitUntil(async () => {
      return (await statusIndicator.getAttribute("class"))?.includes("asc-pending") ?? false;
    }, {
      timeout: 5000,
      timeoutMsg: "Pending status indicator did not appear in time.",
    });
  }

  async waitForSavedStatus() {
    const statusIndicator = await $(".save-status-icon");
    await browser.waitUntil(async () => {
      return (await statusIndicator.getAttribute("class"))?.includes("asc-saved") ?? false;
    }, {
      timeout: 10000,
      timeoutMsg: "Saved status indicator did not appear in time.",
    });
  }

  async getStatusIndicatorTitle() {
    const statusIndicator = await $(".save-status-icon");
    await statusIndicator.waitForExist({ timeout: 10000 });
    return statusIndicator.getAttribute("title");
  }

  async getStatusIndicatorCount() {
    return browser.execute(() => document.querySelectorAll(".save-status-icon").length);
  }

  async getStatusIndicatorColor() {
    return browser.execute(() => {
      const element = document.querySelector(".save-status-icon") as HTMLElement | null;
      return element ? getComputedStyle(element).color : null;
    });
  }

  async openPluginSettingsTab() {
    await browser.execute((pluginId: string) => {
      const app = (window as typeof window & { app: any }).app;
      app.setting.open();
      app.setting.openTabById(pluginId);
    }, PLUGIN_ID);

    await browser.waitUntil(async () => {
      return browser.execute(() => {
        const names = Array.from(document.querySelectorAll(".setting-item-name"));
        return names.some((element) => element.textContent?.trim() === "Disable autosave completely");
      });
    }, {
      timeout: 10000,
      timeoutMsg: "Plugin settings tab did not render in time.",
    });
  }

  async getSettingDescription(settingName: string) {
    return browser.execute((targetSettingName: string) => {
      const items = Array.from(document.querySelectorAll(".setting-item"));
      const target = items.find((item) => {
        const label = item.querySelector(".setting-item-name");
        return label?.textContent?.trim() === targetSettingName;
      });
      return target?.querySelector(".setting-item-description")?.textContent?.trim() ?? null;
    }, settingName);
  }

  async setTextSettingValue(settingName: string, value: string) {
    await browser.execute((targetSettingName: string, nextValue: string) => {
      const items = Array.from(document.querySelectorAll(".setting-item"));
      const target = items.find((item) => {
        const label = item.querySelector(".setting-item-name");
        return label?.textContent?.trim() === targetSettingName;
      });
      const input = target?.querySelector("input:not([type='checkbox']):not([type='color'])") as HTMLInputElement | null;
      if (!input) {
        throw new Error(`Text input for setting '${targetSettingName}' not found.`);
      }

      input.value = nextValue;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.blur();
    }, settingName, value);
    await browser.pause(200);
  }

  async setColorSettingValue(settingName: string, value: string) {
    await browser.execute((targetSettingName: string, nextValue: string) => {
      const items = Array.from(document.querySelectorAll(".setting-item"));
      const target = items.find((item) => {
        const label = item.querySelector(".setting-item-name");
        return label?.textContent?.trim() === targetSettingName;
      });
      const input = target?.querySelector("input[type='color'], input:not([type='checkbox'])") as HTMLInputElement | null;
      if (!input) {
        throw new Error(`Color input for setting '${targetSettingName}' not found.`);
      }

      input.value = nextValue;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.blur();
    }, settingName, value);
    await browser.pause(200);
  }

  async toggleDisableAutosaveSetting() {
    await browser.execute(() => {
      const items = Array.from(document.querySelectorAll(".setting-item"));
      const target = items.find((item) => {
        const label = item.querySelector(".setting-item-name");
        return label?.textContent?.trim() === "Disable autosave completely";
      });

      const checkbox = target?.querySelector("input[type='checkbox']") as HTMLInputElement | null;
      if (!checkbox) {
        throw new Error("Disable autosave toggle not found.");
      }

      checkbox.click();
    });
  }

  async isSaveDelaySettingVisible() {
    return browser.execute(() => {
      const labels = Array.from(document.querySelectorAll(".setting-item-name"));
      return labels.some((label) => label.textContent?.trim() === "Save delay (seconds)");
    });
  }

  async getMainWindowHandle() {
    const handles = await browser.getWindowHandles();
    return handles[0] ?? null;
  }

  async openNoteInNewWindow(notePath: string, initialContent = "") {
    const existingHandles = await browser.getWindowHandles();

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

      const leaf = app.workspace.getLeaf("window");
      await leaf.openFile(file);
    }, notePath, initialContent);

    await browser.waitUntil(async () => {
      const handles = await browser.getWindowHandles();
      return handles.length > existingHandles.length;
    }, {
      timeout: 15000,
      timeoutMsg: "Popup window did not open in time.",
    });

    const updatedHandles = await browser.getWindowHandles();
    const popupHandle = updatedHandles.find((handle) => !existingHandles.includes(handle));
    if (!popupHandle) {
      throw new Error("Failed to identify popup window handle.");
    }

    await browser.switchToWindow(popupHandle);
    await this.waitForWorkspaceReady();
    await this.waitForActiveFile(notePath);
    await this.focusEditor();
    return popupHandle;
  }

  async openNoteInNewTab(notePath: string, initialContent = "") {
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

      const leaf = app.workspace.getLeaf("tab");
      await leaf.openFile(file);
    }, notePath, initialContent);

    await this.waitForActiveFile(notePath);
    await this.focusEditor();
  }

  async switchToWindow(handle: string) {
    await browser.switchToWindow(handle);
    await this.waitForWorkspaceReady();
  }

  async focusWindow() {
    await browser.execute(() => {
      window.focus();
    });
  }

  async closeActiveTab() {
    await browser.execute(() => {
      const app = (window as typeof window & { app: any }).app;
      app.workspace.activeLeaf?.detach?.();
    });
  }

  async triggerWindowBlur() {
    await browser.execute(() => {
      window.dispatchEvent(new FocusEvent("blur", { bubbles: true, cancelable: true }));
    });
  }

  async dispatchBeforeUnload() {
    return browser.execute(() => {
      const event = new Event("beforeunload", { cancelable: true }) as BeforeUnloadEvent;
      const dispatchResult = window.dispatchEvent(event);
      return {
        defaultPrevented: event.defaultPrevented,
        dispatchResult,
        returnValue: String(event.returnValue ?? ""),
      };
    });
  }

  async installConfirmStub(response: boolean) {
    await browser.execute((nextResponse: boolean) => {
      const targetWindow = window as typeof window & {
        __ascOriginalConfirm?: typeof window.confirm;
        __ascConfirmMessages?: string[];
      };

      if (!targetWindow.__ascOriginalConfirm) {
        targetWindow.__ascOriginalConfirm = targetWindow.confirm.bind(targetWindow);
      }

      targetWindow.__ascConfirmMessages = [];
      targetWindow.confirm = (message?: string) => {
        targetWindow.__ascConfirmMessages?.push(String(message ?? ""));
        return nextResponse;
      };
    }, response);
  }

  async getConfirmMessages() {
    return browser.execute(() => {
      const targetWindow = window as typeof window & { __ascConfirmMessages?: string[] };
      return [...(targetWindow.__ascConfirmMessages ?? [])];
    });
  }

  async restoreConfirm() {
    await browser.execute(() => {
      const targetWindow = window as typeof window & {
        __ascOriginalConfirm?: typeof window.confirm;
        __ascConfirmMessages?: string[];
      };

      if (targetWindow.__ascOriginalConfirm) {
        targetWindow.confirm = targetWindow.__ascOriginalConfirm;
        delete targetWindow.__ascOriginalConfirm;
      }

      delete targetWindow.__ascConfirmMessages;
    });
  }

  async triggerQuitShortcut() {
    await browser.execute(() => {
      const event = new KeyboardEvent("keydown", {
        key: "q",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(event);
    });
  }
}

export default new ObsidianApp();
