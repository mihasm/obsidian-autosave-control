import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const outputDir = path.resolve("test-output", "android");
const timestamp = new Date().toISOString().replace(/[.:]/gu, "-");
const logcatPath = path.join(outputDir, `logcat-${timestamp}.log`);
const wdioArgs = ["wdio", "run", "./wdio.android.conf.mts", ...process.argv.slice(2)];
const ANDROID_BOOT_TIMEOUT_MS = 5 * 60 * 1000;
const ANDROID_RUN_TIMEOUT_MS = Number(process.env.OBSIDIAN_ANDROID_RUN_TIMEOUT_MS ?? 120000);

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveBinary(binaryName, env = process.env) {
  const result = spawnSync("which", [binaryName], {
    cwd: process.cwd(),
    encoding: "utf8",
    env,
  });

  if (result.status !== 0) {
    return null;
  }

  const resolvedPath = result.stdout.trim();
  return resolvedPath ? resolvedPath : null;
}

function getConfiguredSdkRoot() {
  return process.env.ANDROID_SDK_ROOT ?? process.env.ANDROID_HOME ?? null;
}

function getAndroidEnv(sdkRoot) {
  return {
    ...process.env,
    ...(sdkRoot ? {
      ANDROID_HOME: sdkRoot,
      ANDROID_SDK_ROOT: sdkRoot,
      PATH: `${path.join(sdkRoot, "platform-tools")}:${path.join(sdkRoot, "emulator")}:${process.env.PATH ?? ""}`,
    } : {}),
  };
}

function listConnectedDevices(adbPath, env) {
  const result = spawnSync(adbPath, ["devices"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env,
  });

  if (result.status !== 0) {
    return [];
  }

  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("List of devices attached"))
    .map((line) => line.split(/\s+/u)[0])
    .filter(Boolean);
}

function getNewDeviceSerial(beforeDevices, afterDevices) {
  const knownDevices = new Set(beforeDevices);
  return afterDevices.find((device) => !knownDevices.has(device)) ?? null;
}

function getSdkRoot(adbPath) {
  return path.dirname(path.dirname(adbPath));
}

function getEmulatorPath(sdkRoot) {
  return path.join(sdkRoot, "emulator", "emulator");
}

