import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { browser } from "@wdio/globals";

const PLUGIN_ID = "autosave-control";

/**
 * Helper for driving more than one real Obsidian vault window at once.
 *
 * A second vault opens as a separate BrowserWindow inside the SAME Obsidian
 * main process (verified via electron.remote.BrowserWindow.getAllWindows()),
 * and WebdriverIO exposes it as an additional window handle we can switch to.
 * This mirrors the bottom-left vault-switcher flow described in issues #28/#29.
 */
class MultiVaultApp {
  /** Absolute path of the vault open in the currently-focused WDIO window. */
  async getCurrentVaultBasePath(): Promise<string> {
    return browser.execute(() => {
      const app = (window as typeof window & { app: any }).app;
      return app.vault.adapter.basePath as string;
    });
  }

  /** Number of BrowserWindows the Obsidian main process currently owns. */
  async getElectronWindowCount(): Promise<number> {
    return browser.execute(() => {
      const electron = (window as typeof window & { require?: any }).require?.("electron");
      return electron?.remote?.BrowserWindow?.getAllWindows?.()?.length ?? -1;
    });
  }

  /**
   * Open a second vault window by copying the currently-open vault (so the
   * plugin and its enablement carry over) and asking Obsidian to open the copy
   * through the same vault-open IPC the switcher uses.
   *
   * Returns the new WDIO window handle and the second vault's path. The caller
   * is switched BACK to the original window before returning.
   */
  async openSecondVaultFromCurrent(): Promise<{ handle: string; vaultPath: string; originalHandle: string }> {
    const originalHandle = await browser.getWindowHandle();
    const sourceVaultPath = await this.getCurrentVaultBasePath();

    const secondVaultPath = fs.mkdtempSync(path.join(os.tmpdir(), "asc-vault2-"));
    // Copy the prepared vault (including .obsidian with the installed + enabled
    // plugin) so the second window boots with the plugin already running.
    fs.cpSync(sourceVaultPath, secondVaultPath, {
      recursive: true,
      filter: (src) => !/[\\/](workspace(-mobile)?\.json)$/u.test(src),
    });

    const handlesBefore = await browser.getWindowHandles();

    await browser.execute((targetVaultPath: string) => {
      const electron = (window as typeof window & { require?: any }).require?.("electron");
      electron?.ipcRenderer?.send?.("vault-open", targetVaultPath, false);
    }, secondVaultPath);

    let newHandle = "";
    await browser.waitUntil(
      async () => {
        const handles = await browser.getWindowHandles();
        newHandle = handles.find((handle) => !handlesBefore.includes(handle)) ?? "";
        return Boolean(newHandle);
      },
      { timeout: 20000, timeoutMsg: "Second vault window never appeared as a WDIO handle." },
    );

    await browser.switchToWindow(originalHandle);

    return { handle: newHandle, vaultPath: secondVaultPath, originalHandle };
  }

  async switchTo(handle: string): Promise<void> {
    await browser.switchToWindow(handle);
  }

  /** Wait until the plugin is loaded in the currently-focused window. */
  async waitForPluginReadyInCurrentWindow(): Promise<void> {
    await browser.execute(async (pluginId: string) => {
      const app = (window as typeof window & { app: any }).app;
      if (!app?.plugins?.plugins?.[pluginId]) {
        app.plugins.setEnable(true);
        await app.plugins.enablePlugin(pluginId);
      }
    }, PLUGIN_ID);

    await browser.waitUntil(
      async () =>
        browser.execute((pluginId: string) => {
          const app = (window as typeof window & { app: any }).app;
          return Boolean(app?.plugins?.plugins?.[pluginId]?.autosaveController);
        }, PLUGIN_ID),
      { timeout: 20000, timeoutMsg: "Plugin did not become ready in the second window." },
    );
  }

