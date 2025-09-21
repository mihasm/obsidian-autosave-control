// src/ui/SettingsTab.ts
import { PluginSettingTab, Setting, App } from "obsidian";
import type { AutoSaveControlSettings } from "../main";

export interface SettingsHost {
  settings: AutoSaveControlSettings;
  saveSettings(): Promise<void>;
  applyColors(): void; // NEW
}

export class AutoSaveControlSettingTab extends PluginSettingTab {
  constructor(app: App, private host: SettingsHost) {
    super(app, host as any);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Autosave Control" });

    new Setting(containerEl)
      .setName("Save interval (seconds)")
      .setDesc("Delay before autosave is written (3–3600).")
      .addText((t) =>
        t
          .setValue(String(this.host.settings.saveInterval))
          .onChange(async (val) => {
            let n = parseInt(val, 10);
            if (isNaN(n)) n = 10;
            n = Math.max(3, Math.min(3600, n));
            this.host.settings.saveInterval = n;
            await this.host.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Saved color")
      .setDesc("Status dot color when all changes are saved.")
      .addColorPicker?.((p) =>
        p.setValue(this.host.settings.savedColor).onChange(async (v) => {
          this.host.settings.savedColor = v;
          await this.host.saveSettings();
          this.host.applyColors();
        })
      ) ?? // fallback if addColorPicker is not available
      new Setting(containerEl)
        .setName("Saved color (hex)")
        .addText((t) =>
          t.setValue(this.host.settings.savedColor).onChange(async (v) => {
            this.host.settings.savedColor = v;
            await this.host.saveSettings();
            this.host.applyColors();
          })
        );

    new Setting(containerEl)
      .setName("Pending color")
      .setDesc("Status dot color when saves are pending.")
      .addColorPicker?.((p) =>
        p.setValue(this.host.settings.pendingColor).onChange(async (v) => {
          this.host.settings.pendingColor = v;
          await this.host.saveSettings();
          this.host.applyColors();
        })
      ) ?? // fallback
      new Setting(containerEl)
        .setName("Pending color (hex)")
        .addText((t) =>
          t.setValue(this.host.settings.pendingColor).onChange(async (v) => {
            this.host.settings.pendingColor = v;
            await this.host.saveSettings();
            this.host.applyColors();
          })
        );
  }
}