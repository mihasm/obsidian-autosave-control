import { browser, expect } from "@wdio/globals";
import ObsidianApp from "../support/ObsidianApp";

const SHORT_DELAY_SECONDS = 3;
const DEFAULT_SAVE_WAIT_TIMEOUT_MS = 7000;
const LONG_WORKSPACE_LAYOUT_DELAY_SECONDS = 10;

async function enableDelayedAutosave(saveDelaySeconds = SHORT_DELAY_SECONDS) {
  await ObsidianApp.setPluginSettings({
    disableAutoSave: false,
    saveDelaySeconds,
  });
}

async function enableManualOnlyMode() {
  await ObsidianApp.setPluginSettings({
    disableAutoSave: true,
    saveDelaySeconds: SHORT_DELAY_SECONDS,
  });
}

async function enableWorkspaceLayoutDeferral(workspaceLayoutSaveDelaySeconds = LONG_WORKSPACE_LAYOUT_DELAY_SECONDS) {
  await ObsidianApp.setPluginSettings({
    deferWorkspaceLayoutSaves: true,
    workspaceLayoutSaveDelaySeconds,
  });
}

async function expectSavedAfterDelay(
  notePath: string,
  expectedContent: string,
  timeout = DEFAULT_SAVE_WAIT_TIMEOUT_MS,
  options: { waitForStatus?: boolean } = {},
) {
  await ObsidianApp.waitForVaultFileContent(notePath, expectedContent, timeout);
  if (options.waitForStatus !== false) {
    await ObsidianApp.waitForSavedStatus();
  }
}

async function expectQuickSwitcherLoadsTargetContent(notePath: string, expectedContent: string) {
  await ObsidianApp.openExistingNoteViaQuickSwitcher(notePath, { focusEditor: false });
  await browser.pause(300);
  await expect(await ObsidianApp.getActiveFilePath()).toBe(notePath);
  await expect(await ObsidianApp.getActiveEditorContent()).toBe(expectedContent);
}

