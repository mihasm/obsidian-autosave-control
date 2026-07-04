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

  // Existing-behaviour coverage for the "explicit save" workflow on mobile,
  // where there is no Cmd/Ctrl+S keyboard shortcut. The save is driven by the
  // wrapped editor:save-file command (ObsidianApp.runSaveCommand), exactly what
  // a toolbar/command-palette "Save current file" button invokes on a phone.
  describe("manual save behaviour", () => {
    it("manual-only mode holds an edit as pending past the delay, then the Save command flushes it to disk", async () => {
      await browser.reloadObsidian({ vault: "test/vaults/simple" });
      await AndroidObsidianApp.prepareCurrentSession();
      await AndroidObsidianApp.setPluginSettings({
        disableAutoSave: true,
        saveDelaySeconds: 3,
      });

      const notePath = "android-manual/manual-only.md";
      await AndroidObsidianApp.createAndOpenNote(notePath, "initial");
      await ObsidianApp.waitForSavedStatus();

      await AndroidObsidianApp.editActiveNoteContent("edited on android");
      await AndroidObsidianApp.waitForPendingCount(1);
      await expect(await AndroidObsidianApp.readNoteFromDisk(notePath)).toBe("initial");

      // Well past the 3s delay: manual-only mode must never auto-save.
      await browser.pause(5000);
      await expect(await AndroidObsidianApp.readNoteFromDisk(notePath)).toBe("initial");
      await expect(await AndroidObsidianApp.getPendingStatusCount()).toBe(1);

      // Explicit save (the mobile "Save current file" path) flushes it.
      await ObsidianApp.runSaveCommand();
      await AndroidObsidianApp.waitForDiskContent(notePath, "edited on android");
      await expect(await AndroidObsidianApp.getPendingStatusCount()).toBe(0);
    });

    it("delayed mode flushes a pending edit immediately when the Save command runs, before the delay elapses", async () => {
      await browser.reloadObsidian({ vault: "test/vaults/simple" });
      await AndroidObsidianApp.prepareCurrentSession();
      await AndroidObsidianApp.setPluginSettings({
        disableAutoSave: false,
        saveDelaySeconds: 60,
      });

      const notePath = "android-manual/delayed-explicit.md";
      await AndroidObsidianApp.createAndOpenNote(notePath, "before");
      await ObsidianApp.waitForSavedStatus();

      await AndroidObsidianApp.editActiveNoteContent("after");
      await AndroidObsidianApp.waitForPendingCount(1);
      await expect(await AndroidObsidianApp.readNoteFromDisk(notePath)).toBe("before");

      await ObsidianApp.runSaveCommand();
      await AndroidObsidianApp.waitForDiskContent(notePath, "after");
      await expect(await AndroidObsidianApp.getPendingStatusCount()).toBe(0);
    });

    it("delayed mode auto-saves a pending edit after the configured delay with no manual action (safety net)", async () => {
      await browser.reloadObsidian({ vault: "test/vaults/simple" });
      await AndroidObsidianApp.prepareCurrentSession();
      await AndroidObsidianApp.setPluginSettings({
        disableAutoSave: false,
        saveDelaySeconds: 3,
      });

      const notePath = "android-manual/delayed-auto.md";
      await AndroidObsidianApp.createAndOpenNote(notePath, "old");
      await ObsidianApp.waitForSavedStatus();

      await AndroidObsidianApp.editActiveNoteContent("new");
      await AndroidObsidianApp.waitForPendingCount(1);
      await expect(await AndroidObsidianApp.readNoteFromDisk(notePath)).toBe("old");

      // No Save command: the timer alone must flush it.
      await AndroidObsidianApp.waitForDiskContent(notePath, "new", 9000);
      await expect(await AndroidObsidianApp.getPendingStatusCount()).toBe(0);
    });

    it("manual-only mode flushes a held edit to disk when the app is backgrounded (minimized)", async () => {
      await browser.reloadObsidian({ vault: "test/vaults/simple" });
      await AndroidObsidianApp.prepareCurrentSession();
      await AndroidObsidianApp.setPluginSettings({
        disableAutoSave: true,
        saveDelaySeconds: 3,
      });

      const notePath = "android-manual/background-flush.md";
      await AndroidObsidianApp.createAndOpenNote(notePath, "before background");
      await ObsidianApp.waitForSavedStatus();

      await AndroidObsidianApp.editActiveNoteContent("after background");
      await AndroidObsidianApp.waitForPendingCount(1);
      await expect(await AndroidObsidianApp.readNoteFromDisk(notePath)).toBe("before background");

      // Minimizing the app (no explicit save, no timer in manual mode) must flush.
      await AndroidObsidianApp.simulateAppBackgrounded();
      await AndroidObsidianApp.waitForDiskContent(notePath, "after background");
      await expect(await AndroidObsidianApp.getPendingStatusCount()).toBe(0);
    });

    // Issue #38 regression guard for the Capacitor resign-active flush.
    //
    // The fix targets iOS, where Capacitor's `appStateChange` maps to
    // `willResignActive` — fired while JS still runs, before the OS can kill the
    // app from the switcher. That timing cannot be reproduced on Android: a
    // diagnostic run driving the real app switcher (KEYCODE_APP_SWITCH) here
    // recorded the events [pause, appStateChange(isActive:true), resume] — the
    // webview is frozen on background, so Capacitor never delivers
    // appStateChange(isActive:false) at all, and no flush can run mid-background.
    // So on Android we assert only what IS verifiable: the plugin loads on mobile
    // without the issue #37 require("electron") crash, the undocumented Capacitor
    // App bridge the fix depends on exists in the real Obsidian build, and the
    // plugin actually registered its resign-active listener on it. The
    // flush-on-leave behaviour itself is covered by the "backgrounded (minimized)"
    // test above via visibilitychange, which Android does deliver.
    it("loads on mobile and registers the Capacitor resign-active flush (issue #38)", async () => {
      await browser.reloadObsidian({ vault: "test/vaults/simple" });
      await AndroidObsidianApp.prepareCurrentSession();

      const runtime = await AndroidObsidianApp.getRuntimeSnapshot();
      await expect(runtime.isMobile).toBe(true);
      await expect(runtime.pluginLoaded).toBe(true);

      const bridge = await AndroidObsidianApp.getCapacitorBridgeSnapshot();
      await expect(bridge.appPluginAvailable).toBe(true);
      await expect(bridge.resignActiveFlushRegistered).toBe(true);
    });
  });
});
