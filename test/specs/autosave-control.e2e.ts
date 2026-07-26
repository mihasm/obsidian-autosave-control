import { browser, expect } from "@wdio/globals";
import ObsidianApp from "../support/ObsidianApp";

const SHORT_DELAY_SECONDS = 3;
const DEFAULT_SAVE_WAIT_TIMEOUT_MS = 7000;
const LONG_WORKSPACE_LAYOUT_DELAY_SECONDS = 10;
// Long enough that an external write to the file lands well inside the hold
// window, the way frontmatter-modified-date's timeout does (issue #43).
const EXTERNAL_WRITE_SAVE_DELAY_SECONDS = 8;
// Long enough to blur mid-countdown and still tell "kept the deadline" apart from
// "restarted the delay" without a knife-edge timing margin.
const BLUR_DEADLINE_SAVE_DELAY_SECONDS = 6;

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

  it("restores the cursor position after switching away from a saved note and back", async () => {
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

  it("restores the cursor after switching away from a note with UNSAVED edits and back (manual mode)", async () => {
    const editedNotePath = "switching/manual-cursor-source.md";
    const otherNotePath = "switching/manual-cursor-other.md";

    // Manual mode: edits are withheld from disk and held as pending data, so on
    // switch-back the plugin must re-inject them via setViewData — the call that
    // resets the caret to (0,0) and the entire reason the cursor capture/restore
    // exists. This is the path test #430 above does NOT cover (it saves first).
    await enableManualOnlyMode();
    await ObsidianApp.createAndOpenNote(editedNotePath, "first line\nsecond line\nthird line");

    // Make an unsaved edit so the note carries pending data across the switch.
    // typeText focuses the editor (caret jumps to end-of-doc) then types, so the
    // "X" lands at the very end -> "third lineX", and is never written to disk.
    await ObsidianApp.typeText("X");
    await browser.pause(200);

    // Park the caret somewhere non-trivial; this is the position we expect back.
    await ObsidianApp.setCursor(1, 4);
    await expect(await ObsidianApp.getCursor()).toEqual({ line: 1, ch: 4 });

    // Switch away (plugin snapshots pending data + captures the caret)...
    await ObsidianApp.createAndOpenNote(otherNotePath, "other note");
    // ...and back into the SAME leaf. preserveCursor so the harness does not move
    // the caret to end-of-doc; whatever the plugin leaves is what we assert.
    await ObsidianApp.openExistingNote(editedNotePath, { preserveCursor: true });
    await browser.pause(400); // let the plugin's setTimeout(0) restore fire

    // Control: the unsaved edit survived the round-trip, proving the setViewData
    // re-injection (the caret-clobbering path) actually ran.
    await expect(await ObsidianApp.getActiveEditorContent()).toContain("third lineX");
    // The actual claim under test: the caret is back where we left it.
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

  it("does not restore the captured cursor over a search-result jump (#40)", async () => {
    const notePath = "switching/search-jump.md";
    const anchorPath = "switching/search-jump-anchor.md";
    const matchLine = "needle target line";
    const capturedCursor = { line: 5, ch: 3 };
    const content = [
      "top of note",
      ...Array.from({ length: 60 }, (_, index) => `filler line ${index + 1}`),
      matchLine,
      ...Array.from({ length: 20 }, (_, index) => `tail line ${index + 1}`),
    ].join("\n");

    await enableDelayedAutosave();
    await ObsidianApp.createAndOpenNote(notePath, content);
    await ObsidianApp.runSaveCommand();
    await ObsidianApp.waitForSavedStatus();

    // Park the cursor somewhere non-trivial; this is the position the plugin
    // captures when we switch away, and the one it wrongly restored in #40.
    await ObsidianApp.setCursor(capturedCursor.line, capturedCursor.ch);
    await expect(await ObsidianApp.getCursor()).toEqual(capturedCursor);

    // Switch away (capturing the cursor for this note) then reopen it via a
    // global-search match. The search jump owns where the view lands, so the
    // captured cursor must not be restored over it.
    await ObsidianApp.createAndOpenNote(anchorPath, "anchor");
    await ObsidianApp.openNoteAtSearchMatch(notePath, matchLine);

    // Let the plugin's post-open cursor-restore timeout run. Before the fix it
    // fired setCursor(capturedCursor) here, snapping the view back off the match.
    await browser.pause(300);

    await expect(await ObsidianApp.getCursor()).not.toEqual(capturedCursor);
  });

  it("REPRO #41: an edit during a same-tab switch must not snapshot the previous note's content", async () => {
    const noteA = "leak/note-a.md";
    const noteB = "leak/note-b.md";
    const bodyA = "AAAA original body of note A";
    const bodyB = "BBBB original body of note B";

    // Long delay so held edits stay in RAM (unsaved) until we flush deliberately.
    await enableDelayedAutosave(30);
    await ObsidianApp.createAndOpenNote(noteA, bodyA);
    await ObsidianApp.createAndOpenNote(noteB, bodyB);

    // Give B a real held edit so it has a pending entry, then land back on A.
    await ObsidianApp.openExistingNote(noteB);
    await ObsidianApp.typeText(" [B was edited]");
    await ObsidianApp.openExistingNote(noteA);

    // Switch A -> B and let a user edit (paste/keystroke) land during the load
    // window where the shared view already reports file=B but its editor still
    // holds A's text. The plugin snapshots the live view for B's pending entry;
    // guarding only on view.file.path === B, it captures A's stale content (#41).
    const outcome = await browser.execute(async (aPath: string, bPath: string, aHead: string) => {
      const app = (window as typeof window & { app: any }).app;
      const leaf = app.workspace.getMostRecentLeaf() ?? app.workspace.activeLeaf;
      const view = leaf.view;
      const fileB = app.vault.getAbstractFileByPath(bPath);

      const openPromise = leaf.openFile(fileB);
      let editedInWindow = false;
      let contentWhenEdited: string | null = null;
      const t0 = performance.now();

      for (let i = 0; i < 200000; i++) {
        const inLoadWindow = view.file?.path === bPath && view.getViewData().startsWith(aHead);
        if (inLoadWindow) {
          // Simulate an edit arriving mid-switch: fire the same input event the
          // editor emits on a keystroke/paste, which the plugin treats as activity.
          const editorEl = view.containerEl.querySelector(".cm-editor") as HTMLElement | null;
          if (editorEl) {
            contentWhenEdited = view.getViewData().slice(0, 4);
            editorEl.dispatchEvent(new Event("input", { bubbles: true }));
            editedInWindow = true;
          }
          break;
        }
        if (view.file?.path === bPath && view.getViewData().startsWith("BBBB")) {
          break;
        }
        if (performance.now() - t0 > 3000) {
          break;
        }
        await (i % 2 === 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, 0)));
      }

      await openPromise;
      return { editedInWindow, contentWhenEdited };
    }, noteA, noteB, "AAAA");

    // The repro is only meaningful if the edit actually landed during the window.
    expect(outcome.editedInWindow).toBe(true);

    // Flush held edits to disk (reschedule to a short delay) and let them settle.
    await enableDelayedAutosave(1);
    await browser.pause(3000);

    const diskA = await ObsidianApp.readVaultFile(noteA);
    const diskB = await ObsidianApp.readVaultFile(noteB);

    // Note B must never end up holding note A's content.
    expect(diskB).not.toContain("AAAA");
    expect(diskB).toContain("BBBB");
    expect(diskA).toContain("AAAA");
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
    await expect(await ObsidianApp.getStatusIndicatorTitle()).toContain("with unsaved changes");
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
    await expect(await ObsidianApp.getStatusIndicatorTitle()).toContain("with unsaved changes");
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

  it("switches notes in the same tab in manual-only mode without prompting and keeps the source note pending", async () => {
    const sourceNotePath = "settings/manual-only-switch-keep-source.md";
    const targetNotePath = "settings/manual-only-switch-keep-target.md";

    await enableManualOnlyMode();
    await ObsidianApp.createAndOpenNote(targetNotePath, "saved target");
    await ObsidianApp.createAndOpenNote(sourceNotePath);
    await ObsidianApp.typeText("unsaved source edit");
    await ObsidianApp.waitForPendingStatus();
    // A real confirm() would freeze the renderer and hang the test; stubbing it
    // lets us assert that no prompt is shown and keeps the run alive if the
    // no-prompt behaviour ever regresses.
    await ObsidianApp.installConfirmStub(true);

    await ObsidianApp.openExistingNote(targetNotePath);

    // The switch goes through silently — no discard prompt — and nothing is written.
    await expect(await ObsidianApp.getConfirmMessages()).toEqual([]);
    await expect(await ObsidianApp.getActiveFilePath()).toBe(targetNotePath);
    await expect(await ObsidianApp.getActiveEditorContent()).toBe("saved target");
    await expect(await ObsidianApp.readVaultFile(sourceNotePath)).toBe("");
    await expect(await ObsidianApp.readVaultFile(targetNotePath)).toBe("saved target");
    // The source note is still pending and surfaced in the status-bar tooltip.
    await expect(await ObsidianApp.getStatusIndicatorTitle()).toContain("with unsaved changes");
    await ObsidianApp.restoreConfirm();
  });

  it("restores the source note's unsaved changes when switching back to it in the same tab in manual-only mode", async () => {
    const sourceNotePath = "settings/manual-only-switch-restore-source.md";
    const targetNotePath = "settings/manual-only-switch-restore-target.md";

    await enableManualOnlyMode();
    await ObsidianApp.createAndOpenNote(targetNotePath, "saved target");
    await ObsidianApp.createAndOpenNote(sourceNotePath);
    await ObsidianApp.typeText("changes to restore");
    await ObsidianApp.waitForPendingStatus();

    await ObsidianApp.openExistingNote(targetNotePath);
    await expect(await ObsidianApp.getActiveEditorContent()).toBe("saved target");

    await ObsidianApp.openExistingNote(sourceNotePath);

    // Coming back restores the buffered (still-unsaved) text into the editor.
    await browser.waitUntil(
      async () => (await ObsidianApp.getActiveEditorContent()) === "changes to restore",
      { timeout: 5000, timeoutMsg: "Pending source-note changes were not restored on switch-back." },
    );
    await expect(await ObsidianApp.getActiveFilePath()).toBe(sourceNotePath);
    await expect(await ObsidianApp.readVaultFile(sourceNotePath)).toBe("");
    await expect(await ObsidianApp.getStatusIndicatorTitle()).toContain("with unsaved changes");
  });

  it("keeps the note pending without prompting when closing a duplicate tab in manual-only mode", async () => {
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

    // Closing the duplicate tab no longer prompts; the note stays open and dirty
    // in the other tab and nothing is written to disk.
    await expect(await ObsidianApp.getConfirmMessages()).toEqual([]);
    await expect(await ObsidianApp.getActiveFilePath()).toBe(notePath);
    await expect(await ObsidianApp.getActiveEditorContent()).toBe("saved base plus unsaved");
    await expect(await ObsidianApp.readVaultFile(notePath)).toBe("saved base");
    await expect(await ObsidianApp.getStatusIndicatorTitle()).toContain("with unsaved changes");

    await ObsidianApp.runSaveCommand();
    await expectSavedAfterDelay(notePath, "saved base plus unsaved", 4000);
    await ObsidianApp.restoreConfirm();
  });

  it("keeps a closed note's unsaved changes and restores them when it is reopened in manual-only mode", async () => {
    const anchorNotePath = "settings/manual-only-close-anchor.md";
    const notePath = "settings/manual-only-close-restore.md";

    await enableManualOnlyMode();
    // An anchor tab keeps the workspace alive once the dirty tab is closed.
    await ObsidianApp.createAndOpenNote(anchorNotePath, "anchor");
    await ObsidianApp.openNoteInNewTab(notePath);
    await ObsidianApp.typeText("close me but keep my edits");
    await ObsidianApp.waitForPendingStatus();
    await ObsidianApp.installConfirmStub(true);

    await ObsidianApp.closeActiveTab();

    // Closing the tab prompts nothing, writes nothing, and keeps the note pending.
    await expect(await ObsidianApp.getConfirmMessages()).toEqual([]);
    await expect(await ObsidianApp.readVaultFile(notePath)).toBe("");
    await expect(await ObsidianApp.getStatusIndicatorTitle()).toContain("with unsaved changes");

    await ObsidianApp.openExistingNote(notePath);

    // Reopening the note restores the buffered, still-unsaved text into the editor.
    await browser.waitUntil(
      async () => (await ObsidianApp.getActiveEditorContent()) === "close me but keep my edits",
      { timeout: 5000, timeoutMsg: "Closed note's pending changes were not restored on reopen." },
    );
    await expect(await ObsidianApp.getActiveFilePath()).toBe(notePath);
    await expect(await ObsidianApp.readVaultFile(notePath)).toBe("");
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
    await expect(await ObsidianApp.getStatusIndicatorTitle()).toContain("with unsaved changes");
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

  it("prevents the default window close in manual-only mode so the discard prompt can run", async () => {
    const notePath = "settings/quit-prompt.md";

    await enableManualOnlyMode();
    await ObsidianApp.createAndOpenNote(notePath);
    await ObsidianApp.typeText("unsaved");
    await ObsidianApp.waitForPendingStatus();

    // The electron 'close' listener must preventDefault so Obsidian does not
    // force-destroy the window after 3s, leaving the quit prompt time to run.
    const windowClose = await ObsidianApp.dispatchElectronWindowClose();
    await expect(windowClose.defaultPrevented).toBe(true);
  });

  it("prompts to discard pending changes on window close in manual-only mode and discards on OK", async () => {
    const notePath = "settings/quit-prompt-ok.md";

    await enableManualOnlyMode();
    await ObsidianApp.createAndOpenNote(notePath);
    await ObsidianApp.typeText("unsaved");
    await ObsidianApp.waitForPendingStatus();
    await ObsidianApp.installConfirmStub(true); // OK = discard & close

    try {
      await ObsidianApp.triggerWorkspaceQuit();
      await browser.waitUntil(async () => (await ObsidianApp.getConfirmMessages()).length > 0, {
        timeout: 5000,
        timeoutMsg: "Window-close discard prompt was not shown.",
      });

      const messages = await ObsidianApp.getConfirmMessages();
      await expect(messages[0]).toContain("discard");
      // OK = discard: the pending change is dropped, nothing is written to disk.
      await expect(await ObsidianApp.readVaultFile(notePath)).toBe("");
    } finally {
      await ObsidianApp.restoreConfirm();
    }
  });

  it("keeps Obsidian open and unsaved when the window-close discard prompt is cancelled in manual-only mode", async () => {
    const notePath = "settings/quit-prompt-cancel.md";

    await enableManualOnlyMode();
    await ObsidianApp.createAndOpenNote(notePath);
    await ObsidianApp.typeText("do not discard");
    await ObsidianApp.waitForPendingStatus();
    await ObsidianApp.installConfirmStub(false); // Cancel = keep editing

    try {
      await ObsidianApp.triggerWorkspaceQuit();
      await browser.waitUntil(async () => (await ObsidianApp.getConfirmMessages()).length > 0, {
        timeout: 5000,
        timeoutMsg: "Window-close discard prompt was not shown.",
      });

      const messages = await ObsidianApp.getConfirmMessages();
      await expect(messages[0]).toContain("discard");
      // Cancel keeps the note open and the change unsaved (not written to disk).
      await expect(await ObsidianApp.getActiveFilePath()).toBe(notePath);
      await expect(await ObsidianApp.readVaultFile(notePath)).toBe("");
    } finally {
      await ObsidianApp.restoreConfirm();
    }
  });

  it("re-prompts on a second window close after the first close prompt was cancelled in manual-only mode", async () => {
    const notePath = "settings/quit-prompt-second-close.md";

    await enableManualOnlyMode();
    await ObsidianApp.createAndOpenNote(notePath);
    await ObsidianApp.typeText("keep me unsaved");
    await ObsidianApp.waitForPendingStatus();
    await ObsidianApp.installConfirmStub(false); // Cancel = keep editing (both times)

    try {
      // First X press: drive Obsidian's REAL window-close quit hook. A task is
      // added, so Obsidian holds the close (defaultPrevented) and shows our
      // discard prompt.
      const first = await ObsidianApp.dispatchObsidianBeforeUnload();
      await expect(first.wasArmed).toBe(true);
      await expect(first.defaultPrevented).toBe(true);
      await browser.waitUntil(async () => (await ObsidianApp.getConfirmMessages()).length >= 1, {
        timeout: 5000,
        timeoutMsg: "First window-close prompt was not shown.",
      });

      // Cancel keeps the window open AND must re-arm Obsidian's one-shot quit
      // hook so the next close is intercepted too.
      await browser.waitUntil(async () => await ObsidianApp.isObsidianQuitHookArmed(), {
        timeout: 5000,
        timeoutMsg: "Obsidian quit hook was not re-armed after the first cancel.",
      });
      await expect(await ObsidianApp.getWindowCloseCount()).toBe(0);

      await ObsidianApp.installConfirmStub(false); // reset captured messages; cancel again

      // Second X press without saving: the prompt MUST appear again and the
      // window must NOT close silently.
      const second = await ObsidianApp.dispatchObsidianBeforeUnload();
      await expect(second.wasArmed).toBe(true);
      await expect(second.defaultPrevented).toBe(true);
      await browser.waitUntil(async () => (await ObsidianApp.getConfirmMessages()).length >= 1, {
        timeout: 5000,
        timeoutMsg: "Second window-close prompt was not shown (silent close regression).",
      });

      await expect(await ObsidianApp.getWindowCloseCount()).toBe(0);
      await expect(await ObsidianApp.getActiveFilePath()).toBe(notePath);
      await expect(await ObsidianApp.readVaultFile(notePath)).toBe("");
    } finally {
      await ObsidianApp.restoreConfirm();
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

  it("changes the status icon size in pixels", async () => {
    await enableDelayedAutosave(30);
    await ObsidianApp.openPluginSettingsTab();
    await ObsidianApp.setTextSettingValue("Status icon size (px)", "24");

    await ObsidianApp.waitForSavedStatus();
    await expect(await ObsidianApp.getStatusIndicatorFontSize()).toBe("24px");
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

  // Issue #18: notes were silently cleared on startup. A view whose file had not
  // truly loaded yet (vault still opening / a deferred tab) exposes an empty
  // buffer; Obsidian's own requestSave then queued that blank and the autosave
  // flush wrote it over the real note. The guard must refuse to blank a note that
  // still has content on disk unless a genuine user edit backs the change. The
  // companion "cuts text and saves after the delay" test proves a real emptying
  // still persists, so the guard is not over-broad.
  it("does not blank a note when a not-yet-loaded view triggers a save (issue #18)", async () => {
    const notePath = "regressions/issue-18-load-race.md";
    const realContent = "# Important\n\nThese notes must survive a still-loading view.";

    await enableDelayedAutosave();
    await ObsidianApp.createAndOpenNote(notePath, realContent);
    await ObsidianApp.runActiveViewSave();
    await ObsidianApp.waitForSavedStatus();

    // Empty the buffer with no keystroke (as a still-loading view would), then let
    // Obsidian's requestSave fire — exactly the sequence that used to clear notes.
    await ObsidianApp.setActiveViewDataWithoutEdit("");
    await expect(await ObsidianApp.getActiveEditorContent()).toBe("");
    await ObsidianApp.runActiveViewRequestSave();

    // Wait well past the autosave delay: the real content must still be on disk.
    await browser.pause((SHORT_DELAY_SECONDS + 2) * 1000);
    await expect(await ObsidianApp.readVaultFile(notePath)).toBe(realContent);
  });

  // Issue #43: a plugin that rewrites the file on disk while we hold a save wiped
  // the held edits. Obsidian merges disk changes into an open editor only when the
  // view is marked dirty, and that flag is set by the very requestSave the plugin
  // swallows — so the view looked clean, Obsidian replaced the buffer with the
  // disk content, and the next flush wrote that wiped version back out.
  it("keeps held edits when another plugin rewrites the file on disk (issue #43)", async () => {
    const notePath = "regressions/issue-43-external-frontmatter.md";
    const initialContent = "# Notes\n\nexisting body";
    const typedText = " plus unsaved typing";

    await enableDelayedAutosave(EXTERNAL_WRITE_SAVE_DELAY_SECONDS);
    await ObsidianApp.createAndOpenNote(notePath, initialContent);
    await ObsidianApp.typeText(typedText);
    await ObsidianApp.waitForPendingStatus();

    // Nothing is on disk yet — this is exactly the window in which
    // frontmatter-modified-date fires its processFrontMatter timeout.
    await expect(await ObsidianApp.readVaultFile(notePath)).toBe(initialContent);
    await ObsidianApp.setFrontmatterPropertyExternally(notePath, "modified", "2026-07-26T12:00");
    await browser.pause(1000);

    // The editor must still hold the typing, now merged with the new frontmatter.
    const editorContent = await ObsidianApp.getActiveEditorContent();
    await expect(editorContent).toContain(typedText);
    await expect(editorContent).toContain("modified: 2026-07-26T12:00");
    await expect(editorContent).toContain("existing body");

    // …and the delayed flush must persist the merged text, not a wiped version.
    await ObsidianApp.waitForVaultFileContaining(
      notePath,
      [typedText, "modified: 2026-07-26T12:00", "# Notes"],
      (EXTERNAL_WRITE_SAVE_DELAY_SECONDS + 6) * 1000,
    );
    await ObsidianApp.waitForSavedStatus();
  });

  it("keeps held edits through an external rewrite in manual-only mode (issue #43)", async () => {
    const notePath = "regressions/issue-43-external-frontmatter-manual.md";
    const initialContent = "# Manual\n\nexisting body";
    const typedText = " plus unsaved typing";

    await enableManualOnlyMode();
    await ObsidianApp.createAndOpenNote(notePath, initialContent);
    await ObsidianApp.typeText(typedText);
    await ObsidianApp.waitForPendingStatus();

    await ObsidianApp.setFrontmatterPropertyExternally(notePath, "modified", "2026-07-26T12:00");
    await browser.pause(1000);

    await expect(await ObsidianApp.getActiveEditorContent()).toContain(typedText);
    // Manual mode still writes nothing of its own: the typing stays held.
    await expect(await ObsidianApp.readVaultFile(notePath)).not.toContain(typedText);
    await expect(await ObsidianApp.getPendingStatusCount()).toBe(1);

    await ObsidianApp.runSaveCommand();
    await ObsidianApp.waitForVaultFileContaining(notePath, [typedText, "modified: 2026-07-26T12:00"]);
    await ObsidianApp.waitForSavedStatus();
  });

  // Companion to the #43 fix: marking the view dirty means Obsidian's blur-driven
  // saveImmediately() now reaches the wrapped save(). Suppressing that save must
  // not re-arm the timer, or clicking out of the editor would postpone every write
  // by another full delay.
  it("does not postpone the pending save when the editor loses focus", async () => {
    const notePath = "regressions/issue-43-blur-keeps-deadline.md";
    const typedText = "typed then clicked away";

    await enableDelayedAutosave(BLUR_DEADLINE_SAVE_DELAY_SECONDS);
    await ObsidianApp.createAndOpenNote(notePath);
    await ObsidianApp.typeText(typedText);
    await ObsidianApp.waitForPendingStatus();

    // Blur halfway through the countdown. The save must still land on the original
    // deadline, i.e. within the remaining half plus slack — not a full delay later.
    await browser.pause((BLUR_DEADLINE_SAVE_DELAY_SECONDS / 2) * 1000);
    await ObsidianApp.blurEditor();
    await expect(await ObsidianApp.readVaultFile(notePath)).toBe("");

    await ObsidianApp.waitForVaultFileContent(
      notePath,
      typedText,
      (BLUR_DEADLINE_SAVE_DELAY_SECONDS / 2) * 1000 + 2500,
    );
  });
});
