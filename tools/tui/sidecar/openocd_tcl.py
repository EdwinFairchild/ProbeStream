"""OpenOCD TCL-RPC client.

Supports both mdw/mww (works on running targets for most STM32) and
bulk read_memory (faster but not universally supported on running targets).
"""

import os
import socket
import struct
import subprocess
import sys
import threading
import time
from contextlib import contextmanager
from typing import Iterator, Optional


class OpenOcdTcl:
    def __init__(self, host: str = "localhost", port: int = 6666, timeout: float = 10.0):
        self.host = host
        self.port = port
        # `recv` timeout is a safety net, not the primary control. The real
        # fix for streaming hangs is `poll off` on OpenOCD (see sidecar
        # `_quiesce_openocd_for_streaming`); without that, target poll
        # collides with our reads on the single-threaded Tcl interpreter
        # and reads can stall arbitrarily.
        self.timeout = timeout
        self.sock: Optional[socket.socket] = None
        # OpenOCD's TCL socket is strictly request/response: one in-flight
        # command per connection, terminated by 0x1A. Multiple threads can
        # invoke this client (poll loop + RPC handler), so every wire-level
        # send must be serialized or the responses interleave and confuse
        # callers (timeouts, garbled hex, etc.).
        self._wire_lock = threading.RLock()

    def connect(self) -> None:
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect((self.host, self.port))

    @property
    def connected(self) -> bool:
        return self.sock is not None

    def close(self) -> None:
        if self.sock:
            try:
                self.sock.close()
            except Exception:
                pass
            self.sock = None

    def _drop_socket(self) -> None:
        """Forcibly tear down the socket so the next call must reconnect.

        Called after any wire-level error: a partial / timed-out response
        leaves the socket holding stale bytes (and possibly an unread 0x1A
        from a delayed reply), which would corrupt every subsequent request.
        """
        if self.sock is not None:
            try:
                self.sock.close()
            except Exception:
                pass
            self.sock = None

    def _ensure_connected(self) -> None:
        if self.sock is None:
            print(f"[tcl] (re)connecting to {self.host}:{self.port}", file=sys.stderr, flush=True)
            self.connect()

    @contextmanager
    def transaction(self) -> Iterator[None]:
        """Group several `send()` calls atomically (e.g. multi-chunk writes)."""
        with self._wire_lock:
            yield

    def send(self, cmd: str) -> str:
        with self._wire_lock:
            t0 = time.monotonic()
            try:
                self._ensure_connected()
                data = cmd.encode("ascii") + b"\x1a"
                self.sock.sendall(data)  # type: ignore[union-attr]
                result = self._recv()
                elapsed = time.monotonic() - t0
                if elapsed > 0.5:
                    print(
                        f"[tcl] SLOW {elapsed:.2f}s: {cmd[:80]!r}",
                        file=sys.stderr, flush=True,
                    )
                return result
            except (socket.timeout, TimeoutError, ConnectionError, OSError) as e:
                elapsed = time.monotonic() - t0
                print(
                    f"[tcl] {type(e).__name__} after {elapsed:.2f}s: {cmd[:80]!r}",
                    file=sys.stderr, flush=True,
                )
                # Socket is now in an unknown state — drop it so the next
                # send() reconnects from scratch. Re-raise so callers can
                # count the failure / surface it to the user.
                self._drop_socket()
                raise

    def _recv(self) -> str:
        buf = b""
        while True:
            chunk = self.sock.recv(8192)  # type: ignore[union-attr]
            if not chunk:
                break
            buf += chunk
            if b"\x1a" in buf:
                break
        return buf.rstrip(b"\x1a").decode("ascii", errors="replace")


    def mdw(self, addr: int) -> int:
        resp = self.send(f"mdw 0x{addr:08X}")
        colon = resp.find(":")
        if colon < 0:
            raise RuntimeError(f"mdw parse error: {resp!r}")
        return int(resp[colon + 1:].strip(), 16)

    def mdw_n(self, addr: int, count: int) -> list[int]:
        resp = self.send(f"mdw 0x{addr:08X} {count}")
        words: list[int] = []
        for line in resp.strip().split("\n"):
            colon = line.find(":")
            if colon < 0:
                continue
            for h in line[colon + 1:].strip().split():
                words.append(int(h, 16))
        return words

    def mww(self, addr: int, val: int) -> None:
        self.send(f"mww 0x{addr:08X} 0x{val:08X}")

    def mwb(self, addr: int, val: int) -> None:
        self.send(f"mwb 0x{addr:08X} 0x{val:02X}")


    def read_bytes_mdw(self, addr: int, count: int) -> bytes:
        if count == 0:
            return b""
        aligned_start = addr & ~3
        aligned_end = (addr + count + 3) & ~3
        word_count = (aligned_end - aligned_start) // 4

        all_bytes = bytearray()
        words_read = 0
        while words_read < word_count:
            chunk = min(32, word_count - words_read)
            words = self.mdw_n(aligned_start + words_read * 4, chunk)
            for w in words:
                all_bytes.extend(struct.pack("<I", w))
            words_read += chunk

        byte_offset = addr - aligned_start
        return bytes(all_bytes[byte_offset:byte_offset + count])


    def read_memory_bytes(self, addr: int, count: int) -> bytes:
        out = bytearray()
        off = 0
        while off < count:
            chunk = min(1024, count - off)
            r = self.send(f"read_memory 0x{addr + off:08X} 8 {chunk}")
            out.extend(int(x, 16) for x in r.strip().split())
            off += chunk
        return bytes(out)

    def read_memory_words(self, addr: int, word_count: int) -> bytes:
        out = bytearray()
        off = 0
        while off < word_count:
            chunk = min(256, word_count - off)
            r = self.send(f"read_memory 0x{addr + off * 4:08X} 32 {chunk}")
            for h in r.strip().split():
                out.extend(struct.pack("<I", int(h, 16)))
            off += chunk
        return bytes(out)


    def write_bytes(self, addr: int, data: bytes) -> None:
        if not data:
            return
        # Single bulk write_memory round-trip is dramatically faster than the
        # per-byte mwb / per-word mww loop, especially under lock contention
        # from the poll thread. Falls back to the slow path if the OpenOCD
        # build doesn't support bulk byte writes.
        try:
            hex_words = " ".join(f"0x{b:02X}" for b in data)
            self.send(f"write_memory 0x{addr:08X} 8 {{{hex_words}}}")
            return
        except Exception:
            pass
        off = 0
        while off < len(data) and (addr + off) % 4 != 0:
            self.mwb(addr + off, data[off])
            off += 1
        while off + 4 <= len(data):
            val = struct.unpack_from("<I", data, off)[0]
            self.mww(addr + off, val)
            off += 4
        while off < len(data):
            self.mwb(addr + off, data[off])
            off += 1


    def read_bytes(self, addr: int, count: int, mode: str = "auto") -> bytes:
        if mode == "bulk":
            return self._read_bytes_bulk(addr, count)
        if mode == "mdw":
            return self.read_bytes_mdw(addr, count)
        # auto: try bulk first, fall back to mdw only on protocol errors.
        # Do NOT fall back on socket/timeout errors: those mean OpenOCD is
        # still processing the previous command (DAP lock held). Sending a
        # second command immediately would queue behind the stale one and
        # also time out, producing a confusing second error.
        try:
            return self._read_bytes_bulk(addr, count)
        except (socket.timeout, TimeoutError, ConnectionError, OSError):
            raise
        except Exception:
            return self.read_bytes_mdw(addr, count)

    def _read_bytes_bulk(self, addr: int, count: int) -> bytes:
        a_start = addr & ~3
        a_end = (addr + count + 3) & ~3
        word_count = (a_end - a_start) // 4
        raw = self.read_memory_words(a_start, word_count)
        byte_off = addr - a_start
        return raw[byte_off:byte_off + count]

    def read_u32(self, addr: int) -> int:
        return self.mdw(addr)

    def write_u32(self, addr: int, val: int) -> None:
        self.mww(addr, val)


