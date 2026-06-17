import { App, ColorComponent, PluginSettingTab, Setting, TextComponent } from "obsidian";
import type { AutoSaveControlSettings } from "../settings/AutoSaveSettings";

export interface SettingsHost {
  settings: AutoSaveControlSettings;
  saveSettings(): Promise<void>;
  applyStatusColors(): void;
  applyStatusIconSize(): void;
}

type LegacyColorTextSetting = Setting & {
  addText: (callback: (textComponent: TextComponent) => unknown) => Setting;
};
type SettingWithColorPicker = LegacyColorTextSetting & {
  addColorPicker: (callback: (colorPicker: ColorComponent) => ColorComponent) => Setting;
};

export class AutoSaveControlSettingsTab extends PluginSettingTab {
  constructor(app: App, private readonly host: SettingsHost) {
    super(app, host as never);
  }

  display(): void {
    this.renderSettings();
  }

  private renderSettings(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("General")
      .setHeading();

    new Setting(containerEl)
      .setName("Disable autosave completely")
      .setDesc("Only save when you trigger Obsidian's Save File command manually.")
      .addToggle((toggleComponent) =>
        toggleComponent.setValue(this.host.settings.disableAutoSave).onChange(async (value) => {
          this.host.settings.disableAutoSave = value;
          await this.host.saveSettings();
          this.renderSettings();
        })
      );

    if (this.host.settings.disableAutoSave) {
      new Setting(containerEl)
        .setName("Warning")
        .setDesc(
          "Automatic saves are fully disabled. Unsaved changes stay only in memory until you use Obsidian's Save File command. Closing Obsidian with pending changes will show a confirmation prompt."
        );
    }

    if (!this.host.settings.disableAutoSave) {
      new Setting(containerEl)
        .setName("Save delay (seconds)")
        .setDesc("How long to wait after editing stops before saving (3-3600).")
        .addText((textComponent) =>
          textComponent
            .setValue(String(this.host.settings.saveDelaySeconds))
            .onChange(async (value) => {
              const parsedValue = Number.parseInt(value, 10);
              const normalizedValue = Number.isNaN(parsedValue)
                ? DEFAULT_SAVE_DELAY_SECONDS
                : Math.max(MIN_SAVE_DELAY_SECONDS, Math.min(MAX_SAVE_DELAY_SECONDS, parsedValue));

              this.host.settings.saveDelaySeconds = normalizedValue;
              await this.host.saveSettings();
            })
        );
    }

    new Setting(containerEl)
      .setName("Defer workspace layout saves")
      .setDesc("Delay workspace.json writes and flush them later to reduce sync churn when switching files.")
      .addToggle((toggleComponent) =>
        toggleComponent.setValue(this.host.settings.deferWorkspaceLayoutSaves).onChange(async (value) => {
          this.host.settings.deferWorkspaceLayoutSaves = value;
          await this.host.saveSettings();
          this.renderSettings();
        })
      );

    if (this.host.settings.deferWorkspaceLayoutSaves) {
      new Setting(containerEl)
        .setName("Workspace layout save delay (seconds)")
        .setDesc("Maximum delay before persisting workspace.json after layout changes (1-3600).")
        .addText((textComponent) =>
          textComponent
            .setValue(String(this.host.settings.workspaceLayoutSaveDelaySeconds))
            .onChange(async (value) => {
              const parsedValue = Number.parseInt(value, 10);
              const normalizedValue = Number.isNaN(parsedValue)
                ? DEFAULT_WORKSPACE_LAYOUT_SAVE_DELAY_SECONDS
                : Math.max(
                    MIN_WORKSPACE_LAYOUT_SAVE_DELAY_SECONDS,
                    Math.min(MAX_WORKSPACE_LAYOUT_SAVE_DELAY_SECONDS, parsedValue)
                  );

              this.host.settings.workspaceLayoutSaveDelaySeconds = normalizedValue;
              await this.host.saveSettings();
            })
        );
    }

    this.addColorSetting({
      containerEl,
      name: "Saved status color",
      description: "Status dot color when all changes are saved.",
      getValue: () => this.host.settings.savedStatusColor,
      setValue: async (value) => {
        this.host.settings.savedStatusColor = value;
        await this.host.saveSettings();
        this.host.applyStatusColors();
      },
    });

    this.addColorSetting({
      containerEl,
      name: "Pending status color",
      description: "Status dot color while a delayed save is waiting.",
      getValue: () => this.host.settings.pendingStatusColor,
      setValue: async (value) => {
        this.host.settings.pendingStatusColor = value;
        await this.host.saveSettings();
        this.host.applyStatusColors();
      },
    });

    new Setting(containerEl)
      .setName("Status icon size (px)")
      .setDesc(`Size of the status bar dot in pixels (${MIN_STATUS_ICON_SIZE_PX}-${MAX_STATUS_ICON_SIZE_PX}).`)
      .addText((textComponent) =>
        textComponent
          .setValue(String(this.host.settings.statusIconSizePx))
          .onChange(async (value) => {
            const parsedValue = Number.parseInt(value, 10);
            const normalizedValue = Number.isNaN(parsedValue)
              ? DEFAULT_STATUS_ICON_SIZE_PX
              : Math.max(
                  MIN_STATUS_ICON_SIZE_PX,
                  Math.min(MAX_STATUS_ICON_SIZE_PX, parsedValue)
                );

            this.host.settings.statusIconSizePx = normalizedValue;
            await this.host.saveSettings();
            this.host.applyStatusIconSize();
          })
      );
  }

  private addColorSetting(options: ColorSettingOptions) {
    const setting = new Setting(options.containerEl)
      .setName(options.name)
      .setDesc(options.description);

    const maybeSettingWithColorPicker = setting as Setting & Partial<SettingWithColorPicker>;
    if (typeof maybeSettingWithColorPicker.addColorPicker === "function") {
      maybeSettingWithColorPicker.addColorPicker((colorPicker: ColorComponent) =>
        colorPicker.setValue(options.getValue()).onChange(options.setValue)
      );
      return;
    }

    (setting as LegacyColorTextSetting).addText((textComponent: TextComponent) =>
      textComponent.setValue(options.getValue()).onChange(options.setValue)
    );
  }
}

type ColorSettingOptions = {
  containerEl: HTMLElement;
  name: string;
  description: string;
  getValue: () => string;
  setValue: (value: string) => Promise<void>;
};

const DEFAULT_SAVE_DELAY_SECONDS = 10;
const MIN_SAVE_DELAY_SECONDS = 3;
const MAX_SAVE_DELAY_SECONDS = 3600;
const DEFAULT_WORKSPACE_LAYOUT_SAVE_DELAY_SECONDS = 60;
const MIN_WORKSPACE_LAYOUT_SAVE_DELAY_SECONDS = 1;
const MAX_WORKSPACE_LAYOUT_SAVE_DELAY_SECONDS = 3600;
const DEFAULT_STATUS_ICON_SIZE_PX = 16;
const MIN_STATUS_ICON_SIZE_PX = 8;
const MAX_STATUS_ICON_SIZE_PX = 32;
