"""National $/mile reference rates, kept current automatically.

How a rate is worked out for each equipment type (van, reefer, flatbed):

* DAT publishes a weekly report per equipment type on its blog with the
  national spot **linehaul** rate (fuel excluded). The app reads it from
  several places on dat.com (RSS feeds and the WordPress JSON API) because no
  single one is reliably up to date; the newest report wins.
* DAT's all-in rate is linehaul plus a fuel surcharge. For one week where both
  numbers are known (built in, or from market.json) the difference is that
  equipment type's fuel surcharge. From then on the surcharge moves with the
  weekly U.S. diesel price (EIA, via FRED): about 1 cent per mile for every
  6 cents per gallon.
* So: rate = latest DAT linehaul + calibrated fuel surcharge + diesel change.
* An all-in number that is newer than the latest report (typed in the app, or
  from market.json) is used as is, plus the diesel change since its date.
* Company mode ignores all of this and uses rates someone typed in, optionally
  adjusted for diesel.

Anything that looks wrong (outside a sane range, or a jump of more than 20%
from the previous week) is not applied; the Rates panel says why.
"""

from __future__ import annotations

import gzip
import json
import logging
import re
import threading
import time
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timezone
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
from typing import Callable
from urllib.request import Request, urlopen

from .miles import USER_AGENT
from .storage import EQUIPMENT, Storage

log = logging.getLogger(__name__)

# Optional: point this at your own repo to push numbers to every copy of the app,
# e.g. https://raw.githubusercontent.com/jane/dispatch-rpm/main/market.json
MARKET_URL = "https://raw.githubusercontent.com/YOUR_USERNAME/dispatch-rpm/main/market.json"
# EIA "U.S. No 2 Diesel Retail Prices", weekly, $/gallon.
DIESEL_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=GASDESW"
# DAT's weekly market reports. Each of these lags sometimes; together they don't.
DAT_URLS = (
    "https://www.dat.com/blog/feed/",
    "https://www.dat.com/blog/category/market-update/feed/",
    "https://www.dat.com/blog/category/van-markets/feed/",
    "https://www.dat.com/blog/category/reefer-markets/feed/",
    "https://www.dat.com/blog/category/flatbed-markets/feed/",
    "https://www.dat.com/blog/wp-json/wp/v2/posts?per_page=20&_fields=date,link,title,content",
)

FUEL_MPG = 6.0               # 1 cent per mile for every 6 cents per gallon
MAX_FUEL_MOVE = 0.75         # $/mi; anything bigger is bad data
MAX_WEEKLY_CHANGE = 0.20     # reject a new number this far from the previous one
LINEHAUL_RANGE = (1.0, 6.0)
ALLIN_RANGE = (1.2, 8.0)
CALIBRATION_DAYS = 4         # linehaul and all-in this close together count as the same week

INTERVALS = {"dat": 12 * 3600, "diesel": 12 * 3600, "teamfile": 6 * 3600}
LOOP_SECONDS = 30 * 60

_DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")
_EQ_WORDS = {"dry van": "van", "van": "van", "reefer": "reefer",
             "refrigerated": "reefer", "flatbed": "flatbed"}
_LINEHAUL_RE = re.compile(
    r"\b(dry van|van|reefer|refrigerated|flatbed)\b"
    r"(?P<mid>[^.$]{0,80}?)\blinehaul\b[^.$]{0,60}?"
    r"\baverag(?:ed|ing)\s+\$(?P<value>\d{1,2}\.\d{2})\s*(?:per|a)\s+mile",
    re.IGNORECASE,
)


# ---------------------------------------------------------------- fetching

def fetch_bytes(url: str, timeout: float) -> bytes:
    req = Request(url, headers={"User-Agent": USER_AGENT, "Accept-Encoding": "identity"})
    with urlopen(req, timeout=timeout) as resp:
        body = resp.read(8_000_000)
    if body[:2] == b"\x1f\x8b":  # some servers gzip regardless
        body = gzip.decompress(body)
    return body


