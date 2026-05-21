import * as path from "node:path";

const androidAvd = process.env.OBSIDIAN_ANDROID_AVD ?? "obsidian_test";

export const config = {
  runner: "local",
  framework: "mocha",
  specs: ["./test/specs/android/**/*.e2e.ts"],
  maxInstances: 1,
  capabilities: [
    {
      browserName: "obsidian",
      browserVersion: "latest",
      platformName: "Android",
      "appium:automationName": "UiAutomator2",
      "appium:avd": androidAvd,
      "appium:noReset": true,
      "appium:autoGrantPermissions": true,
      "appium:autoWebview": false,
      "appium:autoWebviewTimeout": 30000,
      "appium:newCommandTimeout": 240,
      "appium:avdLaunchTimeout": 180000,
      "appium:avdReadyTimeout": 180000,
      "appium:uiautomator2ServerInstallTimeout": 120000,
      "wdio:obsidianOptions": {
        installerVersion: "latest",
        plugins: ["."],
      },
    },
  ],
  services: [
    "obsidian",
    ["appium", {
      args: {
        allowInsecure: "*:chromedriver_autodownload,*:adb_shell",
      },
    }],
  ],
  reporters: ["obsidian"],
  cacheDir: path.resolve(".obsidian-cache"),
  waitforTimeout: 60000,
  waitforInterval: 250,
  mochaOpts: {
    ui: "bdd",
    timeout: 180000,
  },
  logLevel: "warn",
};
