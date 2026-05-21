import { browser, expect } from "@wdio/globals";
import AndroidObsidianApp from "../../support/AndroidObsidianApp";

describe("Android Obsidian smoke", () => {
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
});
