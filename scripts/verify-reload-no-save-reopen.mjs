import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const metadataPath = path.resolve("test-output/reload-no-save-reopen-check.json");

await fs.rm(metadataPath, { force: true });

const runProcess = spawn(
  "npx",
  ["wdio", "run", "./wdio.conf.mts", "--spec", "./test/specs/reload-no-save-reopen.e2e.ts"],
  {
    cwd: process.cwd(),
    stdio: "inherit",
    shell: process.platform === "win32",
  },
);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForFile(filePath, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await fs.readFile(filePath, "utf8");
    } catch {
      await wait(250);
    }
  }

  throw new Error(`Timed out waiting for file ${filePath}`);
}

function getObsidianProcessRows() {
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,command="], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  if (result.status !== 0) {
    return [];
  }

  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(.*)$/u);
      if (!match) {
        return null;
      }

      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        command: match[3],
      };
    })
    .filter((row) => row && (row.command.includes("/Obsidian") || row.command.includes("Obsidian Helper")));
}

function getTrackedProcessIds(rootPid) {
  const rows = getObsidianProcessRows();
  const tracked = new Set([Number(rootPid)]);
  let changed = true;

  while (changed) {
    changed = false;
    for (const row of rows) {
      if (tracked.has(row.ppid) && !tracked.has(row.pid)) {
        tracked.add(row.pid);
        changed = true;
      }
    }
  }

  return tracked;
}

function getMainObsidianRows() {
  return getObsidianProcessRows().filter((row) => row.command.includes("/Obsidian.app/Contents/MacOS/Obsidian"));
}

async function waitForTrackedProcessesExit(trackedPids, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const remainingRows = getObsidianProcessRows().filter((row) => trackedPids.has(row.pid));
    if (remainingRows.length === 0) {
      return true;
    }

    await wait(250);
  }

  return false;
}

function getVisibleWindowCount(appPid) {
  const script = [
    'tell application "System Events"',
    `  if exists (first application process whose unix id is ${Number(appPid)}) then`,
    `    return count of windows of first application process whose unix id is ${Number(appPid)}`,
    "  end if",
    '  return 0',
    'end tell',
  ].join("\n");

  const result = spawnSync("osascript", ["-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  if (result.status !== 0) {
    return 0;
  }

  return Number(result.stdout.trim()) || 0;
}

async function waitForReplacementApp(previousTrackedPids, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const replacement = getMainObsidianRows().find((row) => !previousTrackedPids.has(row.pid));
    if (replacement && getVisibleWindowCount(replacement.pid) > 0) {
      return replacement;
    }

    await wait(250);
  }

  return null;
}

async function terminatePid(pid) {
  if (!pid) {
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }

  await wait(1000);

  try {
    process.kill(pid, 0);
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}

async function waitForChildExit(child, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;

    const timeoutId = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      resolve(null);
    }, timeoutMs);

    child.once("exit", (code) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutId);
      resolve(code);
    });
  });
}

const metadataRaw = await waitForFile(metadataPath, 30000);
const metadata = JSON.parse(metadataRaw);
const trackedPids = getTrackedProcessIds(metadata.appPid);
const originalExited = await waitForTrackedProcessesExit(trackedPids, 5000);
const replacementApp = await waitForReplacementApp(trackedPids, 4000);
const exitCode = await waitForChildExit(runProcess, 8000);

if (!originalExited || !replacementApp) {
  try {
    runProcess.kill("SIGTERM");
  } catch {
    // already gone
  }

  await terminatePid(metadata.rendererPid);
  await terminatePid(metadata.appPid);

  throw new Error(`${!originalExited ? "Original Obsidian process tree did not exit after 'Reload without saving'" : "Obsidian did not relaunch with a visible window after 'Reload without saving'"}${typeof exitCode === "number" ? `; WDIO exited with code ${exitCode}` : ""}`);
}

await terminatePid(replacementApp.pid);

console.log(`Verified reload without saving restarted Obsidian from PID ${metadata.appPid} to PID ${replacementApp.pid}`);

if (typeof exitCode === "number") {
  console.log(`WDIO process exited with code ${exitCode}`);
}
