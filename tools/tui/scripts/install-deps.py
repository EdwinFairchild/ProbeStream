#!/usr/bin/env python3
"""Install Bun (if needed) and ProbeStream TUI dependencies.

Cross-platform entry point:
  python tools/tui/scripts/install-deps.py
"""

from __future__ import annotations

import os
import platform
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

IS_WINDOWS = os.name == "nt"
TUI_DIR = Path(__file__).resolve().parents[1]
BUN_DIR = Path(os.environ.get("BUN_INSTALL", Path.home() / ".bun"))
BUN_BIN_DIR = BUN_DIR / "bin"
BUN_EXE = BUN_BIN_DIR / ("bun.exe" if IS_WINDOWS else "bun")


class InstallError(RuntimeError):
    pass


def info(message: str) -> None:
    print(message, flush=True)


def fail(message: str, *, detail: str | None = None, hint: str | None = None) -> None:
    print(f"ERROR: {message}", file=sys.stderr)
    if detail:
        print(f"\nDetails:\n{detail.strip()}", file=sys.stderr)
    if hint:
        print(f"\nHint: {hint}", file=sys.stderr)


def run(command: list[str], *, cwd: Path | None = None, input_text: str | None = None) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            command,
            cwd=str(cwd) if cwd else None,
            input=input_text,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=True,
        )
    except FileNotFoundError as exc:
        raise InstallError(f"Command not found: {command[0]}") from exc
    except subprocess.CalledProcessError as exc:
        detail = ""
        if exc.stdout:
            detail += exc.stdout
        if exc.stderr:
            detail += exc.stderr
        raise InstallError(f"Command failed: {' '.join(command)}\n{detail}".rstrip()) from exc


def prepend_path_for_this_process(path: Path) -> None:
    os.environ["PATH"] = str(path) + os.pathsep + os.environ.get("PATH", "")


def find_bun() -> Path | None:
    bun = shutil.which("bun")
    if bun:
        return Path(bun)
    if BUN_EXE.exists():
        prepend_path_for_this_process(BUN_BIN_DIR)
        return BUN_EXE
    return None


def bun_version(bun: Path) -> str:
    result = run([str(bun), "--version"])
    return result.stdout.strip()


def download_text(url: str) -> str:
    try:
        with urllib.request.urlopen(url, timeout=30) as response:
            return response.read().decode("utf-8")
    except urllib.error.URLError as exc:
        raise InstallError(
            f"Could not download {url}: {exc}",
        ) from exc


