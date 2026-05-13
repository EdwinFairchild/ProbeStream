#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { chmod, cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const isWindows = process.platform === "win32";
const scriptDir = dirname(fileURLToPath(import.meta.url));
const tuiDir = resolve(scriptDir, "..");
const defaultDistDir = resolve(tuiDir, "..", "..", "probestream-tui-dist");

function run(command: string, args: string[], cwd: string): void {
  console.log(`+ ${[command, ...args].join(" ")}`);
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function shouldCopySidecar(sourcePath: string): boolean {
  const normalized = sourcePath.replaceAll("\\", "/");
  if (normalized.includes("/__pycache__/") || normalized.endsWith("/__pycache__")) return false;
  if (normalized.includes("/.pytest_cache/") || normalized.endsWith("/.pytest_cache")) return false;
  if (normalized.includes("/venv/") || normalized.endsWith("/venv")) return false;
  if (normalized.includes("/.venv/") || normalized.endsWith("/.venv")) return false;
  if (normalized.endsWith(".pyc")) return false;
  return true;
}

async function main(): Promise<void> {
  const distDir = resolve(process.argv[2] ?? defaultDistDir);
  await mkdir(distDir, { recursive: true });

  const binaryName = isWindows ? "probestream-tui.exe" : "probestream-tui";
  const binaryPath = resolve(distDir, binaryName);

  console.log("=== Building ProbeStream TUI ===");
  run(process.execPath, ["build", "src/index.tsx", "--compile", "--outfile", binaryPath], tuiDir);

  await rm(resolve(distDir, "sidecar"), { force: true, recursive: true });
  await rm(resolve(distDir, "sidecar.sh"), { force: true });
  await rm(resolve(distDir, "sidecar.cmd"), { force: true });

  const launcherName = isWindows ? "sidecar.cmd" : "sidecar.sh";
  await cp(resolve(tuiDir, "scripts", launcherName), resolve(distDir, launcherName));
  await cp(resolve(tuiDir, "sidecar"), resolve(distDir, "sidecar"), {
    recursive: true,
    filter: shouldCopySidecar,
  });

  if (!isWindows) {
    await chmod(binaryPath, 0o755);
    await chmod(resolve(distDir, launcherName), 0o755);
  }

  console.log(`=== Done: ${distDir} ===`);
}

await main();
