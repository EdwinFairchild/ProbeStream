"""
Load PROBESTREAM_* environment variables from a gitignored `tests/.env` file
(if present). Existing environment variables win.

Usage (at top of a test script):

    from pathlib import Path
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    import load_env  # noqa: F401

Then read paths via os.environ["PROBESTREAM_OPENOCD_BIN"], etc.
"""

import os
from pathlib import Path

_ENV_FILE = Path(__file__).with_name(".env")

if _ENV_FILE.exists():
    for line in _ENV_FILE.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        key = key.strip()
        val = val.strip().strip('"').strip("'")
        os.environ.setdefault(key, val)
