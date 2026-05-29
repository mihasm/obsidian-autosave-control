import * as fs from "node:fs/promises";
import * as path from "node:path";
import { browser } from "@wdio/globals";
import ObsidianApp from "../support/ObsidianApp";

const METADATA_PATH = path.resolve("test-output/reload-no-save-reopen-check.json");
const REAL_RELOAD_SESSION_HOLD_MS = 10000;

describe("Reload without saving reopen verification", () => {
  it("prepares the real reload-without-saving relaunch path", async () => {
    await ObsidianApp.reloadWithFreshVault();
    await ObsidianApp.setPluginSettings({
      disableAutoSave: false,
      saveDelaySeconds: 30,
    });

    const rendererPid = await ObsidianApp.getRendererPid();
    const appPid = await ObsidianApp.getAppProcessPid();

    await fs.mkdir(path.dirname(METADATA_PATH), { recursive: true });
    await fs.writeFile(METADATA_PATH, JSON.stringify({
      rendererPid,
      appPid,
    }, null, 2));

    await browser.pause(1000);
    try {
      await ObsidianApp.runReloadWithoutSavingCommand();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/no such window|target window already closed|web view not found|ECONNREFUSED/i.test(message)) {
        throw error;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, REAL_RELOAD_SESSION_HOLD_MS));
  });
});
