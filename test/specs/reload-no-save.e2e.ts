import { browser, expect } from "@wdio/globals";
import ObsidianApp from "../support/ObsidianApp";

describe("Reload without saving", () => {
  it("reloads in the same app process and restores the saved note contents", async () => {
    const notePath = "reload/reload-without-saving.md";
    const savedContent = "saved before reload";
    const unsavedSuffix = "\nunsaved line";

    await ObsidianApp.reloadWithFreshVault();
    await ObsidianApp.setPluginSettings({
      disableAutoSave: false,
      saveDelaySeconds: 30,
    });

    await ObsidianApp.createAndOpenNote(notePath, savedContent);
    await ObsidianApp.waitForSavedStatus();
    const appPidBeforeReload = await ObsidianApp.getAppProcessPid();

    await ObsidianApp.typeText(unsavedSuffix);
    await ObsidianApp.waitForPendingStatus();
    await expect(await ObsidianApp.getActiveEditorContent()).toBe(`${savedContent}${unsavedSuffix}`);
    await expect(await ObsidianApp.readVaultFile(notePath)).toBe(savedContent);

    await ObsidianApp.runReloadWithoutSavingCommand();
    await browser.pause(3000);

    await ObsidianApp.waitForWorkspaceReady();
    await ObsidianApp.waitForActiveFile(notePath);

    await expect(await ObsidianApp.getAppProcessPid()).toBe(appPidBeforeReload);
    await expect(await ObsidianApp.getActiveEditorContent()).toBe(savedContent);
    await expect(await ObsidianApp.readVaultFile(notePath)).toBe(savedContent);
  });
});
