import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const metadataPath = path.resolve("test-output/reload-no-save-discard-check.json");

await fs.rm(metadataPath, { force: true });

const runProcess = spawn(
  "npx",
  ["wdio", "run", "./wdio.conf.mts", "--spec", "./test/specs/reload-no-save-discard.e2e.ts"],
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
const noteAbsolutePath = path.join(metadata.vaultBasePath, metadata.notePath);
const trackedPids = getTrackedProcessIds(metadata.appPid);

let noteContent = null;
for (let attempt = 0; attempt < 20; attempt += 1) {
  try {
    noteContent = await fs.readFile(noteAbsolutePath, "utf8");
    break;
  } catch {
    await wait(250);
  }
}

const remainingRows = await waitForTrackedProcessesExit(trackedPids, 5000);
const exitCode = await waitForChildExit(runProcess, 8000);
const failures = [];

if (noteContent !== metadata.savedContent) {
  failures.push(`expected saved content '${metadata.savedContent}' after reload without saving but found '${noteContent ?? "<missing>"}'`);
}

if (noteContent === metadata.pendingContent) {
  failures.push("pending note changes were saved during reload without saving");
}

if (remainingRows.length > 0) {
  const remainingSummary = remainingRows.map((row) => `${row.pid} (ppid ${row.ppid}): ${row.command}`).join("; ");
  failures.push(`original Obsidian processes were still running after reload: ${remainingSummary}`);
}

if (failures.length > 0) {
  try {
    runProcess.kill("SIGTERM");
  } catch {
    // already gone
  }

  for (const row of remainingRows) {
    await terminatePid(row.pid);
  }

  await terminatePid(metadata.rendererPid);
  await terminatePid(metadata.appPid);

  throw new Error(`${failures.join("; ")}${typeof exitCode === "number" ? `; WDIO exited with code ${exitCode}` : ""}`);
}

console.log(`Verified reload without saving discarded unsaved changes for ${metadata.notePath}`);

if (typeof exitCode === "number") {
  console.log(`WDIO process exited with code ${exitCode}`);
}
