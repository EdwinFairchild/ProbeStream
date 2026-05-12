import { describe, expect, test } from "bun:test";
import {
  SETTING_DEFS,
  canCycleValue,
  canOpenValueEditor,
  getBool,
  getString,
  nextSettingValue,
  withDefaults,
} from "./settings.ts";

describe("settings", () => {
  test("SETTING_DEFS has entries", () => {
    expect(SETTING_DEFS.length).toBeGreaterThan(10);
  });

  test("all defs have unique ids", () => {
    const ids = SETTING_DEFS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("withDefaults fills missing keys", () => {
    const s = withDefaults({});
    expect(s.themeName).toBe("probe");
    expect(s.autoscroll).toBe(true);
    expect(s.tclPort).toBe("6666");
  });

  test("withDefaults preserves existing keys", () => {
    const s = withDefaults({ themeName: "github" });
    expect(s.themeName).toBe("github");
  });

  test("withDefaults preserves unknown keys", () => {
    const s = withDefaults({ custom: "value" });
    expect(s.custom).toBe("value");
  });

  test("getBool returns boolean", () => {
    expect(getBool({ autoscroll: true }, "autoscroll")).toBe(true);
    expect(getBool({ autoscroll: false }, "autoscroll")).toBe(false);
    expect(getBool({}, "autoscroll")).toBe(true); // default
    expect(getBool({}, "nonexistent")).toBe(false);
  });

  test("getString returns string", () => {
    expect(getString({ themeName: "github" }, "themeName")).toBe("github");
    expect(getString({}, "themeName")).toBe("probe"); // default
    expect(getString({}, "nonexistent")).toBe("");
  });

  test("predefined selects cycle unless they allow custom values", () => {
    const theme = SETTING_DEFS.find((d) => d.id === "themeName")!;
    const tclPort = SETTING_DEFS.find((d) => d.id === "tclPort")!;
    const scanChunkSize = SETTING_DEFS.find((d) => d.id === "scanChunkSize")!;
    const openocdPath = SETTING_DEFS.find((d) => d.id === "openocdPath")!;

    expect(canCycleValue(theme)).toBe(true);
    expect(canOpenValueEditor(theme)).toBe(false);
    expect(canOpenValueEditor(tclPort)).toBe(true);
    expect(canOpenValueEditor(scanChunkSize)).toBe(true);
    expect(canOpenValueEditor(openocdPath)).toBe(true);
  });

  test("nextSettingValue advances cycleable values", () => {
    const theme = SETTING_DEFS.find((d) => d.id === "themeName")!;
    const autoscroll = SETTING_DEFS.find((d) => d.id === "autoscroll")!;

    expect(nextSettingValue(theme, "probe")).toBe("material");
    expect(nextSettingValue(theme, "unknown")).toBe("probe");
    expect(nextSettingValue(autoscroll, true)).toBe(false);
  });
});
