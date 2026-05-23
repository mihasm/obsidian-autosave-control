import * as fs from "node:fs/promises";
import * as path from "node:path";
import { browser, expect } from "@wdio/globals";
import ObsidianApp from "../support/ObsidianApp";

const METADATA_PATH = path.resolve("test-output/quit-save-check.json");
const REAL_QUIT_SESSION_HOLD_MS = 5000;

describe("Quit save verification", () => {
  it("prepares pending changes for the real quit path", async () => {
    const notePath = "quit/real-quit-save.md";
    const expectedContent = "quit should flush this change";
    const layoutAnchorPath = "quit/layout-anchor.md";
    const layoutTargetPath = "quit/layout-target.md";

    await ObsidianApp.reloadWithFreshVault();
    await ObsidianApp.setPluginSettings({
      disableAutoSave: false,
      saveDelaySeconds: 30,
      deferWorkspaceLayoutSaves: true,
      workspaceLayoutSaveDelaySeconds: 60,
    });

    await ObsidianApp.createAndOpenNote(layoutAnchorPath, "anchor");
    await browser.pause(2500);
    const workspaceMtimeBeforeSwitch = await ObsidianApp.getWorkspaceFileMtimeMs();

    await ObsidianApp.createAndOpenNote(layoutTargetPath, "target");
    await browser.pause(2500);
    await expect(await ObsidianApp.getWorkspaceFileMtimeMs()).toBe(workspaceMtimeBeforeSwitch);
    await expect(await ObsidianApp.getActiveFilePath()).toBe(layoutTargetPath);

    await ObsidianApp.createAndOpenNote(notePath);
    await ObsidianApp.typeText(expectedContent);
    await ObsidianApp.waitForPendingStatus();

    const vaultBasePath = await ObsidianApp.getVaultBasePath();
    const rendererPid = await ObsidianApp.getRendererPid();
    const appPid = await ObsidianApp.getAppProcessPid();

    await fs.mkdir(path.dirname(METADATA_PATH), { recursive: true });
    await fs.writeFile(METADATA_PATH, JSON.stringify({
      notePath,
      expectedContent,
      expectedActiveFilePath: layoutTargetPath,
      workspaceMtimeBeforeSwitch,
      vaultBasePath,
      rendererPid,
      appPid,
    }, null, 2));

    // Keep the WDIO session open while the external verifier sends a real Cmd+Q
    // through the operating system and then checks whether quit completed.
    await new Promise((resolve) => setTimeout(resolve, REAL_QUIT_SESSION_HOLD_MS));
  });
});
