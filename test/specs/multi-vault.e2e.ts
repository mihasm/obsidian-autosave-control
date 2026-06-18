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
