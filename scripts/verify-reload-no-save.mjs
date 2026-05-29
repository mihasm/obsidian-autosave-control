import { spawn, spawnSync } from "node:child_process";
import * as path from "node:path";

const TEST_OBSIDIAN_MARKER = `${path.resolve(".obsidian-cache", "obsidian-installer")}${path.sep}`;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    .filter((row) => row && row.command.includes(TEST_OBSIDIAN_MARKER));
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

async function cleanupTestObsidianProcesses() {
  const pids = [...new Set(getObsidianProcessRows().map((row) => row.pid))];
  for (const pid of pids) {
    await terminatePid(pid);
  }
}

function runReloadSpec() {
  return new Promise((resolve) => {
    const child = spawn(
      "npx",
      ["wdio", "run", "./wdio.conf.mts", "--spec", "./test/specs/reload-no-save.e2e.ts"],
      {
        cwd: process.cwd(),
        stdio: "inherit",
        shell: process.platform === "win32",
      },
    );

    child.once("exit", (code) => resolve(code ?? 1));
  });
}

await cleanupTestObsidianProcesses();

try {
  const exitCode = await runReloadSpec();
  process.exitCode = exitCode;
} finally {
  await cleanupTestObsidianProcesses();
}
