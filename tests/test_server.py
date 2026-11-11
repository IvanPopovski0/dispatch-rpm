import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from dispatch_rpm.miles import MilesError, NoRoute, Place, ZipNotFound
from dispatch_rpm.server import DispatchServer, Lifecycle
from dispatch_rpm.storage import Storage


class FakeMiles:
    def place(self, zip_code):
        if zip_code == "00000":
            raise ZipNotFound("ZIP 00000 not found")
        return Place(zip_code, 41.88, -87.62, "Chicago, IL")

    def route(self, pickup, dropoff):
        if dropoff == "00000":
            raise ZipNotFound("ZIP 00000 not found")
        if dropoff == "96813":
            raise NoRoute("No road route between these ZIP codes")
        if dropoff == "99999":
            raise MilesError("Can't reach the ZIP lookup service")
        return {"pickup": "Chicago, IL", "dropoff": "Dallas, TX", "miles": 968, "source": "road"}


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.db = Storage(Path(cls.tmp.name) / "test.db")
        cls.server = DispatchServer(cls.db, FakeMiles(), port=0)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = cls.server.url.rstrip("/")

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.db.close()
        cls.tmp.cleanup()

    def request(self, method, path, body=None, headers=None):
        data = json.dumps(body).encode() if body is not None else None
        req = Request(self.base + path, data=data, method=method, headers=headers or {})
        if data:
            req.add_header("Content-Type", "application/json")
        try:
            with urlopen(req, timeout=5) as resp:
                return resp.status, resp.headers, resp.read()
        except HTTPError as e:
            return e.code, e.headers, e.read()

    def json(self, method, path, body=None, headers=None):
        status, _, raw = self.request(method, path, body, headers)
        return status, json.loads(raw)

    def test_static_files(self):
        for path, kind in (("/", "text/html"), ("/index.html", "text/html"), ("/style.css", "text/css"),
                           *((f"/{n}.js", "text/javascript") for n in
                             ("main", "common", "calc", "load", "simple", "advanced", "rates", "fx")),
                           *((f"/{n}.svg", "image/svg+xml") for n in ("logo", "logo-mark", "icon"))):
            with self.subTest(path=path):
                status, headers, body = self.request("GET", path)
                self.assertEqual(status, 200)
                self.assertTrue(headers["Content-Type"].startswith(kind))
                self.assertTrue(body)

    def test_no_path_traversal(self):
        for path in ("/../storage.py", "/%2e%2e/storage.py", "/server.py", "/static/app.js"):
            with self.subTest(path=path):
                self.assertEqual(self.request("GET", path)[0], 404)

    def test_state(self):
        status, data = self.json("GET", "/api/state")
        self.assertEqual(status, 200)
        self.assertIn("settings", data)
        self.assertIn("quotes", data)

    def test_miles(self):
        self.assertEqual(self.json("GET", "/api/miles?from=60601&to=75201"),
                         (200, {"pickup": "Chicago, IL", "dropoff": "Dallas, TX",
                                "miles": 968, "source": "road"}))
        self.assertEqual(self.json("GET", "/api/miles?from=60601&to=00000")[0], 404)
        self.assertEqual(self.json("GET", "/api/miles?from=60601&to=99999")[0], 502)
        self.assertEqual(self.json("GET", "/api/miles?from=6060&to=75201")[0], 400)
        self.assertEqual(self.json("GET", "/api/miles")[0], 400)

    def test_place(self):
        self.assertEqual(self.json("GET", "/api/place?zip=60601"), (200, {"zip": "60601", "name": "Chicago, IL"}))
        self.assertEqual(self.json("GET", "/api/place?zip=00000")[0], 404)
        for bad in ("6060", "60601%0A", "%D9%A1%D9%A2%D9%A3%D9%A4%D9%A5"):  # newline, Arabic-Indic digits
            with self.subTest(bad=bad):
                self.assertEqual(self.json("GET", f"/api/place?zip={bad}")[0], 400)

    def test_home_page(self):
        status, _, body = self.request("GET", "/")
        self.assertIn(b'src="main.js"', body)

    def test_quote_round_trip(self):
        status, q = self.json("POST", "/api/quotes", {
            "pickup": "60601", "dropoff": "75201", "equipment": "van",
            "loaded": 968, "deadhead": 50, "rate": 2600})
        self.assertEqual(status, 201)
        ids = [x["id"] for x in self.json("GET", "/api/state")[1]["quotes"]]
        self.assertIn(q["id"], ids)

        status, headers, body = self.request("GET", "/api/quotes.csv")
        self.assertEqual(status, 200)
        self.assertIn("attachment", headers["Content-Disposition"])
        self.assertIn(b"60601", body)

        self.assertEqual(self.json("DELETE", f"/api/quotes/{q['id']}")[0], 200)
        self.assertEqual(self.json("DELETE", f"/api/quotes/{q['id']}")[0], 404)

    def test_quote_with_stops(self):
        base = {"pickup": "30318", "dropoff": "60601", "equipment": "van", "loaded": 1050, "deadhead": 6, "rate": 3300}
        stops = [{"zip": "37203", "kind": "pickup", "rate": 900}, {"zip": "35203", "kind": "drop", "rate": 5}]
        status, q = self.json("POST", "/api/quotes", {**base, "stops": stops})
        self.assertEqual(status, 201)
        self.assertEqual(q["stops"], [{"zip": "37203", "kind": "pickup", "rate": 900.0}, {"zip": "35203", "kind": "drop"}])
        self.json("DELETE", f"/api/quotes/{q['id']}")

        bad = [
            {"stops": "37203"},
            {"stops": [{"zip": "3720", "kind": "drop"}]},
            {"stops": [{"zip": "37203", "kind": "stop"}]},
            {"stops": [{"zip": "37203", "kind": "pickup"}]},              # a pickup needs its rate
            {"stops": [{"zip": "37203", "kind": "pickup", "rate": 3300}]},  # nothing left for the first pickup
            {"stops": [{"zip": "37203", "kind": "drop"}] * 9},
        ]
        for extra in bad:
            with self.subTest(extra=extra):
                self.assertEqual(self.json("POST", "/api/quotes", {**base, **extra})[0], 400)

    def test_quote_details_and_outcome(self):
        base = {"pickup": "60601", "dropoff": "75201", "equipment": "van", "loaded": 968, "deadhead": 50, "rate": 2600}
        status, q = self.json("POST", "/api/quotes", {**base, "broker": " Acme Logistics ", "mc": "MC# 123456",
                                                      "notes": "needs TWIC", "counter": 2900, "status": "booked",
                                                      "final_rate": 2750})
        self.assertEqual(status, 201)
        self.assertEqual((q["broker"], q["mc"], q["notes"], q["counter"], q["status"], q["final_rate"], q["extras"]),
                         ("Acme Logistics", "123456", "needs TWIC", 2900, "booked", 2750, 0))
        status, with_stopoff = self.json("POST", "/api/quotes", {**base, "extras": 150})
        self.assertEqual((status, with_stopoff["extras"]), (201, 150))
        self.json("DELETE", f"/api/quotes/{with_stopoff['id']}")

        status, q = self.json("POST", f"/api/quotes/{q['id']}", {"status": "passed", "notes": "too slow to answer"})
        self.assertEqual((status, q["status"], q["final_rate"], q["notes"]), (200, "passed", None, "too slow to answer"))
        status, q = self.json("POST", f"/api/quotes/{q['id']}", {"status": "booked", "final_rate": 2700})
        self.assertEqual((q["status"], q["final_rate"]), ("booked", 2700))
        self.assertEqual(self.json("POST", "/api/quotes/99999", {"status": "booked"})[0], 404)
        self.assertEqual(self.json("POST", f"/api/quotes/{q['id']}", {"status": "won"})[0], 400)
        self.assertEqual(self.json("POST", f"/api/quotes/{q['id']}", {"status": "booked"},
                                   headers={"Origin": "https://evil.example"})[0], 403)
        self.json("DELETE", f"/api/quotes/{q['id']}")

        bad = [
            {"status": "won"},
            {"final_rate": 2500},                              # an agreed rate needs status booked
            {"status": "booked", "final_rate": 0},
            {"counter": "lots"},
            {"broker": "x" * 81},
            {"notes": "line one\nline two"},
            {"mc": "ABC123"},
            {"mc": "123456789"},
            {"extras": -5},
        ]
        for extra in bad:
            with self.subTest(extra=extra):
                self.assertEqual(self.json("POST", "/api/quotes", {**base, **extra})[0], 400)

    def test_quote_validation(self):
        good = {"pickup": "60601", "dropoff": "75201", "equipment": "van",
                "loaded": 968, "deadhead": 0, "rate": 2600}
        bad_changes = [{"pickup": "606"}, {"equipment": "truck"}, {"loaded": 0},
                       {"loaded": "968"}, {"rate": -5}, {"deadhead": True}, {"rate": float("inf")}]
        for change in bad_changes:
            with self.subTest(change=change):
                body = json.dumps({**good, **change}).encode()  # inf isn't valid JSON, sent raw
                req = Request(self.base + "/api/quotes", data=body, method="POST",
                              headers={"Content-Type": "application/json"})
                with self.assertRaises(HTTPError) as ctx:
                    urlopen(req, timeout=5)
                self.assertEqual(ctx.exception.code, 400)
        self.assertEqual(self.request("POST", "/api/quotes", headers={})[0], 400)

    def test_settings(self):
        status, data = self.json("POST", "/api/settings", {"target": "3.25"})
        self.assertEqual((status, data["target"]), (200, "3.25"))
        self.assertEqual(self.json("POST", "/api/settings", {"hack": "1"})[0], 400)

    def test_market_endpoints(self):
        status, data = self.json("GET", "/api/market")
        self.assertEqual(status, 200)
        self.assertEqual(data["active"]["van"]["value"], 3.07)
        self.assertEqual([s["key"] for s in data["sources"]], ["dat", "diesel", "teamfile"])

        status, data = self.json("POST", "/api/market/manual", {"equipment": "reefer", "value": 3.9})
        self.assertEqual((status, data["active"]["reefer"]["source"]), (200, "manual"))
        status, data = self.json("POST", "/api/market/manual", {"equipment": "reefer", "clear": True})
        self.assertEqual(data["active"]["reefer"]["source"], "builtin")
        self.assertEqual(self.json("POST", "/api/market/manual", {"equipment": "reefer", "value": 99})[0], 400)
        self.assertEqual(self.json("POST", "/api/market/manual", {"equipment": "boat", "value": 3})[0], 400)
        self.assertEqual(self.json("POST", "/api/market/refresh")[0], 200)

    def test_rejects_foreign_origin_and_host(self):
        status, _ = self.json("POST", "/api/settings", {"target": "9"},
                              headers={"Origin": "https://evil.example"})
        self.assertEqual(status, 403)
        status, _ = self.json("GET", "/api/state", headers={"Host": "evil.example"})
        self.assertEqual(status, 403)
        same = self.base.replace("127.0.0.1", "localhost")
        status, _ = self.json("POST", "/api/settings", {"target": "3"}, headers={"Origin": same})
        self.assertEqual(status, 200)

    def test_rejects_bad_content_length_without_waiting(self):
        host, port = self.base.removeprefix("http://").split(":")
        for value in ("-1", "-5", "abc"):
            with self.subTest(content_length=value):
                # the connection stays open, so a server that tries to read the body would hang here
                conn = http.client.HTTPConnection(host, int(port), timeout=3)
                try:
                    conn.putrequest("POST", "/api/settings")
                    conn.putheader("Content-Length", value)
                    conn.endheaders()
                    resp = conn.getresponse()
                    self.assertEqual((resp.status, json.loads(resp.read())), (400, {"error": "bad Content-Length"}))
                finally:
                    conn.close()

    def test_no_road_route_is_reported_as_not_found(self):
        status, data = self.json("GET", "/api/miles?from=60601&to=96813")
        self.assertEqual((status, data), (404, {"error": "No road route between these ZIP codes"}))

    def test_beacon_with_text_plain(self):
        req = Request(self.base + "/api/hello", data=b'{"id": "abc"}', method="POST",
                      headers={"Content-Type": "text/plain;charset=UTF-8"})
        with urlopen(req, timeout=5) as resp:
            self.assertEqual(resp.status, 200)


