"""ZIP-to-ZIP driving miles using free services.

ZIP codes are turned into coordinates with zippopotam.us, then routed with
the public OSRM demo server (OpenStreetMap data). If OSRM is down we fall
back to straight-line distance times a typical road factor, and say so. If
OSRM says no road connects the two, that's an error: the miles must be typed.
"""

from __future__ import annotations

import json
import math
import threading
import time
from dataclasses import dataclass
from typing import Callable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from . import __version__
from .storage import Storage

ZIP_URL = "https://api.zippopotam.us/us/{zip}"
OSRM_URL = "https://router.project-osrm.org/route/v1/driving/{a_lon},{a_lat};{b_lon},{b_lat}?overview=false"
USER_AGENT = f"dispatch-rpm/{__version__}"

# road miles run about 15-20% over straight-line miles on typical US freight lanes
ROAD_FACTOR = 1.18
EARTH_RADIUS_MI = 3958.8


class MilesError(Exception):
    """Lookup failed; the message is shown to the user."""


class ZipNotFound(MilesError):
    pass


class NoRoute(MilesError):
    """No road connects the two points (islands, some Alaska ZIPs); a straight line would be wrong."""


@dataclass
class Place:
    zip: str
    lat: float
    lon: float
    name: str


def fetch_json(url: str, timeout: float) -> dict:
    req = Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urlopen(req, timeout=timeout) as resp:
        return json.load(resp)


def straight_line_miles(a: Place, b: Place) -> float:
    lat1, lat2 = math.radians(a.lat), math.radians(b.lat)
    dlat = lat2 - lat1
    dlon = math.radians(b.lon - a.lon)
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * EARTH_RADIUS_MI * math.asin(math.sqrt(h))


class MilesService:
    def __init__(self, storage: Storage, fetch: Callable[[str, float], dict] = fetch_json):
        self._storage = storage
        self._fetch = fetch
        # the OSRM demo server asks for at most one request per second
        self._osrm_lock = threading.Lock()
        self._osrm_last = 0.0

    def place(self, zip_code: str) -> Place:
        row = self._storage.get_zip(zip_code)
        if row:
            return Place(row["zip"], row["lat"], row["lon"], row["name"])
        try:
            data = self._fetch(ZIP_URL.format(zip=zip_code), 6)
        except HTTPError as e:
            if e.code == 404:
                raise ZipNotFound(f"ZIP {zip_code} not found") from None
            raise MilesError("ZIP lookup service error") from None
        except (URLError, OSError, ValueError):
            raise MilesError("Can't reach the ZIP lookup service (check internet)") from None
        try:
            p = data["places"][0]
            place = Place(zip_code, float(p["latitude"]), float(p["longitude"]),
                          f"{p['place name']}, {p['state abbreviation']}")
        except (KeyError, IndexError, TypeError, ValueError):
            raise ZipNotFound(f"ZIP {zip_code} not found") from None
        self._storage.put_zip(place.zip, place.lat, place.lon, place.name)
        return place

    def _road_miles(self, a: Place, b: Place) -> float:
        url = OSRM_URL.format(a_lon=a.lon, a_lat=a.lat, b_lon=b.lon, b_lat=b.lat)
        with self._osrm_lock:
            wait = 1.0 - (time.monotonic() - self._osrm_last)
            if wait > 0:
                time.sleep(wait)
            try:
                data = self._fetch(url, 8)
            except HTTPError as e:
                # OSRM answers 400 with a JSON code when there is no road between the points
                try:
                    data = json.loads(e.read())
                except (AttributeError, OSError, ValueError):
                    raise e from None
                if not isinstance(data, dict):
                    raise
            finally:
                self._osrm_last = time.monotonic()
        if data.get("code") in ("NoRoute", "NoSegment"):
            raise NoRoute("No road route between these ZIP codes")
        if data.get("code") != "Ok" or not data.get("routes"):
            raise MilesError("no route found")
        return data["routes"][0]["distance"] / 1609.344

    def route(self, pickup: str, dropoff: str) -> dict:
        a, b = self.place(pickup), self.place(dropoff)
        result = {"pickup": a.name, "dropoff": b.name}

        cached = self._storage.get_route(pickup, dropoff)
        if cached is not None:
            return {**result, "miles": round(cached), "source": "cache"}

        if pickup == dropoff:
            return {**result, "miles": 0, "source": "road"}

        try:
            miles = self._road_miles(a, b)
        except NoRoute:
            raise
        except (MilesError, HTTPError, URLError, OSError, ValueError, KeyError, TypeError):
            # don't cache estimates; the next lookup tries the real route again
            miles = straight_line_miles(a, b) * ROAD_FACTOR
            return {**result, "miles": round(miles), "source": "estimate"}

        self._storage.put_route(pickup, dropoff, miles)
        return {**result, "miles": round(miles), "source": "road"}
