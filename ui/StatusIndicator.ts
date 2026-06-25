import type { Plugin } from "obsidian";

// Cap how many note names the hover tooltip spells out. Kept in step with the
// close/quit dialog so both surfaces read the same; the rest collapse into
// "…and N more" so the tooltip never grows unbounded.
const MAX_LISTED_UNSAVED_NOTES = 5;

export class SaveStatusIndicator {
  private element: HTMLElement | null = null;
  private savedColor = "#32cd32";
  private pendingColor = "#00bfff";
  private iconSizePx = 16;
  private pendingSaveCount = 0;
  private pendingNoteNamesProvider: (() => string[]) | null = null;

  constructor(private readonly plugin: Plugin) {}

  attach() {
    this.detach();
    this.removeStaleIndicators();
    this.element = this.plugin.addStatusBarItem();
    this.element.setText("●");
    this.element.addClass("save-status-icon");
    // Rebuild the tooltip lazily on hover so it always reflects the notes that
    // are pending right now, not whatever they were at the last count change.
    this.element.addEventListener("mouseenter", () => this.refreshTooltip());
    this.applyIconSize();
    this.showAllChangesSaved();
    this.refreshTooltip();
  }

  // Lets the plugin supply the current unsaved-note names (from the autosave
  // controller) without coupling this UI class to the controller directly.
  setPendingNoteNamesProvider(provider: () => string[]) {
    this.pendingNoteNamesProvider = provider;
  }

  detach() {
    this.element?.remove();
    this.element = null;
  }

  setPendingSaveCount(pendingSaveCount: number) {
    if (!this.element) {
      return;
    }

    this.pendingSaveCount = pendingSaveCount;

    if (pendingSaveCount > 0) {
      this.element.classList.remove("asc-saved");
      this.element.classList.add("asc-pending");
      this.applyCurrentColor();
      this.refreshTooltip();
      return;
    }

    this.showAllChangesSaved();
  }

  setColors(savedColor: string, pendingColor: string) {
    this.savedColor = savedColor;
    this.pendingColor = pendingColor;
    this.applyCurrentColor();
  }

  setIconSize(iconSizePx: number) {
    this.iconSizePx = iconSizePx;
    this.applyIconSize();
  }

  private showAllChangesSaved() {
    if (!this.element) {
      return;
    }

    this.element.classList.remove("asc-pending");
    this.element.classList.add("asc-saved");
    this.applyCurrentColor();
    this.refreshTooltip();
  }

  // Compose the hover tooltip. When changes are pending it lists the unsaved
  // notes (capped, mirroring the close/quit dialog); otherwise it confirms the
  // vault is fully saved.
  private refreshTooltip() {
    if (!this.element) {
      return;
    }

    if (this.pendingSaveCount <= 0) {
      this.element.setAttribute("title", "All changes saved");
      return;
    }

    const noteNames = this.pendingNoteNamesProvider?.() ?? [];
    if (noteNames.length === 0) {
      this.element.setAttribute("title", "Changes pending save");
      return;
    }

    const heading = noteNames.length === 1
      ? "1 note with unsaved changes:"
      : `${noteNames.length} notes with unsaved changes:`;

    const listedNames = noteNames.slice(0, MAX_LISTED_UNSAVED_NOTES);
    const lines = listedNames.map((name) => `• ${name}`);
    const hiddenCount = noteNames.length - listedNames.length;
    if (hiddenCount > 0) {
      lines.push(`…and ${hiddenCount} more`);
    }

    this.element.setAttribute("title", `${heading}\n${lines.join("\n")}`);
  }

  private removeStaleIndicators() {
    activeDocument.querySelectorAll(".save-status-icon").forEach((element: Element) => element.remove());
  }

  private applyCurrentColor() {
    if (!this.element) {
      return;
    }

    this.element.style.color = this.element.classList.contains("asc-pending")
      ? this.pendingColor
      : this.savedColor;
  }

  private applyIconSize() {
    if (!this.element) {
      return;
    }

    this.element.style.fontSize = `${this.iconSizePx}px`;
  }
}
