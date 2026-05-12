export interface ThemeData {
  bg: string;
  surface: string;
  surfaceVariant: string;
  surfaceHigh: string;

  primary: string;
  primaryDim: string;
  secondary: string;

  accent: string;
  accentDim: string;

  ok: string;
  warn: string;
  error: string;

  text: string;
  textDim: string;
  muted: string;

  border: string;
  borderFocus: string;

  selectionFocused: string;
  selectionBlurred: string;
}

const PROBE_DARK: ThemeData = {
  bg: "#0c0e14",
  surface: "#141820",
  surfaceVariant: "#1c2230",
  surfaceHigh: "#252d3e",

  primary: "#7dd3fc",
  primaryDim: "#0369a1",
  secondary: "#34d399",

  accent: "#60a5fa",
  accentDim: "#1e3a5f",

  ok: "#4ade80",
  warn: "#fbbf24",
  error: "#f87171",

  text: "#e2e8f0",
  textDim: "#94a3b8",
  muted: "#64748b",

  border: "#1e293b",
  borderFocus: "#60a5fa",

  selectionFocused: "#1e3a5f",
  selectionBlurred: "#1e293b",
};

const MATERIAL: ThemeData = {
  bg: "#121212",
  surface: "#1a1a1a",
  surfaceVariant: "#242424",
  surfaceHigh: "#2e2e2e",

  primary: "#bb86fc",
  primaryDim: "#7c4dff",
  secondary: "#03dac6",

  accent: "#4ea1ff",
  accentDim: "#1f3a5c",

  ok: "#69f0ae",
  warn: "#ffb74d",
  error: "#cf6679",

  text: "#e6e1e5",
  textDim: "#b0b0b0",
  muted: "#7a7a7a",

  border: "#2a2a2a",
  borderFocus: "#4ea1ff",

  selectionFocused: "#1f3a5c",
  selectionBlurred: "#2a2a2a",
};

const GITHUB: ThemeData = {
  bg: "#0d1117",
  surface: "#161b22",
  surfaceVariant: "#1f242c",
  surfaceHigh: "#262c36",

  primary: "#d2a8ff",
  primaryDim: "#a371f7",
  secondary: "#79c0ff",

  accent: "#58a6ff",
  accentDim: "#1f3b66",

  ok: "#3fb950",
  warn: "#d29922",
  error: "#f85149",

  text: "#c9d1d9",
  textDim: "#8b949e",
  muted: "#6e7681",

  border: "#30363d",
  borderFocus: "#58a6ff",

  selectionFocused: "#1f3b66",
  selectionBlurred: "#21262d",
};

export const THEMES = {
  probe: PROBE_DARK,
  material: MATERIAL,
  github: GITHUB,
} as const;

export type ThemeName = keyof typeof THEMES;
export const THEME_NAMES = Object.keys(THEMES) as ThemeName[];

export const theme: ThemeData = { ...PROBE_DARK };

export function applyTheme(name: string): boolean {
  const next = (THEMES as Record<string, ThemeData | undefined>)[name];
  if (!next) return false;
  Object.assign(theme, next);
  return true;
}
