import json
import tempfile
import time
import unittest
from datetime import date
from pathlib import Path

from dispatch_rpm import market
from dispatch_rpm.market import (RateUpdater, diesel_change, extract_linehaul, parse_diesel_csv,
                                 parse_market, parse_posts, resolve, resolve_equipment, set_manual)
from dispatch_rpm.storage import Storage

# Sentences below are copied from DAT's weekly reports.
FEED = b"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel><title>DAT</title>
<item>
  <title>Dry Van Report: Rates hold as load posts cool and capacity stays thin</title>
  <pubDate>Mon, 09 Nov 2026 19:32:04 +0000</pubDate>
  <content:encoded><![CDATA[
    <p>Dry van spot linehaul rates paid to carriers averaged $2.26 per mile last week, minus fuel,
    up 1.3%, or $0.03 per mile, from the week before.</p>
    <p>All rates cited are linehaul only. They exclude fuel costs and surcharges unless otherwise noted.</p>
    <p>The 10 dry van bellwether states averaged $2.99 per mile last week.</p>
    <p>Contract linehaul averaged $2.49 per mile this week against a spot rate of $2.65 per mile.</p>
    <p>Reefer spot linehaul averaged $2.80 per mile last week, minus fuel.</p>
  ]]></content:encoded>
</item>
<item>
  <title>Reefer Report: Rates firm as truck posts shrink</title>
  <pubDate>Mon, 02 Nov 2026 19:56:11 +0000</pubDate>
  <description><![CDATA[Reefer spot linehaul rates paid to carriers averaged $2.71 per mile last week, minus fuel, up 1.2%, or $0.03 per]]></description>
</item>
<item>
  <title>Flatbed Report: Capacity keeps shrinking</title>
  <pubDate>Tue, 10 Nov 2026 23:02:27 +0000</pubDate>
  <content:encoded><![CDATA[<p>Flatbed spot linehaul averaged $2.64&nbsp;per mile this week, minus fuel, up 1.1%.</p>]]></content:encoded>
