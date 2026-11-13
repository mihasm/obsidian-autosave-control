import * as path from "node:path";

export const config = {
  runner: "local",
  framework: "mocha",
  specs: ["./test/specs/**/*.e2e.ts"],
  maxInstances: 1,
  bail: 0,
  capabilities: [
    {
      browserName: "obsidian",
      browserVersion: "latest",
      "wdio:obsidianOptions": {
        installerVersion: "latest",
        // Installed but off; only the #44 tests switch them on (Custom
        // Attachment Location requires Advanced Rename and Delete Handler).
        plugins: [
          ".",
          { repo: "mnaoumov/obsidian-advanced-rename-and-delete-handler", enabled: false },
          { repo: "mnaoumov/obsidian-custom-attachment-location", enabled: false },
        ],
        vault: "test/vaults/simple",
      },
    },
  ],
  services: ["obsidian"],
  reporters: ["obsidian"],
  cacheDir: path.resolve(".obsidian-cache"),
  mochaOpts: {
    ui: "bdd",
    bail: false,
    timeout: 120000,
  },
  logLevel: "warn",
};
