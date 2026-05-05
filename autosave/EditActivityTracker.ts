import { MarkdownView } from "obsidian";
import { dlog } from "../debug";

export class EditActivityTracker {
  private readonly lastEditActivityAtByPath = new Map<string, number>();
  private readonly listenersByWindow = new Map<Window, EditActivityWindowListeners>();

  constructor(
    private readonly getActiveMarkdownView: () => MarkdownView | null,
    private readonly onEditActivity?: (view: MarkdownView, filePath: string) => void,
    private readonly isManualSaveShortcut?: (event: KeyboardEvent) => boolean,
    private readonly onManualSaveShortcut?: (view: MarkdownView, filePath: string, event: KeyboardEvent) => boolean,
  ) {}

  attachToWindow(targetWindow: Window | null | undefined) {
    if (!targetWindow || this.listenersByWindow.has(targetWindow)) {
      return;
    }

    const recordEditActivity = (event: Event) => {
      if (!this.isEventFromMarkdownEditor(event)) {
        return;
      }

      this.recordActiveFileEditActivity(true);
    };

    const onKeydown = (event: KeyboardEvent) => {
      if (this.handleManualSaveShortcut(event)) {
        return;
      }

      if (["Enter", "Backspace", "Delete"].includes(event.key) && this.isEventFromMarkdownEditor(event)) {
        this.recordActiveFileEditActivity(true);
      }
    };

    const listeners: EditActivityWindowListeners = {
      keydown: onKeydown,
      input: recordEditActivity,
      paste: recordEditActivity,
      cut: recordEditActivity,
    };

    targetWindow.addEventListener("keydown", listeners.keydown, true);
    targetWindow.addEventListener("input", listeners.input, true);
    targetWindow.addEventListener("paste", listeners.paste, true);
    targetWindow.addEventListener("cut", listeners.cut, true);

    this.listenersByWindow.set(targetWindow, listeners);
  }

  detachAll() {
    for (const [targetWindow, listeners] of this.listenersByWindow.entries()) {
      targetWindow.removeEventListener("keydown", listeners.keydown, true);
      targetWindow.removeEventListener("input", listeners.input, true);
      targetWindow.removeEventListener("paste", listeners.paste, true);
      targetWindow.removeEventListener("cut", listeners.cut, true);
    }

    this.listenersByWindow.clear();
  }

  getLastEditActivityAt(filePath: string): number {
    return this.lastEditActivityAtByPath.get(filePath) ?? 0;
  }

  renameTrackedFile(oldPath: string, newPath: string) {
    const lastEditActivityAt = this.lastEditActivityAtByPath.get(oldPath);
    if (lastEditActivityAt === undefined) {
      return;
    }

    this.lastEditActivityAtByPath.delete(oldPath);
    this.lastEditActivityAtByPath.set(newPath, lastEditActivityAt);
  }

  private handleManualSaveShortcut(event: KeyboardEvent): boolean {
    if (!this.isManualSaveShortcut?.(event)) {
      return false;
    }

    const activeMarkdownView = this.getActiveMarkdownView();
    const filePath = activeMarkdownView?.file?.path;
    if (!activeMarkdownView || !filePath) {
      return false;
    }

    return this.onManualSaveShortcut?.(activeMarkdownView, filePath, event) ?? false;
  }

  private recordActiveFileEditActivity(shouldLog = false) {
    const activeMarkdownView = this.getActiveMarkdownView();
    const filePath = activeMarkdownView?.file?.path;

    if (!filePath) {
      return;
    }

    this.lastEditActivityAtByPath.set(filePath, Date.now());
    this.onEditActivity?.(activeMarkdownView, filePath);

    if (shouldLog) {
      dlog("Edit activity", filePath);
    }
  }

  private isEventFromMarkdownEditor(event: Event): boolean {
    const targetElement = event.target instanceof Element
      ? event.target
      : (document.activeElement instanceof Element ? document.activeElement : null);
    if (!targetElement) {
      return false;
    }

    if (targetElement.closest(".prompt, .modal, .suggestion-container, .prompt-input")) {
      return false;
    }

    if (targetElement.closest(".inline-title, .inline-title-input, .view-header-title, .workspace-tab-header")) {
      return false;
    }

    return targetElement.closest(".cm-editor") !== null;
  }
}

type EditActivityWindowListeners = {
  keydown: (event: KeyboardEvent) => void;
  input: (event: Event) => void;
  paste: (event: Event) => void;
  cut: (event: Event) => void;
};
