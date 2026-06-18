import * as fs from "node:fs/promises";
import * as path from "node:path";
import { browser } from "@wdio/globals";
import ObsidianApp from "../support/ObsidianApp";

const METADATA_PATH = path.resolve("test-output/quit-manual-check.json");
const REAL_QUIT_SESSION_HOLD_MS = 30000;

describe("Manual-mode quit verification", () => {
  it("prepares a manual-only quit with unsaved changes and a slow discard prompt", async () => {
    await ObsidianApp.reloadWithFreshVault();
    await ObsidianApp.setPluginSettings({ disableAutoSave: true, saveDelaySeconds: 3 });

    await ObsidianApp.createAndOpenNote("quit/manual-unsaved.md");
    await ObsidianApp.typeText("unsaved manual edit");
    await ObsidianApp.waitForPendingStatus();

    // Manual mode shows a "discard unsaved changes?" confirm on Cmd+Q. Simulate
    // a real human taking longer than the quit-shortcut intent TTL (2s) to click
    // "OK", which is exactly the case that regressed: the app must still quit.
    await browser.execute(() => {
      const targetWindow = window as typeof window & { confirm: (message?: string) => boolean };
      targetWindow.confirm = () => {
        // Block just past the 2s quit-shortcut intent TTL so a slow human
        // response is simulated, while leaving the external verifier's 5s exit
        // window enough room for the app to fully tear down.
        const end = Date.now() + 2300;
        while (Date.now() < end) {
          // busy-wait to emulate a slow human response
        }
        return true;
      };
    });

    const appPid = await ObsidianApp.getAppProcessPid();
    const rendererPid = await ObsidianApp.getRendererPid();

    await fs.mkdir(path.dirname(METADATA_PATH), { recursive: true });
    await fs.writeFile(METADATA_PATH, JSON.stringify({ appPid, rendererPid }, null, 2));

    // Keep the session open while the external verifier sends a real Cmd+Q.
    await new Promise((resolve) => setTimeout(resolve, REAL_QUIT_SESSION_HOLD_MS));
  });
});