# ---------------------------------------------------------------- parsing

class _TextExtractor(HTMLParser):
    _BLOCKS = {"p", "br", "li", "div", "h1", "h2", "h3", "h4", "tr", "td", "section"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self._skip += 1
        elif tag in self._BLOCKS:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in ("script", "style") and self._skip:
            self._skip -= 1
        elif tag in self._BLOCKS:
            self.parts.append("\n")

    def handle_data(self, data):
        if not self._skip:
            self.parts.append(data)


def html_to_text(html: str) -> str:
    parser = _TextExtractor()
    parser.feed(html or "")
    parser.close()
    text = "".join(parser.parts).replace("\xa0", " ")
    return re.sub(r"[ \t]+", " ", text)


def extract_linehaul(title: str, html: str) -> dict[str, float]:
    """National spot linehaul $/mi per equipment type from one DAT report.

    Only equipment named in the title counts, so a dry van report's mention of
    reefers (or a "related posts" teaser) can't leak in.
    """
    title_l = (title or "").lower()
    wanted = {eq for word, eq in _EQ_WORDS.items() if re.search(rf"\b{word}\b", title_l)}
    found: dict[str, float] = {}
    text = html_to_text(html)
    for m in _LINEHAUL_RE.finditer(text):
        eq = _EQ_WORDS[m.group(1).lower()]
        mid = m.group("mid").lower()
        # The same sentence, before the equipment word ("Our top 50 van lanes ...").
        lead = re.split(r"[.\n]", text[max(0, m.start() - 60):m.start()])[-1].lower()
        context = f"{lead} {mid}"
        if eq not in wanted or eq in found or "spot" not in mid:
            continue
        if any(word in context for word in ("contract", "bellwether", "top ", "lanes", "states")):
            continue
        found[eq] = float(m.group("value"))
    return found


def _iso(dt: datetime) -> str:
    if dt.tzinfo:
        dt = dt.astimezone(timezone.utc)
    return dt.date().isoformat()


def parse_posts(body: bytes) -> list[dict]:
    """RSS 2.0 feed or WordPress /wp/v2/posts JSON -> [{title, date, html}]."""
    text = body.lstrip(b"\xef\xbb\xbf \t\r\n")
    posts = []
    if text[:1] == b"[":
        try:
            data = json.loads(text)
        except ValueError:
            return []
        for p in data if isinstance(data, list) else []:
            try:
                posts.append({"title": html_to_text(p["title"]["rendered"]).strip(),
                              "date": _iso(datetime.fromisoformat(p["date"][:19])),
                              "html": p["content"]["rendered"]})
            except (KeyError, TypeError, ValueError):
                continue
        return posts
    try:
        root = ET.fromstring(text)
    except ET.ParseError:
        return []
    for item in root.iter("item"):
        content = (item.findtext("{http://purl.org/rss/1.0/modules/content/}encoded")
                   or item.findtext("description") or "")
        try:
            when = _iso(parsedate_to_datetime(item.findtext("pubDate") or ""))
        except (TypeError, ValueError):
            continue
        posts.append({"title": (item.findtext("title") or "").strip(), "date": when, "html": content})
    return posts


def parse_diesel_csv(text: str) -> list[tuple[str, float]]:
    """FRED CSV ("DATE,GASDESW" or "observation_date,GASDESW") -> sorted [(date, price)]."""
    rows = []
    for line in text.splitlines()[1:]:
        day, _, value = (part.strip() for part in line.partition(","))
        if not _DATE_RE.fullmatch(day):
            continue
        try:
            price = float(value)  # FRED writes "." for a missing week
        except ValueError:
            continue
        if 1.0 <= price <= 10.0:
            rows.append((day, price))
    rows.sort()
    return rows


def parse_market(data) -> list[tuple[str, str, float, str]] | None:
    """market.json -> [(equipment, kind, value, as_of)], or None if malformed.

    {"updated": "2026-11-06", "van": 3.07, "reefer": 3.63, "flatbed": 3.62,
     "linehaul": {"van": 2.23, ...}}   <- linehaul is optional
    """
    if not isinstance(data, dict) or not _DATE_RE.fullmatch(str(data.get("updated", ""))):
        return None
    day = data["updated"]
    rows = []
    for eq in EQUIPMENT:
        rate = data.get(eq)
        if isinstance(rate, bool) or not isinstance(rate, (int, float)) or not ALLIN_RANGE[0] <= rate <= ALLIN_RANGE[1]:
            return None
        rows.append((eq, "allin", float(rate), day))
    linehaul = data.get("linehaul")
    if isinstance(linehaul, dict):
        for eq in EQUIPMENT:
            v = linehaul.get(eq)
            if isinstance(v, (int, float)) and not isinstance(v, bool) and LINEHAUL_RANGE[0] <= v <= LINEHAUL_RANGE[1]:
                rows.append((eq, "linehaul", float(v), day))
    return rows


# ---------------------------------------------------------------- resolving

_NICE = {"van": "Dry van", "reefer": "Reefer", "flatbed": "Flatbed"}


def _short(day: str) -> str:
    d = date.fromisoformat(day)
    return f"{d:%b} {d.day}"


def _days(a: str, b: str) -> int:
    return (date.fromisoformat(a) - date.fromisoformat(b)).days


def diesel_change(series: list[tuple[str, float]], since: str) -> float:
    """$/mi the fuel surcharge moved since a date (0 if unknown or implausible)."""
    if not series or not since:
        return 0.0
    before = [price for day, price in series if day <= since]
    if not before:
        return 0.0
    move = (series[-1][1] - before[-1]) / FUEL_MPG
    return move if abs(move) <= MAX_FUEL_MOVE else 0.0


def resolve_equipment(obs: list[dict], diesel: list[tuple[str, float]]) -> dict | None:
    allin = sorted((o for o in obs if o["kind"] == "allin"),
                   key=lambda o: (o["as_of"], o["source"] == "manual"))
    linehaul = sorted((o for o in obs if o["kind"] == "linehaul"), key=lambda o: o["as_of"])
    if not allin:
        return None
    latest = allin[-1]

    # Fuel surcharge = all-in minus linehaul, from the newest week that has both (DAT numbers only).
    surcharge = surcharge_date = None
    for a in reversed(allin):
        if a["source"] == "manual":
            continue
        near = [l for l in linehaul if abs(_days(l["as_of"], a["as_of"])) <= CALIBRATION_DAYS]
        if near:
            l = min(near, key=lambda l: abs(_days(l["as_of"], a["as_of"])))
            surcharge, surcharge_date = a["value"] - l["value"], a["as_of"]
            break

    report = linehaul[-1] if linehaul else None
    if report and surcharge is not None and report["as_of"] > latest["as_of"]:
        fuel = surcharge + diesel_change(diesel, surcharge_date)
        value, base = report["value"] + fuel, report
        result = {"method": "linehaul", "linehaul": report["value"], "fuel": round(fuel, 3),
                  "fuel_change": round(diesel_change(diesel, surcharge_date), 3)}
    else:
        change = diesel_change(diesel, latest["as_of"])
        value, base = latest["value"] + change, latest
        result = {"method": "allin", "allin": latest["value"], "fuel_change": round(change, 3)}
    return {**result, "value": round(value, 2), "as_of": base["as_of"],
            "source": base["source"], "note": base["note"]}


def resolve(storage: Storage) -> dict:
    """Everything the UI needs about reference rates."""
    settings = storage.settings()
    obs = storage.observations()
    diesel = storage.diesel()
    auto = {eq: resolve_equipment([o for o in obs if o["equipment"] == eq], diesel) for eq in EQUIPMENT}

    company = {}
    company_date = settings["company_date"]
    follow = settings["company_diesel"] == "1"
    for eq in EQUIPMENT:
        raw = settings[f"company_{eq}"]
        if not raw:
            company[eq] = None
            continue
        change = diesel_change(diesel, company_date) if follow else 0.0
        company[eq] = {"value": round(float(raw) + change, 2), "base": float(raw),
                       "fuel_change": round(change, 3), "as_of": company_date,
                       "source": "company", "method": "company"}

    mode = settings["rate_mode"]
    active = {}
    for eq in EQUIPMENT:
        use_company = mode == "company" and company[eq] is not None
        active[eq] = company[eq] if use_company else auto[eq]
        if mode == "company" and not use_company and active[eq]:
            active[eq] = {**active[eq], "fallback": True}

    statuses = storage.source_status()
    return {
        "mode": mode,
        "active": active,
        "auto": auto,
        "company": {"rates": company, "by": settings["company_by"], "date": company_date, "diesel": follow},
        "diesel": {"price": diesel[-1][1], "week": diesel[-1][0]} if diesel else None,
        "sources": [{"key": key, **statuses.get(key, {"ok": None, "checked": None, "message": ""})}
                    for key in ("dat", "diesel", "teamfile")],
    }


# ---------------------------------------------------------------- updating

class RateUpdater:
    """Checks DAT, diesel and market.json on a schedule and stores what it finds."""

    def __init__(self, storage: Storage, market_url: str | None = MARKET_URL,
                 diesel_url: str | None = DIESEL_URL, dat_urls: tuple[str, ...] | None = DAT_URLS,
                 fetch: Callable[[str, float], bytes] = fetch_bytes):
        self._storage = storage
        self._market_url = market_url if market_url and "YOUR_USERNAME" not in market_url else None
        self._diesel_url = diesel_url
        self._dat_urls = tuple(dat_urls or ())
        self._fetch = fetch
        self._run_lock = threading.Lock()
        self._stop = threading.Event()
        self.done = threading.Event()   # set after the first check finishes
        self.checking = False

    def start(self) -> None:
        threading.Thread(target=self._loop, name="rate-updater", daemon=True).start()

    def stop(self) -> None:
        self._stop.set()

    def wait(self, timeout: float) -> None:
        self.done.wait(timeout)

    def _loop(self) -> None:
        while True:
            try:
                self.run()
            except Exception:
                log.exception("rate update failed")
            if self._stop.wait(LOOP_SECONDS):
                return

    def _due(self, name: str, force: bool) -> bool:
        if force:
            return True
        checked = self._storage.source_status().get(name, {}).get("checked")
        return not checked or time.time() - checked >= INTERVALS[name]

    def run(self, force: bool = False) -> None:
        with self._run_lock:
            self.checking = True
            try:
                jobs = []
                if self._dat_urls and self._due("dat", force):
                    jobs.append(self._check_dat)
                if self._diesel_url and self._due("diesel", force):
                    jobs.append(self._check_diesel)
                if self._market_url and self._due("teamfile", force):
                    jobs.append(self._check_teamfile)
                with ThreadPoolExecutor(max_workers=3) as pool:
                    for job in [pool.submit(j) for j in jobs]:
                        try:
                            job.result()
                        except Exception:
                            log.exception("rate source failed")
            finally:
                self.checking = False
                self.done.set()

    def _get_many(self, urls) -> list[bytes | Exception]:
        def get(url):
            try:
                return self._fetch(url, 8)
            except Exception as e:  # noqa: BLE001 - reported per source
                return e
        with ThreadPoolExecutor(max_workers=6) as pool:
            return list(pool.map(get, urls))

    def _accept(self, eq: str, kind: str, value: float, as_of: str) -> str | None:
        """Why a new number should NOT be stored, or None if it looks fine."""
        low, high = LINEHAUL_RANGE if kind == "linehaul" else ALLIN_RANGE
        if not low <= value <= high:
            return f"${value:.2f} is outside ${low:.2f}-${high:.2f}"
        earlier = [o for o in self._storage.observations()
                   if o["equipment"] == eq and o["kind"] == kind and o["as_of"] < as_of
                   and o["source"] != "manual"]
        if earlier:
            prev = earlier[-1]["value"]
            if abs(value / prev - 1) > MAX_WEEKLY_CHANGE:
                return f"${value:.2f} is too far from ${prev:.2f} the week before"
        return None

    def _check_dat(self) -> None:
        newest: dict[str, tuple[str, float, str]] = {}
        reached = 0
        for body in self._get_many(self._dat_urls):
            if isinstance(body, Exception):
                continue
            posts = parse_posts(body)
            reached += bool(posts)
            for post in posts:
                for eq, value in extract_linehaul(post["title"], post["html"]).items():
                    if eq not in newest or post["date"] > newest[eq][0]:
                        newest[eq] = (post["date"], value, post["title"])
        if not reached:
            self._storage.set_source_status("dat", False, "Couldn't reach DAT's weekly reports.")
            return
        parts, problems = [], []
        for eq in EQUIPMENT:
            if eq not in newest:
                continue
            day, value, title = newest[eq]
            reason = self._accept(eq, "linehaul", value, day)
            if reason:
                problems.append(f"{_NICE[eq]}: ignored {reason}")
                continue
            self._storage.add_observation(eq, "linehaul", value, day, "dat", title)
            parts.append(f"{_NICE[eq]} ${value:.2f} linehaul, {_short(day)}")
        message = "; ".join(parts + problems) or "Reached DAT, but no new rate reports were found."
        self._storage.set_source_status("dat", bool(parts), message)
        log.info("DAT: %s", message)

    def _check_diesel(self) -> None:
        body = self._get_many([self._diesel_url])[0]
        rows = [] if isinstance(body, Exception) else parse_diesel_csv(body.decode("utf-8", "replace"))
        if not rows:
            self._storage.set_source_status("diesel", False, "Couldn't get the weekly diesel price.")
            return
        cutoff = f"{date.today().year - 3}-01-01"
        self._storage.put_diesel([r for r in rows if r[0] >= cutoff])
        week, price = rows[-1]
        self._storage.set_source_status("diesel", True, f"${price:.3f}/gal, week of {_short(week)}")

    def _check_teamfile(self) -> None:
        body = self._get_many([self._market_url])[0]
        try:
            rows = None if isinstance(body, Exception) else parse_market(json.loads(body))
        except ValueError:
            rows = None
        if not rows:
            self._storage.set_source_status("teamfile", False, "Couldn't read market.json.")
            return
        problems = []
        for eq, kind, value, day in rows:
            reason = self._accept(eq, kind, value, day)
            if reason:
                problems.append(f"{eq}: ignored {reason}")
            else:
                self._storage.add_observation(eq, kind, value, day, "teamfile", "market.json")
        message = "; ".join([f"market.json from {_short(rows[0][3])}"] + problems)
        self._storage.set_source_status("teamfile", True, message)


def set_manual(storage: Storage, equipment: str, value: float | None) -> None:
    """Type a national rate by hand (dated today), or clear the hand-typed ones."""
    if equipment not in EQUIPMENT:
        raise ValueError("unknown equipment")
    storage.delete_observations(equipment, "manual")
    if value is not None:
        if not ALLIN_RANGE[0] <= value <= ALLIN_RANGE[1]:
            raise ValueError(f"rate must be between ${ALLIN_RANGE[0]:.2f} and ${ALLIN_RANGE[1]:.2f}")
        storage.add_observation(equipment, "allin", value, date.today().isoformat(), "manual", "typed in the app")
