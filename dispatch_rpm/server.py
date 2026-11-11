"""Local HTTP server: serves the UI and a small JSON API on 127.0.0.1."""

from __future__ import annotations

import json
import logging
import math
import re
import sys
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from . import __version__
from .market import RateUpdater, resolve, set_manual
from .miles import MilesError, MilesService, NoRoute, ZipNotFound
from .storage import EQUIPMENT, QUOTE_STATUSES, Storage

log = logging.getLogger(__name__)

STATIC_DIR = Path(__file__).resolve().parent / "static"

# explicit types: on Windows, mimetypes reads the registry and can map .js to
# text/plain, which browsers refuse to run as a module
_TYPES = {".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml"}
STATIC_FILES = {
    f"/{name}": (name, _TYPES[Path(name).suffix] + "; charset=utf-8")
    for name in ("index.html", "style.css", "main.js", "common.js", "calc.js", "load.js",
                 "simple.js", "advanced.js", "rates.js", "fx.js", "stops.js", "logo.svg", "logo-mark.svg", "icon.svg")
}
STATIC_FILES["/"] = STATIC_FILES["/index.html"]

ZIP_RE = re.compile(r"\d{5}", re.ASCII)
MC_RE = re.compile(r"(?:MC[\s#-]*)?(\d{1,8})", re.ASCII | re.IGNORECASE)
MAX_BODY = 64 * 1024
MAX_STOPS = 8


class Lifecycle:
    """Tracks open app windows so the server can exit after the last one closes."""

    def __init__(self, grace: float = 4.0, first_connect_timeout: float = 120.0):
        self.grace = grace
        self.first_connect_timeout = first_connect_timeout
        self._lock = threading.Lock()
        self._clients: set[str] = set()
        self._started = time.monotonic()
        self._seen_client = False
        self._empty_since: float | None = None

    def hello(self, client_id: str) -> None:
        with self._lock:
            self._clients.add(client_id)
            self._seen_client = True
            self._empty_since = None

    def bye(self, client_id: str) -> None:
        with self._lock:
            self._clients.discard(client_id)
            if not self._clients:
                self._empty_since = time.monotonic()

    def should_exit(self, now: float | None = None) -> bool:
        now = time.monotonic() if now is None else now
        with self._lock:
            if not self._seen_client:
                return now - self._started > self.first_connect_timeout
            return self._empty_since is not None and now - self._empty_since > self.grace


class DispatchServer(ThreadingHTTPServer):
    daemon_threads = True
    # on Windows SO_REUSEADDR lets two programs bind the same port, so leave it off there
    allow_reuse_address = sys.platform != "win32"

    def __init__(self, storage: Storage, miles: MilesService,
                 host: str = "127.0.0.1", port: int = 0, rates: RateUpdater | None = None):
        self.storage = storage
        self.miles = miles
        self.rates = rates
        self.lifecycle = Lifecycle()
        super().__init__((host, port), Handler)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server_port}/"

    def allowed_hosts(self) -> set[str]:
        port = self.server_port
        return {f"127.0.0.1:{port}", f"localhost:{port}"}

    def market(self) -> dict:
        data = resolve(self.storage)
        data["checking"] = bool(self.rates and self.rates.checking)
        return data


class BadRequest(Exception):
    pass


def _number(body: dict, key: str, minimum: float, maximum: float) -> float:
    value = body.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise BadRequest(f"{key} must be a number")
    if not minimum <= value <= maximum:
        raise BadRequest(f"{key} is out of range")
    return float(value)


def _zip(value) -> str:
    if not isinstance(value, str) or not ZIP_RE.fullmatch(value):
        raise BadRequest("ZIP codes must be 5 digits")
    return value


def _text(body: dict, key: str, limit: int) -> str:
    value = body.get(key) or ""
    if not isinstance(value, str) or len(value) > limit or any(ord(c) < 32 for c in value):
        raise BadRequest(f"{key} must be text of at most {limit} characters on one line")
    return value.strip()


def _mc(value) -> str:
    """An MC number as digits only; 'MC 123456' and 'MC#123456' are fine too."""
    if not value:
        return ""
    m = MC_RE.fullmatch(value.strip()) if isinstance(value, str) else None
    if not m:
        raise BadRequest("MC number must be up to 8 digits")
    return m.group(1)


def _outcome(body: dict) -> tuple[str, float | None]:
    """Quote status and, for a booked load, the agreed rate (optional)."""
    status = body.get("status") or "quoted"
    if status not in QUOTE_STATUSES:
        raise BadRequest(f"status must be one of {', '.join(QUOTE_STATUSES)}")
    final_rate = None
    if body.get("final_rate") is not None:
        if status != "booked":
            raise BadRequest("an agreed rate needs status booked")
        final_rate = _number(body, "final_rate", 1, 1_000_000)
    return status, final_rate


