#!/usr/bin/env python3
"""ProbeStream TUI sidecar — HTTP/SSE server for the Bun/OpenTUI frontend.

Exposes:
  GET  /health         — liveness + status summary
  POST /rpc            — JSON-RPC style dispatch
  GET  /stream         — SSE stream of data batches
"""

import argparse
import base64
import json
import os
import re
import shutil
import signal
import sys
import threading
import time
import traceback
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Optional

# Allow running as module or script
if __name__ == "__main__" and __package__ is None:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from openocd_tcl import OpenOcdTcl, OpenOcdProcess
    from probestream_reader import ProbeStreamReader
else:
    from .openocd_tcl import OpenOcdTcl, OpenOcdProcess
    from .probestream_reader import ProbeStreamReader



def settings_path() -> Path:
    base = os.environ.get("XDG_CONFIG_HOME", str(Path.home() / ".config"))
    return Path(base) / "probestream-tui" / "settings.json"


def load_settings() -> dict:
    p = settings_path()
    if p.exists():
        try:
            return json.loads(p.read_text())
        except Exception:
            pass
    return {}


def save_settings(data: dict) -> dict:
    p = settings_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, indent=2))
    return data



_ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")


def _strip_ansi(text: str) -> str:
    return _ANSI_RE.sub("", text)


def _coerce_int(value: Any, default: int = 0) -> int:
    """Best-effort int coercion for RPC params + persisted settings.

    Accepts native ints, decimal/hex strings ("0x20000000", "196608"),
    floats from JSON, and falls back to ``default`` for None/blank/garbage.
    """
    if value is None:
        return default
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        s = value.strip()
        if not s:
            return default
        try:
            return int(s, 0)
        except ValueError:
            try:
                return int(float(s))
            except ValueError:
                return default
    return default


def _run_probe_tool(name: str, args: list[str], timeout: float = 4.0) -> tuple[bool, str, bool]:
    exe = shutil.which(name)
    if not exe:
        return False, "not found", False
    proc: subprocess.Popen[str] | None = None
    try:
        proc = subprocess.Popen(
            [exe, *args],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            start_new_session=True,
        )
        output, _ = proc.communicate(timeout=timeout)
        return True, _strip_ansi(output).strip(), False
    except subprocess.TimeoutExpired:
        if proc is not None:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
            try:
                output, _ = proc.communicate(timeout=1)
            except Exception:
                output = ""
        else:
            output = ""
        return True, f"timed out after {timeout:.1f}s\n{output.strip()}".strip(), True
    except Exception as e:
        return True, f"{type(e).__name__}: {e}", False


def _first_match(pattern: str, text: str) -> str:
    m = re.search(pattern, text, flags=re.IGNORECASE | re.MULTILINE)
    return m.group(1).strip() if m else ""


def _probe_id(tool: str, serial: str, index: int) -> str:
    return f"{tool}:{serial or index}"


def _add_probe(probes: list[dict], seen: set[str], probe: dict) -> None:
    serial = probe.get("serial", "")
    key = f"serial:{serial.lower()}" if serial else f"{probe.get('tool', '')}:{probe.get('id', '')}"
    if key in seen:
        return
    seen.add(key)
    probes.append(probe)


def _parse_st_info(output: str, probes: list[dict], seen: set[str]) -> None:
    blocks = re.split(r"\n\s*\n", _strip_ansi(output))
    index = 0
    for block in blocks:
        if "serial" not in block.lower() and "descr" not in block.lower():
            continue
        serial = _first_match(r"^\s*serial\s*:\s*(.+)$", block)
        version = _first_match(r"^\s*version\s*:\s*(.+)$", block)
        descr = _first_match(r"^\s*descr\s*:\s*(.+)$", block)
        chipid = _first_match(r"^\s*chipid\s*:\s*(.+)$", block)
        label = descr or version or serial or f"ST-LINK {index + 1}"
        _add_probe(probes, seen, {
            "id": _probe_id("st-info", serial, index),
            "tool": "st-info",
            "vendor": "STMicroelectronics",
            "product": label,
            "serial": serial,
            "target": chipid,
            "status": "available",
            "raw": block.strip(),
        })
        index += 1


