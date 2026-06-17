import * as path from "node:path";

export const config = {
  runner: "local",
  framework: "mocha",
  specs: ["./test/specs/community-install-issue34.e2e.ts"],
  maxInstances: 1,
  bail: 0,
  capabilities: [
    {
      browserName: "obsidian",
      browserVersion: "latest",
      "wdio:obsidianOptions": {
        installerVersion: "latest",
        plugins: ["."],
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
