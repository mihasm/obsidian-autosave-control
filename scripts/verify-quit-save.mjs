import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const metadataPath = path.resolve("test-output/quit-save-check.json");

await fs.rm(metadataPath, { force: true });

const runProcess = spawn(
  "npx",
  ["wdio", "run", "./wdio.conf.mts", "--spec", "./test/specs/quit-save.e2e.ts"],
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
const noteAbsolutePath = path.join(metadata.vaultBasePath, metadata.notePath);
const trackedPids = getTrackedProcessIds(metadata.appPid);

async function getWorkspaceFileInfo(vaultBasePath) {
  const obsidianConfigPath = path.join(vaultBasePath, ".obsidian");
  const workspaceFileName = (await fs.readdir(obsidianConfigPath))
    .find((fileName) => /^workspace.*\.json$/u.test(fileName));

  if (!workspaceFileName) {
    throw new Error(`Could not find workspace json in ${obsidianConfigPath}`);
  }

  const workspaceAbsolutePath = path.join(obsidianConfigPath, workspaceFileName);
  const stats = await fs.stat(workspaceAbsolutePath);
  const raw = await fs.readFile(workspaceAbsolutePath, "utf8");

  return {
    workspaceAbsolutePath,
    mtimeMs: stats.mtimeMs,
    raw,
  };
}

await wait(1000);
sendRealQuitShortcut(metadata.appPid);

let savedContent = null;
let fileExists = false;
let workspaceInfo = null;
for (let attempt = 0; attempt < 40; attempt += 1) {
  try {
    savedContent = await fs.readFile(noteAbsolutePath, "utf8");
    fileExists = true;
    workspaceInfo = await getWorkspaceFileInfo(metadata.vaultBasePath);
    const workspaceHasActiveFile = typeof metadata.expectedActiveFilePath !== "string"
      || workspaceInfo.raw.includes(metadata.expectedActiveFilePath);
    const workspaceMtimeAdvanced = typeof metadata.workspaceMtimeBeforeSwitch !== "number"
      || workspaceInfo.mtimeMs > metadata.workspaceMtimeBeforeSwitch;

    if (savedContent === metadata.expectedContent && workspaceHasActiveFile && workspaceMtimeAdvanced) {
      break;
    }
  } catch {
    // keep polling briefly for the final quit flush
  }

  await wait(250);
}

const remainingRows = await waitForTrackedProcessesExit(trackedPids, 5000);

const failures = [];

if (!fileExists) {
  failures.push(`note file was not found at ${noteAbsolutePath}`);
}

if (savedContent !== metadata.expectedContent) {
  failures.push(`expected '${metadata.expectedContent}' but found '${savedContent ?? "<missing>"}'`);
}

if (!workspaceInfo) {
  failures.push("workspace json was not found after quit");
} else {
  if (
    typeof metadata.workspaceMtimeBeforeSwitch === "number"
    && !(workspaceInfo.mtimeMs > metadata.workspaceMtimeBeforeSwitch)
  ) {
    failures.push(
      `expected workspace mtime to advance past ${metadata.workspaceMtimeBeforeSwitch} but found ${workspaceInfo.mtimeMs}`
    );
  }

  if (
    typeof metadata.expectedActiveFilePath === "string"
    && !workspaceInfo.raw.includes(metadata.expectedActiveFilePath)
  ) {
    failures.push(`expected workspace json to mention active file '${metadata.expectedActiveFilePath}'`);
  }
}

if (remainingRows.length > 0) {
  const remainingSummary = remainingRows.map((row) => `${row.pid} (ppid ${row.ppid}): ${row.command}`).join("; ");
  failures.push(`Obsidian processes still running after Cmd+Q: ${remainingSummary}`);
}

if (failures.length > 0) {
  for (const row of remainingRows) {
    await terminatePid(row.pid);
  }
  await terminatePid(metadata.rendererPid);
  await terminatePid(metadata.appPid);
  try {
    runProcess.kill("SIGTERM");
  } catch {
    // already gone
  }

  const exitCode = await waitForChildExit(runProcess, 5000);
  throw new Error(`Quit-save verification failed: ${failures.join("; ")}${typeof exitCode === "number" ? `; WDIO exited with code ${exitCode}` : ""}`);
}

const exitCode = await waitForChildExit(runProcess, 20000);

console.log(`Verified quit-save flush for ${metadata.notePath}`);
console.log(`Obsidian app PID ${metadata.appPid} exited`);
console.log(`Obsidian renderer PID ${metadata.rendererPid} exited`);

if (typeof exitCode === "number") {
  console.log(`WDIO process exited with code ${exitCode}`);
}