function getAvailableAvds(emulatorPath, env) {
  const result = spawnSync(emulatorPath, ["-list-avds"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env,
  });

  if (result.status !== 0) {
    return [];
  }

  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function resetObsidianProcess(adbPath, env) {
  spawnSync(adbPath, ["shell", "input", "keyevent", "KEYCODE_HOME"], {
    cwd: process.cwd(),
    stdio: "ignore",
    env,
  });

  spawnSync(adbPath, ["shell", "am", "force-stop", "md.obsidian"], {
    cwd: process.cwd(),
    stdio: "ignore",
    env,
  });
}

async function ensureDeviceReady(adbPath, env, avdName) {
  let selectedAvd = avdName;
  const connectedDevices = listConnectedDevices(adbPath, env);
  let startedEmulator = false;
  let deviceSerial = connectedDevices[0] ?? null;

  if (connectedDevices.length === 0) {
    const sdkRoot = getSdkRoot(adbPath);
    const emulatorPath = getEmulatorPath(sdkRoot);
    const availableAvds = getAvailableAvds(emulatorPath, env);
    selectedAvd = selectedAvd || availableAvds[0];

    if (!selectedAvd) {
      throw new Error("No Android Virtual Device is available. Create an AVD in Android Studio first.");
    }

    console.log(`Starting Android emulator '${selectedAvd}'`);
    const emulatorProcess = spawn(emulatorPath, ["-avd", selectedAvd], {
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
      env,
    });
    emulatorProcess.unref();
    startedEmulator = true;
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < ANDROID_BOOT_TIMEOUT_MS) {
    const devices = listConnectedDevices(adbPath, env);
    if (devices.length === 0) {
      await wait(2000);
      continue;
    }

    const bootCompletedResult = spawnSync(adbPath, ["shell", "getprop", "sys.boot_completed"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env,
    });
    const bootCompleted = bootCompletedResult.status === 0 && bootCompletedResult.stdout.trim() === "1";

    if (bootCompleted) {
      deviceSerial = startedEmulator ? (getNewDeviceSerial(connectedDevices, devices) ?? devices[0] ?? null) : (devices[0] ?? null);
      console.log(`Android device is ready: ${deviceSerial ?? devices[0]}`);
      return {
        deviceSerial,
        selectedAvd,
        startedEmulator,
      };
    }

    await wait(2000);
  }

  throw new Error(`Timed out waiting ${ANDROID_BOOT_TIMEOUT_MS}ms for the Android emulator to boot.`);
}

function stopEmulator(adbPath, env, deviceSerial) {
  if (!deviceSerial || !deviceSerial.startsWith("emulator-")) {
    return;
  }

  const result = spawnSync(adbPath, ["-s", deviceSerial, "emu", "kill"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env,
  });

  if (result.status !== 0) {
    const details = (result.stderr || result.stdout || "unknown adb error").trim();
    console.warn(`Failed to stop Android emulator '${deviceSerial}': ${details}`);
    return;
  }

  console.log(`Stopped Android emulator '${deviceSerial}'`);
}

async function main() {
  await fsp.mkdir(outputDir, { recursive: true });

  let logcatProcess = null;
  let logcatStream = null;
  let ownedEmulatorSerial = null;
  let exitCode = 1;
  const configuredSdkRoot = getConfiguredSdkRoot();
  let env = getAndroidEnv(configuredSdkRoot);
  const adbPath = resolveBinary("adb", env);
  const sdkRoot = adbPath ? getSdkRoot(adbPath) : configuredSdkRoot;
  env = getAndroidEnv(sdkRoot);

  try {
    if (adbPath) {
      const deviceInfo = await ensureDeviceReady(adbPath, env, process.env.OBSIDIAN_ANDROID_AVD ?? null);
      if (deviceInfo.selectedAvd) {
        env.OBSIDIAN_ANDROID_AVD = deviceInfo.selectedAvd;
      }
      if (deviceInfo.startedEmulator) {
        ownedEmulatorSerial = deviceInfo.deviceSerial;
      }
      resetObsidianProcess(adbPath, env);

      spawnSync(adbPath, ["logcat", "-c"], {
        cwd: process.cwd(),
        stdio: "inherit",
        env,
      });

      logcatStream = fs.createWriteStream(logcatPath, { flags: "a" });
      logcatProcess = spawn(adbPath, ["logcat", "-v", "time"], {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
        env,
      });
      logcatProcess.stdout.pipe(logcatStream);
      logcatProcess.stderr.pipe(logcatStream);
      console.log(`Capturing adb logcat to ${logcatPath}`);
    } else {
      console.warn("adb was not found on PATH. Android log capture is disabled for this run.");
    }

    const wdioProcess = spawn("npx", wdioArgs, {
      cwd: process.cwd(),
      stdio: ["inherit", "pipe", "pipe"],
      shell: process.platform === "win32",
      env,
    });

    const resetTimeout = () => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        timedOut = true;
        console.error(`Android WDIO run was idle for ${ANDROID_RUN_TIMEOUT_MS}ms and will be terminated.`);
        try {
          wdioProcess.kill("SIGTERM");
        } catch {
          // already exited
        }
      }, ANDROID_RUN_TIMEOUT_MS);
    };

    const forwardOutput = (chunk, stream) => {
      stream.write(chunk);
      resetTimeout();
    };

    let timedOut = false;
    let timeoutId = setTimeout(() => {
      timedOut = true;
      console.error(`Android WDIO run was idle for ${ANDROID_RUN_TIMEOUT_MS}ms and will be terminated.`);
      try {
        wdioProcess.kill("SIGTERM");
      } catch {
        // already exited
      }
    }, ANDROID_RUN_TIMEOUT_MS);

    wdioProcess.stdout.on("data", (chunk) => {
      forwardOutput(chunk, process.stdout);
    });
    wdioProcess.stderr.on("data", (chunk) => {
      forwardOutput(chunk, process.stderr);
    });

    exitCode = await new Promise((resolve) => {
      wdioProcess.once("exit", (code) => {
        clearTimeout(timeoutId);
        resolve(timedOut ? 124 : (code ?? 1));
      });
    });
  } finally {
    if (logcatProcess) {
      logcatProcess.kill("SIGTERM");
    }
    if (logcatStream) {
      await new Promise((resolve) => logcatStream.end(resolve));
    }

    if (adbPath) {
      console.log(`Saved Android logs to ${logcatPath}`);
      stopEmulator(adbPath, env, ownedEmulatorSerial);
    }
  }

  return Number(exitCode);
}

process.exit(await main());