class TruckZipSettingTest(unittest.TestCase):
    def test_truck_zip(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = Storage(Path(tmp) / "t.db")
            try:
                db.update_settings({"truck_zip": "30318"})
                db.update_settings({"truck_zip": ""})
                with self.assertRaises(ValueError):
                    db.update_settings({"truck_zip": "3031"})
            finally:
                db.close()


class LifecycleTest(unittest.TestCase):
    def test_exits_after_last_window(self):
        lc = Lifecycle(grace=4)
        lc.hello("a")
        lc.hello("b")
        lc.bye("a")
        self.assertFalse(lc.should_exit(now=10**9))
        lc.bye("b")
        t = lc._empty_since
        self.assertFalse(lc.should_exit(now=t + 3))
        self.assertTrue(lc.should_exit(now=t + 5))

    def test_reload_keeps_running(self):
        lc = Lifecycle(grace=4)
        lc.hello("old")
        lc.bye("old")
        lc.hello("new")
        self.assertFalse(lc.should_exit(now=10**9))

    def test_gives_up_if_no_window_ever_connects(self):
        lc = Lifecycle(first_connect_timeout=120)
        self.assertFalse(lc.should_exit(now=lc._started + 60))
        self.assertTrue(lc.should_exit(now=lc._started + 121))


if __name__ == "__main__":
    unittest.main()