def _parse_stm32_programmer(output: str, probes: list[dict], seen: set[str]) -> None:
    """Parse `STM32_Programmer_CLI --list stlink-only` output.

    Each probe is introduced by a header line like ``ST-Link Probe N :``
    followed by indented ``Key : Value`` lines until a blank line, the
    closing ``------`` separator, or the next header.
    """
    lines = _strip_ansi(output).splitlines()
    header_re = re.compile(r"^\s*ST-Link\s+Probe\s+\d+\s*:\s*$", re.IGNORECASE)
    kv_re = re.compile(r"^\s*([A-Za-z][A-Za-z0-9 \-_/]*?)\s*:\s*(.+?)\s*$")
    i = 0
    index = 0
    while i < len(lines):
        if not header_re.match(lines[i]):
            i += 1
            continue
        i += 1
        fields: dict[str, str] = {}
        while i < len(lines):
            line = lines[i]
            stripped = line.strip()
            if not stripped or stripped.startswith("---") or header_re.match(line):
                break
            kv = kv_re.match(line)
            if kv:
                fields[kv.group(1).strip().lower()] = kv.group(2).strip()
            i += 1
        serial = (
            fields.get("st-link sn")
            or fields.get("sn")
            or fields.get("serial number", "")
        )
        firmware = fields.get("st-link fw", "")
        board = fields.get("board name", "")
        product = f"ST-LINK {firmware}".strip()
        _add_probe(probes, seen, {
            "id": _probe_id("STM32_Programmer_CLI", serial, index),
            "tool": "STM32_Programmer_CLI",
            "vendor": "STMicroelectronics",
            "product": product,
            "serial": serial,
            "target": board,
            "status": "available",
            "raw": "\n".join(f"{k}: {v}" for k, v in fields.items()),
        })
        index += 1


def discover_debug_probes() -> dict:
    probes: list[dict] = []
    seen: set[str] = set()
    tools: list[dict] = []

    found, output, timed_out = _run_probe_tool("st-info", ["--probe"], timeout=2.0)
    tools.append({"name": "st-info", "available": found, "timedOut": timed_out, "message": output[:240]})
    if found:
        _parse_st_info(output, probes, seen)

    found, output, timed_out = _run_probe_tool(
        "STM32_Programmer_CLI", ["--list", "stlink-only"], timeout=6.0
    )
    tools.append({
        "name": "STM32_Programmer_CLI",
        "available": found,
        "timedOut": timed_out,
        "message": output[:240],
    })
    if found and not timed_out:
        _parse_stm32_programmer(output, probes, seen)

    return {
        "ok": True,
        "probes": probes,
        "tools": tools,
        "error": None if probes else "No debug probes found by st-info or STM32_Programmer_CLI",
    }



class SSEClients:
    # Keep a small ring of recently broadcast batches so that newly-connected
    # SSE subscribers (e.g. the StreamPage mounting just after `/start`) can
    # backfill batches that were published in the brief window between
    # streamStart and the SSE handshake completing.
    _BACKLOG_SIZE = 256

    def __init__(self):
        self._lock = threading.Lock()
        self._clients: list["SidecarHandler"] = []
        self._backlog: list[bytes] = []

    def add(self, handler: "SidecarHandler") -> None:
        with self._lock:
            self._clients.append(handler)
            backlog = list(self._backlog)
        # Replay outside the lock to avoid blocking broadcasts.
        for encoded in backlog:
            try:
                handler.wfile.write(encoded)
                handler.wfile.flush()
            except Exception:
                with self._lock:
                    if handler in self._clients:
                        self._clients.remove(handler)
                return

    def remove(self, handler: "SidecarHandler") -> None:
        with self._lock:
            self._clients = [c for c in self._clients if c is not handler]

    def clear_backlog(self) -> None:
        with self._lock:
            self._backlog.clear()

    def broadcast(self, data: dict) -> None:
        line = f"data: {json.dumps(data)}\n\n"
        encoded = line.encode("utf-8")
        with self._lock:
            self._backlog.append(encoded)
            if len(self._backlog) > self._BACKLOG_SIZE:
                del self._backlog[: len(self._backlog) - self._BACKLOG_SIZE]
            dead: list["SidecarHandler"] = []
            for c in self._clients:
                try:
                    c.wfile.write(encoded)
                    c.wfile.flush()
                except Exception as e:
                    print(
                        f"[sidecar] dropping SSE client (write failed: {type(e).__name__}: {e})",
                        file=sys.stderr, flush=True,
                    )
                    dead.append(c)
            for c in dead:
                self._clients.remove(c)
                try:
                    c._sse_close_event.set()
                except Exception:
                    pass



