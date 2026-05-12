// Clipboard helper using available system tools.
// Tries Wayland (wl-copy), X11 (xclip, xsel), macOS (pbcopy), Windows (clip).

async function trySpawn(cmd: string[], input: string): Promise<boolean> {
  try {
    const proc = Bun.spawn({ cmd, stdin: "pipe", stdout: "ignore", stderr: "ignore" });
    proc.stdin.write(input);
    await proc.stdin.end();
    const code = await proc.exited;
    return code === 0;
  } catch {
    return false;
  }
}

export async function copyToClipboard(text: string): Promise<{ ok: boolean; tool: string; error?: string }> {
  const candidates: { tool: string; cmd: string[] }[] = [
    { tool: "wl-copy", cmd: ["wl-copy"] },
    { tool: "xclip", cmd: ["xclip", "-selection", "clipboard"] },
    { tool: "xsel", cmd: ["xsel", "--clipboard", "--input"] },
    { tool: "pbcopy", cmd: ["pbcopy"] },
    { tool: "clip", cmd: ["clip"] },
  ];
  for (const { tool, cmd } of candidates) {
    if (await trySpawn(cmd, text)) {
      return { ok: true, tool };
    }
  }
  return { ok: false, tool: "", error: "no clipboard tool found (install xclip, wl-clipboard, or xsel)" };
}