describe("Autosave Control manual scenarios", () => {
  beforeEach(async () => {
    await ObsidianApp.reloadWithFreshVault();
  });

  it("types normal letters continuously for longer than 2 seconds without saving until typing stops", async () => {
    const notePath = "core/continuous-typing.md";

    await enableDelayedAutosave();
    await ObsidianApp.createAndOpenNote(notePath);
    await ObsidianApp.typeText("abcd");
    await browser.pause(1200);
    await ObsidianApp.typeText("efgh");
    await ObsidianApp.waitForPendingStatus();
    await expect(await ObsidianApp.readVaultFile(notePath)).toBe("");

    await expectSavedAfterDelay(notePath, "abcdefgh");
  });

  it("stops typing and waits for exactly one save after the configured delay", async () => {
    const notePath = "core/one-save-after-delay.md";

    await enableDelayedAutosave();
    await ObsidianApp.createAndOpenNote(notePath);
    await ObsidianApp.typeText("save once");
    await ObsidianApp.waitForPendingStatus();
    await browser.pause(1500);
    await expect(await ObsidianApp.readVaultFile(notePath)).toBe("");

    await expectSavedAfterDelay(notePath, "save once");
    const savedMtime = await ObsidianApp.getVaultFileMtimeMs(notePath);
    await browser.pause(1500);
    await expect(await ObsidianApp.getVaultFileMtimeMs(notePath)).toBe(savedMtime);
  });

  it("resets the timer when typing resumes before the delay finishes", async () => {
    const notePath = "core/reset-timer.md";

    await enableDelayedAutosave();
    await ObsidianApp.createAndOpenNote(notePath);
    await ObsidianApp.typeText("abc");
    await ObsidianApp.waitForPendingStatus();
    await browser.pause(2000);
    await ObsidianApp.typeText("d");
    await browser.pause(1500);
    await expect(await ObsidianApp.readVaultFile(notePath)).toBe("");

    await expectSavedAfterDelay(notePath, "abcd");
  });

  it("leaves an idle note without changes and performs no extra saves", async () => {
    const notePath = "core/idle-note.md";

    await enableDelayedAutosave();
    await ObsidianApp.createAndOpenNote(notePath, "already saved");
    await ObsidianApp.waitForSavedStatus();
    const initialMtime = await ObsidianApp.getVaultFileMtimeMs(notePath);

    await browser.pause(4000);

    await expect(await ObsidianApp.getVaultFileMtimeMs(notePath)).toBe(initialMtime);
    await expect(await ObsidianApp.readVaultFile(notePath)).toBe("already saved");
  });

  it("ignores requestSave when the active note is already clean", async () => {
    const notePath = "core/clean-request-save.md";

    await enableDelayedAutosave();
    await ObsidianApp.createAndOpenNote(notePath, "already saved");
    await ObsidianApp.waitForSavedStatus();
    const initialMtime = await ObsidianApp.getVaultFileMtimeMs(notePath);

    await ObsidianApp.runActiveViewRequestSave();
    await browser.pause(1000);

    await expect(await ObsidianApp.getPendingStatusCount()).toBe(0);
    await expect(await ObsidianApp.getVaultFileMtimeMs(notePath)).toBe(initialMtime);
    await expect(await ObsidianApp.readVaultFile(notePath)).toBe("already saved");
  });

  it("uses Obsidian's Save File command to save immediately while changes are pending", async () => {
    const notePath = "core/manual-save-command.md";

    await enableDelayedAutosave();
    await ObsidianApp.createAndOpenNote(notePath);
    await ObsidianApp.typeText("manual save path");
    await ObsidianApp.waitForPendingStatus();
    await browser.pause(1000);
    await expect(await ObsidianApp.readVaultFile(notePath)).toBe("");

    await ObsidianApp.runSaveCommand();
    await expectSavedAfterDelay(notePath, "manual save path", 7000);
  });

  it("presses Enter repeatedly and still delays the save", async () => {
    const notePath = "special-input/enter.md";

    await enableDelayedAutosave();
    await ObsidianApp.createAndOpenNote(notePath);
    await ObsidianApp.pressKey("Enter", 3);
    await ObsidianApp.waitForPendingStatus();
    await browser.pause(1200);
    await expect(await ObsidianApp.readVaultFile(notePath)).toBe("");

    await expectSavedAfterDelay(notePath, "\n\n\n");
  });

  it("presses Backspace repeatedly and still delays the save", async () => {
    const notePath = "special-input/backspace.md";

    await enableDelayedAutosave();
    await ObsidianApp.createAndOpenNote(notePath, "abcd");
    await ObsidianApp.pressKey("Backspace", 2);
    await ObsidianApp.waitForPendingStatus();
    await browser.pause(1200);
    await expect(await ObsidianApp.readVaultFile(notePath)).toBe("abcd");

    await expectSavedAfterDelay(notePath, "ab");
  });

  it("presses Delete repeatedly and still delays the save", async () => {
    const notePath = "special-input/delete.md";

    await enableDelayedAutosave();
    await ObsidianApp.createAndOpenNote(notePath, "abcd");
    await ObsidianApp.deleteFromStart(2);
    await ObsidianApp.waitForPendingStatus();
    await browser.pause(1200);
    await expect(await ObsidianApp.readVaultFile(notePath)).toBe("abcd");

    await expectSavedAfterDelay(notePath, "cd");
  });

  it("presses Space repeatedly and still delays the save", async () => {
    const notePath = "special-input/space.md";

    await enableDelayedAutosave();
    await ObsidianApp.createAndOpenNote(notePath);
    await ObsidianApp.pressKey("Space", 3);
    await ObsidianApp.waitForPendingStatus();
    await browser.pause(1200);
    await expect(await ObsidianApp.readVaultFile(notePath)).toBe("");

    await ObsidianApp.waitForSavedStatus(5000);
  });

  it("pastes text and saves after the delay", async () => {
    const notePath = "special-input/paste.md";

    await enableDelayedAutosave();
    await ObsidianApp.createAndOpenNote(notePath);
    await ObsidianApp.pasteText("pasted text");
    await ObsidianApp.waitForPendingStatus();
    await browser.pause(1200);
    await expect(await ObsidianApp.readVaultFile(notePath)).toBe("");

    await expectSavedAfterDelay(notePath, "pasted text", 5000);
  });

  it("cuts text and saves after the delay", async () => {
    const notePath = "special-input/cut.md";

    await enableDelayedAutosave();
    await ObsidianApp.createAndOpenNote(notePath, "cut me");
    await ObsidianApp.selectAllEditorContent();
    await ObsidianApp.cutSelection();
    await ObsidianApp.waitForPendingStatus();
    await browser.pause(1200);
    await expect(await ObsidianApp.readVaultFile(notePath)).toBe("cut me");

    await expectSavedAfterDelay(notePath, "", 5000);
  });

  it("opens a note in a new window and uses delayed save there too", async () => {
    const notePath = "multiple-windows/popup-note.md";
    const mainHandle = await ObsidianApp.getMainWindowHandle();

    await enableDelayedAutosave();
    await ObsidianApp.openNoteInNewWindow(notePath);
    await ObsidianApp.typeText("popup edit");
    await browser.pause(1200);
    await expect(await ObsidianApp.readVaultFile(notePath)).toBe("");
    await expectSavedAfterDelay(notePath, "popup edit", 7000, { waitForStatus: false });

    if (mainHandle) {
      await ObsidianApp.switchToWindow(mainHandle);
    }
  });

  it("edits different notes in the main window and a popup window on independent timers", async () => {
    const mainNotePath = "multiple-windows/main-note.md";
    const popupNotePath = "multiple-windows/popup-note-independent.md";
    const mainHandle = await ObsidianApp.getMainWindowHandle();

    await enableDelayedAutosave();
    await ObsidianApp.createAndOpenNote(mainNotePath);
    await ObsidianApp.typeText("main");
    await ObsidianApp.waitForPendingStatus();

    const popupHandle = await ObsidianApp.openNoteInNewWindow(popupNotePath);
    await ObsidianApp.typeText("popup");
    await browser.pause(1200);

    await expect(await ObsidianApp.readVaultFile(mainNotePath)).toBe("");
    await expect(await ObsidianApp.readVaultFile(popupNotePath)).toBe("");

    if (mainHandle) {
      await ObsidianApp.switchToWindow(mainHandle);
    }
    await expectSavedAfterDelay(mainNotePath, "main");
    await ObsidianApp.switchToWindow(popupHandle);
    await expectSavedAfterDelay(popupNotePath, "popup", 7000, { waitForStatus: false });
  });

  it("switches focus between windows while a save is pending without forcing an immediate save", async () => {
    const mainNotePath = "multiple-windows/focus-main.md";
    const popupNotePath = "multiple-windows/focus-popup.md";
    const mainHandle = await ObsidianApp.getMainWindowHandle();

    await enableDelayedAutosave();
    await ObsidianApp.createAndOpenNote(mainNotePath);
    await ObsidianApp.typeText("pending main");
    await ObsidianApp.waitForPendingStatus();

    const popupHandle = await ObsidianApp.openNoteInNewWindow(popupNotePath);
    await ObsidianApp.focusWindow();
    await browser.pause(1000);
    if (mainHandle) {
      await ObsidianApp.switchToWindow(mainHandle);
    }

    await expect(await ObsidianApp.readVaultFile(mainNotePath)).toBe("");
    await expectSavedAfterDelay(mainNotePath, "pending main");
    await ObsidianApp.switchToWindow(popupHandle);
  });

  it("closes a popup window with pending edits and flushes them to disk", async () => {
    const notePath = "multiple-windows/close-popup.md";
    const mainHandle = await ObsidianApp.getMainWindowHandle();

    await enableDelayedAutosave();
    await ObsidianApp.openNoteInNewWindow(notePath);
    await ObsidianApp.typeText("close popup");
    await browser.pause(1000);
    await expect(await ObsidianApp.readVaultFile(notePath)).toBe("");

    await browser.closeWindow();
    if (mainHandle) {
      await ObsidianApp.switchToWindow(mainHandle);
    }
    await expectSavedAfterDelay(notePath, "close popup", 7000, { waitForStatus: false });
  });

  it("switches to another note without forcing an immediate save and still saves on the timer", async () => {
    const originalNotePath = "switching/switch-away-source.md";
    const targetNotePath = "switching/switch-away-target.md";

    await enableDelayedAutosave();
    await ObsidianApp.createAndOpenNote(originalNotePath);
    await ObsidianApp.typeText("switch away");
    await ObsidianApp.waitForPendingStatus();
    await ObsidianApp.createAndOpenNote(targetNotePath, "other note");
    await browser.pause(1000);
    await expect(await ObsidianApp.readVaultFile(originalNotePath)).toBe("");

    await expectSavedAfterDelay(originalNotePath, "switch away");
  });

  it("opens an existing note through the quick switcher from a blank leaf without blanking the file", async () => {
    const targetNotePath = "switching/quick-switch-blank-target.md";
    const targetContent = "quick switch target should stay intact";

    await enableDelayedAutosave();
    await ObsidianApp.createAndOpenNote("switching/quick-switch-anchor.md", "anchor");
    await ObsidianApp.createAndOpenNote(targetNotePath, targetContent);
    await ObsidianApp.closeActiveTab();
    await browser.pause(300);
    await expectQuickSwitcherLoadsTargetContent(targetNotePath, targetContent);
    await browser.pause(4000);

    await expect(await ObsidianApp.readVaultFile(targetNotePath)).toBe(targetContent);
  });

  it("opens an existing note through the quick switcher from a saved note without showing the previous note's content", async () => {
    const sourceNotePath = "switching/quick-switch-saved-source.md";
    const targetNotePath = "switching/quick-switch-saved-target.md";
    const sourceContent = "quick switch saved source content";
    const targetContent = "quick switch saved target content";

    await enableDelayedAutosave();
    await ObsidianApp.createAndOpenNote(targetNotePath, targetContent);
    await ObsidianApp.createAndOpenNote(sourceNotePath, sourceContent);
    await ObsidianApp.runSaveCommand();
    await ObsidianApp.waitForSavedStatus();

    await expectQuickSwitcherLoadsTargetContent(targetNotePath, targetContent);
    await browser.pause(4000);

    await expect(await ObsidianApp.readVaultFile(sourceNotePath)).toBe(sourceContent);
    await expect(await ObsidianApp.readVaultFile(targetNotePath)).toBe(targetContent);
  });

  it("opens an existing note through the quick switcher from another unsaved note without showing the previous note's content", async () => {
    const sourceNotePath = "switching/quick-switch-source.md";
    const targetNotePath = "switching/quick-switch-target.md";
    const sourceContent = "quick switch pending source content";
    const targetContent = "quick switch target content should survive";

    await enableDelayedAutosave();
    await ObsidianApp.createAndOpenNote(targetNotePath, targetContent);
    await ObsidianApp.createAndOpenNote(sourceNotePath);
    await ObsidianApp.typeText(sourceContent);
    await ObsidianApp.waitForPendingStatus();
    await expectQuickSwitcherLoadsTargetContent(targetNotePath, targetContent);

    await expectSavedAfterDelay(sourceNotePath, sourceContent);
    await expect(await ObsidianApp.readVaultFile(targetNotePath)).toBe(targetContent);
  });

  it("keeps subsequent target edits scoped to the target note after quick switching from another unsaved note", async () => {
    const sourceNotePath = "switching/quick-switch-edit-source.md";
    const targetNotePath = "switching/quick-switch-edit-target.md";
    const sourceContent = "source note pending content";
    const targetContent = "target note original content";
    const targetSuffix = " plus target edit";

    await enableDelayedAutosave();
    await ObsidianApp.createAndOpenNote(targetNotePath, targetContent);
    await ObsidianApp.createAndOpenNote(sourceNotePath);
    await ObsidianApp.typeText(sourceContent);
    await ObsidianApp.waitForPendingStatus();

    await expectQuickSwitcherLoadsTargetContent(targetNotePath, targetContent);
    await ObsidianApp.typeText(targetSuffix);
    await ObsidianApp.waitForPendingStatus();

    await expectSavedAfterDelay(targetNotePath, `${targetContent}${targetSuffix}`);
    await expectSavedAfterDelay(sourceNotePath, sourceContent);
  });

  it("keeps subsequent target edits scoped to the target note after quick switching from a saved note", async () => {
    const sourceNotePath = "switching/quick-switch-saved-edit-source.md";
    const targetNotePath = "switching/quick-switch-saved-edit-target.md";
    const sourceContent = "saved source note content";
    const targetContent = "saved target note content";
    const targetSuffix = " plus fresh target edit";

    await enableDelayedAutosave();
    await ObsidianApp.createAndOpenNote(targetNotePath, targetContent);
    await ObsidianApp.createAndOpenNote(sourceNotePath, sourceContent);
    await ObsidianApp.runSaveCommand();
    await ObsidianApp.waitForSavedStatus();

    await expectQuickSwitcherLoadsTargetContent(targetNotePath, targetContent);
    await ObsidianApp.typeText(targetSuffix);
    await ObsidianApp.waitForPendingStatus();

    await expectSavedAfterDelay(targetNotePath, `${targetContent}${targetSuffix}`);
    await expect(await ObsidianApp.readVaultFile(sourceNotePath)).toBe(sourceContent);
  });

  it("opens an existing note through the quick switcher after manually saving the current note without copying that content", async () => {
    const sourceNotePath = "switching/quick-switch-manual-save-source.md";
    const targetNotePath = "switching/quick-switch-manual-save-target.md";
    const sourceContent = "quick switch manual save source content";
    const targetContent = "quick switch manual save target content";

    await enableDelayedAutosave();
    await ObsidianApp.createAndOpenNote(targetNotePath, targetContent);
    await ObsidianApp.createAndOpenNote(sourceNotePath);
    await ObsidianApp.typeText(sourceContent);
    await ObsidianApp.waitForPendingStatus();
    await ObsidianApp.runSaveCommand();
    await ObsidianApp.waitForSavedStatus();

    await expectQuickSwitcherLoadsTargetContent(targetNotePath, targetContent);
    await browser.pause(4000);

    await expect(await ObsidianApp.readVaultFile(sourceNotePath)).toBe(sourceContent);
    await expect(await ObsidianApp.readVaultFile(targetNotePath)).toBe(targetContent);
  });

  it("loses the cursor position after switching away from a saved note and back", async () => {
    const originalNotePath = "switching/cursor-source.md";
    const targetNotePath = "switching/cursor-target.md";

    await enableDelayedAutosave();
    await ObsidianApp.createAndOpenNote(originalNotePath, "first line\nsecond line\nthird line");
    await ObsidianApp.runSaveCommand();
    await browser.pause(500);

    await ObsidianApp.setCursor(1, 4);
    await expect(await ObsidianApp.getCursor()).toEqual({ line: 1, ch: 4 });

    await ObsidianApp.createAndOpenNote(targetNotePath, "other note");
    await ObsidianApp.openExistingNote(originalNotePath, { preserveCursor: true });

    await expect(await ObsidianApp.getCursor()).toEqual({ line: 1, ch: 4 });
  });

  it("keeps header wikilink navigation scrolled to the linked heading", async () => {
    const sourceNotePath = "switching/header-link-source.md";
    const targetNotePath = "switching/header-link-target.md";
    const targetHeader = "Linked Heading";
    const targetLinkPath = targetNotePath.replace(/\.md$/u, "");
    const targetContent = [
      "top of note",
      ...Array.from({ length: 40 }, (_, index) => `filler line ${index + 1}`),
      `# ${targetHeader}`,
      "linked section",
    ].join("\n");

    await enableDelayedAutosave();
    await ObsidianApp.createAndOpenNote(targetNotePath, targetContent);
    await ObsidianApp.runSaveCommand();
    await ObsidianApp.waitForSavedStatus();
    await ObsidianApp.setCursor(0, 0);

    await ObsidianApp.createAndOpenNote(sourceNotePath, `[[${targetLinkPath}#${targetHeader}]]`);
    await ObsidianApp.openWikiLink(`${targetLinkPath}#${targetHeader}`, sourceNotePath);
    await ObsidianApp.waitForActiveFile(targetNotePath);

    await browser.waitUntil(async () => {
      return ObsidianApp.isEditorLineVisible(`# ${targetHeader}`);
    }, {
      timeout: 5000,
      timeoutMsg: "Header wikilink navigation did not reach the linked heading.",
    });

    await expect(await ObsidianApp.isEditorLineVisible(`# ${targetHeader}`)).toBe(true);
  });

  it("closes a note tab with pending edits and saves the note", async () => {
    const notePath = "switching/close-tab.md";

    await enableDelayedAutosave();
    await ObsidianApp.openNoteInNewTab("switching/anchor.md", "anchor");
    await ObsidianApp.openNoteInNewTab(notePath);
    await ObsidianApp.typeText("tab close save");
    await ObsidianApp.waitForPendingStatus();
    await browser.pause(1000);
    await expect(await ObsidianApp.readVaultFile(notePath)).toBe("");

    await ObsidianApp.closeActiveTab();
    await expectSavedAfterDelay(notePath, "tab close save");
  });

  it("focuses another Obsidian window without forcing an immediate save", async () => {
    const mainNotePath = "switching/window-switch-main.md";
    const popupNotePath = "switching/window-switch-popup.md";
    const mainHandle = await ObsidianApp.getMainWindowHandle();

    await enableDelayedAutosave();
    await ObsidianApp.createAndOpenNote(mainNotePath);
    await ObsidianApp.typeText("window switch");
    await ObsidianApp.waitForPendingStatus();

    const popupHandle = await ObsidianApp.openNoteInNewWindow(popupNotePath, "popup anchor");
    await browser.pause(1000);
    if (mainHandle) {
      await ObsidianApp.switchToWindow(mainHandle);
    }

    await expect(await ObsidianApp.readVaultFile(mainNotePath)).toBe("");
    await expectSavedAfterDelay(mainNotePath, "window switch");
    await ObsidianApp.switchToWindow(popupHandle);
  });

  it("switches to another app before the delay finishes without forcing a save", async () => {
    const notePath = "switching/blur-window.md";

    await enableDelayedAutosave();
    await ObsidianApp.createAndOpenNote(notePath);
    await ObsidianApp.typeText("blur test");
    await ObsidianApp.waitForPendingStatus();
    await ObsidianApp.triggerWindowBlur();
    await browser.pause(1000);

    await expect(await ObsidianApp.readVaultFile(notePath)).toBe("");
    await expectSavedAfterDelay(notePath, "blur test");
  });

  it("disables and reloads the plugin while nothing is pending and keeps editing working", async () => {
    const notePath = "switching/reload-plugin.md";

    await expect(await ObsidianApp.getStatusIndicatorCount()).toBe(1);
    await ObsidianApp.reloadPlugin();
    await expect(await ObsidianApp.getStatusIndicatorCount()).toBe(1);
    await enableDelayedAutosave();
    await ObsidianApp.createAndOpenNote(notePath);
    await ObsidianApp.typeText("still works");
    await ObsidianApp.waitForPendingStatus();

    await expectSavedAfterDelay(notePath, "still works");
  });

  it("changes the status dot to pending soon after editing starts", async () => {
    const notePath = "status/pending-tooltip.md";

    await enableDelayedAutosave(30);
    await ObsidianApp.createAndOpenNote(notePath);
    await ObsidianApp.typeText("x");
    await ObsidianApp.waitForPendingStatus();
    await expect(await ObsidianApp.getStatusIndicatorTitle()).toBe("Changes pending save");
  });

  it("changes the status dot back to saved after autosave completes", async () => {
    const notePath = "status/saved-tooltip.md";

    await enableDelayedAutosave();
    await ObsidianApp.createAndOpenNote(notePath);
    await ObsidianApp.typeText("saved again");
    await ObsidianApp.waitForPendingStatus();
    await expectSavedAfterDelay(notePath, "saved again");
    await expect(await ObsidianApp.getStatusIndicatorTitle()).toBe("All changes saved");
  });

  it("keeps the status saved after renaming an existing file via the title in delayed autosave mode", async () => {
    const notePath = "status/rename-title-delayed-source.md";
    const expectedNotePath = "status/rename-title-delayed-renamed.md";

    await enableDelayedAutosave();
    await ObsidianApp.createAndOpenNote(notePath, "saved content");
    await ObsidianApp.waitForSavedStatus();

    await ObsidianApp.renameActiveFileViaTitle("rename-title-delayed-renamed");

    await expect(await ObsidianApp.getActiveFilePath()).toBe(expectedNotePath);
    await expect(await ObsidianApp.readVaultFile(expectedNotePath)).toBe("saved content");
    await expect(await ObsidianApp.getStatusIndicatorTitle()).toBe("All changes saved");
  });

  it("keeps the status saved after renaming an existing file via the file manager in delayed autosave mode", async () => {
    const notePath = "status/rename-sidebar-delayed-source.md";
    const expectedNotePath = "status/rename-sidebar-delayed-renamed.md";

    await enableDelayedAutosave();
    await ObsidianApp.createAndOpenNote(notePath, "saved content");
    await ObsidianApp.waitForSavedStatus();

    await ObsidianApp.renameActiveFileViaFileManager("rename-sidebar-delayed-renamed");

    await expect(await ObsidianApp.getActiveFilePath()).toBe(expectedNotePath);
    await expect(await ObsidianApp.readVaultFile(expectedNotePath)).toBe("saved content");
    await expect(await ObsidianApp.getStatusIndicatorTitle()).toBe("All changes saved");
  });

  it("keeps the indicator pending until two different files have both saved", async () => {
    const firstNotePath = "status/two-files-first.md";
    const secondNotePath = "status/two-files-second.md";

    await enableDelayedAutosave();
    await ObsidianApp.createAndOpenNote(firstNotePath);
    await ObsidianApp.typeText("first");
    await ObsidianApp.waitForPendingStatus();
    await browser.pause(1500);
    await ObsidianApp.openNoteInNewTab(secondNotePath);
    await ObsidianApp.typeText("second");
    await ObsidianApp.waitForPendingStatus();

    await ObsidianApp.waitForVaultFileContent(firstNotePath, "first", 5000);
    await expect(await ObsidianApp.getStatusIndicatorTitle()).toBe("Changes pending save");
    await expectSavedAfterDelay(secondNotePath, "second");
  });

  it("enables complete autosave disablement, hides save delay, and shows the warning", async () => {
    await enableDelayedAutosave(10);
    await ObsidianApp.openPluginSettingsTab();
    await ObsidianApp.toggleDisableAutosaveSetting();

    await browser.waitUntil(async () => !(await ObsidianApp.isSaveDelaySettingVisible()), {
      timeout: 5000,
      timeoutMsg: "Save delay control stayed visible after disabling autosave.",
    });

    await expect(await ObsidianApp.getSettingDescription("Warning")).toContain("Automatic saves are fully disabled");
  });

  it("keeps changes pending until manual save when autosave is completely disabled", async () => {
    const notePath = "settings/manual-only-pending.md";

    await enableManualOnlyMode();
    await ObsidianApp.createAndOpenNote(notePath);
    await ObsidianApp.typeText("still pending");
    await ObsidianApp.waitForPendingStatus();
    await browser.pause(4500);
    await expect(await ObsidianApp.readVaultFile(notePath)).toBe("");

    await ObsidianApp.runSaveCommand();
    await expectSavedAfterDelay(notePath, "still pending", 4000);
  });

  it("does not update workspace.json after sidebar note switches without note edits in manual-only mode", async () => {
    const firstNotePath = "settings/manual-only-switch-first.md";
    const secondNotePath = "settings/manual-only-switch-second.md";
    const firstNoteContent = "first note stays saved";
    const secondNoteContent = "second note stays saved";

    await enableManualOnlyMode();
    await enableWorkspaceLayoutDeferral();
    await ObsidianApp.createAndOpenNote(firstNotePath, firstNoteContent);
    await ObsidianApp.createAndOpenNote(secondNotePath, secondNoteContent);
    const firstNoteMtimeMs = await ObsidianApp.getVaultFileMtimeMs(firstNotePath);
    const secondNoteMtimeMs = await ObsidianApp.getVaultFileMtimeMs(secondNotePath);

    await ObsidianApp.clickSidebarNote(firstNotePath);
    await browser.pause(2500);
    const initialWorkspaceMtimeMs = await ObsidianApp.getWorkspaceFileMtimeMs();

    await ObsidianApp.clickSidebarNote(secondNotePath);
    await browser.pause(2500);

    await expect(await ObsidianApp.readVaultFile(firstNotePath)).toBe(firstNoteContent);
    await expect(await ObsidianApp.readVaultFile(secondNotePath)).toBe(secondNoteContent);
    await expect(await ObsidianApp.getVaultFileMtimeMs(firstNotePath)).toBe(firstNoteMtimeMs);
    await expect(await ObsidianApp.getVaultFileMtimeMs(secondNotePath)).toBe(secondNoteMtimeMs);
    await expect(await ObsidianApp.getWorkspaceFileMtimeMs()).toBe(initialWorkspaceMtimeMs);

    await ObsidianApp.openExistingNote(firstNotePath);
    await ObsidianApp.typeText(" plus a real edit");
    await expect(await ObsidianApp.readVaultFile(firstNotePath)).toBe(firstNoteContent);

    await ObsidianApp.runSaveCommand();
    await expectSavedAfterDelay(firstNotePath, `${firstNoteContent} plus a real edit`, 4000);
    await expect(await ObsidianApp.readVaultFile(secondNotePath)).toBe(secondNoteContent);
  });

  it("cancels same-leaf note switching in manual-only mode and keeps the unsaved note visible", async () => {
    const sourceNotePath = "settings/manual-only-switch-cancel-source.md";
    const targetNotePath = "settings/manual-only-switch-cancel-target.md";

    await enableManualOnlyMode();
    await ObsidianApp.createAndOpenNote(targetNotePath, "saved target");
    await ObsidianApp.createAndOpenNote(sourceNotePath);
    await ObsidianApp.typeText("keep me visible");
    await ObsidianApp.waitForPendingStatus();
    await ObsidianApp.installConfirmStub(false);

    await ObsidianApp.requestOpenExistingNote(targetNotePath);
    const messages = await ObsidianApp.getConfirmMessages();

    await expect(messages[0]).toContain("discard those changes");
    await expect(await ObsidianApp.getActiveFilePath()).toBe(sourceNotePath);
    await expect(await ObsidianApp.getActiveEditorContent()).toBe("keep me visible");
    await expect(await ObsidianApp.readVaultFile(sourceNotePath)).toBe("");
    await expect(await ObsidianApp.readVaultFile(targetNotePath)).toBe("saved target");
    await ObsidianApp.restoreConfirm();
  });

  it("allows same-leaf note switching in manual-only mode after discarding unsaved changes", async () => {
    const sourceNotePath = "settings/manual-only-switch-discard-source.md";
    const targetNotePath = "settings/manual-only-switch-discard-target.md";

    await enableManualOnlyMode();
    await ObsidianApp.createAndOpenNote(targetNotePath, "saved target");
    await ObsidianApp.createAndOpenNote(sourceNotePath);
    await ObsidianApp.typeText("discard me");
    await ObsidianApp.waitForPendingStatus();
    await ObsidianApp.installConfirmStub(true);

    await ObsidianApp.openExistingNote(targetNotePath);
    const messages = await ObsidianApp.getConfirmMessages();

    await expect(messages[0]).toContain("discard those changes");
    await expect(await ObsidianApp.getActiveFilePath()).toBe(targetNotePath);
    await expect(await ObsidianApp.getActiveEditorContent()).toBe("saved target");
    await expect(await ObsidianApp.readVaultFile(sourceNotePath)).toBe("");
    await expect(await ObsidianApp.readVaultFile(targetNotePath)).toBe("saved target");
    await ObsidianApp.restoreConfirm();
  });

  it("keeps another dirty tab unsaved when discarding a duplicate tab in manual-only mode", async () => {
    const notePath = "settings/manual-only-duplicate-tab.md";

    await enableManualOnlyMode();
    await ObsidianApp.createAndOpenNote(notePath);
    await ObsidianApp.typeText("saved base");
    await ObsidianApp.runSaveCommand();
    await expectSavedAfterDelay(notePath, "saved base", 4000);

    await ObsidianApp.typeText(" plus unsaved");
    await ObsidianApp.waitForPendingStatus();
    await ObsidianApp.openExistingNoteInNewTab(notePath);
    await ObsidianApp.installConfirmStub(true);

    await ObsidianApp.closeActiveTab();
    const messages = await ObsidianApp.getConfirmMessages();

    await expect(messages[0]).toContain("discard those changes");
    await expect(await ObsidianApp.getActiveFilePath()).toBe(notePath);
    await expect(await ObsidianApp.getActiveEditorContent()).toBe("saved base plus unsaved");
    await expect(await ObsidianApp.readVaultFile(notePath)).toBe("saved base");
    await expect(await ObsidianApp.getStatusIndicatorTitle()).toBe("Changes pending save");

    await ObsidianApp.runSaveCommand();
    await expectSavedAfterDelay(notePath, "saved base plus unsaved", 4000);
    await ObsidianApp.restoreConfirm();
  });

  it("cancels deleting a dirty file in manual-only mode and keeps it pending", async () => {
    const notePath = "settings/manual-only-delete-cancel.md";

    await enableManualOnlyMode();
    await ObsidianApp.createAndOpenNote(notePath, "saved base");
    await ObsidianApp.runSaveCommand();
    await expectSavedAfterDelay(notePath, "saved base", 4000);

    await ObsidianApp.typeText(" plus unsaved");
    await ObsidianApp.waitForPendingStatus();
    await ObsidianApp.installConfirmStub(false);

    await ObsidianApp.deleteActiveFile();
    const messages = await ObsidianApp.getConfirmMessages();

    await expect(messages[0]).toContain("Delete the file and discard those changes");
    await expect(await ObsidianApp.getActiveFilePath()).toBe(notePath);
    await expect(await ObsidianApp.getActiveEditorContent()).toBe("saved base plus unsaved");
    await expect(await ObsidianApp.readVaultFile(notePath)).toBe("saved base");
    await expect(await ObsidianApp.getStatusIndicatorTitle()).toBe("Changes pending save");
    await ObsidianApp.restoreConfirm();
  });

  it("deletes a dirty file in manual-only mode only after confirming discard and clears pending state", async () => {
    const notePath = "settings/manual-only-delete-confirm.md";

    await enableManualOnlyMode();
    await ObsidianApp.createAndOpenNote(notePath, "saved base");
    await ObsidianApp.runSaveCommand();
    await expectSavedAfterDelay(notePath, "saved base", 4000);

    await ObsidianApp.typeText(" plus unsaved");
    await ObsidianApp.waitForPendingStatus();
    await ObsidianApp.installConfirmStub(true);

    await ObsidianApp.deleteActiveFile();
    const messages = await ObsidianApp.getConfirmMessages();

    await expect(messages[0]).toContain("Delete the file and discard those changes");
    await ObsidianApp.waitForVaultFileMissing(notePath, 10000);
    await expect(await ObsidianApp.getActiveFilePath()).not.toBe(notePath);
    await ObsidianApp.waitForSavedStatus();
    await expect(await ObsidianApp.getStatusIndicatorTitle()).toBe("All changes saved");
    await ObsidianApp.restoreConfirm();
  });

  it("flushes deferred workspace.json when manual save succeeds", async () => {
    const firstNotePath = "settings/manual-only-layout-flush-first.md";
    const secondNotePath = "settings/manual-only-layout-flush-second.md";

    await enableManualOnlyMode();
    await enableWorkspaceLayoutDeferral();
    await ObsidianApp.createAndOpenNote(firstNotePath, "first");
    await ObsidianApp.createAndOpenNote(secondNotePath, "second");
    await ObsidianApp.clickSidebarNote(firstNotePath);
    await browser.pause(2500);
    const initialWorkspaceMtimeMs = await ObsidianApp.getWorkspaceFileMtimeMs();

    await ObsidianApp.clickSidebarNote(secondNotePath);
    await browser.pause(2500);
    await expect(await ObsidianApp.getWorkspaceFileMtimeMs()).toBe(initialWorkspaceMtimeMs);

    await ObsidianApp.openExistingNote(firstNotePath);
    await ObsidianApp.typeText(" plus edit");
    await ObsidianApp.runSaveCommand();
    await expectSavedAfterDelay(firstNotePath, "first plus edit", 4000);
    await ObsidianApp.waitForWorkspaceFileMtimeChange(initialWorkspaceMtimeMs, 4000);
  });

  it("flushes deferred workspace.json when autosave completes", async () => {
    const firstNotePath = "settings/autosave-layout-flush-first.md";
    const secondNotePath = "settings/autosave-layout-flush-second.md";

    await enableDelayedAutosave();
    await enableWorkspaceLayoutDeferral();
    await ObsidianApp.createAndOpenNote(firstNotePath, "first");
    await ObsidianApp.createAndOpenNote(secondNotePath, "second");
    await ObsidianApp.clickSidebarNote(firstNotePath);
    await browser.pause(2500);
    const initialWorkspaceMtimeMs = await ObsidianApp.getWorkspaceFileMtimeMs();

    await ObsidianApp.clickSidebarNote(secondNotePath);
    await browser.pause(2500);
    await expect(await ObsidianApp.getWorkspaceFileMtimeMs()).toBe(initialWorkspaceMtimeMs);

    await ObsidianApp.openExistingNote(firstNotePath);
    await ObsidianApp.typeText(" plus autosave");
    await ObsidianApp.waitForPendingStatus();
    await expectSavedAfterDelay(firstNotePath, "first plus autosave");
    await ObsidianApp.waitForWorkspaceFileMtimeChange(initialWorkspaceMtimeMs, 4000);
  });

  it("flushes deferred workspace.json after a 3 second workspace layout delay", async () => {
    const firstNotePath = "settings/layout-delay-3s-first.md";
    const secondNotePath = "settings/layout-delay-3s-second.md";

    await enableManualOnlyMode();
    await enableWorkspaceLayoutDeferral(3);
    await ObsidianApp.createAndOpenNote(firstNotePath, "first");
    await ObsidianApp.createAndOpenNote(secondNotePath, "second");
    await ObsidianApp.clickSidebarNote(firstNotePath);
    await browser.pause(2500);
    const initialWorkspaceMtimeMs = await ObsidianApp.getWorkspaceFileMtimeMs();

    await ObsidianApp.clickSidebarNote(secondNotePath);
    await browser.pause(2200);
    await expect(await ObsidianApp.getWorkspaceFileMtimeMs()).toBe(initialWorkspaceMtimeMs);
    await ObsidianApp.waitForWorkspaceFileMtimeChange(initialWorkspaceMtimeMs, 4000);
  });

  it("flushes deferred workspace.json after a 5 second workspace layout delay", async () => {
    const firstNotePath = "settings/layout-delay-5s-first.md";
    const secondNotePath = "settings/layout-delay-5s-second.md";

    await enableManualOnlyMode();
    await enableWorkspaceLayoutDeferral(5);
    await ObsidianApp.createAndOpenNote(firstNotePath, "first");
    await ObsidianApp.createAndOpenNote(secondNotePath, "second");
    await ObsidianApp.clickSidebarNote(firstNotePath);
    await browser.pause(2500);
    const initialWorkspaceMtimeMs = await ObsidianApp.getWorkspaceFileMtimeMs();

    await ObsidianApp.clickSidebarNote(secondNotePath);
    await browser.pause(4200);
    await expect(await ObsidianApp.getWorkspaceFileMtimeMs()).toBe(initialWorkspaceMtimeMs);
    await ObsidianApp.waitForWorkspaceFileMtimeChange(initialWorkspaceMtimeMs, 4000);
  });

  it("defers direct workspace layout save calls until the configured flush point", async () => {
    const notePath = "settings/manual-only-layout-anchor.md";

    await enableManualOnlyMode();
    await enableWorkspaceLayoutDeferral();
    await ObsidianApp.createAndOpenNote(notePath, "anchor");
    await browser.pause(2500);
    const initialWorkspaceMtimeMs = await ObsidianApp.getWorkspaceFileMtimeMs();

    const layoutSaveMethods = await browser.execute(() => {
      const app = (window as typeof window & { app: any }).app;
      return {
        requestSaveLayout: typeof app.workspace?.requestSaveLayout,
        saveLayout: typeof app.workspace?.saveLayout,
      };
    });

    await browser.execute(async () => {
      const app = (window as typeof window & { app: any }).app;
      await app.workspace?.requestSaveLayout?.();
      await app.workspace?.saveLayout?.();
    });
    await browser.pause(500);

    await expect(await ObsidianApp.getWorkspaceFileMtimeMs()).toBe(initialWorkspaceMtimeMs);
    await ObsidianApp.typeText(" edit");
    await ObsidianApp.runSaveCommand();
    await expectSavedAfterDelay(notePath, "anchor edit", 4000);
    await ObsidianApp.waitForWorkspaceFileMtimeChange(initialWorkspaceMtimeMs, 4000);
    await expect(layoutSaveMethods.requestSaveLayout === "function" || layoutSaveMethods.saveLayout === "function").toBe(true);
  });

  it("flushes pending note changes when closing Obsidian without the quit shortcut in manual-only mode", async () => {
    const notePath = "settings/quit-prompt.md";

    await enableManualOnlyMode();
    await ObsidianApp.createAndOpenNote(notePath);
    await ObsidianApp.typeText("unsaved");
    await ObsidianApp.waitForPendingStatus();
    await browser.execute(() => {
      const app = (window as typeof window & { app: any }).app;
      const plugin = app?.plugins?.plugins?.["autosave-control"] as {
        autosaveController?: { exitApplicationAfterFlush?: () => void };
      } | undefined;
      const controller = plugin?.autosaveController as {
        exitApplicationAfterFlush?: () => void;
      } | undefined;
      const targetWindow = window as typeof window & {
        __ascOriginalExitApplicationAfterFlush?: () => void;
      };
      if (!controller?.exitApplicationAfterFlush) {
        throw new Error("Autosave Control exit handler is not available.");
      }

      targetWindow.__ascOriginalExitApplicationAfterFlush = controller.exitApplicationAfterFlush;
      controller.exitApplicationAfterFlush = () => {};
    });

    try {
      const windowClose = await ObsidianApp.dispatchElectronWindowClose();
      await expect(windowClose.defaultPrevented).toBe(true);
      await expectSavedAfterDelay(notePath, "unsaved", 4000);
    } finally {
      await browser.execute(() => {
        const app = (window as typeof window & { app: any }).app;
        const plugin = app?.plugins?.plugins?.["autosave-control"] as {
          autosaveController?: { exitApplicationAfterFlush?: () => void };
        } | undefined;
        const controller = plugin?.autosaveController as {
          exitApplicationAfterFlush?: () => void;
        } | undefined;
        const targetWindow = window as typeof window & {
          __ascOriginalExitApplicationAfterFlush?: () => void;
        };
        if (controller && targetWindow.__ascOriginalExitApplicationAfterFlush) {
          controller.exitApplicationAfterFlush = targetWindow.__ascOriginalExitApplicationAfterFlush;
        }
        delete targetWindow.__ascOriginalExitApplicationAfterFlush;
      });
    }
  });

  it("cancels the close prompt in manual-only mode and keeps Obsidian open without saving", async () => {
    const notePath = "settings/cancel-quit.md";

    await enableManualOnlyMode();
    await ObsidianApp.createAndOpenNote(notePath);
    await ObsidianApp.typeText("do not discard");
    await ObsidianApp.waitForPendingStatus();
    await ObsidianApp.installConfirmStub(false);

    await ObsidianApp.triggerQuitShortcut();
    const messages = await ObsidianApp.getConfirmMessages();

    await expect(messages[0]).toContain("Quit Obsidian and discard");
    await expect(await ObsidianApp.getActiveFilePath()).toBe(notePath);
    await expect(await ObsidianApp.readVaultFile(notePath)).toBe("");
    await ObsidianApp.restoreConfirm();
  });

  it("re-enables delayed autosave while changes are pending in manual-only mode and resumes the timer", async () => {
    const notePath = "settings/reenable-timer.md";

    await enableManualOnlyMode();
    await ObsidianApp.createAndOpenNote(notePath);
    await ObsidianApp.typeText("resume timer");
    await ObsidianApp.waitForPendingStatus();

    await ObsidianApp.setPluginSettings({ disableAutoSave: false, saveDelaySeconds: SHORT_DELAY_SECONDS });
    await expectSavedAfterDelay(notePath, "resume timer");
  });

  it("changes save delay to another valid value and uses it for the next pending save", async () => {
    const notePath = "settings/change-delay.md";

    await enableDelayedAutosave();
    await ObsidianApp.openPluginSettingsTab();
    await ObsidianApp.setTextSettingValue("Save delay (seconds)", "5");
    await ObsidianApp.createAndOpenNote(notePath);
    await ObsidianApp.typeText("five second save");
    await ObsidianApp.waitForPendingStatus();
    await browser.pause(3500);
    await expect(await ObsidianApp.readVaultFile(notePath)).toBe("");

    await expectSavedAfterDelay(notePath, "five second save", 4000);
  });

  it("clamps save delay values below 3 and above 3600", async () => {
    await enableDelayedAutosave();
    await ObsidianApp.openPluginSettingsTab();
    await ObsidianApp.setTextSettingValue("Save delay (seconds)", "1");
    await expect((await ObsidianApp.getPluginSettings()).saveDelaySeconds).toBe(3);

    await ObsidianApp.openPluginSettingsTab();
    await ObsidianApp.setTextSettingValue("Save delay (seconds)", "7200");
    await expect((await ObsidianApp.getPluginSettings()).saveDelaySeconds).toBe(3600);
  });

  it("falls back to a valid number when save delay input is non-numeric and keeps working", async () => {
    const notePath = "settings/non-numeric-delay.md";

    await enableDelayedAutosave();
    await ObsidianApp.openPluginSettingsTab();
    await ObsidianApp.setTextSettingValue("Save delay (seconds)", "abc");
    await expect((await ObsidianApp.getPluginSettings()).saveDelaySeconds).toBe(10);

    await ObsidianApp.createAndOpenNote(notePath);
    await ObsidianApp.typeText("default fallback");
    await ObsidianApp.waitForPendingStatus();
    await expectSavedAfterDelay(notePath, "default fallback", 16000);
  });

  it("changes the saved and pending status colors and updates the status dot", async () => {
    const notePath = "settings/status-colors.md";

    await enableDelayedAutosave(30);
    await ObsidianApp.openPluginSettingsTab();
    await ObsidianApp.setColorSettingValue("Saved status color", "#ff0000");
    await ObsidianApp.setColorSettingValue("Pending status color", "#0000ff");

    await ObsidianApp.waitForSavedStatus();
    await expect(await ObsidianApp.getStatusIndicatorColor()).toBe("rgb(255, 0, 0)");

    await ObsidianApp.createAndOpenNote(notePath);
    await ObsidianApp.typeText("x");
    await ObsidianApp.waitForPendingStatus();
    await expect(await ObsidianApp.getStatusIndicatorColor()).toBe("rgb(0, 0, 255)");
  });

  it("keeps the status saved after renaming an existing file via the title in manual-only mode", async () => {
    const notePath = "settings/rename-title-manual-source.md";
    const expectedNotePath = "settings/rename-title-manual-renamed.md";

    await enableManualOnlyMode();
    await ObsidianApp.createAndOpenNote(notePath, "saved content");
    await ObsidianApp.runSaveCommand();
    await expectSavedAfterDelay(notePath, "saved content", 4000);

    await ObsidianApp.renameActiveFileViaTitle("rename-title-manual-renamed");

    await expect(await ObsidianApp.getActiveFilePath()).toBe(expectedNotePath);
    await expect(await ObsidianApp.readVaultFile(expectedNotePath)).toBe("saved content");
    await expect(await ObsidianApp.getStatusIndicatorTitle()).toBe("All changes saved");
  });

  it("keeps the status saved after renaming an existing file via the file manager in manual-only mode", async () => {
    const notePath = "settings/rename-sidebar-manual-source.md";
    const expectedNotePath = "settings/rename-sidebar-manual-renamed.md";

    await enableManualOnlyMode();
    await ObsidianApp.createAndOpenNote(notePath, "saved content");
    await ObsidianApp.runSaveCommand();
    await expectSavedAfterDelay(notePath, "saved content", 4000);

    await ObsidianApp.renameActiveFileViaFileManager("rename-sidebar-manual-renamed");

    await expect(await ObsidianApp.getActiveFilePath()).toBe(expectedNotePath);
    await expect(await ObsidianApp.readVaultFile(expectedNotePath)).toBe("saved content");
    await expect(await ObsidianApp.getStatusIndicatorTitle()).toBe("All changes saved");
  });

  it("loads default settings and works from a fresh clean plugin state", async () => {
    const notePath = "settings/fresh-defaults.md";
    await ObsidianApp.clearPluginData();
    await ObsidianApp.reloadPlugin();
    await expect(await ObsidianApp.getStatusIndicatorCount()).toBe(1);
    const settings = await ObsidianApp.getPluginSettings();

    await expect(settings.disableAutoSave).toBe(false);
    await expect(settings.saveDelaySeconds).toBe(10);
    await expect(settings.deferWorkspaceLayoutSaves).toBe(false);
    await expect(settings.workspaceLayoutSaveDelaySeconds).toBe(60);
    await expect(settings.savedStatusColor).toBe("#32cd32");
    await expect(settings.pendingStatusColor).toBe("#00bfff");
    await ObsidianApp.waitForSavedStatus();

    await ObsidianApp.createAndOpenNote(notePath);
    await ObsidianApp.typeText("fresh install works");
    await ObsidianApp.waitForPendingStatus();
  });

  it("blocks a plugin-triggered save before typing when the note is already dirty", async () => {
    const notePath = "regressions/programmatic-save.md";

    await enableDelayedAutosave();
    await ObsidianApp.createAndOpenNote(notePath);
    await ObsidianApp.pasteText("dirty without typing");
    await ObsidianApp.runActiveViewSave();
    await ObsidianApp.waitForPendingStatus();
    await browser.pause(1200);
    await expect(await ObsidianApp.readVaultFile(notePath)).toBe("");

    await expectSavedAfterDelay(notePath, "dirty without typing");
  });
});
