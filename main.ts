// src/main.ts
import { Plugin, Notice } from "obsidian";
import { StatusIndicator } from "./ui/StatusIndicator";
import { AutoSaveControlSettingTab } from "./ui/SettingsTab";
import { App, MarkdownView, TFile, TextFileView } from "obsidian";
import { dlog } from "./debug";

export interface AutoSaveControlSettings {
  saveInterval: number;        // seconds
  savedColor: string;
  pendingColor: string;
}

export const DEFAULT_SETTINGS: AutoSaveControlSettings = {
  saveInterval: 10,
  savedColor: "#32cd32", // limegreen
  pendingColor: "#00bfff", // deepskyblue
};

export type Pending = {
  file: TFile;
  view: TextFileView;
  timeoutId: number;
};

const GLOBAL_LAST_INPUT_AT = new Map<string, number>();

export default class AutoSaveControlPlugin extends Plugin {
  settings!: AutoSaveControlSettings;
  private status!: StatusIndicator;
  private controller!: AutoSaveController;
  private styleEl: HTMLStyleElement | null = null;

  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    // status indicator
    this.status = new StatusIndicator(this);
    this.status.attach();

    // controller
    this.controller = new AutoSaveController(this.app, () => this.settings, this);
    this.controller.setPendingCallback((count) => this.status.setPending(count));
    this.controller.apply();

    // css
    this.installStyle();
    this.applyColors();

