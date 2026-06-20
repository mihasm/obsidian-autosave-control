import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { browser, expect } from "@wdio/globals";
import ObsidianApp from "../support/ObsidianApp";
import MultiVaultApp from "../support/MultiVaultApp";

const LONG_SAVE_DELAY_SECONDS = 120;

/**
 * Regression coverage for multi-vault behaviour.
 *
 * Both vaults are real Obsidian windows living in the same main process (the
 * bottom-left vault-switcher flow). See issues:
 *   #29 https://github.com/mihasm/obsidian-autosave-control/issues/29
 *   #28 https://github.com/mihasm/obsidian-autosave-control/issues/28
 */
describe("Multi-vault windows (issues #28/#29)", () => {
  let secondVaultPath = "";
  let firstWindowHandle = "";
  let secondWindowHandle = "";

  beforeEach(async () => {
    await ObsidianApp.reloadWithFreshVault();
    await ObsidianApp.setPluginSettings({
      disableAutoSave: false,
      saveDelaySeconds: LONG_SAVE_DELAY_SECONDS,
    });

    const opened = await MultiVaultApp.openSecondVaultFromCurrent();
    secondVaultPath = opened.vaultPath;
    firstWindowHandle = opened.originalHandle;
    secondWindowHandle = opened.handle;

    await MultiVaultApp.switchTo(secondWindowHandle);
    await MultiVaultApp.waitForPluginReadyInCurrentWindow();
    await ObsidianApp.setPluginSettings({
      disableAutoSave: false,
      saveDelaySeconds: LONG_SAVE_DELAY_SECONDS,
    });
    await MultiVaultApp.switchTo(firstWindowHandle);
  });

  afterEach(async () => {
    // Really close any extra windows so each test starts from a single window.
    // (Some tests stub the close, leaving the second window open.)
    try {
      const handles = await browser.getWindowHandles();
      for (const handle of handles) {
        if (handle === firstWindowHandle) {
          continue;
        }
        try {
          await browser.switchToWindow(handle);
          await MultiVaultApp.closeCurrentWindowForReal();
        } catch {
          // window may already be gone
        }
      }
      await browser.switchToWindow(firstWindowHandle);
      await browser.waitUntil(
        async () => (await MultiVaultApp.getElectronWindowCount()) === 1,
        { timeout: 10000, timeoutMsg: "Extra windows did not close between tests." },
      );
    } catch {
      // first window may be gone if a regression tore down the app
    }
    if (secondVaultPath) {
      MultiVaultApp.removeVaultDir(secondVaultPath);
      secondVaultPath = "";
    }
  });

  it("opens the second vault as a separate window in the same process", async () => {
    await expect(await MultiVaultApp.getElectronWindowCount()).toBe(2);
    const handles = await browser.getWindowHandles();
    await expect(handles).toContain(firstWindowHandle);
    await expect(handles).toContain(secondWindowHandle);
  });

  it("#29: REALLY closing one window WITH pending changes must not quit the whole app and still flushes", async () => {
    const notePath = "multi-vault/pending.md";
    const noteContent = "unsaved edit in the second vault";
    const logPath = path.join(os.tmpdir(), `asc-quit-log-pending-${secondWindowHandle}.txt`);
    fs.writeFileSync(logPath, "");

    try {
      // Make a pending (unsaved) change in the SECOND vault only.
      await MultiVaultApp.switchTo(secondWindowHandle);
      await ObsidianApp.createAndOpenNote(notePath);
      await ObsidianApp.typeText(noteContent);
      await browser.waitUntil(
        async () => (await ObsidianApp.getPendingStatusCount()) > 0,
        { timeout: 10000, timeoutMsg: "Second vault never registered a pending change." },
      );

      // Log (instead of executing) any app-wide quit attempt, then really close
      // this window.
      await MultiVaultApp.installFileLoggedQuitSpyInCurrentWindow(logPath);
      await MultiVaultApp.closeCurrentWindowForReal();

      // The second window closes on its own; the first vault must survive.
      await browser.switchToWindow(firstWindowHandle);
      await browser.waitUntil(
        async () => (await MultiVaultApp.getElectronWindowCount()) === 1,
        { timeout: 15000, timeoutMsg: "Second window never closed." },
      );
      await expect(await MultiVaultApp.getCurrentVaultBasePath()).toBeTruthy();

      // The defect (#29): closing the window called electron app.exit()/quit().
      const quitLog = fs.readFileSync(logPath, "utf8");
      await expect(quitLog).not.toContain("app.exit");
      await expect(quitLog).not.toContain("app.quit");

      // The pending change must have been flushed to disk before closing.
      const savedContent = fs.readFileSync(path.join(secondVaultPath, notePath), "utf8");
      await expect(savedContent).toBe(noteContent);
    } finally {
      fs.rmSync(logPath, { force: true });
    }
  });

  it("#28: app-quit prompts every vault and only the last to answer exits the app", async () => {
    // Manual (autosave-off) mode in BOTH vaults, each with an unsaved change.
    const firstNote = "multi-vault/quit-first.md";
    const secondNote = "multi-vault/quit-second.md";
    const firstLogPath = path.join(os.tmpdir(), `asc-appquit-log-first-${secondWindowHandle}.txt`);
    const secondLogPath = path.join(os.tmpdir(), `asc-appquit-log-second-${secondWindowHandle}.txt`);
    fs.writeFileSync(firstLogPath, "");
    fs.writeFileSync(secondLogPath, "");

    try {
      await MultiVaultApp.switchTo(firstWindowHandle);
      await ObsidianApp.setPluginSettings({ disableAutoSave: true, saveDelaySeconds: LONG_SAVE_DELAY_SECONDS });
      await ObsidianApp.createAndOpenNote(firstNote);
      await ObsidianApp.typeText("unsaved edit in the first vault");
      await browser.waitUntil(
        async () => (await ObsidianApp.getPendingStatusCount()) > 0,
        { timeout: 10000, timeoutMsg: "First vault never registered a pending change." },
      );
      await MultiVaultApp.installFileLoggedQuitSpyInCurrentWindow(firstLogPath);

      await MultiVaultApp.switchTo(secondWindowHandle);
      await ObsidianApp.setPluginSettings({ disableAutoSave: true, saveDelaySeconds: LONG_SAVE_DELAY_SECONDS });
      await ObsidianApp.createAndOpenNote(secondNote);
      await ObsidianApp.typeText("unsaved edit in the second vault");
      await browser.waitUntil(
        async () => (await ObsidianApp.getPendingStatusCount()) > 0,
        { timeout: 10000, timeoutMsg: "Second vault never registered a pending change." },
      );
      await MultiVaultApp.installFileLoggedQuitSpyInCurrentWindow(secondLogPath);

      // Record—rather than execute—any global app exit, so a non-last vault can
      // never tear down the whole app.

      // First vault answers its quit prompt (discard). It is NOT the last vault to
      // answer, so it must record its decision and NOT exit the app — the second
      // vault is still open and unprompted (the original #28 hard-kill defect).
      // resetCoordination clears any leaked round, as Electron's before-quit would.
      await MultiVaultApp.switchTo(firstWindowHandle);
      await MultiVaultApp.simulateAppQuitInCurrentWindow({ markShortcutIntent: false, resetCoordination: true });
      await expect(fs.readFileSync(firstLogPath, "utf8")).not.toContain("app.exit");
      await expect(fs.readFileSync(firstLogPath, "utf8")).not.toContain("app.quit");

      // Both vault windows are still alive; the second vault still gets to prompt.
      await expect(await MultiVaultApp.getElectronWindowCount()).toBe(2);

      // Second vault answers (discard). It is now the LAST open vault still to
      // answer, so it completes the set and MUST exit the whole app — the bug the
      // user hit was the app lingering after both vaults answered.
      await MultiVaultApp.switchTo(secondWindowHandle);
      await MultiVaultApp.simulateAppQuitInCurrentWindow({ markShortcutIntent: false });
      await expect(fs.readFileSync(secondLogPath, "utf8")).toContain("app.exit");
    } finally {
      fs.rmSync(firstLogPath, { force: true });
      fs.rmSync(secondLogPath, { force: true });
    }
  });

  it("#29: REALLY closing one window (no pending changes) must not quit the whole app", async () => {
    // This mirrors the user-reported scenario: with several vaults open, click
    // the red close button on one window. Closing a window fires that window's
    // workspace "quit" event, which must NOT tear down the whole application.
    const logPath = path.join(os.tmpdir(), `asc-quit-log-${secondWindowHandle}.txt`);
    fs.writeFileSync(logPath, "");

    try {
      // Log (instead of executing) any app-wide quit attempt so the record
      // survives the window actually closing.
      await MultiVaultApp.switchTo(secondWindowHandle);
      await MultiVaultApp.installFileLoggedQuitSpyInCurrentWindow(logPath);

      // Really close the second window.
      await MultiVaultApp.closeCurrentWindowForReal();

      // The second window should close on its own...
      await browser.switchToWindow(firstWindowHandle);
      await browser.waitUntil(
        async () => (await MultiVaultApp.getElectronWindowCount()) === 1,
        { timeout: 15000, timeoutMsg: "Second window never closed." },
      );

      // ...and the first vault window must still be alive.
      await expect(await MultiVaultApp.getCurrentVaultBasePath()).toBeTruthy();

      // The defect (#29): closing the window called electron app.exit()/quit(),
      // which would tear down the whole app and every other open vault.
      const quitLog = fs.readFileSync(logPath, "utf8");
      await expect(quitLog).not.toContain("app.exit");
      await expect(quitLog).not.toContain("app.quit");
    } finally {
      fs.rmSync(logPath, { force: true });
    }
  });
});