class OpenOcdProcess:
    """Manages a spawned OpenOCD process."""

    def __init__(self):
        self.proc: Optional[subprocess.Popen] = None
        self._log_lines: list[str] = []
        self._log_lock = threading.Lock()

    def get_log(self, tail: int = 50) -> list[str]:
        with self._log_lock:
            return list(self._log_lines[-tail:])

    @property
    def running(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    @property
    def pid(self) -> Optional[int]:
        return self.proc.pid if self.proc else None

    def spawn(
        self,
        openocd_path: str = "openocd",
        scripts_path: str = "",
        interface_config: str = "interface/stlink.cfg",
        target_config: str = "",
        adapter_serial: str = "",
        tcl_port: int = 6666,
    ) -> None:
        if self.running:
            raise RuntimeError("OpenOCD already running")

        def _normalize(cfg: str, subdir: str) -> str:
            # Allow bare filenames like "stm32g4x.cfg" by auto-prefixing the
            # standard OpenOCD scripts subdirectory ("target/", "interface/").
            # Absolute paths and any value already containing a "/" are left
            # untouched so power users can point at custom configs.
            if not cfg or "/" in cfg or os.path.isabs(cfg):
                return cfg
            return f"{subdir}/{cfg}"

        args = [openocd_path]
        if scripts_path:
            args.extend(["-s", scripts_path])
        if adapter_serial:
            args.extend(["-c", f"adapter serial {adapter_serial}"])
        if interface_config:
            args.extend(["-f", _normalize(interface_config, "interface")])
        if target_config:
            args.extend(["-f", _normalize(target_config, "target")])
        args.extend(["-c", f"tcl_port {tcl_port}"])

        self.proc = subprocess.Popen(
            args,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            start_new_session=True,  # own process group → group-kill on stop
        )

        # CRITICAL: drain the stdout/stderr pipe continuously in a daemon
        # thread. Linux pipe buffers are ~64 KB. OpenOCD logs every Tcl
        # command to stderr; when those writes fill the pipe buffer, OpenOCD's
        # entire process blocks — including the Tcl interpreter thread that
        # processes our read_memory commands — which causes recv() timeouts
        # on our end. The test harness routes to DEVNULL so it never hits
        # this; the sidecar PIPE path does without a drain thread.
        self._log_lines: list[str] = []
        self._log_lock = threading.Lock()
        _proc_ref = self.proc
        def _drain(proc: subprocess.Popen) -> None:
            try:
                for raw in proc.stdout:  # type: ignore[union-attr]
                    line = raw.decode("utf-8", errors="replace").rstrip()
                    with self._log_lock:
                        self._log_lines.append(line)
                        if len(self._log_lines) > 500:
                            del self._log_lines[:len(self._log_lines) - 500]
            except Exception:
                pass
        threading.Thread(target=_drain, args=(_proc_ref,), daemon=True, name="openocd-drain").start()

        time.sleep(2)
        if self.proc.poll() is not None:
            with self._log_lock:
                output = "\n".join(self._log_lines)
            rc = self.proc.returncode
            self.proc = None
            cmdline = " ".join(args)
            raise RuntimeError(
                f"OpenOCD exited immediately (rc={rc})\n"
                f"  cmd: {cmdline}\n"
                f"  output:\n{output.strip() or '(no output)'}"
            )

    def stop(self) -> None:
        if not self.proc:
            return
        proc = self.proc
        self.proc = None

        def _signal_group(sig: int) -> None:
            try:
                os.killpg(os.getpgid(proc.pid), sig)
            except ProcessLookupError:
                pass
            except Exception:
                # PG kill failed; fall back to per-process signal.
                try:
                    proc.send_signal(sig)
                except Exception:
                    pass

        import signal as _signal
        _signal_group(_signal.SIGTERM)
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            _signal_group(_signal.SIGKILL)
            try:
                proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                pass