def _stops(value) -> list[dict]:
    """Stops between pickup and dropoff for an LTL / partial run; each pickup carries its own rate."""
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > MAX_STOPS:
        raise BadRequest(f"stops must be a list of at most {MAX_STOPS}")
    stops = []
    for stop in value:
        if not isinstance(stop, dict) or stop.get("kind") not in ("pickup", "drop"):
            raise BadRequest("each stop needs a kind: pickup or drop")
        clean = {"zip": _zip(stop.get("zip")), "kind": stop["kind"]}
        if stop["kind"] == "pickup":
            clean["rate"] = _number(stop, "rate", 1, 1_000_000)
        stops.append(clean)
    return stops


class Handler(BaseHTTPRequestHandler):
    server: DispatchServer
    server_version = f"dispatch-rpm/{__version__}"

    # BaseHTTPRequestHandler logs to stderr, which is None in a windowed .exe
    def log_message(self, fmt, *args):
        log.debug("%s - %s", self.address_string(), fmt % args)

    # helpers

    def _send(self, status: int, body: bytes, content_type: str, extra: dict | None = None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, data, status: int = 200):
        self._send(status, json.dumps(data).encode(), "application/json")

    def _error(self, status: int, message: str):
        self._json({"error": message}, status)

    def _host_ok(self) -> bool:
        # blocks DNS rebinding: only answer requests addressed to us by our own name
        return self.headers.get("Host", "") in self.server.allowed_hosts()

    def _origin_ok(self) -> bool:
        # blocks other websites from posting to the local API
        origin = self.headers.get("Origin")
        return origin is None or origin in {f"http://{h}" for h in self.server.allowed_hosts()}

    def _body(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = -1
        if length < 0:  # read(-1) would wait for the client to hang up
            raise BadRequest("bad Content-Length")
        if length > MAX_BODY:
            raise BadRequest("request too large")
        raw = self.rfile.read(length) if length else b""
        try:
            data = json.loads(raw or b"{}")
        except ValueError:
            raise BadRequest("invalid JSON") from None
        if not isinstance(data, dict):
            raise BadRequest("expected a JSON object")
        return data

    def _dispatch(self, routes: dict, path: str, check_origin: bool):
        if not self._host_ok():
            return self._error(HTTPStatus.FORBIDDEN, "bad host")
        if check_origin and not self._origin_ok():
            return self._error(HTTPStatus.FORBIDDEN, "bad origin")
        for pattern, fn in routes.items():
            m = re.fullmatch(pattern, path)
            if m:
                try:
                    return fn(*m.groups())
                except BadRequest as e:
                    return self._error(HTTPStatus.BAD_REQUEST, str(e))
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                    # the page cancelled the request (e.g. a newer miles lookup replaced it)
                    self.close_connection = True
                    return None
                except Exception:
                    log.exception("error handling %s %s", self.command, path)
                    return self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "internal error")
        self._error(HTTPStatus.NOT_FOUND, "not found")

    # HTTP verbs

    def do_GET(self):
        url = urlsplit(self.path)
        self._query = parse_qs(url.query)
        self._dispatch({
            r"/api/ping": self.ping,
            r"/api/state": self.state,
            r"/api/market": self.market,
            r"/api/miles": self.lookup_miles,
            r"/api/place": self.lookup_place,
            r"/api/quotes\.csv": self.export_csv,
            r"/[\w.\-]*": lambda: self.static(url.path),
        }, url.path, check_origin=False)

    do_HEAD = do_GET

    def do_POST(self):
        self._dispatch({
            r"/api/settings": self.save_settings,
            r"/api/quotes": self.add_quote,
            r"/api/quotes/(\d+)": self.update_quote,
            r"/api/market/refresh": self.refresh_market,
            r"/api/market/manual": self.manual_rate,
            r"/api/hello": self.hello,
            r"/api/bye": self.bye,
        }, urlsplit(self.path).path, check_origin=True)

    def do_DELETE(self):
        self._dispatch({
            r"/api/quotes/(\d+)": self.delete_quote,
        }, urlsplit(self.path).path, check_origin=True)

    # endpoints

    def static(self, path: str):
        entry = STATIC_FILES.get(path)
        if not entry:
            return self._error(HTTPStatus.NOT_FOUND, "not found")
        name, content_type = entry
        self._send(200, (STATIC_DIR / name).read_bytes(), content_type)

    def ping(self):
        self._json({"app": "dispatch-rpm", "version": __version__})

    def state(self):
        if self.server.rates:
            # on first load, give the rate check a moment so the page shows fresh numbers
            self.server.rates.wait(3)
        self._json({
            "version": __version__,
            "settings": self.server.storage.settings(),
            "quotes": self.server.storage.quotes(),
            "market": self.server.market(),
        })

    def market(self):
        self._json(self.server.market())

    def refresh_market(self):
        if self.server.rates:
            self.server.rates.run(force=True)
        self._json(self.server.market())

    def manual_rate(self):
        body = self._body()
        equipment = body.get("equipment")
        if equipment not in EQUIPMENT:
            raise BadRequest("unknown equipment")
        value = None if body.get("clear") else _number(body, "value", 0.01, 100)
        try:
            set_manual(self.server.storage, equipment, value)
        except ValueError as e:
            raise BadRequest(str(e)) from None
        self._json(self.server.market())

    def lookup_miles(self):
        pickup = _zip((self._query.get("from") or [""])[0])
        dropoff = _zip((self._query.get("to") or [""])[0])
        try:
            self._json(self.server.miles.route(pickup, dropoff))
        except (ZipNotFound, NoRoute) as e:
            self._error(HTTPStatus.NOT_FOUND, str(e))
        except MilesError as e:
            self._error(HTTPStatus.BAD_GATEWAY, str(e))

    def lookup_place(self):
        zip_code = _zip((self._query.get("zip") or [""])[0])
        try:
            place = self.server.miles.place(zip_code)
        except ZipNotFound as e:
            return self._error(HTTPStatus.NOT_FOUND, str(e))
        except MilesError as e:
            return self._error(HTTPStatus.BAD_GATEWAY, str(e))
        self._json({"zip": place.zip, "name": place.name})

    def export_csv(self):
        body = self.server.storage.quotes_csv().encode("utf-8-sig")  # BOM so Excel reads UTF-8
        self._send(200, body, "text/csv; charset=utf-8",
                   {"Content-Disposition": 'attachment; filename="dispatch-quotes.csv"'})

    def save_settings(self):
        try:
            self._json(self.server.storage.update_settings(self._body()))
        except ValueError as e:
            raise BadRequest(str(e)) from None

    def add_quote(self):
        body = self._body()
        equipment = body.get("equipment")
        if equipment not in EQUIPMENT:
            raise BadRequest("unknown equipment")
        rate = _number(body, "rate", 1, 1_000_000)
        stops = _stops(body.get("stops"))
        status, final_rate = _outcome(body)
        # the first pickup's own rate is what's left of the total, so it must be at least $1
        if rate - sum(s.get("rate", 0) for s in stops) < 1:
            raise BadRequest("rate must cover every pickup's rate")
        quote = self.server.storage.add_quote(
            pickup=_zip(body.get("pickup")),
            dropoff=_zip(body.get("dropoff")),
            equipment=equipment,
            loaded=_number(body, "loaded", 1, 10_000),
            deadhead=_number(body, "deadhead", 0, 10_000),
            rate=rate,
            stops=stops,
            status=status,
            final_rate=final_rate,
            counter=_number(body, "counter", 1, 1_000_000) if body.get("counter") is not None else None,
            extras=_number(body, "extras", 0, 1_000_000) if body.get("extras") is not None else 0,
            broker=_text(body, "broker", 80),
            mc=_mc(body.get("mc")),
            notes=_text(body, "notes", 280),
        )
        self._json(quote, HTTPStatus.CREATED)

    def update_quote(self, quote_id: str):
        body = self._body()
        status, final_rate = _outcome(body)
        quote = self.server.storage.update_quote(int(quote_id), status, final_rate, _text(body, "notes", 280))
        if quote:
            self._json(quote)
        else:
            self._error(HTTPStatus.NOT_FOUND, "quote not found")

    def delete_quote(self, quote_id: str):
        if self.server.storage.delete_quote(int(quote_id)):
            self._json({"ok": True})
        else:
            self._error(HTTPStatus.NOT_FOUND, "quote not found")

    def _client_id(self) -> str:
        cid = self._body().get("id")
        if not isinstance(cid, str) or not 0 < len(cid) <= 64:
            raise BadRequest("bad client id")
        return cid

    def hello(self):
        self.server.lifecycle.hello(self._client_id())
        self._json({"ok": True})

    def bye(self):
        self.server.lifecycle.bye(self._client_id())
        self._json({"ok": True})
