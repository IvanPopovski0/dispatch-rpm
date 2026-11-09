import tempfile
import unittest
from pathlib import Path
from unittest import mock
from urllib.error import HTTPError, URLError

from dispatch_rpm import miles
from dispatch_rpm.miles import MilesError, MilesService, Place, ZipNotFound, straight_line_miles
from dispatch_rpm.storage import Storage

ZIPS = {
    "60601": {"places": [{"place name": "Chicago", "state abbreviation": "IL",
                          "latitude": "41.8858", "longitude": "-87.6181"}]},
    "75201": {"places": [{"place name": "Dallas", "state abbreviation": "TX",
                          "latitude": "32.7872", "longitude": "-96.7985"}]},
}
OSRM_OK = {"code": "Ok", "routes": [{"distance": 1557761.2, "duration": 61728.4}]}


class FakeFetch:
    def __init__(self, osrm=OSRM_OK):
        self.osrm = osrm
        self.calls = []

    def __call__(self, url, timeout):
        self.calls.append(url)
        if "zippopotam" in url:
            zip_code = url.rsplit("/", 1)[1]
            if zip_code not in ZIPS:
                raise HTTPError(url, 404, "Not Found", {}, None)
            return ZIPS[zip_code]
        if isinstance(self.osrm, Exception):
            raise self.osrm
        return self.osrm


class MilesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = Storage(Path(self.tmp.name) / "test.db")
        # Skip the one-request-per-second OSRM pause in tests.
        patcher = mock.patch.object(miles.time, "sleep")
        patcher.start()
        self.addCleanup(patcher.stop)

    def tearDown(self):
        self.db.close()
        self.tmp.cleanup()

    def test_straight_line(self):
        chicago = Place("60601", 41.8858, -87.6181, "Chicago, IL")
        dallas = Place("75201", 32.7872, -96.7985, "Dallas, TX")
        self.assertAlmostEqual(straight_line_miles(chicago, dallas), 803, delta=5)
        self.assertEqual(straight_line_miles(chicago, chicago), 0)

    def test_road_route_then_cache(self):
        fetch = FakeFetch()
        svc = MilesService(self.db, fetch)
        first = svc.route("60601", "75201")
        self.assertEqual(first, {"pickup": "Chicago, IL", "dropoff": "Dallas, TX",
                                 "miles": 968, "source": "road"})
        calls = len(fetch.calls)
        second = svc.route("60601", "75201")
        self.assertEqual(second["source"], "cache")
        self.assertEqual(second["miles"], 968)
        self.assertEqual(len(fetch.calls), calls, "cached lookup should not hit the network")

    def test_falls_back_to_estimate(self):
        for failure in (URLError("down"), TimeoutError(), {"code": "NoRoute", "routes": []}, {"weird": 1}):
            with self.subTest(failure=failure):
                svc = MilesService(self.db, FakeFetch(osrm=failure))
                result = svc.route("60601", "75201")
                self.assertEqual(result["source"], "estimate")
                self.assertAlmostEqual(result["miles"], 803 * miles.ROAD_FACTOR, delta=10)
        self.assertIsNone(self.db.get_route("60601", "75201"), "estimates must not be cached")

    def test_unknown_zip(self):
        svc = MilesService(self.db, FakeFetch())
        with self.assertRaises(ZipNotFound):
            svc.route("60601", "00000")

    def test_zip_service_down(self):
        def offline(url, timeout):
            raise URLError("no internet")
        with self.assertRaises(MilesError) as ctx:
            MilesService(self.db, offline).route("60601", "75201")
        self.assertNotIsInstance(ctx.exception, ZipNotFound)

    def test_same_zip(self):
        result = MilesService(self.db, FakeFetch()).route("60601", "60601")
        self.assertEqual(result["miles"], 0)


if __name__ == "__main__":
    unittest.main()
