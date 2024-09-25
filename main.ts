import { App, Plugin, TFile, MarkdownView, PluginSettingTab, Setting } from 'obsidian';

interface ObsidianAutosaveControlSettings {
  saveInterval: number;
}

const DEFAULT_SETTINGS: ObsidianAutosaveControlSettings = {
  saveInterval: 10, // default to 10 seconds
};

export default class ObsidianAutosaveControlPlugin extends Plugin {
  settings: ObsidianAutosaveControlSettings;
  originalVaultModify: (file: TFile, data: string) => Promise<void>;
  lockedFiles: Map<string, { file: TFile; content: string; timeoutId: number }> = new Map();
  isManualSave: boolean = false;
  previousActiveFilePath: string | null = null;
  statusIcon: HTMLElement;

  async onload() {
    console.log("loading plugin obsidian-autosave-control");

    // Load settings
    await this.loadSettings();

    // Create and initialize status icon
    this.addStatusIcon();

    // Add settings tab
    this.addSettingTab(new ObsidianAutosaveControlSettingTab(this.app, this));

    // Save the original 'modify' method
    this.originalVaultModify = this.app.vault.modify.bind(this.app.vault);

    // Override 'modify' method
    this.app.vault.modify = async (file: TFile, data: string): Promise<void> => {
      const filePath = file.path;
      if (this.isManualSave) {
        // Allow manual saves to proceed
        return await this.originalVaultModify(file, data);
      }

      if (this.lockedFiles.has(filePath)) {
        console.log(`Preventing modification of locked file: ${filePath}`);
        // Update the content in memory
        const lockedFile = this.lockedFiles.get(filePath)!;
        lockedFile.content = data;

        // Reset the timeout
        clearTimeout(lockedFile.timeoutId);
        lockedFile.timeoutId = window.setTimeout(() => {
          this.unlockAndSaveFile(filePath);
        }, this.settings.saveInterval * 1000);
      } else {
        // First modification to this file, lock it and store content
        console.log(`Locking file: ${filePath}`);
        const timeoutId = window.setTimeout(() => {
          this.unlockAndSaveFile(filePath);
        }, this.settings.saveInterval * 1000);

        this.lockedFiles.set(filePath, { file, content: data, timeoutId });
      }

      // Update the icon state
      this.updateIconState();

      // Do not save to disk immediately
      return;
    };

    // Listen for file open events to initialize content for open files
    this.registerEvent(
      this.app.workspace.on('file-open', async (file: TFile | null) => {
        if (file && this.lockedFiles.has(file.path)) {
          // Update content from editor if available
          const content = await this.getFileContent(file);
          const lockedFile = this.lockedFiles.get(file.path)!;
          lockedFile.content = content;
        }
      })
    );

    // Track active file changes
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', (leaf) => {
        if (leaf && leaf.view instanceof MarkdownView) {
          const file = leaf.view.file;
          if (file) {
            const currentFilePath = file.path;
            const previousFilePath = this.previousActiveFilePath;

            // If there's a previous file, and it's different from the current
            if (previousFilePath && previousFilePath !== currentFilePath) {
              // Check if the previous file is locked
              if (this.lockedFiles.has(previousFilePath)) {
                // Forcefully save and unlock the previous file
                this.unlockAndSaveFile(previousFilePath);
              }
            }

            // Update the previous active file path
            this.previousActiveFilePath = currentFilePath;
          }
        }
      })
    );

    // Initialize previous active file path
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView && activeView.file) {
      this.previousActiveFilePath = activeView.file.path;
    }

    // Handle window close and quit events
    this.registerEvent(this.app.workspace.on('quit', () => {
      console.log("App quit event detected. Saving all locked files.");
      this.saveAllLockedFiles();
    }));

    this.registerEvent(this.app.workspace.on('window-close', () => {
      console.log("Window close event detected. Saving all locked files.");
      this.saveAllLockedFiles();
    }));

    // Handle file rename events
    this.registerEvent(
      this.app.vault.on('rename', (file: TFile, oldPath: string) => {
        if (this.lockedFiles.has(oldPath)) {
          console.log(`File renamed from ${oldPath} to ${file.path}`);

          // Get the locked file entry
          const lockedFile = this.lockedFiles.get(oldPath)!;

          // Remove the old entry and add the new one
          this.lockedFiles.delete(oldPath);
          this.lockedFiles.set(file.path, { ...lockedFile, file });

          // Update the status icon state
          this.updateIconState();
        }
      })
    );

    // Register file close (active-leaf-change) event listener
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', (leaf) => {
        const previousFilePath = this.previousActiveFilePath;

        if (previousFilePath && this.lockedFiles.has(previousFilePath)) {
          console.log(`File close detected for: ${previousFilePath}. Saving before closing.`);
          this.unlockAndSaveFile(previousFilePath);
        }

        if (leaf && leaf.view instanceof MarkdownView) {
          this.previousActiveFilePath = leaf.view.file?.path ?? null;
        }
      })
    );
  }

  // Create a status icon in the title bar
  addStatusIcon() {
    this.statusIcon = this.addStatusBarItem();
    this.statusIcon.setText('●');  // Simple circle indicator
    //this.statusIcon.setAttr('aria-label', 'Save Status');
    this.statusIcon.addClass('save-status-icon');

    // Set initial state to green (everything saved)
    this.statusIcon.style.color = 'limegreen';
    this.statusIcon.setAttribute('title', 'All changes saved');
  }

  // Update the icon's color and tooltip based on locked files
  updateIconState() {
    if (this.lockedFiles.size > 0) {
      // Set to blue (indicating that some files are locked)
      this.statusIcon.style.color = 'deepskyblue';
      this.statusIcon.setAttribute('title', 'Changes pending save');
    } else {
      // Set to green (everything saved)
      this.statusIcon.style.color = 'limegreen';
      this.statusIcon.setAttribute('title', 'All changes saved');
    }
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

    // Reset manual save flag
    this.isManualSave = false;

    // Update the icon state
    this.updateIconState();
  }

  async saveAllLockedFiles() {
    console.log("Saving all locked files before closing.");
    for (const filePath of this.lockedFiles.keys()) {
      await this.unlockAndSaveFile(filePath);
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
    console.log("plugin obsidian-autosave-control unloaded");

    // Restore the original 'modify' method
    this.app.vault.modify = this.originalVaultModify;

    // Clear all timeouts
    this.lockedFiles.forEach((lockedFile) => {
      clearTimeout(lockedFile.timeoutId);
    });

    // Save all locked files on unload
    this.saveAllLockedFiles();
  }
}

class ObsidianAutosaveControlSettingTab extends PluginSettingTab {
  plugin: ObsidianAutosaveControlPlugin;

  constructor(app: App, plugin: ObsidianAutosaveControlPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();

    containerEl.createEl('h2', { text: 'Obsidian Autosave Control Settings' });

    new Setting(containerEl)
      .setName('Save Interval')
      .setDesc(
        'The period (in seconds) during which file changes are kept in memory before being saved to disk. Must be between 1 and 3600 seconds.'
      )
      .addText((text) =>
        text
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
          })
      );
  }
}