class CaptureService:
    def __init__(self):
        self.active = False
        self.path: Optional[str] = None
        self.format: str = "raw"
        self.bytes_written = 0
        self.error: Optional[str] = None
        self._file = None
        self._lock = threading.Lock()

    def start(self, path: Optional[str] = None, fmt: Optional[str] = None) -> dict:
        with self._lock:
            if self.active:
                return self.status()
            self.format = fmt or "raw"
            self.path = path or f"capture_{int(time.time())}.{self.format}"
            self.bytes_written = 0
            self.error = None
            try:
                self._file = open(self.path, "ab" if self.format == "raw" else "a")
                self.active = True
            except Exception as e:
                self.error = str(e)
            return self.status()

    def stop(self) -> dict:
        with self._lock:
            if self._file:
                try:
                    self._file.flush()
                    self._file.close()
                except Exception:
                    pass
                self._file = None
            self.active = False
            return self.status()

    def write(self, channel: int, data: bytes, ts: float) -> None:
        with self._lock:
            if not self.active or not self._file:
                return
            try:
                if self.format == "raw":
                    self._file.write(data)
                elif self.format == "text":
                    self._file.write(data.decode("ascii", errors="replace"))
                elif self.format == "jsonl":
                    record = {
                        "ts": ts,
                        "ch": channel,
                        "data": base64.b64encode(data).decode(),
                    }
                    self._file.write(json.dumps(record) + "\n")
                self.bytes_written += len(data)
            except Exception as e:
                self.error = str(e)

    def status(self) -> dict:
        return {
            "active": self.active,
            "path": self.path,
            "format": self.format,
            "bytesWritten": self.bytes_written,
            "error": self.error,
        }



