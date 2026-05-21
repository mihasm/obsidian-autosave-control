import { browser, expect } from "@wdio/globals";
import AndroidObsidianApp from "../support/AndroidObsidianApp";
import ObsidianApp from "../support/ObsidianApp";

describe("Android", () => {
  it("downloads Obsidian into the emulator and reaches the startup screen", async () => {
    await AndroidObsidianApp.switchToObsidianWebView();

    await browser.waitUntil(async () => {
      return browser.execute(() => document.readyState === "complete" && Boolean(document.body));
    }, {
      timeout: 15000,
      timeoutMsg: "Obsidian startup screen did not finish loading in time.",
    });

    const startupState = await browser.execute(() => {
      return {
        bodyText: document.body?.innerText ?? "",
        href: window.location.href,
        readyState: document.readyState,
      };
    });

    await expect(startupState.readyState).toBe("complete");
    await expect(startupState.href).toContain("http://localhost");
    await expect(startupState.bodyText.length).toBeGreaterThan(0);

    await browser.execute(() => {
      localStorage.clear();
    });

    await browser.saveScreenshot("./test-output/android/obsidian-android-smoke.png");
  });

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
