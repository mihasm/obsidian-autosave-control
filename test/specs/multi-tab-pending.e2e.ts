import { browser, expect } from "@wdio/globals";
import ObsidianApp from "../support/ObsidianApp";

// Reproduces the reported bug: note A is edited (not saved), note B is opened in
// a NEW tab, edited and saved. The status indicator must keep showing "pending"
// because A is still dirty — saving B must never report "all changes saved" while
// A's edits are still buffered and unwritten on disk.

const LONG_SAVE_DELAY_SECONDS = 30;

describe("Multi-tab pending state", () => {
  beforeEach(async () => {
    await ObsidianApp.reloadWithFreshVault();
  });

  it("manual mode: saving note B in a new tab keeps note A pending and unsaved", async () => {
    const noteA = "multitab/a.md";
    const noteB = "multitab/b.md";

    await ObsidianApp.setPluginSettings({
      disableAutoSave: true,
      saveDelaySeconds: LONG_SAVE_DELAY_SECONDS,
    });

    // A native confirm() would freeze the renderer and hang the test. Opening B in
    // a new tab must NOT prompt (no leaf switch on A's leaf) — assert that later.
    await ObsidianApp.installConfirmStub(true);

    await ObsidianApp.createAndOpenNote(noteA);
    await ObsidianApp.typeText("note A pending edit");
    await ObsidianApp.waitForPendingStatus();
    await expect(await ObsidianApp.getPendingStatusCount()).toBe(1);

    await ObsidianApp.openNoteInNewTab(noteB, "");
    await ObsidianApp.typeText("note B edit");
    await ObsidianApp.runSaveCommand();

    // B is written to disk...
    await ObsidianApp.waitForVaultFileContent(noteB, "note B edit", 7000);

    // ...but A is still pending: the queue still holds it, the dot is still
    // "pending", and A's bytes never reached disk.
    await expect(await ObsidianApp.getPendingStatusCount()).toBe(1);
    await expect(await ObsidianApp.getStatusIndicatorTitle()).toBe("Changes pending save");
    await expect(await ObsidianApp.readVaultFile(noteA)).toBe("");

    // No confirm dialog should have been triggered by opening B in a new tab.
    await expect(await ObsidianApp.getConfirmMessages()).toEqual([]);

    await ObsidianApp.restoreConfirm();
  });

  it("delayed autosave: saving note B in a new tab does not flip A to saved before its delay", async () => {
    const noteA = "multitab/auto-a.md";
    const noteB = "multitab/auto-b.md";

    await ObsidianApp.setPluginSettings({
      disableAutoSave: false,
      saveDelaySeconds: LONG_SAVE_DELAY_SECONDS,
    });

    await ObsidianApp.createAndOpenNote(noteA);
    await ObsidianApp.typeText("note A pending edit");
    await ObsidianApp.waitForPendingStatus();

    await ObsidianApp.openNoteInNewTab(noteB, "");
    await ObsidianApp.typeText("note B edit");
    await ObsidianApp.runSaveCommand();
    await ObsidianApp.waitForVaultFileContent(noteB, "note B edit", 7000);

    // A's autosave timer (30s) has not fired yet, so A must still read as pending
    // and remain unsaved on disk right after B is saved.
    await expect(await ObsidianApp.getPendingStatusCount()).toBe(1);
    await expect(await ObsidianApp.getStatusIndicatorTitle()).toBe("Changes pending save");
    await expect(await ObsidianApp.readVaultFile(noteA)).toBe("");
  });
});