class StreamService:
    def __init__(
        self,
        reader: ProbeStreamReader,
        sse: SSEClients,
        capture: CaptureService,
    ):
        self.reader = reader
        self.sse = sse
        self.capture = capture
        self.active = False
        self.total_bytes = 0
        self.total_batches = 0
        self.dropped_batches = 0
        self.seq = 0
        self.start_time = 0.0
        self._thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()
        self._poll_ms = 25

    def start(self, poll_ms: int = 25) -> dict:
        if self.active:
            return self.status()
        if not self.reader.attached:
            return {"active": False, "error": "ProbeStream not attached"}
        self._poll_ms = poll_ms
        self._stop_event.clear()
        self.active = True
        self.start_time = time.time()
        self._thread = threading.Thread(target=self._poll_loop, daemon=True)
        self._thread.start()
        return self.status()

    def stop(self) -> dict:
        self._stop_event.set()
        self.active = False
        if self._thread:
            self._thread.join(timeout=2)
            self._thread = None
        return self.status()

    def clear(self) -> None:
        self.total_bytes = 0
        self.total_batches = 0
        self.dropped_batches = 0
        self.seq = 0

    def status(self) -> dict:
        uptime = (time.time() - self.start_time) * 1000 if self.active else 0
        if self.reader.attached:
            self.reader.refresh_channel_info()
        channel_info = [ch.info(i) for i, ch in enumerate(self.reader.up_channels)] if self.reader.attached else []
        return {
            "active": self.active,
            "sessionId": "default",
            "totalBytes": self.total_bytes,
            "totalBatches": self.total_batches,
            "droppedBatches": self.dropped_batches,
            "uptimeMs": int(uptime),
            "channels": [ch["index"] for ch in channel_info],
            "channelInfo": channel_info,
        }

    def send(self, channel: int, data: bytes) -> dict:
        if not self.reader.attached:
            return {"written": 0, "channel": channel}
        written = self.reader.write_down(channel, data)
        return {"written": written, "channel": channel}

    def _poll_loop(self) -> None:
        # Adaptive drain: while the firmware has data, loop with a tiny yield
        # so we keep up with high-rate producers without starving the HTTP
        # server thread (which handles /send, stream.status, SSE writes).
        # When the channel is idle, back off toward the configured poll
        # interval so we don't spin the CPU.
        idle_streak = 0
        busy_streak = 0
        MAX_BUSY = 32  # force a real yield after this many back-to-back drains
        consecutive_errors = 0
        last_error_msg = ""
        while not self._stop_event.is_set():
            try:
                def on_data(ch: int, data: bytes) -> None:
                    self.seq += 1
                    ts = time.time() * 1000
                    batch = {
                        "sessionId": "default",
                        "seq": self.seq,
                        "ts": ts,
                        "channel": ch,
                        "byteCount": len(data),
                        "payload": base64.b64encode(data).decode(),
                    }
                    if 0 <= ch < len(self.reader.up_channels):
                        info = self.reader.up_channels[ch].info(ch)
                        batch["channelFlags"] = info["flags"]
                        batch["channelType"] = info["channelType"]
                        batch["channelTypeName"] = info["channelTypeName"]
                        batch["graphable"] = info["graphable"]
                    self.total_bytes += len(data)
                    self.total_batches += 1
                    self.sse.broadcast(batch)
                    self.capture.write(ch, data, ts / 1000)

                read = self.reader.poll_up(on_data)
                if consecutive_errors > 0:
                    print(
                        f"[sidecar] poll recovered after {consecutive_errors} error(s)",
                        file=sys.stderr, flush=True,
                    )
                consecutive_errors = 0
                last_error_msg = ""
            except Exception as e:
                self.dropped_batches += 1
                read = 0
                consecutive_errors += 1
                msg = f"{type(e).__name__}: {e}"
                # Log first error and every power-of-two thereafter so we
                # don't flood, but loud enough to actually notice.
                if consecutive_errors == 1 or (
                    consecutive_errors & (consecutive_errors - 1)
                ) == 0 or msg != last_error_msg:
                    print(
                        f"[sidecar] poll_up error #{consecutive_errors}: {msg}",
                        file=sys.stderr, flush=True,
                    )
                    if consecutive_errors == 1:
                        traceback.print_exc(file=sys.stderr)
                        sys.stderr.flush()
                last_error_msg = msg
                # The OpenOcdTcl layer already drops the socket on any
                # wire-level error, so the next send() reconnects on its
                # own. After a few back-to-back failures, ping OpenOCD
                # itself to distinguish "host bridge wedged" from "OpenOCD
                # daemon stuck on SWD" (target hung / ST-Link wedged).
                if consecutive_errors == 5:
                    print(
                        "[sidecar] 5 consecutive poll errors — pinging OpenOCD",
                        file=sys.stderr, flush=True,
                    )
                    try:
                        pong = self.reader.tcl.send("capture {echo pong}")
                        print(
                            f"[sidecar] OpenOCD ping reply: {pong.strip()!r}",
                            file=sys.stderr, flush=True,
                        )
                    except Exception as ping_err:
                        print(
                            f"[sidecar] OpenOCD ping failed: {ping_err}"
                            " — daemon likely stuck on SWD; restart OpenOCD",
                            file=sys.stderr, flush=True,
                        )
                # Back off harder under sustained failure so we don't burn
                # CPU on a dead link.
                if consecutive_errors >= 5:
                    self._stop_event.wait(0.5)

            if read > 0:
                idle_streak = 0
                busy_streak += 1
                if busy_streak >= MAX_BUSY:
                    # Periodic forced yield: lets /send / stream.status / SSE
                    # writes definitely make progress even under sustained
                    # firehose load.
                    busy_streak = 0
                    self._stop_event.wait(0.001)
                else:
                    # Tiny sleep(0) hands off the GIL without real delay.
                    time.sleep(0)
                continue

            busy_streak = 0
            idle_streak = min(idle_streak + 1, 16)
            base = self._poll_ms / 1000.0
            sleep_s = min(base, 0.001 * (1 << min(idle_streak, 4)))
            self._stop_event.wait(sleep_s)



tcl = OpenOcdTcl()
ocd_process = OpenOcdProcess()
reader = ProbeStreamReader(tcl)
sse_clients = SSEClients()
capture_svc = CaptureService()
stream_svc = StreamService(reader, sse_clients, capture_svc)
current_settings = load_settings()



