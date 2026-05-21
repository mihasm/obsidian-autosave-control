import { browser, expect } from "@wdio/globals";
import AndroidObsidianApp from "../../support/AndroidObsidianApp";
import ObsidianApp from "../../support/ObsidianApp";

describe("Android issue #23", () => {
  it("switches vaults after saving without getting stuck on saving", async () => {
    await browser.reloadObsidian({ vault: "test/vaults/simple" });
    await AndroidObsidianApp.prepareCurrentSession();

    await AndroidObsidianApp.setPluginSettings({
      disableAutoSave: false,
      saveDelaySeconds: 3,
    });

    await AndroidObsidianApp.createAndOpenNote("issue-23/source.md", "start");
    await ObsidianApp.waitForSavedStatus();
    await ObsidianApp.runSaveCommand();
    await ObsidianApp.waitForSavedStatus();
    await expect(await AndroidObsidianApp.getPendingStatusCount()).toBe(0);

    await browser.reloadObsidian({ vault: "test/vaults/alternate" });
    await AndroidObsidianApp.prepareCurrentSession();

    const runtime = await AndroidObsidianApp.getRuntimeSnapshot();
    await expect(runtime.workspaceReady).toBe(true);
    await expect(runtime.pendingSaveCount).toBe(0);

    await browser.saveScreenshot("./test-output/android/issue-23-after-switch.png");
  });
});
