"""SQLite storage for settings, saved quotes, rate observations and lookup caches."""

from __future__ import annotations

import csv
import io
import json
import sqlite3
import threading
import time
from datetime import datetime
from pathlib import Path

EQUIPMENT = ("van", "reefer", "flatbed")

DEFAULT_SETTINGS = {
    "ui_mode": "simple",        # simple | advanced
    "equipment": "van",
    "truck_zip": "",
    "target": "2.50",
    "floor": "2.00",
    "speed": "55",
    "effects": "on",            # on | off
    # where the reference $/mile comes from: national averages, or rates a manager gave you
    "rate_mode": "auto",        # auto | company
    "company_van": "",
    "company_reefer": "",
    "company_flatbed": "",
    "company_by": "",
    "company_van_date": "",     # the day each company rate was set; diesel moves it from there
    "company_reefer_date": "",
    "company_flatbed_date": "",
    "company_diesel": "1",      # 1 = adjust company rates for diesel each week
    # optional trip cost assumptions; blank means not set, so no estimate is made from them
    "mpg": "",
    "cost_per_mile": "",
    "cost_includes_fuel": "0",  # 1 = cost per mile already covers fuel, so fuel isn't added again
    "fuel_price": "",           # blank = the latest weekly EIA diesel price
}

# optional numbers and the range each must fall in
_NUMBER_RANGES = {"mpg": (2, 20), "cost_per_mile": (0, 20), "fuel_price": (1, 10)}

_CHOICES = {
    "ui_mode": ("simple", "advanced"),
    "equipment": EQUIPMENT,
    "effects": ("on", "off"),
    "rate_mode": ("auto", "company"),
    "company_diesel": ("0", "1"),
    "cost_includes_fuel": ("0", "1"),
}

# DAT's weekly market data for Oct 24-30, 2026: the all-in 7-day averages (linehaul +
# fuel surcharge) and the linehaul-only rates; having both for the same week gives
# each equipment type's fuel surcharge
BUILTIN_DATE = "2026-10-30"
BUILTIN_NOTE = "DAT spot market data, Oct 24-30, 2026"
BUILTIN_RATES = {
    "van": {"allin": 3.07, "linehaul": 2.23},
    "reefer": {"allin": 3.63, "linehaul": 2.71},
    "flatbed": {"allin": 3.62, "linehaul": 2.61},
}

_SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS quotes (
    id        INTEGER PRIMARY KEY,
    created   REAL NOT NULL,
    pickup    TEXT NOT NULL,
    dropoff   TEXT NOT NULL,
    equipment TEXT NOT NULL,
    loaded    REAL NOT NULL,
    deadhead  REAL NOT NULL,
    rate      REAL NOT NULL  -- the broker's offer; for an LTL / partial run, every pickup's rate added up
);
CREATE INDEX IF NOT EXISTS quotes_created ON quotes (created);
CREATE TABLE IF NOT EXISTS zips (
    zip  TEXT PRIMARY KEY,
    lat  REAL NOT NULL,
    lon  REAL NOT NULL,
    name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS routes (
    pickup  TEXT NOT NULL,
    dropoff TEXT NOT NULL,
    miles   REAL NOT NULL,
    PRIMARY KEY (pickup, dropoff)
);
-- One national $/mile figure: kind is 'allin' (fuel included) or 'linehaul' (fuel excluded).
CREATE TABLE IF NOT EXISTS rate_obs (
    equipment TEXT NOT NULL,
    kind      TEXT NOT NULL,
    value     REAL NOT NULL,
    as_of     TEXT NOT NULL,
    source    TEXT NOT NULL,
    note      TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (equipment, kind, source, as_of)
);
-- Numbers held back for being far from the last accepted one, until a report from another week agrees.
CREATE TABLE IF NOT EXISTS rate_held (
    equipment TEXT NOT NULL,
    kind      TEXT NOT NULL,
    value     REAL NOT NULL,
    as_of     TEXT NOT NULL,
    source    TEXT NOT NULL,
    note      TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (equipment, kind, source, as_of)
);
CREATE TABLE IF NOT EXISTS diesel (
    week  TEXT PRIMARY KEY,
    price REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS source_status (
    name    TEXT PRIMARY KEY,
    ok      INTEGER NOT NULL,
    checked REAL NOT NULL,
    message TEXT NOT NULL
);
"""

# quote columns added after 2.3; databases from before get them on first start
QUOTE_COLUMNS = {
    "stops": "TEXT NOT NULL DEFAULT '[]'",        # JSON: stops between pickup and dropoff, in drive order
    "status": "TEXT NOT NULL DEFAULT 'quoted'",   # quoted | booked | passed
    "final_rate": "REAL",                         # what was agreed, once booked
    "counter": "REAL",                            # what you asked for
    "extras": "REAL NOT NULL DEFAULT 0",          # broker-paid stop-off on top of the rate
    "broker": "TEXT NOT NULL DEFAULT ''",
    "mc": "TEXT NOT NULL DEFAULT ''",
    "notes": "TEXT NOT NULL DEFAULT ''",
}
QUOTE_STATUSES = ("quoted", "booked", "passed")

_QUOTE_SELECT = f"""
SELECT q.id, q.created, q.pickup, q.dropoff, q.equipment, q.loaded, q.deadhead, q.rate,
       {", ".join(f"q.{name}" for name in QUOTE_COLUMNS)},
       zp.name AS pickup_name, zd.name AS dropoff_name
FROM quotes q
LEFT JOIN zips zp ON zp.zip = q.pickup
LEFT JOIN zips zd ON zd.zip = q.dropoff
"""


def _quote(row: sqlite3.Row) -> dict:
    return {**dict(row), "stops": json.loads(row["stops"])}


def _csv_text(value: str) -> str:
    """Free text for a spreadsheet: a leading = + - @ would otherwise run as a formula."""
    return f"'{value}" if value[:1] in ("=", "+", "-", "@", "\t", "\r") else value


def _check_setting(key: str, value) -> None:
    if key not in DEFAULT_SETTINGS:
        raise ValueError(f"unknown setting: {key}")
    if not isinstance(value, str) or len(value) > 60:
        raise ValueError(f"bad value for {key}")
    if key in _CHOICES and value not in _CHOICES[key]:
        raise ValueError(f"bad value for {key}: {value}")
    if key.endswith("_date") and value and not (len(value) == 10 and value[4] == "-" and value[7] == "-"
                                                and value.replace("-", "").isascii()
                                                and value.replace("-", "").isdigit()):
        raise ValueError(f"{key} must be YYYY-MM-DD")
    if key == "truck_zip" and value and not (len(value) == 5 and value.isascii() and value.isdigit()):
        raise ValueError("truck ZIP must be 5 digits")
    if key.startswith("company_") and key[8:] in EQUIPMENT and value:
        try:
            ok = 0.5 <= float(value) <= 20
        except ValueError:
            ok = False
        if not ok:
            raise ValueError(f"{key} must be a rate between 0.50 and 20.00")
    if key in _NUMBER_RANGES and value:
        low, high = _NUMBER_RANGES[key]
        try:
            ok = low <= float(value) <= high
        except ValueError:
            ok = False
        if not ok:
            raise ValueError(f"{key} must be a number from {low} to {high}")


class Storage:
    def __init__(self, path: str | Path):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(str(path), check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        with self._lock:
            self._db.executescript(_SCHEMA)
            have = {row["name"] for row in self._db.execute("PRAGMA table_info(quotes)")}
            for name, definition in QUOTE_COLUMNS.items():
                if name not in have:
                    self._db.execute(f"ALTER TABLE quotes ADD COLUMN {name} {definition}")
        self._seed()

    def _seed(self) -> None:
        rows = [(eq, kind, value, BUILTIN_DATE, "builtin", BUILTIN_NOTE)
                for eq, kinds in BUILTIN_RATES.items() for kind, value in kinds.items()]
        with self._lock, self._db:
            self._db.executemany("INSERT OR IGNORE INTO rate_obs VALUES (?, ?, ?, ?, ?, ?)", rows)
            # v1.1/1.2 kept the market numbers in settings; carry newer ones over once
            old = dict(self._db.execute(
                "SELECT key, value FROM settings WHERE key LIKE 'market_%'").fetchall())
            if old.get("market_date", "") > BUILTIN_DATE:
                for eq in EQUIPMENT:
                    try:
                        value = float(old.get(f"market_{eq}", ""))
                    except ValueError:
                        continue
                    self._db.execute("INSERT OR IGNORE INTO rate_obs VALUES (?, 'allin', ?, ?, 'manual', ?)",
                                     (eq, value, old["market_date"], "carried over from an earlier version"))
            self._db.execute("DELETE FROM settings WHERE key LIKE 'market_%' OR key IN "
                             "('fuel_adjust', 'diesel_price', 'diesel_week')")
            # up to 2.1 one company_date covered all three company rates; give each saved rate that
            # date so every adjusted rate stays what it was, then drop the shared one
            old = dict(self._db.execute("SELECT key, value FROM settings WHERE key LIKE 'company_%'").fetchall())
            if "company_date" in old:
                self._db.executemany("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)",
                                     [(f"company_{eq}_date", old["company_date"])
                                      for eq in EQUIPMENT if old.get(f"company_{eq}")])
                self._db.execute("DELETE FROM settings WHERE key = 'company_date'")

    def close(self) -> None:
        with self._lock:
            self._db.close()

    def _query(self, sql: str, params: tuple = ()) -> list[sqlite3.Row]:
        with self._lock:
            return self._db.execute(sql, params).fetchall()

    def _write(self, sql: str, params: tuple = ()) -> sqlite3.Cursor:
        with self._lock, self._db:
            return self._db.execute(sql, params)

    # settings

    def settings(self) -> dict[str, str]:
        values = dict(DEFAULT_SETTINGS)
        for row in self._query("SELECT key, value FROM settings"):
            if row["key"] in values:
                values[row["key"]] = row["value"]
        return values

    def update_settings(self, changes: dict) -> dict[str, str]:
        for key, value in changes.items():
            _check_setting(key, value)
        with self._lock, self._db:
            self._db.executemany("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
                                 list(changes.items()))
        return self.settings()

    # quotes

    def add_quote(self, pickup: str, dropoff: str, equipment: str, loaded: float, deadhead: float,
                  rate: float, stops: list[dict] | None = None, **details) -> dict:
        """`details` are the optional QUOTE_COLUMNS: status, final_rate, counter, extras, broker, mc, notes."""
        unknown = set(details) - set(QUOTE_COLUMNS)
        if unknown:
            raise ValueError(f"unknown quote fields: {sorted(unknown)}")
        columns = {"created": time.time(), "pickup": pickup, "dropoff": dropoff, "equipment": equipment,
                   "loaded": loaded, "deadhead": deadhead, "rate": rate, "stops": json.dumps(stops or []), **details}
        cur = self._write(f"INSERT INTO quotes ({', '.join(columns)}) VALUES ({', '.join('?' * len(columns))})",
                          tuple(columns.values()))
        return self.quote(cur.lastrowid)

    def quote(self, quote_id: int) -> dict | None:
        rows = self._query(_QUOTE_SELECT + " WHERE q.id = ?", (quote_id,))
        return _quote(rows[0]) if rows else None

    def update_quote(self, quote_id: int, status: str, final_rate: float | None, notes: str) -> dict | None:
        """Record how a quote turned out. A final rate only stays on a booked quote."""
        if status not in QUOTE_STATUSES:
            raise ValueError(f"unknown status: {status}")
        self._write("UPDATE quotes SET status = ?, final_rate = ?, notes = ? WHERE id = ?",
                    (status, final_rate if status == "booked" else None, notes, quote_id))
        return self.quote(quote_id)

    def quotes(self) -> list[dict]:
        return [_quote(r) for r in self._query(_QUOTE_SELECT + " ORDER BY q.created DESC")]

    def delete_quote(self, quote_id: int) -> bool:
        return self._write("DELETE FROM quotes WHERE id = ?", (quote_id,)).rowcount > 0

    def quotes_csv(self) -> str:
        out = io.StringIO()
        writer = csv.writer(out, lineterminator="\n")
        writer.writerow(["date", "pickup", "pickup_city", "dropoff", "dropoff_city", "equipment",
                         "loaded_miles", "deadhead_miles", "rate", "all_in_rpm", "loaded_rpm", "stops",
                         "status", "final_rate", "counter", "broker", "mc", "notes"])
        money = lambda n: "" if n is None else f"{n:.2f}"  # noqa: E731
        for q in self.quotes():
            total = q["loaded"] + q["deadhead"]
            writer.writerow([
                datetime.fromtimestamp(q["created"]).strftime("%Y-%m-%d %H:%M"),
                q["pickup"], _csv_text(q["pickup_name"] or ""), q["dropoff"], _csv_text(q["dropoff_name"] or ""),
                q["equipment"], f"{q['loaded']:g}", f"{q['deadhead']:g}", f"{q['rate']:.2f}",
                f"{q['rate'] / total:.2f}", f"{q['rate'] / q['loaded']:.2f}",
                "; ".join(f"{s['zip']} {s['kind']}" + (f" {s['rate']:.2f}" if "rate" in s else "")
                          for s in q["stops"]),
                q["status"], money(q["final_rate"]), money(q["counter"]),
                _csv_text(q["broker"]), q["mc"], _csv_text(q["notes"]),
            ])
        return out.getvalue()

    # national rates

    def add_observation(self, equipment: str, kind: str, value: float, as_of: str,
                        source: str, note: str = "") -> None:
        self._write("INSERT OR REPLACE INTO rate_obs VALUES (?, ?, ?, ?, ?, ?)",
                    (equipment, kind, value, as_of, source, note))

    def observations(self) -> list[dict]:
        return [dict(r) for r in self._query(
            "SELECT equipment, kind, value, as_of, source, note FROM rate_obs ORDER BY as_of")]

    def delete_observations(self, equipment: str, source: str) -> int:
        return self._write("DELETE FROM rate_obs WHERE equipment = ? AND source = ?",
                           (equipment, source)).rowcount

    def hold_observation(self, equipment: str, kind: str, value: float, as_of: str,
                         source: str, note: str = "") -> None:
        self._write("INSERT OR REPLACE INTO rate_held VALUES (?, ?, ?, ?, ?, ?)",
                    (equipment, kind, value, as_of, source, note))

    def held_observations(self, equipment: str, kind: str) -> list[dict]:
        return [dict(r) for r in self._query(
            "SELECT equipment, kind, value, as_of, source, note FROM rate_held "
            "WHERE equipment = ? AND kind = ? ORDER BY as_of", (equipment, kind))]

    def clear_held(self, equipment: str, kind: str) -> None:
        self._write("DELETE FROM rate_held WHERE equipment = ? AND kind = ?", (equipment, kind))

    def put_diesel(self, rows: list[tuple[str, float]]) -> None:
        with self._lock, self._db:
            self._db.executemany("INSERT OR REPLACE INTO diesel (week, price) VALUES (?, ?)", rows)

    def diesel(self) -> list[tuple[str, float]]:
        return [(r["week"], r["price"]) for r in self._query("SELECT week, price FROM diesel ORDER BY week")]

    def set_source_status(self, name: str, ok: bool, message: str) -> None:
        self._write("INSERT OR REPLACE INTO source_status VALUES (?, ?, ?, ?)",
                    (name, int(ok), time.time(), message))

    def source_status(self) -> dict[str, dict]:
        return {r["name"]: {"ok": bool(r["ok"]), "checked": r["checked"], "message": r["message"]}
                for r in self._query("SELECT name, ok, checked, message FROM source_status")}

    # lookup caches

    def get_zip(self, zip_code: str) -> sqlite3.Row | None:
        rows = self._query("SELECT zip, lat, lon, name FROM zips WHERE zip = ?", (zip_code,))
        return rows[0] if rows else None

    def put_zip(self, zip_code: str, lat: float, lon: float, name: str) -> None:
        self._write("INSERT OR REPLACE INTO zips (zip, lat, lon, name) VALUES (?, ?, ?, ?)",
                    (zip_code, lat, lon, name))

    def get_route(self, pickup: str, dropoff: str) -> float | None:
        rows = self._query("SELECT miles FROM routes WHERE pickup = ? AND dropoff = ?",
                           (pickup, dropoff))
        return rows[0]["miles"] if rows else None

    def put_route(self, pickup: str, dropoff: str, miles: float) -> None:
        self._write("INSERT OR REPLACE INTO routes (pickup, dropoff, miles) VALUES (?, ?, ?)",
                    (pickup, dropoff, miles))
