import * as fs from "node:fs/promises";
import * as path from "node:path";
import ObsidianApp from "../support/ObsidianApp";

const METADATA_PATH = path.resolve("test-output/quit-clean-check.json");

describe("Clean quit verification", () => {
  it("prepares a real quit with no pending changes", async () => {
    await ObsidianApp.reloadWithFreshVault();

    const appPid = await ObsidianApp.getAppProcessPid();
    const rendererPid = await ObsidianApp.getRendererPid();

    await fs.mkdir(path.dirname(METADATA_PATH), { recursive: true });
    await fs.writeFile(METADATA_PATH, JSON.stringify({
      appPid,
      rendererPid,
    }, null, 2));

    // Keep the WDIO session open while the external verifier sends a real Cmd+Q
    // through the operating system and then checks whether quit completed.
    await new Promise((resolve) => setTimeout(resolve, 60000));
  });
});