def install_bun_windows() -> None:
    if shutil.which("powershell") is None and shutil.which("pwsh") is None:
        raise InstallError("PowerShell is required to install Bun on Windows.")
    shell = shutil.which("powershell") or shutil.which("pwsh")
    assert shell is not None
    script = download_text("https://bun.sh/install.ps1")
    info("Installing Bun with the official Windows installer...")
    run([shell, "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "-"], input_text=script)
    prepend_path_for_this_process(BUN_BIN_DIR)


def install_bun_unix() -> None:
    if shutil.which("bash") is None:
        raise InstallError("bash is required to install Bun on Linux/macOS.")
    script = download_text("https://bun.sh/install")
    info("Installing Bun with the official Linux/macOS installer...")
    run(["bash"], input_text=script)
    prepend_path_for_this_process(BUN_BIN_DIR)


def install_bun() -> Path:
    if IS_WINDOWS:
        install_bun_windows()
    else:
        install_bun_unix()

    bun = find_bun()
    if not bun:
        raise InstallError(
            f"Bun installer completed, but {BUN_EXE} was not found.",
        )
    return bun


def persist_path_windows(path: Path) -> None:
    try:
        import winreg  # type: ignore[attr-defined]
    except ImportError as exc:
        raise InstallError("Python winreg module is unavailable; cannot update user PATH.") from exc

    key_path = "Environment"
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path, 0, winreg.KEY_READ | winreg.KEY_WRITE) as key:
        try:
            current, value_type = winreg.QueryValueEx(key, "Path")
        except FileNotFoundError:
            current, value_type = "", winreg.REG_EXPAND_SZ
        parts = [part for part in str(current).split(";") if part]
        target = str(path)
        if any(part.lower() == target.lower() for part in parts):
            info("Bun PATH entry already present in the Windows user PATH.")
            return
        next_value = ";".join([target, *parts])
        winreg.SetValueEx(key, "Path", 0, value_type, next_value)
    info(f"Added {path} to the Windows user PATH. Re-open terminals to pick it up.")


def append_unique_line(path: Path, line: str, comment: str) -> bool:
    try:
        existing = path.read_text(encoding="utf-8") if path.exists() else ""
        if str(BUN_BIN_DIR) in existing or ".bun/bin" in existing:
            return False
        with path.open("a", encoding="utf-8") as handle:
            if existing and not existing.endswith("\n"):
                handle.write("\n")
            handle.write(f"\n{comment}\n{line}\n")
        return True
    except OSError as exc:
        raise InstallError(f"Could not update {path}: {exc}") from exc


def persist_path_unix(path: Path) -> None:
    line = 'export PATH="$HOME/.bun/bin:$PATH"'
    comment = "# added by ProbeStream TUI install-deps.py"
    shell = os.environ.get("SHELL", "")
    candidates: list[Path] = []
    if shell.endswith("bash"):
        candidates.append(Path.home() / ".bashrc")
    elif shell.endswith("zsh"):
        candidates.append(Path.home() / ".zshrc")
    candidates.append(Path.home() / ".profile")

    updated: list[Path] = []
    for candidate in dict.fromkeys(candidates):
        if append_unique_line(candidate, line, comment):
            updated.append(candidate)

    if updated:
        joined = ", ".join(str(item) for item in updated)
        info(f"Added Bun to PATH in {joined}. Re-open your terminal or source the file.")
    else:
        info("Bun PATH entry already present in your shell profile files.")


def persist_path(path: Path) -> None:
    if str(path) in os.environ.get("PATH", ""):
        info("Bun is available in PATH for this installer run.")
    if IS_WINDOWS:
        persist_path_windows(path)
    else:
        persist_path_unix(path)


def ensure_bun() -> Path:
    bun = find_bun()
    if bun:
        info(f"Bun found: {bun} ({bun_version(bun)})")
    else:
        bun = install_bun()
        info(f"Bun installed: {bun} ({bun_version(bun)})")
    persist_path(BUN_BIN_DIR)
    return bun


def install_dependencies(bun: Path) -> None:
    package_json = TUI_DIR / "package.json"
    if not package_json.exists():
        raise InstallError(f"Could not find {package_json}; script path looks wrong.")
    info(f"Running bun install in {TUI_DIR}...")
    result = run([str(bun), "install"], cwd=TUI_DIR)
    if result.stdout.strip():
        print(result.stdout.rstrip())
    if result.stderr.strip():
        print(result.stderr.rstrip(), file=sys.stderr)


def main() -> int:
    info("ProbeStream TUI dependency installer")
    info(f"Platform: {platform.system()} {platform.release()}")
    info(f"TUI directory: {TUI_DIR}")
    try:
        bun = ensure_bun()
        install_dependencies(bun)
    except InstallError as exc:
        fail(
            "TUI dependency installation failed.",
            detail=str(exc),
            hint=(
                "Check your network connection and that Python can run subprocesses. "
                "If Bun is installed manually, ensure its bin directory is on PATH, then rerun this script."
            ),
        )
        return 1
    except KeyboardInterrupt:
        fail("Installation cancelled by user.")
        return 130

    info("")
    info("All done. To start the TUI:")
    info("  cd tools/tui")
    info("  bun run dev")
    if not IS_WINDOWS:
        info("or:")
        info("  cd tools/tui && ./scripts/dev.sh")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
