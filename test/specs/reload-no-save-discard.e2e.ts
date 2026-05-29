import * as fs from "node:fs/promises";
import * as path from "node:path";
import { browser, expect } from "@wdio/globals";
import ObsidianApp from "../support/ObsidianApp";

const METADATA_PATH = path.resolve("test-output/reload-no-save-discard-check.json");
const REAL_RELOAD_SESSION_HOLD_MS = 10000;

describe("Reload without saving discard verification", () => {
  it("prepares pending changes for the real reload-without-saving discard path", async () => {
    const notePath = "reload/reload-without-saving-discard.md";
    const savedContent = "saved before reload";
    const pendingContent = `${savedContent}\nunsaved line`;

    await ObsidianApp.reloadWithFreshVault();
    await ObsidianApp.setPluginSettings({
      disableAutoSave: false,
      saveDelaySeconds: 30,
    });

    await ObsidianApp.createAndOpenNote(notePath, savedContent);
    await ObsidianApp.waitForSavedStatus();
    await ObsidianApp.typeText("\nunsaved line");
    await ObsidianApp.waitForPendingStatus();
    await expect(await ObsidianApp.readVaultFile(notePath)).toBe(savedContent);

    const vaultBasePath = await ObsidianApp.getVaultBasePath();
    const rendererPid = await ObsidianApp.getRendererPid();
    const appPid = await ObsidianApp.getAppProcessPid();

    await fs.mkdir(path.dirname(METADATA_PATH), { recursive: true });
    await fs.writeFile(METADATA_PATH, JSON.stringify({
      notePath,
      savedContent,
      pendingContent,
      vaultBasePath,
      rendererPid,
      appPid,
    }, null, 2));

    await browser.pause(1000);
    try {
      await ObsidianApp.runReloadWithoutSavingCommand();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/no such window|target window already closed|web view not found/i.test(message)) {
        throw error;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, REAL_RELOAD_SESSION_HOLD_MS));
  });
});
