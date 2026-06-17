import { browser, expect } from "@wdio/globals";
import ObsidianApp from "../support/ObsidianApp";

describe("Community plugin install regressions", () => {
  beforeEach(async () => {
    await ObsidianApp.reloadWithFreshVaultWithoutPlugin();
  });

  it("issue #34: re-enabling the plugin while the editor is already open still delays autosave", async () => {
    const notePath = "install/community-plugin-needs-restart.md";

    await ObsidianApp.createAndOpenNote(notePath);
    await ObsidianApp.enablePlugin();
    await ObsidianApp.waitForPluginReady();
    await ObsidianApp.disablePlugin();
    await browser.waitUntil(async () => !(await ObsidianApp.isPluginLoaded()), {
      timeout: 10000,
      timeoutMsg: "Plugin did not unload after being disabled.",
    });
    await ObsidianApp.enablePlugin();
    await ObsidianApp.waitForPluginReady();
    await ObsidianApp.setPluginSettings({
      disableAutoSave: false,
      saveDelaySeconds: 10,
    });

    await ObsidianApp.typeText("installed from community plugins");
    await ObsidianApp.waitForPendingStatus();
    await browser.pause(4000);
    await expect(await ObsidianApp.readVaultFile(notePath)).toBe("");
  });
});