    // settings tab
    this.addSettingTab(new AutoSaveControlSettingTab(this.app, this as any));
  }

  onunload() {
    this.controller.restore();
    if (this.styleEl) {
      this.styleEl.remove();
      this.styleEl = null;
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /** apply user colors -> CSS variables */
  applyColors(): void {
    const root = document.documentElement;
    root.style.setProperty("--asc-saved-color", this.settings.savedColor);
    root.style.setProperty("--asc-pending-color", this.settings.pendingColor);
  }

  /** inject minimal CSS once */
  private installStyle(): void {
    if (this.styleEl) return;
    const css = `
      .save-status-icon.asc-saved   { color: var(--asc-saved-color,   #32cd32); }
      .save-status-icon.asc-pending { color: var(--asc-pending-color, #00bfff); }
    `;
    const el = document.createElement("style");
    el.setAttribute("data-asc", "styles");
    el.textContent = css;
    document.head.appendChild(el);
    this.styleEl = el;
  }
}


type SaveFn = (this: MarkdownView, ...args: unknown[]) => Promise<void> | void;
const LOG = (...a: unknown[]) => dlog("[asc]", ...a);

const INPUT_GRACE_MS = 2100; // allow Obsidian's autosave (~2s) once

const windowsWithListeners = new WeakSet<Window>();

export class AutoSaveController {
  private readonly app: App;
  private readonly getSettings: () => AutoSaveControlSettings;
  private readonly plugin: Plugin;
  private onPendingChange?: (count: number) => void;

  private origSave: SaveFn | null = null;
  private unloading = false;

  private pending = new Map<string, Pending>();
  private windowEnd = new Map<string, number>();
  private token = new Map<string, number>();

  private onBeforeUnload?: () => void;

  constructor(app: App, settings: () => AutoSaveControlSettings, plugin: Plugin) {
    this.app = app;
    this.getSettings = settings;
    this.plugin = plugin;
  }

  setPendingCallback(cb: (count: number) => void) {
    this.onPendingChange = cb;
  }

  /** Wrap MarkdownView.save and attach minimal listeners */
  apply() {
    if (this.origSave) return;

    const proto = MarkdownView.prototype as unknown as { save: SaveFn };
    this.origSave = proto.save;
    proto.save = this.makeWrapper(proto.save);

    // listeners
    this.onBeforeUnload = () => { this.unloading = true; };
    window.addEventListener("beforeunload", this.onBeforeUnload, { capture: true });

    // Apply input listeners immediately
    this.applyGlobalInputListeners();

    // Also apply when switching to markdown views
    this.app.workspace.on("active-leaf-change", (leaf) => {
      LOG("leaf changed");
      if(!leaf) return;
      const view = leaf.view;
      if (view instanceof MarkdownView) {
        this.applyGlobalInputListeners();
      }
    });

    LOG("wrapped save");
  }

  private applyGlobalInputListeners() {
    LOG("applying global input listeners");
    const win = window;
    if (windowsWithListeners.has(win)) {
      LOG("listeners already applied to this window");
      return; // already applied
    }

    const mark = () => {
      const mv = this.app.workspace.getActiveViewOfType(MarkdownView);
      const path = mv?.file?.path;
      LOG("input event detected, file:", path);
      if (path) {
        this.markInput(path);
        LOG("marked input for", path, "at", Date.now());
      }
    };

    const onInput = () => mark();
    const onPaste = () => mark();
    const onCut = () => mark();

    win.addEventListener("input", onInput, true);
    win.addEventListener("paste", onPaste, true);
    win.addEventListener("cut", onCut, true);

    windowsWithListeners.add(win);
    LOG("input listeners registered on window");

    // flush all pending files when window is closing
    win.addEventListener("beforeunload", () => {
      this.flushAllPending();
    });
  }

  private async flushAllPending() {
    const paths = Array.from(this.pending.keys());
    for (const path of paths) {
      await this.flush(path);
    }
  }

  /** Restore original save and detach listeners */
  restore() {
    const proto = MarkdownView.prototype as unknown as { save: SaveFn };
    if (this.origSave) {
      proto.save = this.origSave;
      this.origSave = null;
    }

    if (this.onBeforeUnload) window.removeEventListener("beforeunload", this.onBeforeUnload, { capture: true } as AddEventListenerOptions);
    this.onBeforeUnload = undefined;
    LOG("restored save");
  }

  private makeWrapper(original: SaveFn): SaveFn {
    const self = this;

    return function wrappedSave(this: MarkdownView, ...args: unknown[]) {
      const file: TFile | null | undefined = this.file;
      const path = file?.path;
      LOG("wrapped Save called:"+path+"/"+file);
      if (!path) return original.apply(this, args);

      const now = Date.now();
      const last = GLOBAL_LAST_INPUT_AT.get(path) ?? 0;  // use global map
      const since = now - last;
      LOG(path+":since:"+since);
      const insideGrace = since >= 0 && since <= INPUT_GRACE_MS;

      // If unloading, save immediately
      if (self.unloading) {
        LOG(path+": unloading, saving immediately");
        self.clearPending(path);
        self.windowEnd.delete(path);
        self.token.delete(path);
        return original.apply(this, args);
      }

      // Check if there's already a pending save for this file
      const hasPending = self.pending.has(path);
      
      if (insideGrace) {
        const end = self.windowEnd.get(path) ?? 0;
        const tok = self.token.get(path);
        const windowAlive = now <= end;
        const sameEpoch = tok !== undefined && tok === last;

        if (windowAlive && sameEpoch) {
          LOG(path+": inside grace window, already deferred, ignoring");
          return; // Already deferred, ignore this save attempt
        }

        LOG(path+": inside grace, deferring save for " + self.getSettings().saveInterval + "s");
        self.defer(path, this as TextFileView);
        self.windowEnd.set(path, last + INPUT_GRACE_MS);
        self.token.set(path, last);
        return;
      }

      // Outside grace period
      if (hasPending) {
        // If there's a pending save, let it complete via the timer
        LOG(path+": outside grace but has pending, ignoring (will save via timer)");
        return;
      }

      // No recent input and no pending save, allow immediate save
      LOG(path+": no recent input, no pending, saving immediately");
      self.clearPending(path);
      self.windowEnd.delete(path);
      self.token.delete(path);
      return original.apply(this, args);
    };
  }

  private markInput(path: string) {
    GLOBAL_LAST_INPUT_AT.set(path, Date.now());
  }

  private defer(path: string, view: TextFileView) {
    const existing = this.pending.get(path);
    if (existing) {
      clearTimeout(existing.timeoutId);
   }
    const interval = this.getSettings().saveInterval;
    const timeoutId = window.setTimeout(() => this.flush(path), interval * 1000);
    this.pending.set(path, { file: view.file!, view, timeoutId });
    this.emitPending();
  }

  private async flush(path: string) {
    const entry = this.pending.get(path);
    if (!entry || !this.origSave) return;

    clearTimeout(entry.timeoutId);
    this.pending.delete(path);
    this.emitPending();

    await this.origSave.call(entry.view as unknown as MarkdownView);
    this.windowEnd.delete(path);
    this.token.delete(path);
    LOG("flushed", path);
  }

  private clearPending(path: string) {
    const p = this.pending.get(path);
    if (!p) return;
    clearTimeout(p.timeoutId);
    this.pending.delete(path);
    this.emitPending();
  }

  private emitPending() {
    this.onPendingChange?.(this.pending.size);
  }
}