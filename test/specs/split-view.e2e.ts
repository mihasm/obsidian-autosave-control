import { browser, expect } from "@wdio/globals";
import ObsidianApp from "../support/ObsidianApp";

// Split-view edge cases. Changing focus between split-view panes must never
// flip the save-status indicator to "all saved" while an inactive pane still
// holds unsaved edits. These specs pin down the correct behaviour across the
// full matrix of split scenarios: two splits, three splits, the same note in
// several panes, both save modes, and closing panes — asserting that the
// pending count, the status icon and the on-disk bytes always reflect the true
// global state regardless of which pane has focus.

const LONG_SAVE_DELAY_SECONDS = 30;

async function enableManualMode() {
  await ObsidianApp.setPluginSettings({
    disableAutoSave: true,
    saveDelaySeconds: LONG_SAVE_DELAY_SECONDS,
  });
}

async function enableDelayedMode() {
  await ObsidianApp.setPluginSettings({
    disableAutoSave: false,
    saveDelaySeconds: LONG_SAVE_DELAY_SECONDS,
  });
}

describe("Split-view pending state", () => {
  beforeEach(async () => {
    await ObsidianApp.reloadWithFreshVault();
    // Any confirm() in these flows would freeze the renderer and hang the test;
    // none should fire, which we assert where it matters.
    await ObsidianApp.installConfirmStub(true);
  });

  afterEach(async () => {
    await ObsidianApp.restoreConfirm();
  });

  it("manual mode: focusing the other pane keeps the edited pane pending", async () => {
    const noteA = "split/a.md";
    const noteB = "split/b.md";

    await enableManualMode();
    await ObsidianApp.createAndOpenNote(noteA, "note A original");
    await ObsidianApp.openNoteInSplit(noteB, "note B original");

    await ObsidianApp.typeText(" edited-B");
    await ObsidianApp.waitForPendingStatus();
    await expect(await ObsidianApp.getPendingStatusCount()).toBe(1);

    // Focus note A — B is still unsaved, so pending must persist.
    await ObsidianApp.focusLeafForFile(noteA, { preserveCursor: true });
    await browser.pause(300);
    await expect(await ObsidianApp.getPendingStatusCount()).toBe(1);
    await ObsidianApp.waitForPendingStatus();
    await expect(await ObsidianApp.getStatusIndicatorTitle()).toContain("with unsaved changes");
    await expect(await ObsidianApp.readVaultFile(noteB)).toBe("note B original");

    // Focus back to B, then A again — still pending each time, no data lost.
    await ObsidianApp.focusLeafForFile(noteB, { preserveCursor: true });
    await browser.pause(300);
    await expect(await ObsidianApp.getPendingStatusCount()).toBe(1);
    await expect(await ObsidianApp.getActiveEditorContent()).toBe("note B original edited-B");

    await ObsidianApp.focusLeafForFile(noteA, { preserveCursor: true });
    await browser.pause(300);
    await expect(await ObsidianApp.getPendingStatusCount()).toBe(1);
    await ObsidianApp.waitForPendingStatus();

    await expect(await ObsidianApp.getConfirmMessages()).toEqual([]);
  });

  it("manual mode: both panes dirty stays at two pending across every focus change", async () => {
    const noteA = "split/two-a.md";
    const noteB = "split/two-b.md";

    await enableManualMode();
    await ObsidianApp.createAndOpenNote(noteA, "A");
    await ObsidianApp.openNoteInSplit(noteB, "B");

    // Dirty B (active), then dirty A.
    await ObsidianApp.typeText(" b-edit");
    await ObsidianApp.waitForPendingStatus();
    await ObsidianApp.typeTextIntoLeafForFile(noteA, " a-edit");
    await browser.pause(300);
    await expect(await ObsidianApp.getPendingStatusCount()).toBe(2);

    // Bounce focus between the two panes; count must stay at two throughout.
    for (const note of [noteB, noteA, noteB, noteA]) {
      await ObsidianApp.focusLeafForFile(note, { preserveCursor: true });
      await browser.pause(200);
      await expect(await ObsidianApp.getPendingStatusCount()).toBe(2);
      await ObsidianApp.waitForPendingStatus();
    }

    // Neither note reached disk.
    await expect(await ObsidianApp.readVaultFile(noteA)).toBe("A");
    await expect(await ObsidianApp.readVaultFile(noteB)).toBe("B");
    await expect(await ObsidianApp.getConfirmMessages()).toEqual([]);
  });

  it("manual mode: three panes with one dirty note stays pending as focus rotates", async () => {
    const noteA = "split/tri-a.md";
    const noteB = "split/tri-b.md";
    const noteC = "split/tri-c.md";

    await enableManualMode();
    await ObsidianApp.createAndOpenNote(noteA, "A");
    await ObsidianApp.openNoteInSplit(noteB, "B");
    await ObsidianApp.openNoteInSplit(noteC, "C");

    // Only C is edited.
    await ObsidianApp.typeText(" c-edit");
    await ObsidianApp.waitForPendingStatus();
    await expect(await ObsidianApp.getPendingStatusCount()).toBe(1);

    for (const note of [noteA, noteB, noteC, noteA, noteC]) {
      await ObsidianApp.focusLeafForFile(note, { preserveCursor: true });
      await browser.pause(200);
      await expect(await ObsidianApp.getPendingStatusCount()).toBe(1);
      await ObsidianApp.waitForPendingStatus();
    }

    await expect(await ObsidianApp.getStatusIndicatorTitle()).toContain("tri-c");
    await expect(await ObsidianApp.readVaultFile(noteC)).toBe("C");
  });

  it("manual mode: the same note in two panes tracks a single pending entry across focus", async () => {
    const noteA = "split/dup.md";

    await enableManualMode();
    await ObsidianApp.createAndOpenNote(noteA, "shared original");
    // Same note opened again in a split pane.
    await ObsidianApp.openExistingNoteInSplit(noteA);
    await expect(await ObsidianApp.countLeavesForFile(noteA)).toBe(2);

    await ObsidianApp.typeText(" dup-edit");
    await ObsidianApp.waitForPendingStatus();
    await expect(await ObsidianApp.getPendingStatusCount()).toBe(1);

    // Focus the other pane of the same note — still exactly one pending entry.
    await ObsidianApp.focusLeafForFile(noteA, { preserveCursor: true });
    await browser.pause(300);
    await expect(await ObsidianApp.getPendingStatusCount()).toBe(1);
    await ObsidianApp.waitForPendingStatus();
    // Obsidian mirrors the edit into the second pane's editor.
    await expect(await ObsidianApp.getActiveEditorContent()).toBe("shared original dup-edit");
    await expect(await ObsidianApp.readVaultFile(noteA)).toBe("shared original");
  });

  it("manual mode: manually saving one split pane clears only that note", async () => {
    const noteA = "split/save-a.md";
    const noteB = "split/save-b.md";

    await enableManualMode();
    await ObsidianApp.createAndOpenNote(noteA, "A");
    await ObsidianApp.openNoteInSplit(noteB, "B");

    await ObsidianApp.typeText(" b-edit");
    await ObsidianApp.waitForPendingStatus();
    await ObsidianApp.typeTextIntoLeafForFile(noteA, " a-edit");
    await browser.pause(200);
    await expect(await ObsidianApp.getPendingStatusCount()).toBe(2);

    // Save A (the active pane) only. B must remain pending and unwritten.
    await ObsidianApp.runSaveCommand();
    await ObsidianApp.waitForVaultFileContent(noteA, "A a-edit", 7000);
    await expect(await ObsidianApp.getPendingStatusCount()).toBe(1);
    await ObsidianApp.waitForPendingStatus();
    await expect(await ObsidianApp.getStatusIndicatorTitle()).toContain("save-b");
    await expect(await ObsidianApp.readVaultFile(noteB)).toBe("B");

    // Focusing back to B must still show it pending.
    await ObsidianApp.focusLeafForFile(noteB, { preserveCursor: true });
    await browser.pause(300);
    await expect(await ObsidianApp.getPendingStatusCount()).toBe(1);
    await ObsidianApp.waitForPendingStatus();
  });

  it("manual mode: closing a split pane keeps the other note's pending edits", async () => {
    const noteA = "split/close-a.md";
    const noteB = "split/close-b.md";

    await enableManualMode();
    await ObsidianApp.createAndOpenNote(noteA, "A");
    await ObsidianApp.openNoteInSplit(noteB, "B");

    await ObsidianApp.typeText(" b-edit");
    await ObsidianApp.waitForPendingStatus();
    await ObsidianApp.typeTextIntoLeafForFile(noteA, " a-edit");
    await browser.pause(200);
    await expect(await ObsidianApp.getPendingStatusCount()).toBe(2);

    // Close A's pane. Its edits are snapshotted (not written, not discarded), so
    // both notes stay pending and no confirm dialog fires.
    await ObsidianApp.closeLeafForFile(noteA);
    await browser.pause(300);
    await expect(await ObsidianApp.getPendingStatusCount()).toBe(2);
    await ObsidianApp.waitForPendingStatus();
    await expect(await ObsidianApp.readVaultFile(noteA)).toBe("A");
    await expect(await ObsidianApp.readVaultFile(noteB)).toBe("B");
    await expect(await ObsidianApp.getConfirmMessages()).toEqual([]);

    // B is still open and focusable, and remains pending.
    await ObsidianApp.focusLeafForFile(noteB, { preserveCursor: true });
    await browser.pause(200);
    await expect(await ObsidianApp.getPendingStatusCount()).toBe(2);
  });

  it("manual mode: closing the edited pane of a duplicated note keeps it pending in the survivor", async () => {
    const noteA = "split/dup-close.md";

    await enableManualMode();
    await ObsidianApp.createAndOpenNote(noteA, "shared");
    await ObsidianApp.openExistingNoteInSplit(noteA);
    await expect(await ObsidianApp.countLeavesForFile(noteA)).toBe(2);

    // Edit in the active (second) pane, then close that same pane.
    await ObsidianApp.typeText(" dup-edit");
    await ObsidianApp.waitForPendingStatus();
    await ObsidianApp.closeLeafForFile(noteA);
    await browser.pause(300);

    // One pane remains; the note is still pending and not yet on disk.
    await expect(await ObsidianApp.countLeavesForFile(noteA)).toBe(1);
    await expect(await ObsidianApp.getPendingStatusCount()).toBe(1);
    await ObsidianApp.waitForPendingStatus();
    await expect(await ObsidianApp.readVaultFile(noteA)).toBe("shared");

    // The surviving pane still carries the edit and can be saved explicitly.
    await ObsidianApp.focusLeafForFile(noteA, { preserveCursor: true });
    await expect(await ObsidianApp.getActiveEditorContent()).toBe("shared dup-edit");
    await ObsidianApp.runSaveCommand();
    await ObsidianApp.waitForVaultFileContent(noteA, "shared dup-edit", 7000);
    await ObsidianApp.waitForSavedStatus();
    await expect(await ObsidianApp.getPendingStatusCount()).toBe(0);
  });

  it("delayed mode: focusing another split pane does not flush the pending note early", async () => {
    const noteA = "split/delayed-a.md";
    const noteB = "split/delayed-b.md";

    await enableDelayedMode();
    await ObsidianApp.createAndOpenNote(noteA, "A");
    await ObsidianApp.openNoteInSplit(noteB, "B");

    await ObsidianApp.typeText(" b-edit");
    await ObsidianApp.waitForPendingStatus();
    await expect(await ObsidianApp.getPendingStatusCount()).toBe(1);

    // The 30s timer has not fired; focusing A must not force B to disk.
    await ObsidianApp.focusLeafForFile(noteA, { preserveCursor: true });
    await browser.pause(500);
    await expect(await ObsidianApp.getPendingStatusCount()).toBe(1);
    await ObsidianApp.waitForPendingStatus();
    await expect(await ObsidianApp.readVaultFile(noteB)).toBe("B");
  });

  it("manual mode: horizontal split behaves the same as vertical for pending state", async () => {
    const noteA = "split/h-a.md";
    const noteB = "split/h-b.md";

    await enableManualMode();
    await ObsidianApp.createAndOpenNote(noteA, "A");
    await ObsidianApp.openNoteInSplit(noteB, "B", "horizontal");

    await ObsidianApp.typeText(" b-edit");
    await ObsidianApp.waitForPendingStatus();
    await expect(await ObsidianApp.getPendingStatusCount()).toBe(1);

    await ObsidianApp.focusLeafForFile(noteA, { preserveCursor: true });
    await browser.pause(300);
    await expect(await ObsidianApp.getPendingStatusCount()).toBe(1);
    await ObsidianApp.waitForPendingStatus();
    await expect(await ObsidianApp.readVaultFile(noteB)).toBe("B");
  });

  it("manual mode: editing then immediately switching panes keeps the edit pending", async () => {
    const noteA = "split/race-a.md";
    const noteB = "split/race-b.md";

    await enableManualMode();
    await ObsidianApp.createAndOpenNote(noteA, "A");
    await ObsidianApp.openNoteInSplit(noteB, "B");

    // Edit B and switch to A with no settle time in between.
    await ObsidianApp.typeText(" b-edit");
    await ObsidianApp.focusLeafForFile(noteA, { preserveCursor: true });
    await ObsidianApp.waitForPendingStatus();
    await expect(await ObsidianApp.getPendingStatusCount()).toBe(1);
    await expect(await ObsidianApp.readVaultFile(noteB)).toBe("B");

    // B still carries the edit when revisited.
    await ObsidianApp.focusLeafForFile(noteB, { preserveCursor: true });
    await browser.pause(200);
    await expect(await ObsidianApp.getActiveEditorContent()).toBe("B b-edit");
  });

  it("manual mode: a dirty note kept in a background tab stays pending when its tab is hidden", async () => {
    const noteA = "split/bg-a.md";
    const noteB = "split/bg-b.md";

    await enableManualMode();
    // Note B first, then note A in a NEW TAB of the same pane group so B's tab
    // goes to the background (and Obsidian may defer its view).
    await ObsidianApp.createAndOpenNote(noteB, "B");
    await ObsidianApp.typeText(" b-edit");
    await ObsidianApp.waitForPendingStatus();
    await expect(await ObsidianApp.getPendingStatusCount()).toBe(1);

    await ObsidianApp.openNoteInNewTab(noteA, "A");
    await browser.pause(400);
    // B's tab is now hidden; its pending edit must persist and never reach disk.
    await expect(await ObsidianApp.getPendingStatusCount()).toBe(1);
    await ObsidianApp.waitForPendingStatus();
    await expect(await ObsidianApp.readVaultFile(noteB)).toBe("B");

    // Returning to B's tab restores its edit and keeps it pending.
    await ObsidianApp.focusLeafForFile(noteB, { preserveCursor: true });
    await browser.pause(300);
    await expect(await ObsidianApp.getPendingStatusCount()).toBe(1);
    await expect(await ObsidianApp.getActiveEditorContent()).toBe("B b-edit");
  });

  it("manual mode: two independent splits each with a dirty note keep both pending as focus cycles", async () => {
    const noteA = "split/multi-a.md";
    const noteB = "split/multi-b.md";
    const noteC = "split/multi-c.md";
    const noteD = "split/multi-d.md";

    await enableManualMode();
    await ObsidianApp.createAndOpenNote(noteA, "A");
    await ObsidianApp.openNoteInSplit(noteB, "B");
    await ObsidianApp.openNoteInSplit(noteC, "C", "horizontal");
    await ObsidianApp.openNoteInSplit(noteD, "D");

    // Dirty B and D only.
    await ObsidianApp.typeTextIntoLeafForFile(noteB, " b-edit");
    await ObsidianApp.typeTextIntoLeafForFile(noteD, " d-edit");
    await browser.pause(300);
    await expect(await ObsidianApp.getPendingStatusCount()).toBe(2);

    for (const note of [noteA, noteC, noteB, noteD, noteA, noteD, noteB]) {
      await ObsidianApp.focusLeafForFile(note, { preserveCursor: true });
      await browser.pause(150);
      await expect(await ObsidianApp.getPendingStatusCount()).toBe(2);
      await ObsidianApp.waitForPendingStatus();
    }

    const title = await ObsidianApp.getStatusIndicatorTitle();
    await expect(title).toContain("multi-b");
    await expect(title).toContain("multi-d");
    await expect(await ObsidianApp.readVaultFile(noteB)).toBe("B");
    await expect(await ObsidianApp.readVaultFile(noteD)).toBe("D");
    await expect(await ObsidianApp.getConfirmMessages()).toEqual([]);
  });

  it("manual mode: editing one pane never contaminates the other note's content", async () => {
    const noteA = "split/iso-a.md";
    const noteB = "split/iso-b.md";

    await enableManualMode();
    await ObsidianApp.createAndOpenNote(noteA, "alpha");
    await ObsidianApp.openNoteInSplit(noteB, "beta");

    await ObsidianApp.typeText(" b-only");
    await ObsidianApp.waitForPendingStatus();

    // Focus A: its editor must still show the untouched A content.
    await ObsidianApp.focusLeafForFile(noteA, { preserveCursor: true });
    await browser.pause(200);
    await expect(await ObsidianApp.getActiveEditorContent()).toBe("alpha");

    // Focus B: its edit is intact.
    await ObsidianApp.focusLeafForFile(noteB, { preserveCursor: true });
    await browser.pause(200);
    await expect(await ObsidianApp.getActiveEditorContent()).toBe("beta b-only");

    // Save both explicitly and confirm each landed with its own content.
    await ObsidianApp.runSaveCommand();
    await ObsidianApp.waitForVaultFileContent(noteB, "beta b-only", 7000);
    await ObsidianApp.focusLeafForFile(noteA, { preserveCursor: true });
    await ObsidianApp.runSaveCommand();
    await ObsidianApp.waitForVaultFileContent(noteA, "alpha", 7000);
    await ObsidianApp.waitForSavedStatus();
    await expect(await ObsidianApp.getPendingStatusCount()).toBe(0);
  });
});