</item>
</channel></rss>"""

WP_JSON = json.dumps([
    {"date": "2026-11-03T11:56:11", "link": "https://www.dat.com/blog/x",
     "title": {"rendered": "Reefer Produce Report: Produce volume slips 3%"},
     "content": {"rendered": "<p>RateView shows reefer spot linehaul rates paid to carriers averaging $2.74 per mile, minus fuel.</p>"}},
]).encode()

DIESEL = b"""observation_date,GASDESW
2026-10-19,3.700
2026-10-26,3.720
2026-11-02,3.840
2026-11-09,3.900
"""


class ParsingTest(unittest.TestCase):
    def test_extract_linehaul_only_takes_the_reports_own_equipment(self):
        van = parse_posts(FEED)[0]
        self.assertEqual(extract_linehaul(van["title"], van["html"]), {"van": 2.26})
        self.assertEqual(extract_linehaul("Flatbed Report", "<p>Flatbed spot linehaul averaged $2.64 per mile</p>"),
                         {"flatbed": 2.64})
        self.assertEqual(extract_linehaul("Reefer Report",
                                          "Reefer national spot linehaul rates paid to carriers averaged "
                                          "$2.63 per mile last week (minus fuel)"), {"reefer": 2.63})

    def test_extract_ignores_traps(self):
        traps = [
            ("Dry Van Report", "Contract linehaul averaged $2.49 per mile this week."),
            ("Dry Van Report", "The 10 dry van bellwether states averaged $2.99 per mile."),
            ("Weekly market update", "Dry van spot linehaul averaged $2.25 per mile."),  # title names no equipment
            ("Dry Van Report", "Dry van contract linehaul averaged $2.80 per mile."),
            ("Dry Van Report", "Our top 50 van lanes spot linehaul averaged $3.10 per mile."),
        ]
        for title, html in traps:
            with self.subTest(html=html):
                self.assertEqual(extract_linehaul(title, html), {})

    def test_parse_rss_and_json(self):
        posts = parse_posts(FEED)
        self.assertEqual([p["date"] for p in posts], ["2026-11-09", "2026-11-02", "2026-11-10"])
        self.assertEqual(extract_linehaul(posts[1]["title"], posts[1]["html"]), {"reefer": 2.71})
        self.assertEqual(extract_linehaul(posts[2]["title"], posts[2]["html"]), {"flatbed": 2.64})
        wp = parse_posts(WP_JSON)
        self.assertEqual(wp[0]["date"], "2026-11-03")
        self.assertEqual(extract_linehaul(wp[0]["title"], wp[0]["html"]), {"reefer": 2.74})
        for junk in (b"", b"<html>blocked</html>", b"[{}]", b"not json [", b"<rss><channel><item>"):
            self.assertEqual(parse_posts(junk), [])

    def test_parse_diesel_and_market(self):
        self.assertEqual(parse_diesel_csv(DIESEL.decode())[-1], ("2026-11-09", 3.9))
        self.assertEqual(parse_diesel_csv("DATE,GASDESW\n2026-11-02,.\n"), [])
        rows = parse_market({"updated": "2026-11-06", "van": 3.1, "reefer": 3.6, "flatbed": 3.5,
                             "linehaul": {"van": 2.25}})
        self.assertIn(("van", "linehaul", 2.25, "2026-11-06"), rows)
        self.assertIsNone(parse_market({"updated": "2026-11-06", "van": 3.1}))

    def test_repo_market_json_is_valid(self):
        data = json.loads((Path(__file__).parent.parent / "market.json").read_text())
        self.assertIsNotNone(parse_market(data))


def obs(eq, kind, value, as_of, source="builtin"):
    return {"equipment": eq, "kind": kind, "value": value, "as_of": as_of, "source": source, "note": ""}


class ResolveTest(unittest.TestCase):
    base = [obs("van", "allin", 3.07, "2026-10-30"), obs("van", "linehaul", 2.23, "2026-10-30")]
    diesel = [("2026-10-26", 3.72), ("2026-11-02", 3.84), ("2026-11-09", 3.90)]

    def test_builtin_only(self):
        r = resolve_equipment(self.base, [])
        self.assertEqual((r["value"], r["method"], r["as_of"]), (3.07, "allin", "2026-10-30"))

    def test_diesel_moves_the_fuel_part(self):
        # diesel $3.72 on Oct 26 -> $3.90 now = +18c/gal = +3c/mi
        self.assertAlmostEqual(diesel_change(self.diesel, "2026-10-30"), 0.03)
        self.assertEqual(resolve_equipment(self.base, self.diesel)["value"], 3.10)

    def test_new_dat_report_plus_calibrated_fuel(self):
        rows = self.base + [obs("van", "linehaul", 2.26, "2026-11-09", "dat")]
        r = resolve_equipment(rows, self.diesel)
        # 2.26 linehaul + (3.07 - 2.23) surcharge + 0.03 diesel
        self.assertEqual((r["method"], r["value"], r["as_of"], r["source"]), ("linehaul", 3.13, "2026-11-09", "dat"))
        self.assertAlmostEqual(r["fuel"], 0.87)

    def test_hand_typed_rate_wins_until_a_newer_report(self):
        rows = self.base + [obs("van", "linehaul", 2.26, "2026-11-05", "dat"),
                            obs("van", "allin", 3.30, "2026-11-08", "manual")]
        r = resolve_equipment(rows, self.diesel)
        self.assertEqual((r["source"], r["method"]), ("manual", "allin"))
        self.assertAlmostEqual(r["value"], 3.30 + diesel_change(self.diesel, "2026-11-08"), places=2)
        rows.append(obs("van", "linehaul", 2.30, "2026-11-12", "dat"))
        self.assertEqual(resolve_equipment(rows, self.diesel)["source"], "dat")

    def test_manual_numbers_are_not_used_for_calibration(self):
        rows = [obs("van", "allin", 3.07, "2026-10-30"), obs("van", "linehaul", 2.23, "2026-10-30"),
                obs("van", "allin", 4.00, "2026-11-02", "manual"), obs("van", "linehaul", 2.25, "2026-11-02", "dat"),
                obs("van", "linehaul", 2.26, "2026-11-09", "dat")]
        self.assertAlmostEqual(resolve_equipment(rows, [])["fuel"], 0.84)


class StoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = Storage(Path(self.tmp.name) / "t.db")

    def tearDown(self):
        self.db.close()
        self.tmp.cleanup()

    def updater(self, responses, **kw):
        calls = []

        def fetch(url, timeout):
            calls.append(url)
            value = responses.get(url, OSError("offline"))
            if isinstance(value, Exception):
                raise value
            return value
        kw.setdefault("market_url", None)
        u = RateUpdater(self.db, diesel_url="diesel", dat_urls=("feed", "wp"), fetch=fetch, **kw)
        return u, calls

    def test_full_update(self):
        u, calls = self.updater({"feed": FEED, "wp": WP_JSON, "diesel": DIESEL})
        u.run()
        status = {s["key"]: s for s in resolve(self.db)["sources"]}
        self.assertTrue(status["dat"]["ok"], status["dat"])
        self.assertTrue(status["diesel"]["ok"])
        self.assertIsNone(status["teamfile"]["ok"])
        r = resolve(self.db)["active"]
        # van: 2.26 + 0.84 + (3.90 - 3.72)/6 = 3.13
        self.assertEqual((r["van"]["value"], r["van"]["as_of"]), (3.13, "2026-11-09"))
        # reefer: newest report is the produce report on Nov 3 ($2.74)
        self.assertEqual((r["reefer"]["linehaul"], r["reefer"]["as_of"]), (2.74, "2026-11-03"))
        self.assertEqual(r["flatbed"]["linehaul"], 2.64)

        calls.clear()
        u.run()
        self.assertEqual(calls, [], "nothing is due again for 12 hours")
        u.run(force=True)
        self.assertTrue(calls)

    def test_offline_keeps_builtin_numbers(self):
        u, _ = self.updater({})
        u.run()
        m = resolve(self.db)
        self.assertEqual(m["active"]["van"]["value"], 3.07)
        self.assertFalse(m["sources"][0]["ok"])
        self.assertIn("Couldn't reach", m["sources"][0]["message"])

    def test_rejects_wild_jumps(self):
        wild = FEED.replace(b"$2.26 per mile last week", b"$3.40 per mile last week")
        u, _ = self.updater({"feed": wild, "diesel": DIESEL})
        u.run()
        m = resolve(self.db)
        self.assertNotEqual(m["auto"]["van"]["source"], "dat")
        self.assertIn("too far", m["sources"][0]["message"])

    def test_team_file(self):
        team = json.dumps({"updated": "2026-11-12", "van": 3.20, "reefer": 3.70, "flatbed": 3.65}).encode()
        u, _ = self.updater({"team": team}, market_url="team")
        u.run()
        m = resolve(self.db)
        self.assertEqual((m["active"]["van"]["value"], m["active"]["van"]["source"]), (3.20, "teamfile"))

    def test_manual_and_company(self):
        set_manual(self.db, "van", 3.33)
        self.assertEqual(resolve(self.db)["active"]["van"]["source"], "manual")
        set_manual(self.db, "van", None)
        self.assertEqual(resolve(self.db)["active"]["van"]["source"], "builtin")
        with self.assertRaises(ValueError):
            set_manual(self.db, "van", 0.2)

        self.db.update_settings({"rate_mode": "company", "company_van": "3.40",
                                 "company_date": date.today().isoformat(), "company_by": "Mira"})
        m = resolve(self.db)
        self.assertEqual((m["active"]["van"]["value"], m["active"]["van"]["source"]), (3.40, "company"))
        self.assertTrue(m["active"]["reefer"]["fallback"], "no company reefer rate -> national")
        self.assertEqual(m["company"]["by"], "Mira")

    def test_company_follows_diesel(self):
        self.db.put_diesel([("2026-10-26", 3.72), ("2026-11-09", 3.90)])
        self.db.update_settings({"rate_mode": "company", "company_van": "3.00", "company_date": "2026-10-30"})
        self.assertEqual(resolve(self.db)["active"]["van"]["value"], 3.03)
        self.db.update_settings({"company_diesel": "0"})
        self.assertEqual(resolve(self.db)["active"]["van"]["value"], 3.00)

    def test_status_timestamps(self):
        u, _ = self.updater({"feed": FEED, "diesel": DIESEL})
        before = time.time()
        u.run()
        self.assertGreaterEqual(resolve(self.db)["sources"][1]["checked"], before)


if __name__ == "__main__":
    unittest.main()
