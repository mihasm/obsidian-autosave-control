import type { Plugin } from "obsidian";

export class SaveStatusIndicator {
  private element: HTMLElement | null = null;
  private savedColor = "#32cd32";
  private pendingColor = "#00bfff";
  private iconSizePx = 16;

  constructor(private readonly plugin: Plugin) {}

  attach() {
    this.detach();
    this.removeStaleIndicators();
    this.element = this.plugin.addStatusBarItem();
    this.element.setText("●");
    this.element.addClass("save-status-icon");
    this.applyIconSize();
    this.showAllChangesSaved();
  }

  detach() {
    this.element?.remove();
    this.element = null;
  }

  setPendingSaveCount(pendingSaveCount: number) {
    if (!this.element) {
      return;
    }

    if (pendingSaveCount > 0) {
      this.element.classList.remove("asc-saved");
      this.element.classList.add("asc-pending");
      this.element.setAttribute("title", "Changes pending save");
      this.applyCurrentColor();
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
    this.element.setAttribute("title", "All changes saved");
    this.applyCurrentColor();
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
