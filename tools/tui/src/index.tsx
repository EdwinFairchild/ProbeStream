import React from "react";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { AppFrame } from "./components/AppFrame.tsx";
import { BridgeClient } from "./bridge/client.ts";
import { ensureSidecar } from "./bridge/supervisor.ts";
import { applyTheme } from "./theme.ts";
import { loadLocalSettings } from "./settingsStorage.ts";

function applyPersistedThemeEarly(): void {
  const settings = loadLocalSettings();
  if (typeof settings.themeName === "string") {
    applyTheme(settings.themeName);
  }
}
applyPersistedThemeEarly();

const client = new BridgeClient();

const sidecarLog: string[] = [];
const sidecarLogListeners = new Set<(line: string) => void>();
function pushSidecarLog(line: string): void {
  sidecarLog.push(line);
  if (sidecarLog.length > 200) sidecarLog.shift();
  for (const listener of sidecarLogListeners) listener(line);
}

const supervised = await ensureSidecar({
  baseUrl: client.baseUrl,
  onLog: pushSidecarLog,
}).catch((err: Error) => {
  console.error(`Failed to start sidecar: ${err.message}`);
  process.exit(1);
});

// Drop any SSE backlog the sidecar may still hold from a previous TUI
// session (the supervisor reuses an already-running sidecar if one is
// listening on the bridge port). Without this the StreamPage would
// instantly replay stale batches on launch.
try {
  await client.streamClear();
} catch {
  // Sidecar may not be ready yet for RPC; harmless — backlog will just
  // be whatever the previous session left, which the user can flush
  // manually with /clear.
}

function Root({ onQuit }: { onQuit: () => void }) {
  return (
    <AppFrame
      client={client}
      onQuit={onQuit}
      initialSidecarLog={sidecarLog}
      subscribeSidecarLog={(listener) => {
        sidecarLogListeners.add(listener);
        return () => sidecarLogListeners.delete(listener);
      }}
      clearSidecarLog={() => {
        sidecarLog.length = 0;
      }}
    />
  );
}

const renderer = await createCliRenderer({
  exitOnCtrlC: false,
  useMouse: true,
  useKittyKeyboard: { events: true },
});

const quit = () => {
  renderer.destroy();
  supervised?.stop();
  if (supervised?.spawned && sidecarLog.length) {
    process.stderr.write(
      `\n--- sidecar log (last ${sidecarLog.length} lines) ---\n` +
      sidecarLog.join("\n") +
      "\n",
    );
  }
  process.exit(0);
};

createRoot(renderer).render(<Root onQuit={quit} />);
renderer.start();
