import type {
  CaptureStatus,
  ProbeDiscoveryResult,
  DiscoverResult,
  HealthResponse,
  OpenocdSpawnResult,
  SendResult,
  SessionInfo,
  StreamBatch,
  StreamStatus,
} from "./types.ts";

export class BridgeError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "BridgeError";
  }
}

export interface BridgeClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
}

const DEFAULT_BASE_URL =
  process.env.PSTUI_SIDECAR_URL ?? "http://127.0.0.1:17900";

interface RpcResponse<T> {
  result?: T;
  error?: string;
}

export class BridgeClient {
  readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: BridgeClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? 8_000;
  }

  async call<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    opts: { timeoutMs?: number } = {},
  ): Promise<T> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? this.timeoutMs);
    try {
      const res = await fetch(this.baseUrl + "/rpc", {
        method: "POST",
        signal: ctl.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method, params }),
      });
      const text = await res.text();
      let parsed: RpcResponse<T> = {};
      if (text.length > 0) {
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new BridgeError(
            `Invalid JSON from /rpc: ${text.slice(0, 120)}`,
            res.status,
          );
        }
      }
      if (!res.ok || parsed.error) {
        throw new BridgeError(parsed.error ?? `HTTP ${res.status}`, res.status);
      }
      return parsed.result as T;
    } catch (err) {
      if (err instanceof BridgeError) throw err;
      if ((err as { name?: string })?.name === "AbortError") {
        throw new BridgeError(`Request timed out: ${method}`);
      }
      throw new BridgeError(
        `Sidecar unreachable at ${this.baseUrl} (${(err as Error).message})`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async health(): Promise<HealthResponse> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 2_000);
    try {
      const res = await fetch(this.baseUrl + "/health", { signal: ctl.signal });
      if (!res.ok) throw new BridgeError(`HTTP ${res.status}`, res.status);
      return (await res.json()) as HealthResponse;
    } catch (err) {
      if (err instanceof BridgeError) throw err;
      throw new BridgeError(`Sidecar unreachable (${(err as Error).message})`);
    } finally {
      clearTimeout(timer);
    }
  }


  discoverProbes(): Promise<ProbeDiscoveryResult> {
    return this.call("probes.discover", {}, { timeoutMs: 20_000 });
  }


  openocdConnect(host?: string, port?: number): Promise<{ ok: boolean; error?: string }> {
    return this.call("openocd.connect", { host, port });
  }

  openocdSpawn(opts?: {
    openocdPath?: string;
    scriptsPath?: string;
    interfaceConfig?: string;
    targetConfig?: string;
    adapterSerial?: string;
    tclPort?: number;
  }): Promise<OpenocdSpawnResult> {
    return this.call("openocd.spawn", opts ?? {}, { timeoutMs: 15_000 });
  }

  openocdStop(): Promise<{ ok: boolean }> {
    return this.call("openocd.stop");
  }

  openocdStatus(): Promise<{ connected: boolean; spawned: boolean; pid: number | null }> {
    return this.call("openocd.status");
  }


  discover(opts?: {
    ramStart?: number;
    ramSize?: number;
    scanChunkSize?: number;
  }): Promise<DiscoverResult> {
    return this.call("probestream.discover", opts ?? {}, { timeoutMs: 30_000 });
  }

  attach(addr: number): Promise<DiscoverResult> {
    return this.call("probestream.attach", { addr });
  }

  sessions(): Promise<SessionInfo[]> {
    return this.call<SessionInfo[]>("probestream.sessions");
  }


  streamStart(opts?: { channels?: number[] }): Promise<StreamStatus> {
    return this.call("stream.start", opts ?? {});
  }

  streamStop(): Promise<StreamStatus> {
    return this.call("stream.stop");
  }

  streamStatus(): Promise<StreamStatus> {
    return this.call("stream.status");
  }

  streamSend(channel: number, data: string): Promise<SendResult> {
    return this.call("stream.send", { channel, data }, { timeoutMs: 20_000 });
  }

  streamSendHex(channel: number, hex: string): Promise<SendResult> {
    return this.call("stream.send_hex", { channel, hex }, { timeoutMs: 20_000 });
  }

  streamClear(): Promise<{ ok: boolean }> {
    return this.call("stream.clear");
  }


  captureStart(path?: string, format?: string): Promise<CaptureStatus> {
    return this.call("capture.start", { path, format });
  }

  captureStop(): Promise<CaptureStatus> {
    return this.call("capture.stop");
  }

  captureStatus(): Promise<CaptureStatus> {
    return this.call("capture.status");
  }


  settingsGet(): Promise<Record<string, unknown>> {
    return this.call<Record<string, unknown>>("settings.get");
  }

  settingsSet(values: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.call<Record<string, unknown>>("settings.set", { values });
  }


  streamEvents(
    onBatch: (batch: StreamBatch) => void,
    onError?: (err: Error) => void,
  ): { close: () => void } {
    const ctl = new AbortController();
    const url = this.baseUrl + "/stream";

    // Helper: sleep that respects the abort signal.
    const pause = (ms: number) =>
      new Promise<void>((resolve) => {
        const id = setTimeout(resolve, ms);
        ctl.signal.addEventListener("abort", () => { clearTimeout(id); resolve(); }, { once: true });
      });

    (async () => {
      while (!ctl.signal.aborted) {
        try {
          const res = await fetch(url, { signal: ctl.signal });
          if (!res.ok || !res.body) {
            onError?.(new BridgeError(`SSE connect failed: HTTP ${res.status}`));
            await pause(2_000);
            continue;
          }
          const bodyReader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";

          while (true) {
            const { done, value } = await bodyReader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
              if (line.startsWith("data: ")) {
                try {
                  const batch = JSON.parse(line.slice(6)) as StreamBatch;
                  onBatch(batch);
                } catch {
                  // malformed SSE line
                }
              }
            }
          }
          // Stream ended (server closed connection) — reconnect after a brief pause.
        } catch (err) {
          if (ctl.signal.aborted || (err as { name?: string })?.name === "AbortError") {
            return;
          }
          onError?.(err as Error);
        }
        await pause(500);
      }
    })();

    return { close: () => ctl.abort() };
  }
}
