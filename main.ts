import { App, Plugin, TFile, MarkdownView, PluginSettingTab, Setting } from 'obsidian';

interface CustomFileLockSettings {
  saveInterval: number;
}

const DEFAULT_SETTINGS: CustomFileLockSettings = {
  saveInterval: 10, // default to 10 seconds
};

export default class CustomFileLockPlugin extends Plugin {
  settings: CustomFileLockSettings;
  originalVaultModify: (file: TFile, data: string) => Promise<void>;
  lockedFiles: Map<string, { file: TFile; content: string; timeoutId: number }> = new Map();
  isManualSave: boolean = false;

  async onload() {
    console.log("Plugin loaded.");

    // Load settings
    await this.loadSettings();

    // Add settings tab
    this.addSettingTab(new CustomFileLockSettingTab(this.app, this));

    // Save the original 'modify' method
    this.originalVaultModify = this.app.vault.modify.bind(this.app.vault);

    // Override 'modify' method
    this.app.vault.modify = async (file: TFile, data: string): Promise<void> => {
      const filePath = file.path;
      if (this.lockedFiles.has(filePath)) {
        console.log(`Preventing modification of locked file: ${filePath}`);
        // Do nothing, simulate successful modification
        return;
      } else {
        // Call the original 'modify' method
        return await this.originalVaultModify(file, data);
      }
    };

    // Listen for file modifications
    this.registerEvent(this.app.vault.on('modify', (file: TFile) => {
      (async () => {
        if (this.isManualSave) {
          this.isManualSave = false;
          return;
        }

        console.log(`File ${file.name} is being modified.`);

        const filePath = file.path;

        if (this.lockedFiles.has(filePath)) {
          // Reset the timeout
          const lockedFile = this.lockedFiles.get(filePath);
          if (lockedFile) {
            clearTimeout(lockedFile.timeoutId);
            // Set new timeout
            lockedFile.timeoutId = window.setTimeout(() => {
              this.unlockAndSaveFile(filePath);
            }, this.settings.saveInterval * 1000);
          }
        } else {
          // Lock the file
          const timeoutId = window.setTimeout(() => {
            this.unlockAndSaveFile(filePath);
          }, this.settings.saveInterval * 1000);

          // Initialize content
          try {
            const content = await this.getFileContent(file);
            // Add to lockedFiles
            this.lockedFiles.set(filePath, { file, content, timeoutId });
          } catch (err) {
            console.error(`Failed to get content for file: ${filePath}`, err);
          }
        }
      })();
    }));

    // Update content periodically
    this.registerInterval(window.setInterval(() => this.updateContent(), 1000));
  }

  async getFileContent(file: TFile): Promise<string> {
    const filePath = file.path;
    const leaves = this.app.workspace.getLeavesOfType('markdown');
    for (const leaf of leaves) {
      const view = leaf.view as MarkdownView;
      if (view && view.file && view.file.path === filePath) {
        return view.editor.getValue();
      }
    }
    // If not open in an editor, read from cache
    return await this.app.vault.cachedRead(file);
  }

  async updateContent() {
    const leaves = this.app.workspace.getLeavesOfType('markdown');
    for (const leaf of leaves) {
      const view = leaf.view as MarkdownView;
      if (view && view.file) {
        const filePath = view.file.path;
        if (this.lockedFiles.has(filePath)) {
          const lockedFile = this.lockedFiles.get(filePath);
          if (lockedFile) {
            lockedFile.content = view.editor.getValue();
          }
        }
      }
    }
  }

  async unlockAndSaveFile(filePath: string) {
    const lockedFile = this.lockedFiles.get(filePath);
    if (!lockedFile) {
      console.error(`No locked file to unlock and save for path: ${filePath}`);
      return;
    }

    // Clear the timeout
    clearTimeout(lockedFile.timeoutId);

    // Remove from lockedFiles
    this.lockedFiles.delete(filePath);

    // Flag as manual save to prevent recursion
    this.isManualSave = true;

    // Now save the file
    const content = lockedFile.content;
    try {
      await this.originalVaultModify(lockedFile.file, content);
      console.log(`Saved file: ${filePath}`);
    } catch (err) {
      console.error(`Failed to save file: ${filePath}`, err);
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  updateTimeouts() {
    this.lockedFiles.forEach((lockedFile, filePath) => {
      clearTimeout(lockedFile.timeoutId);
      // Set new timeout
      lockedFile.timeoutId = window.setTimeout(() => {
        this.unlockAndSaveFile(filePath);
      }, this.settings.saveInterval * 1000);
    });
  }

  onunload() {
    console.log("Plugin unloaded.");

    // Restore the original 'modify' method
    this.app.vault.modify = this.originalVaultModify;

    // Clear all timeouts
    this.lockedFiles.forEach((lockedFile) => {
      clearTimeout(lockedFile.timeoutId);
    });
  }
}

class CustomFileLockSettingTab extends PluginSettingTab {
  plugin: CustomFileLockPlugin;

  constructor(app: App, plugin: CustomFileLockPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();

    containerEl.createEl('h2', { text: 'Custom File Lock Settings' });

    new Setting(containerEl)
      .setName('Save Interval')
      .setDesc('The period (in seconds) during which file changes are kept in memory before being saved to disk. Must be between 1 and 3600 seconds.')
      .addText(text => text
        .setPlaceholder('Enter save interval in seconds')
        .setValue(this.plugin.settings.saveInterval.toString())
        .onChange(async (value) => {
          let newValue = parseInt(value);
          if (isNaN(newValue)) {
            newValue = DEFAULT_SETTINGS.saveInterval;
          }
          if (newValue < 1) newValue = 1;
          if (newValue > 3600) newValue = 3600;
          this.plugin.settings.saveInterval = newValue;
          console.log(`Save interval set to: ${newValue} seconds`);

          // Save the settings
          await this.plugin.saveSettings();

          // Update existing timeouts to use new interval
          this.plugin.updateTimeouts();
        }));
  }
}
