import { spawn, type ChildProcess } from "node:child_process";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

export interface SupervisorOptions {
  baseUrl: string;
  launcher?: string;
  extraArgs?: string[];
  startupTimeoutMs?: number;
  onLog?: (line: string) => void;
}

export interface SupervisedSidecar {
  spawned: boolean;
  stop: () => void;
}

const IS_WINDOWS = process.platform === "win32";
const SIDECAR_SCRIPT = IS_WINDOWS ? "sidecar.cmd" : "sidecar.sh";

function resolveDefaultLauncher(): string {
  const override = process.env.PSTUI_SIDECAR;
  if (override && override.length > 0) return override;

  const execDir = dirname(process.execPath);
  const execName = basename(process.execPath);
  const adjacentScript = SIDECAR_SCRIPT;
  const adjacent = resolve(execDir, adjacentScript);
  if (
    (execName === "probestream-tui" || execName === "probestream-tui-bin" ||
     execName === "probestream-tui.exe" || execName === "probestream-tui-bin.exe") &&
    existsSync(adjacent)
  ) {
    return adjacent;
  }

  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return resolve(here, `../../scripts/${SIDECAR_SCRIPT}`);
  } catch {
    return adjacent;
  }
}

const DEFAULT_LAUNCHER = resolveDefaultLauncher();

async function ping(baseUrl: string, timeoutMs = 800): Promise<boolean> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${baseUrl}/health`, { signal: ctl.signal });
    return r.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

async function waitForHealth(baseUrl: string, deadline: number): Promise<boolean> {
  while (Date.now() < deadline) {
    if (await ping(baseUrl)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

export async function ensureSidecar(opts: SupervisorOptions): Promise<SupervisedSidecar> {
  if (await ping(opts.baseUrl)) {
    return { spawned: false, stop: () => {} };
  }

  const launcher = opts.launcher ?? DEFAULT_LAUNCHER;
  const args = opts.extraArgs ?? [];
  const spawnOpts: import("node:child_process").SpawnOptions = {
    stdio: ["ignore", "pipe", "pipe"],
    // Put sidecar (and any grandchildren like OpenOCD) in their own process
    // group so we can signal the entire group with `kill(-pid, …)` on quit.
    // On Windows detached=true creates a new process group which lets
    // taskkill /T terminate the whole tree.
    detached: true,
  };
  // On Windows, .cmd files must be launched via cmd.exe
  const spawnCmd = IS_WINDOWS && launcher.endsWith(".cmd")
    ? "cmd.exe"
    : launcher;
  const spawnArgs = IS_WINDOWS && launcher.endsWith(".cmd")
    ? ["/c", launcher, ...args]
    : args;
  const child: ChildProcess = spawn(spawnCmd, spawnArgs, spawnOpts);

  const log = opts.onLog ?? (() => {});
  const pipe = (buf: Buffer) =>
    buf
      .toString("utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .forEach(log);
  child.stdout?.on("data", pipe);
  child.stderr?.on("data", pipe);

  let exited = false;
  child.on("exit", (code, sig) => {
    exited = true;
    log(`[sidecar] exited code=${code} signal=${sig ?? ""}`);
  });

  const killGroup = IS_WINDOWS
    ? () => {
        if (!child.pid) return;
        // On Windows, kill the whole process tree via taskkill.
        try {
          spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" });
        } catch {
          try { child.kill(); } catch { /* ignore */ }
        }
      }
    : (sig: NodeJS.Signals) => {
        if (!child.pid) return;
        try {
          process.kill(-child.pid, sig); // negative pid → signal whole group
        } catch {
          // Group may already be gone or we lost the race; fall back to direct kill.
          try { child.kill(sig); } catch { /* ignore */ }
        }
      };

  const stop = () => {
    if (exited) return;
    if (IS_WINDOWS) {
      (killGroup as () => void)();
    } else {
      (killGroup as (sig: NodeJS.Signals) => void)("SIGTERM");
      // Escalate if the group is still alive after a short grace period.
      setTimeout(() => {
        if (!exited) (killGroup as (sig: NodeJS.Signals) => void)("SIGKILL");
      }, 1500).unref?.();
    }
  };

  const cleanup = () => stop();
  process.once("exit", cleanup);
  process.once("SIGINT", () => { cleanup(); process.exit(130); });
  process.once("SIGTERM", () => { cleanup(); process.exit(143); });
  if (!IS_WINDOWS) {
    process.once("SIGHUP", () => { cleanup(); process.exit(129); });
  }
  process.once("uncaughtException", (err) => {
    cleanup();
    console.error(err);
    process.exit(1);
  });

  const timeoutMs = opts.startupTimeoutMs ?? 15_000;
  const ok = await waitForHealth(opts.baseUrl, Date.now() + timeoutMs);
  if (!ok) {
    stop();
    throw new Error(
      `sidecar did not become healthy within ${timeoutMs}ms at ${opts.baseUrl}`,
    );
  }

  return { spawned: true, stop };
}