def _quiesce_openocd_for_streaming() -> Optional[str]:
    """Disable OpenOCD's background activities that contend with our
    high-rate `read_memory` traffic on the single-threaded Tcl interpreter.

    Root cause this addresses:
        OpenOCD runs `target poll` every ~100 ms (DAP transaction over SWD).
        Our streaming poll thread issues hundreds of `read_memory` requests
        per second on the same interpreter. When a target-poll lands while
        we have a request in flight, OpenOCD serialises both behind the DAP
        lock; if SWD is even slightly slow, the read can stall indefinitely
        and our recv() times out. Disabling the background poll removes the
        only other Tcl-queue contender so reads stay deterministic.

    Returns an error string if any command failed (informational only — we
    still proceed; the user can stream and watch for issues).
    """
    if not tcl.connected:
        return "not connected"
    errors: list[str] = []
    # `poll off` stops the periodic target state probe. We don't care about
    # halt notifications — the firmware never halts during streaming.
    for cmd in ("poll off",):
        try:
            tcl.send(cmd)
        except Exception as e:
            errors.append(f"{cmd}: {e}")
    return "; ".join(errors) if errors else None


def rpc_dispatch(method: str, params: dict) -> Any:
    global current_settings
    if method == "sidecar.claim":
        _start_parent_watchdog(_request_shutdown, _coerce_int(params.get("parentPid"), 0))
        return {"ok": True, "pid": os.getpid()}

    if method == "sidecar.shutdown":
        _request_shutdown()
        return {"ok": True}

    # -- Debug probes --
    if method == "probes.discover":
        return discover_debug_probes()

    # -- OpenOCD --
    if method == "openocd.connect":
        host = params.get("host", "localhost")
        port = params.get("port", 6666)
        try:
            tcl.close()
            tcl.host = host
            tcl.port = int(port)
            tcl.connect()
            err = _quiesce_openocd_for_streaming()
            if err:
                print(f"[sidecar] quiesce warning: {err}", file=sys.stderr, flush=True)
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    if method == "openocd.spawn":
        try:
            ocd_process.spawn(
                openocd_path=params.get("openocdPath", "openocd"),
                scripts_path=params.get("scriptsPath", ""),
                interface_config=params.get("interfaceConfig", "interface/stlink.cfg"),
                target_config=params.get("targetConfig", ""),
                adapter_serial=params.get("adapterSerial", ""),
                tcl_port=int(params.get("tclPort", 6666)),
            )
            time.sleep(1)
            tcl.host = "localhost"
            tcl.port = int(params.get("tclPort", 6666))
            tcl.connect()
            err = _quiesce_openocd_for_streaming()
            if err:
                print(f"[sidecar] quiesce warning: {err}", file=sys.stderr, flush=True)
            return {"ok": True, "pid": ocd_process.pid, "error": None}
        except Exception as e:
            return {"ok": False, "pid": None, "error": str(e)}

    if method == "openocd.stop":
        stream_svc.stop()
        tcl.close()
        ocd_process.stop()
        return {"ok": True}

    if method == "openocd.status":
        return {
            "connected": tcl.connected,
            "spawned": ocd_process.running,
            "pid": ocd_process.pid,
        }

    if method == "openocd.log":
        tail = int(params.get("tail", 50))
        return {"lines": ocd_process.get_log(tail)}

    # -- ProbeStream --
    if method == "probestream.discover":
        if not tcl.connected:
            return {"attached": False, "controlBlockAddr": None, "numUp": 0, "numDown": 0, "error": "OpenOCD not connected"}
        ram_start = _coerce_int(params.get("ramStart", current_settings.get("ramStart")), 0x20000000)
        ram_size = _coerce_int(params.get("ramSize", current_settings.get("ramSize")), 196608)
        chunk = _coerce_int(params.get("scanChunkSize", current_settings.get("scanChunkSize")), 1024)
        reader.read_mode = current_settings.get("readMode", "auto")
        ok = reader.discover(ram_start, ram_size, chunk)
        if ok:
            return {
                "attached": True,
                "controlBlockAddr": reader.cb_addr,
                "numUp": reader.num_up,
                "numDown": reader.num_down,
                "error": None,
            }
        return {"attached": False, "controlBlockAddr": None, "numUp": 0, "numDown": 0, "error": "Control block not found"}

    if method == "probestream.attach":
        if not tcl.connected:
            return {"attached": False, "controlBlockAddr": None, "numUp": 0, "numDown": 0, "error": "OpenOCD not connected"}
        addr = _coerce_int(params.get("addr"), 0)
        reader.read_mode = current_settings.get("readMode", "auto")
        ok = reader.attach(addr)
        if ok:
            return {
                "attached": True,
                "controlBlockAddr": reader.cb_addr,
                "numUp": reader.num_up,
                "numDown": reader.num_down,
                "error": None,
            }
        return {"attached": False, "controlBlockAddr": None, "numUp": 0, "numDown": 0, "error": "Attach failed — bad magic or address"}

    if method == "probestream.sessions":
        sessions = []
        if tcl.connected or reader.attached:
            sessions.append({
                "id": "default",
                "label": f"{tcl.host}:{tcl.port}",
                "tclHost": tcl.host,
                "tclPort": tcl.port,
                "openocdState": "spawned" if ocd_process.running else ("connected" if tcl.connected else "disconnected"),
                "targetConfig": current_settings.get("targetConfig", ""),
                "interfaceConfig": current_settings.get("interfaceConfig", ""),
                "adapterSerial": current_settings.get("adapterSerial", ""),
                "probestreamAttached": reader.attached,
                "controlBlockAddr": reader.cb_addr if reader.attached else None,
                "ramStart": int(current_settings.get("ramStart", "0x20000000"), 0),
                "ramSize": int(current_settings.get("ramSize", 196608)),
                "numUp": reader.num_up,
                "numDown": reader.num_down,
                "lastError": None,
            })
        return sessions

    # -- Stream --
    if method == "stream.start":
        poll_ms = int(current_settings.get("pollMs", 25))
        return stream_svc.start(poll_ms)

    if method == "stream.stop":
        return stream_svc.stop()

    if method == "stream.status":
        return stream_svc.status()

    if method == "stream.send":
        channel = int(params.get("channel", 0))
        data_b64 = params.get("data", "")
        data = base64.b64decode(data_b64) if data_b64 else b""
        return stream_svc.send(channel, data)

    if method == "stream.send_hex":
        channel = int(params.get("channel", 0))
        hex_str = params.get("hex", "")
        data = bytes.fromhex(hex_str) if hex_str else b""
        return stream_svc.send(channel, data)

    if method == "stream.clear":
        stream_svc.clear()
        # Also drop the SSE backlog so a freshly-attached client (or a TUI
        # restart that reuses an existing sidecar) does not replay stale
        # batches from the previous session.
        sse_clients.clear_backlog()
        return {"ok": True}

    # -- Capture --
    if method == "capture.start":
        path = params.get("path")
        fmt = params.get("format")
        return capture_svc.start(path, fmt)

    if method == "capture.stop":
        return capture_svc.stop()

    if method == "capture.status":
        return capture_svc.status()

    # -- Settings --
    if method == "settings.get":
        return current_settings

    if method == "settings.set":
        values = params.get("values", {})
        current_settings.update(values)
        save_settings(current_settings)
        return current_settings

    raise ValueError(f"Unknown method: {method}")



class SidecarHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass  # suppress default logging

    def do_GET(self):
        if self.path == "/health":
            body = json.dumps({
                "ok": True,
                "pid": os.getpid(),
                "openocd_connected": tcl.connected,
                "probestream_attached": reader.attached,
                "streaming": stream_svc.active,
            }).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if self.path == "/stream":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            # Cap how long a single SSE write to this client may block. If the
            # consumer stalls, the broadcast (called from the poll thread)
            # would otherwise hang forever and freeze streaming. A timeout
            # turns that into a clean error → client gets dropped, polling
            # keeps going.
            try:
                self.connection.settimeout(2.0)
            except Exception:
                pass
            # Per-connection event: broadcast() sets this when it drops the
            # client (write timeout/error). The handler wakes up, exits, and
            # the HTTP connection closes → client gets EOF → it reconnects.
            self._sse_close_event = threading.Event()
            sse_clients.add(self)
            try:
                self._sse_close_event.wait()
            except Exception:
                pass
            finally:
                sse_clients.remove(self)
            return

        self.send_error(404)

    def do_POST(self):
        if self.path == "/rpc":
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length) if length > 0 else b""
            try:
                req = json.loads(body) if body else {}
                method = req.get("method", "")
                params = req.get("params", {})
                result = rpc_dispatch(method, params)
                resp = json.dumps({"result": result}).encode()
                self.send_response(200)
            except Exception as e:
                resp = json.dumps({"error": str(e)}).encode()
                self.send_response(200)

            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(resp)))
            self.end_headers()
            self.wfile.write(resp)
            return

        self.send_error(404)