  /**
   * Replace the teardown entry points in the current window with recording
   * stubs, WITHOUT actually quitting or closing anything:
   *   - electron.remote.app.exit / app.quit  → app-wide quit (the #29 defect)
   *   - this window's BrowserWindow.close / destroy → single-window close (correct)
   *
   * This lets a test assert that closing one window closes ONLY that window and
   * never tears down the whole application, while keeping the WDIO session alive
   * and observable.
   */
  async installCloseSpiesInCurrentWindow(): Promise<void> {
    await browser.execute(() => {
      const electron = (window as typeof window & { require?: any }).require?.("electron");
      const app = electron?.remote?.app;
      const browserWindow = electron?.remote?.getCurrentWindow?.();
      const state = window as typeof window & {
        __ascAppWideQuitCalls?: string[];
        __ascWindowCloseCalls?: string[];
      };

      state.__ascAppWideQuitCalls = [];
      state.__ascWindowCloseCalls = [];

      if (app) {
        app.exit = (...args: unknown[]) => {
          state.__ascAppWideQuitCalls?.push(`exit(${args.join(",")})`);
        };
        app.quit = () => {
          state.__ascAppWideQuitCalls?.push("quit()");
        };
      }

      if (browserWindow) {
        browserWindow.close = () => {
          state.__ascWindowCloseCalls?.push("close()");
        };
        browserWindow.destroy = () => {
          state.__ascWindowCloseCalls?.push("destroy()");
        };
      }
    });
  }

  async getAppWideQuitCallsInCurrentWindow(): Promise<string[]> {
    return browser.execute(() => {
      const state = window as typeof window & { __ascAppWideQuitCalls?: string[] };
      return [...(state.__ascAppWideQuitCalls ?? [])];
    });
  }

  async getWindowCloseCallsInCurrentWindow(): Promise<string[]> {
    return browser.execute(() => {
      const state = window as typeof window & { __ascWindowCloseCalls?: string[] };
      return [...(state.__ascWindowCloseCalls ?? [])];
    });
  }

  /**
   * Stub electron.remote.app.exit/quit in the current window to append to a log
   * FILE (instead of actually quitting), so the record survives the window
   * really closing. Used to detect whether closing this window tries to quit the
   * whole application. Returns the log path to read afterwards.
   */
  async installFileLoggedQuitSpyInCurrentWindow(logPath: string): Promise<void> {
    await browser.execute((targetLogPath: string) => {
      const w = window as typeof window & { require?: any };
      const electron = w.require?.("electron");
      const fsMod = w.require?.("fs");
      const app = electron?.remote?.app;
      const append = (line: string) => {
        try {
          fsMod?.appendFileSync?.(targetLogPath, line + "\n");
        } catch {
          // ignore logging failures
        }
      };
      if (app) {
        app.exit = (...a: unknown[]) => append(`app.exit(${a.join(",")})`);
        app.quit = () => append("app.quit()");
      }
    }, logPath);
  }

  /**
   * Really close the currently-focused window (its own BrowserWindow), but
   * defer the actual close so this execute() call returns first. Closing the
   * window WebdriverIO is actively driving mid-call kills the command socket;
   * deferring lets the caller switch the driver to another window beforehand.
   */
  async closeCurrentWindowForReal(): Promise<void> {
    await browser.execute(() => {
      const electron = (window as typeof window & { require?: any }).require?.("electron");
      const browserWindow = electron?.remote?.getCurrentWindow?.();
      setTimeout(() => {
        try {
          browserWindow?.close?.();
        } catch {
          // window may already be gone
        }
      }, 200);
    });
  }

  /**
   * Fire the plugin's own electron "close" listener for the current window,
   * i.e. simulate the user closing just this one window. Returns whether the
   * close was intercepted (preventDefault), which is what happens when there
   * are pending unsaved changes.
   */
  async requestSingleWindowCloseInCurrentWindow(): Promise<{ defaultPrevented: boolean }> {
    return browser.execute(() => {
      const app = (window as typeof window & { app: any }).app;
      const plugin = app?.plugins?.plugins?.["autosave-control"] as {
        autosaveController?: {
          electronCloseListenersByWindow?: Map<
            Window,
            { listener: (event: { preventDefault: () => void }) => void }
          >;
        };
      } | undefined;
      const observer = plugin?.autosaveController?.electronCloseListenersByWindow?.get(window);
      const listener = observer?.listener;
      if (!listener) {
        throw new Error("Electron close listener is not attached to this window.");
      }

      let defaultPrevented = false;
      listener({ preventDefault: () => { defaultPrevented = true; } });
      return { defaultPrevented };
    });
  }

  /** Best-effort cleanup of a second vault directory created during a test. */
  removeVaultDir(vaultPath: string): void {
    try {
      fs.rmSync(vaultPath, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }
}

export default new MultiVaultApp();
