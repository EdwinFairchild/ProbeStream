import { spawn, spawnSync, type ChildProcess } from "node:child_process";
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

interface ResolvedLauncher {
  cmd: string;
  args: string[];
  /** Original launcher path/string (for logging/debug). */
  display: string;
}

function findRepoSidecarPy(): string | null {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const py = resolve(here, "../../sidecar/pstui_sidecar.py");
    return existsSync(py) ? py : null;
  } catch {
    return null;
  }
}

function findAdjacentSidecarPy(): string | null {
  const execDir = dirname(process.execPath);
  // Common layouts: <execDir>/sidecar/pstui_sidecar.py or <execDir>/pstui_sidecar.py
  const candidates = [
    resolve(execDir, "sidecar", "pstui_sidecar.py"),
    resolve(execDir, "pstui_sidecar.py"),
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  return null;
}

function resolveLauncher(override?: string): ResolvedLauncher {
  const envOverride = override ?? process.env.PSTUI_SIDECAR;

  // Honor explicit override exactly (assume user knows what they want).
  if (envOverride && envOverride.length > 0) {
    if (IS_WINDOWS && envOverride.toLowerCase().endsWith(".cmd")) {
      return { cmd: "cmd.exe", args: ["/c", envOverride], display: envOverride };
    }
    return { cmd: envOverride, args: [], display: envOverride };
  }

  // On Windows, prefer launching python directly (no cmd.exe → no console
  // window pop-up regardless of windowsHide / detached interactions).
  if (IS_WINDOWS) {
    const py = findRepoSidecarPy() ?? findAdjacentSidecarPy();
    if (py) {
      const host = process.env.PSTUI_SIDECAR_HOST ?? "127.0.0.1";
      const port = process.env.PSTUI_SIDECAR_PORT ?? "17900";
      return {
        cmd: "python",
        args: [py, "--host", host, "--port", port],
        display: `python ${py}`,
      };
    }
    // Fall through to .cmd shim if we couldn't locate the .py.
  }

  // Default: use the platform script shim.
  const execDir = dirname(process.execPath);
  const execName = basename(process.execPath);
  const adjacent = resolve(execDir, SIDECAR_SCRIPT);
  let shim = adjacent;
  if (
    !((execName === "probestream-tui" || execName === "probestream-tui-bin" ||
       execName === "probestream-tui.exe" || execName === "probestream-tui-bin.exe") &&
      existsSync(adjacent))
  ) {
    try {
      const here = dirname(fileURLToPath(import.meta.url));
      shim = resolve(here, `../../scripts/${SIDECAR_SCRIPT}`);
    } catch {
      shim = adjacent;
    }
  }

  if (IS_WINDOWS && shim.toLowerCase().endsWith(".cmd")) {
    return { cmd: "cmd.exe", args: ["/c", shim], display: shim };
  }
  return { cmd: shim, args: [], display: shim };
}

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

async function sidecarRpc(baseUrl: string, method: string, params: Record<string, unknown> = {}): Promise<void> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 1_000);
  try {
    await fetch(`${baseUrl}/rpc`, {
      method: "POST",
      signal: ctl.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method, params }),
    });
  } catch {
    // Best-effort lifecycle RPC. If the sidecar is already gone, cleanup won.
  } finally {
    clearTimeout(timer);
  }
}

export async function ensureSidecar(opts: SupervisorOptions): Promise<SupervisedSidecar> {
  if (await ping(opts.baseUrl)) {
    await sidecarRpc(opts.baseUrl, "sidecar.claim", { parentPid: process.pid });
    return {
      spawned: false,
      stop: () => { void sidecarRpc(opts.baseUrl, "sidecar.shutdown"); },
    };
  }

  const resolved = resolveLauncher(opts.launcher);
  const extraArgs = opts.extraArgs ?? [];
  const spawnArgs = [...resolved.args, ...extraArgs];
  const spawnOpts: import("node:child_process").SpawnOptions = {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PSTUI_PARENT_PID: String(process.pid),
    },
    // Suppress any console window on Windows. Combined with NOT setting
    // detached:true on Windows, this keeps the python sidecar fully hidden.
    windowsHide: true,
  };
  if (IS_WINDOWS) {
    // CREATE_NO_WINDOW (0x08000000) prevents a console from being created
    // for the child even when the parent has one (e.g. PowerShell). We use
    // taskkill /T to terminate the tree on stop, so we don't need a new
    // process group here.
    (spawnOpts as { creationflags?: number }).creationflags = 0x08000000;
  } else {
    // POSIX: own process group so we can group-signal on quit.
    spawnOpts.detached = true;
  }
  const child: ChildProcess = spawn(resolved.cmd, spawnArgs, spawnOpts);

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
        // On Windows, kill the whole process tree via taskkill SYNCHRONOUSLY.
        // Async spawn here would race with process.exit() in quit() and the
        // sidecar (and its OpenOCD child) would be orphaned.
        try {
          spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], {
            stdio: "ignore",
            windowsHide: true,
            timeout: 4000,
          });
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
