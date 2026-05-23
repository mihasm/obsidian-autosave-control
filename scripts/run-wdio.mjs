import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";

const SPEC_DIR = path.resolve("test", "specs");
const SPECIAL_DESKTOP_SPECS = new Set(["quit-clean.e2e.ts", "quit-save.e2e.ts"]);
const ANDROID_SPEC = "android.e2e.ts";
const desktopOnly = process.argv.includes("--desktop-only");

async function getDesktopSpecs() {
  const entries = await fs.readdir(SPEC_DIR);
  return entries
    .filter((entry) => entry.endsWith(".e2e.ts"))
    .filter((entry) => entry !== ANDROID_SPEC)
    .filter((entry) => !SPECIAL_DESKTOP_SPECS.has(entry))
    .sort()
    .map((entry) => `./test/specs/${entry}`);
}

function runCommand(label, command, args) {
  console.log(`\n=== ${label} ===`);

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      stdio: "inherit",
      shell: process.platform === "win32",
    });

    child.once("exit", (code) => {
      resolve(code ?? 1);
    });
  });
}

const runs = [];

for (const spec of await getDesktopSpecs()) {
  runs.push({
    label: `Desktop ${spec}`,
    command: "npx",
    args: ["wdio", "run", "./wdio.conf.mts", "--spec", spec],
  });
}

runs.push(
  { label: "Desktop quit clean", command: "node", args: ["./scripts/verify-quit-clean.mjs"] },
  { label: "Desktop quit save", command: "node", args: ["./scripts/verify-quit-save.mjs"] },
);

if (!desktopOnly) {
  runs.push({ label: "Android", command: "node", args: ["./scripts/run-android-wdio.mjs"] });
}

const failures = [];

for (const run of runs) {
  const exitCode = await runCommand(run.label, run.command, run.args);
  if (exitCode !== 0) {
    failures.push(`${run.label} exited with code ${exitCode}`);
  }
}

if (failures.length > 0) {
  console.error("\nWDIO completed with failures:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("\nWDIO completed successfully.");
