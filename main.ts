import { Plugin } from "obsidian";
import { AutoSaveController } from "./autosave/AutoSaveController";
import { DEFAULT_SETTINGS, type AutoSaveControlSettings } from "./settings/AutoSaveSettings";
import { AutoSaveControlSettingsTab } from "./ui/SettingsTab";
import { SaveStatusIndicator } from "./ui/StatusIndicator";

export default class AutoSaveControlPlugin extends Plugin {
  settings!: AutoSaveControlSettings;

  private saveStatusIndicator!: SaveStatusIndicator;
  private autosaveController!: AutoSaveController;
  private runtimeCleanup: (() => void) | null = null;

  async onload() {
    const globalState = window as typeof window & { __ascRuntimeCleanup?: (() => void) | null };
    globalState.__ascRuntimeCleanup?.();

    const loadedSettings = await this.loadData() as Partial<AutoSaveControlSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedSettings ?? {});

    this.saveStatusIndicator = new SaveStatusIndicator(this);
    this.saveStatusIndicator.attach();

    this.autosaveController = new AutoSaveController(this.app, () => this.settings);
    this.autosaveController.setPendingSaveCountChangeHandler((pendingSaveCount) => {
      this.saveStatusIndicator.setPendingSaveCount(pendingSaveCount);
    });
    this.autosaveController.enable();

    this.applyStatusColors();
    this.applyStatusIconSize();

    this.addSettingTab(new AutoSaveControlSettingsTab(this.app, this));

    this.runtimeCleanup = () => {
      this.autosaveController.disable();
      this.saveStatusIndicator.detach();
    };

    globalState.__ascRuntimeCleanup = this.runtimeCleanup;
  }

  onunload() {
    this.runtimeCleanup?.();

    const globalState = window as typeof window & { __ascRuntimeCleanup?: (() => void) | null };
    if (globalState.__ascRuntimeCleanup === this.runtimeCleanup) {
      globalState.__ascRuntimeCleanup = null;
    }

    this.runtimeCleanup = null;
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.autosaveController.refreshScheduling();
  }

  applyStatusColors(): void {
    this.saveStatusIndicator.setColors(
      this.settings.savedStatusColor,
      this.settings.pendingStatusColor,
    );
  }

  applyStatusIconSize(): void {
    this.saveStatusIndicator.setIconSize(this.settings.statusIconSizePx);
  }
}
