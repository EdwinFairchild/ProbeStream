export interface HealthResponse {
  ok: boolean;
  pid: number;
  openocd_connected: boolean;
  probestream_attached: boolean;
  streaming: boolean;
}

export interface DebugProbeInfo {
  id: string;
  tool: string;
  vendor: string;
  product: string;
  serial: string;
  target?: string;
  status: "available" | "unknown";
  raw?: string;
}

export interface ProbeToolStatus {
  name: string;
  available: boolean;
  timedOut?: boolean;
  message: string;
}

export interface ProbeDiscoveryResult {
  ok: boolean;
  probes: DebugProbeInfo[];
  tools: ProbeToolStatus[];
  error: string | null;
}

export interface SessionInfo {
  id: string;
  label: string;
  tclHost: string;
  tclPort: number;
  openocdState: "disconnected" | "connected" | "spawned";
  targetConfig: string;
  interfaceConfig: string;
  adapterSerial: string;
  probestreamAttached: boolean;
  controlBlockAddr: number | null;
  ramStart: number;
  ramSize: number;
  numUp: number;
  numDown: number;
  lastError: string | null;
}

export interface ChannelInfo {
  index: number;
  bufferAddr: number;
  size: number;
  wrOff: number;
  rdOff: number;
  flags: number;
}

export interface DiscoverResult {
  attached: boolean;
  controlBlockAddr: number | null;
  numUp: number;
  numDown: number;
  error: string | null;
}

export interface StreamBatch {
  sessionId: string;
  seq: number;
  ts: number;
  channel: number;
  byteCount: number;
  payload: string; // base64
}

export interface StreamStatus {
  active: boolean;
  sessionId: string | null;
  totalBytes: number;
  totalBatches: number;
  droppedBatches: number;
  uptimeMs: number;
  channels: number[];
}

export interface CaptureStatus {
  active: boolean;
  path: string | null;
  format: "raw" | "text" | "jsonl";
  bytesWritten: number;
  error: string | null;
}

export interface OpenocdSpawnResult {
  ok: boolean;
  pid: number | null;
  error: string | null;
}

export interface SendResult {
  written: number;
  channel: number;
}
