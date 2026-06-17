import { browser, expect } from "@wdio/globals";
import ObsidianApp from "../support/ObsidianApp";

describe("Community plugin install regressions", () => {
  beforeEach(async () => {
    await ObsidianApp.reloadWithFreshVaultWithoutPlugin();
  });

  it("issue #34: does not save immediately after community-plugin install until Obsidian restarts", async () => {
    const notePath = "install/community-plugin-needs-restart.md";

    await ObsidianApp.createAndOpenNote(notePath);
    await ObsidianApp.installCommunityPluginViaUi("Autosave Control");
    await ObsidianApp.clickCommunityPluginEnableButton("Autosave Control");
    await expect(await ObsidianApp.isPluginLoaded()).toBe(true);
    await ObsidianApp.returnToEditor(notePath);
    await browser.waitUntil(async () => {
      return (await ObsidianApp.getStatusIndicatorCount()) > 0;
    }, {
      timeout: 10000,
      timeoutMsg: "Save status indicator did not appear after enabling the plugin from Community Plugins.",
    });
    await ObsidianApp.setPluginSettings({
      disableAutoSave: false,
      saveDelaySeconds: 10,
    });
    await ObsidianApp.typeText("installed from community plugins");
    await browser.pause(4000);
    await expect(await ObsidianApp.readVaultFile(notePath)).toBe("");
  });
});
