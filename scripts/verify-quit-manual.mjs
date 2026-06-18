import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const metadataPath = path.resolve("test-output/quit-manual-check.json");

await fs.rm(metadataPath, { force: true });

const runProcess = spawn(
  "npx",
  ["wdio", "run", "./wdio.conf.mts", "--spec", "./test/specs/quit-manual.e2e.ts"],
  {
    cwd: process.cwd(),
    stdio: "inherit",
    shell: process.platform === "win32",
  },
);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sendRealQuitShortcut(appPid) {
  const script = [
    'tell application id "md.obsidian" to activate',
    'delay 1',
    'tell application "System Events"',
    `  set frontmost of first application process whose unix id is ${Number(appPid)} to true`,
    '  delay 0.5',
    '  key code 12 using command down',
    'end tell',
  ].join("\n");

  const result = spawnSync("osascript", ["-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(`Failed to send real Cmd+Q to Obsidian PID ${appPid}: ${result.stderr || result.stdout || "unknown osascript error"}`);
  }
}

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

function getStillRunningTrackedRows(trackedPids) {
  const rows = getObsidianProcessRows();
  return rows.filter((row) => trackedPids.has(row.pid));
}

async function waitForTrackedProcessesExit(trackedPids, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const remainingRows = getStillRunningTrackedRows(trackedPids);
    if (remainingRows.length === 0) {
      return [];
    }

    await wait(250);
  }

  return getStillRunningTrackedRows(trackedPids);
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

await wait(1000);
sendRealQuitShortcut(metadata.appPid);

// This scenario's confirm prompt deliberately blocks ~2.3s (to outlast the 2s
// quit-shortcut intent TTL), so the real teardown only begins after that delay.
// Give the main process and its GPU/network helpers a generous window to fully
// exit. The bug being guarded against leaves the app open indefinitely, so a
// longer timeout does not weaken the check.
const remainingRows = await waitForTrackedProcessesExit(trackedPids, 20000);

if (remainingRows.length > 0) {
  for (const row of remainingRows) {
    await terminatePid(row.pid);
  }

  try {
    runProcess.kill("SIGTERM");
  } catch {
    // already gone
  }

  const exitCode = await waitForChildExit(runProcess, 5000);
  const remainingSummary = remainingRows.map((row) => `${row.pid} (ppid ${row.ppid}): ${row.command}`).join("; ");
  throw new Error(`Manual-mode quit verification failed: Obsidian processes still running after 5s: ${remainingSummary}${typeof exitCode === "number" ? `; WDIO exited with code ${exitCode}` : ""}`);
}

const exitCode = await waitForChildExit(runProcess, 20000);

console.log(`Verified manual-mode quit for Obsidian app PID ${metadata.appPid}`);
console.log(`Verified manual-mode quit for Obsidian renderer PID ${metadata.rendererPid}`);

if (typeof exitCode === "number") {
  console.log(`WDIO process exited with code ${exitCode}`);
}
