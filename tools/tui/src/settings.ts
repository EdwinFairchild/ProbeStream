import { THEME_NAMES } from "./theme.ts";

export interface BoolSettingDef {
  id: string;
  label: string;
  description: string;
  type: "bool";
  default: boolean;
}

export interface SelectSettingDef {
  id: string;
  label: string;
  description: string;
  type: "select";
  options: readonly string[];
  default: string;
  allowCustom?: boolean;
}

export interface StringSettingDef {
  id: string;
  label: string;
  description: string;
  type: "string";
  default: string;
}

export type SettingDef = BoolSettingDef | SelectSettingDef | StringSettingDef;

export const SETTING_DEFS: SettingDef[] = [
  {
    id: "themeName",
    label: "Theme",
    description: "Colour palette for the TUI.",
    type: "select",
    options: THEME_NAMES,
    default: "probe",
  },
  {
    id: "openocdPath",
    label: "OpenOCD path",
    description: "Path to the openocd binary.",
    type: "string",
    default: "openocd",
  },
  {
    id: "openocdScriptsPath",
    label: "OpenOCD scripts path",
    description: "Path to the OpenOCD scripts/tcl directory.",
    type: "string",
    default: "",
  },
  {
    id: "interfaceConfig",
    label: "Interface config",
    description: "OpenOCD interface config file (e.g. interface/stlink.cfg).",
    type: "string",
    default: "interface/stlink.cfg",
  },
  {
    id: "targetConfig",
    label: "Target config",
    description: "OpenOCD target config file (e.g. target/stm32u3x.cfg).",
    type: "string",
    default: "",
  },
  {
    id: "adapterSerial",
    label: "Adapter serial",
    description: "ST-Link or probe adapter serial number for multi-probe setups.",
    type: "string",
    default: "",
  },
  {
    id: "tclHost",
    label: "TCL host",
    description: "OpenOCD TCL-RPC host.",
    type: "string",
    default: "localhost",
  },
  {
    id: "tclPort",
    label: "TCL port",
    description: "OpenOCD TCL-RPC port.",
    type: "select",
    options: ["6666", "6667", "6668", "6669"],
    default: "6666",
    allowCustom: true,
  },
  {
    id: "ramStart",
    label: "RAM start",
    description: "Target RAM start address for ProbeStream scan (hex).",
    type: "string",
    default: "0x20000000",
  },
  {
    id: "ramSize",
    label: "RAM size",
    description: "Target RAM size in bytes for ProbeStream scan.",
    type: "string",
    default: "196608",
  },
  {
    id: "scanChunkSize",
    label: "Scan chunk size",
    description: "Chunk size in bytes for RAM scanning.",
    type: "select",
    options: ["512", "1024", "2048", "4096"],
    default: "1024",
    allowCustom: true,
  },
  {
    id: "controlBlockAddr",
    label: "Control block address",
    description: "Known control block address (skip scan). Leave empty to auto-discover.",
    type: "string",
    default: "",
  },
  {
    id: "readMode",
    label: "Read mode",
    description: "Memory read strategy: auto selects the fastest available.",
    type: "select",
    options: ["auto", "bulk", "mdw"],
    default: "auto",
  },
  {
    id: "pollMs",
    label: "Poll interval (ms)",
    description: "Polling interval for up-channel reads.",
    type: "select",
    options: ["10", "25", "50", "100"],
    default: "25",
  },
  {
    id: "defaultUpChannel",
    label: "Default up channel",
    description: "Default up-channel index to display.",
    type: "select",
    options: ["0", "1", "2", "3"],
    default: "0",
  },
  {
    id: "defaultDownChannel",
    label: "Default down channel",
    description: "Default down-channel index for terminal input.",
    type: "select",
    options: ["0", "1", "2", "3"],
    default: "0",
  },
  {
    id: "captureEnabled",
    label: "Capture enabled",
    description: "Automatically capture stream data to file.",
    type: "bool",
    default: false,
  },
  {
    id: "capturePath",
    label: "Capture path",
    description: "File path for stream capture output.",
    type: "string",
    default: "",
  },
  {
    id: "captureFormat",
    label: "Capture format",
    description: "Format for captured stream data.",
    type: "select",
    options: ["raw", "text", "jsonl"],
    default: "raw",
  },
  {
    id: "autoscroll",
    label: "Autoscroll",
    description: "Keep stream output pinned to newest data.",
    type: "bool",
    default: true,
  },
  {
    id: "chunkHistoryPerChannel",
    label: "Stream history",
    description: "Stream chunks retained per channel. Older chunks are dropped to keep memory bounded during long sessions.",
    type: "select",
    options: ["100", "250", "500", "1000", "2000", "5000"],
    default: "500",
    allowCustom: true,
  },
  {
    id: "maxStreamSplits",
    label: "Max stream splits",
    description: "Maximum up-channel panes shown by /channel split.",
    type: "select",
    options: ["1", "2", "3", "4"],
    default: "2",
  },
  {
    id: "graphWindowSize",
    label: "Graph window size",
    description: "Maximum numeric samples retained per graphed channel.",
    type: "select",
    options: ["64", "128", "256", "512", "1024"],
    default: "256",
    allowCustom: true,
  },
  {
    id: "graphChannels",
    label: "Graph channels",
    description: "Comma-separated up-channel indexes with graph panes enabled.",
    type: "string",
    default: "",
  },
  {
    id: "statsChannels",
    label: "Stats channels",
    description: "Comma-separated up-channel indexes with running stats enabled.",
    type: "string",
    default: "",
  },
];

export type SettingsMap = Record<string, unknown>;

export function canOpenValueEditor(def: SettingDef): boolean {
  return def.type === "string" || (def.type === "select" && def.allowCustom === true);
}

export function canCycleValue(def: SettingDef): boolean {
  return def.type === "bool" || def.type === "select";
}

export function nextSettingValue(def: SettingDef, current: unknown): unknown {
  if (def.type === "bool") return !current;
  if (def.type !== "select") return current;

  const options = def.options;
  const currentValue = typeof current === "string" ? current : def.default;
  const currentIndex = options.indexOf(currentValue);
  const nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % options.length;
  return options[nextIndex] ?? def.default;
}

export function withDefaults(stored: SettingsMap | null | undefined): SettingsMap {
  const out: SettingsMap = { ...(stored ?? {}) };
  for (const def of SETTING_DEFS) {
    out[def.id] = stored && def.id in stored ? stored[def.id] : def.default;
  }
  return out;
}

export function getBool(s: SettingsMap, id: string): boolean {
  const v = s[id];
  if (typeof v === "boolean") return v;
  const def = SETTING_DEFS.find((d) => d.id === id);
  return def && def.type === "bool" ? def.default : false;
}

export function getString(s: SettingsMap, id: string): string {
  const v = s[id];
  if (typeof v === "string") return v;
  const def = SETTING_DEFS.find((d) => d.id === id);
  return def && (def.type === "select" || def.type === "string") ? def.default : "";
}
