"""Entry point: start the local server and open the app window."""

from __future__ import annotations

import argparse
import json
import logging
import os
import shutil
import subprocess
import sys
import threading
import time
import webbrowser
from logging.handlers import RotatingFileHandler
from pathlib import Path
from urllib.request import urlopen

from . import __version__
from .market import DAT_URLS, DIESEL_URL, MARKET_URL, RateUpdater
from .miles import MilesService
from .server import DispatchServer
from .storage import Storage

DEFAULT_PORT = 47321
WINDOW_SIZE = "1060,1000"
log = logging.getLogger("dispatch_rpm")


def default_data_dir() -> Path:
    if sys.platform == "win32":
        return Path(os.environ.get("APPDATA") or Path.home()) / "DispatchRPM"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "DispatchRPM"
    return Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share") / "dispatch-rpm"


def setup_logging(data_dir: Path, verbose: bool) -> None:
    if log.handlers:
        return
    data_dir.mkdir(parents=True, exist_ok=True)
    handler = RotatingFileHandler(data_dir / "dispatch-rpm.log", maxBytes=256_000,
                                  backupCount=1, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    log.addHandler(handler)
    log.setLevel(logging.DEBUG if verbose else logging.INFO)


def _app_browsers() -> list[str]:
    """Chromium-based browsers that support --app (a window with no tabs or address bar)."""
    if sys.platform == "win32":
        roots = [os.environ.get(v) for v in ("PROGRAMFILES(X86)", "PROGRAMFILES", "LOCALAPPDATA")]
        rel = [r"Microsoft\Edge\Application\msedge.exe",
               r"Google\Chrome\Application\chrome.exe",
               r"BraveSoftware\Brave-Browser\Application\brave.exe"]
        return [str(Path(root) / r) for r in rel for root in roots if root]
    if sys.platform == "darwin":
        return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
                "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
                "/Applications/Chromium.app/Contents/MacOS/Chromium"]
    names = ["chromium", "chromium-browser", "google-chrome-stable", "google-chrome",
             "brave", "brave-browser", "microsoft-edge-stable", "microsoft-edge"]
    return [p for p in (shutil.which(n) for n in names) if p]


def open_window(url: str, size: str = WINDOW_SIZE) -> None:
    for exe in _app_browsers():
        if not Path(exe).is_file():
            continue
        try:
            subprocess.Popen([exe, f"--app={url}", f"--window-size={size}"],
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, start_new_session=True)
            log.info("opened app window with %s", exe)
            return
        except OSError:
            log.warning("could not start %s", exe, exc_info=True)
    webbrowser.open(url)


def running_instance(port: int) -> str | None:
    """Return the URL of an already-running copy of the app on this port, if any."""
    url = f"http://127.0.0.1:{port}/"
    try:
        with urlopen(url + "api/ping", timeout=1) as resp:
            if json.load(resp).get("app") == "dispatch-rpm":
                return url
    except (OSError, ValueError):
        pass
    return None


def _watch_for_exit(server: DispatchServer) -> None:
    while True:
        time.sleep(0.5)
        if server.lifecycle.should_exit():
            log.info("no windows open, shutting down")
            server.shutdown()
            return


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="dispatch-rpm", description="Rate-per-mile calculator for dispatchers.")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"local port (default {DEFAULT_PORT})")
    parser.add_argument("--data-dir", type=Path, help="where to keep the database and log")
    parser.add_argument("--no-window", action="store_true",
                        help="don't open a window; just print the URL and keep running")
    parser.add_argument("--market-url", default=MARKET_URL,
                        help="optional market.json with rates for every copy of the app; 'off' to disable")
    parser.add_argument("--offline-rates", action="store_true",
                        help="don't check DAT reports or diesel prices online")
    parser.add_argument("--verbose", action="store_true", help="log every request")
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    args = parser.parse_args(argv)

    port = args.port
    data_dir = args.data_dir or default_data_dir()
    setup_logging(data_dir, args.verbose)

    existing = running_instance(port)
    if existing:
        log.info("already running at %s", existing)
        if not args.no_window:
            open_window(existing)
        print(f"Dispatch RPM is already running at {existing}")
        return 0

    storage = Storage(data_dir / "dispatch.db")
    miles = MilesService(storage)
    rates = RateUpdater(storage,
                        market_url=None if args.market_url == "off" else args.market_url,
                        diesel_url=None if args.offline_rates else DIESEL_URL,
                        dat_urls=None if args.offline_rates else DAT_URLS)
    rates.start()
    try:
        server = DispatchServer(storage, miles, port=port, rates=rates)
    except OSError:
        log.warning("port %s busy, using a random port", port)
        server = DispatchServer(storage, miles, port=0, rates=rates)

    log.info("dispatch-rpm %s listening on %s (data in %s)", __version__, server.url, data_dir)
    print(f"Dispatch RPM running at {server.url}  (data: {data_dir})")
    print("Press Ctrl+C to quit." if args.no_window else "Close the window to quit.")

    if not args.no_window:
        threading.Thread(target=_watch_for_exit, args=(server,), daemon=True).start()
        open_window(server.url)

    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        rates.stop()
        server.server_close()
        storage.close()
    return 0