def _install_parent_death_signal() -> None:
    """On Linux, ask the kernel to send SIGTERM to us when our parent dies.

    Ensures the sidecar (and any OpenOCD it owns) is reaped if the TUI
    crashes or is `kill -9`'d before it can clean us up.
    """
    if sys.platform != "linux":
        return
    try:
        import ctypes
        PR_SET_PDEATHSIG = 1
        libc = ctypes.CDLL("libc.so.6", use_errno=True)
        libc.prctl(PR_SET_PDEATHSIG, signal.SIGTERM, 0, 0, 0)
    except Exception:
        pass


_parent_watchdog_pid: Optional[int] = None
_parent_watchdog_lock = threading.Lock()
_server_ref: Optional[ThreadingHTTPServer] = None


def _request_shutdown() -> None:
    if _server_ref is not None:
        threading.Thread(target=_server_ref.shutdown, daemon=True).start()


def _start_parent_watchdog(on_parent_dead, parent_pid: Optional[int] = None) -> None:
    global _parent_watchdog_pid
    if parent_pid is None:
        raw_pid = os.environ.get("PSTUI_PARENT_PID", "")
        try:
            parent_pid = int(raw_pid)
        except ValueError:
            return
    if parent_pid <= 0 or parent_pid == os.getpid():
        return

    with _parent_watchdog_lock:
        if _parent_watchdog_pid == parent_pid:
            return
        _parent_watchdog_pid = parent_pid

    watched_pid = parent_pid

    def _is_current_watch() -> bool:
        with _parent_watchdog_lock:
            return _parent_watchdog_pid == watched_pid

    def _notify() -> None:
        if not _is_current_watch():
            return
        print(
            f"[sidecar] parent process {watched_pid} is gone, shutting down",
            file=sys.stderr,
            flush=True,
        )
        on_parent_dead()

    if sys.platform == "win32":
        def _watch_windows() -> None:
            try:
                import ctypes
                kernel32 = ctypes.windll.kernel32
                SYNCHRONIZE = 0x00100000
                INFINITE = 0xFFFFFFFF
                handle = kernel32.OpenProcess(SYNCHRONIZE, False, watched_pid)
                if not handle:
                    _notify()
                    return
                try:
                    kernel32.WaitForSingleObject(handle, INFINITE)
                finally:
                    kernel32.CloseHandle(handle)
                _notify()
            except Exception as e:
                print(
                    f"[sidecar] parent watchdog unavailable: {type(e).__name__}: {e}",
                    file=sys.stderr,
                    flush=True,
                )
        threading.Thread(target=_watch_windows, daemon=True, name="parent-watchdog").start()
        return

    def _watch_posix() -> None:
        while True:
            try:
                os.kill(watched_pid, 0)
            except ProcessLookupError:
                _notify()
                return
            except PermissionError:
                pass
            except Exception as e:
                print(
                    f"[sidecar] parent watchdog unavailable: {type(e).__name__}: {e}",
                    file=sys.stderr,
                    flush=True,
                )
                return
            time.sleep(1.0)
    threading.Thread(target=_watch_posix, daemon=True, name="parent-watchdog").start()


def main():
    global _server_ref
    parser = argparse.ArgumentParser(description="ProbeStream TUI sidecar")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=17900)
    args = parser.parse_args()

    _install_parent_death_signal()

    print("[sidecar] OpenOCD not connected at startup — use /openocd start or /openocd connect", file=sys.stderr)

    server = ThreadingHTTPServer((args.host, args.port), SidecarHandler)
    _server_ref = server
    server.daemon_threads = True
    print(f"[sidecar] listening on http://{args.host}:{args.port}", file=sys.stderr)

    def _shutdown(signum, _frame):
        print(f"[sidecar] received signal {signum}, shutting down", file=sys.stderr)
        # serve_forever() runs in this thread; shutdown() must be called from
        # another thread, so spin a tiny one-shot.
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, _shutdown)
    # SIGHUP does not exist on Windows.
    if hasattr(signal, "SIGHUP"):
        signal.signal(signal.SIGHUP, _shutdown)

    _start_parent_watchdog(_request_shutdown)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        try: stream_svc.stop()
        except Exception: pass
        try: capture_svc.stop()
        except Exception: pass
        try: tcl.close()
        except Exception: pass
        try: ocd_process.stop()
        except Exception: pass
        print("[sidecar] shutdown complete", file=sys.stderr)


if __name__ == "__main__":
    main()
