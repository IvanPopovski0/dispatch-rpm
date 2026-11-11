import sqlite3
import tempfile
import unittest
from pathlib import Path

from dispatch_rpm.storage import DEFAULT_SETTINGS, Storage


class StorageTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = Storage(Path(self.tmp.name) / "nested" / "test.db")

    def tearDown(self):
        self.db.close()
        self.tmp.cleanup()

    def test_defaults_and_updates(self):
        self.assertEqual(self.db.settings(), DEFAULT_SETTINGS)
        updated = self.db.update_settings({"target": "3.10", "equipment": "reefer"})
        self.assertEqual(updated["target"], "3.10")
        self.assertEqual(updated["equipment"], "reefer")
        self.assertEqual(updated["floor"], DEFAULT_SETTINGS["floor"])
        self.db.update_settings({"target": "3.20"})
        self.assertEqual(self.db.settings()["target"], "3.20")

    def test_rejects_bad_settings(self):
        for bad in ({"nope": "1"}, {"target": 3}, {"equipment": "boxtruck"}, {"target": "x" * 100}):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                self.db.update_settings(bad)
        self.assertEqual(self.db.settings(), DEFAULT_SETTINGS)

    def test_cost_settings(self):
        self.db.update_settings({"mpg": "6.5", "cost_per_mile": "1.85", "fuel_price": "", "cost_includes_fuel": "1"})
        self.assertEqual(self.db.settings()["mpg"], "6.5")
        for bad in ({"mpg": "0"}, {"mpg": "six"}, {"cost_per_mile": "-1"}, {"fuel_price": "40"},
                    {"cost_includes_fuel": "yes"}):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                self.db.update_settings(bad)

    def test_new_setting_rules(self):
        self.db.update_settings({"ui_mode": "advanced", "rate_mode": "company", "company_van": "3.25",
                                 "company_van_date": "2026-11-09", "company_by": "Mira", "effects": "off"})
        for bad in ({"ui_mode": "expert"}, {"company_van": "abc"}, {"company_van": "0.1"},
                    {"company_reefer_date": "Nov 9"}, {"company_date": "2026-11-09"}, {"rate_mode": "x"}):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                self.db.update_settings(bad)
        self.db.update_settings({"company_van": ""})  # clearing is fine

    def test_builtin_rates_seeded_once(self):
        rows = [o for o in self.db.observations() if o["source"] == "builtin"]
        self.assertEqual(len(rows), 6)
        self.db.close()
        self.db = Storage(Path(self.tmp.name) / "nested" / "test.db")
        self.assertEqual(len([o for o in self.db.observations() if o["source"] == "builtin"]), 6)

    def test_migrates_old_market_settings(self):
        path = Path(self.tmp.name) / "old.db"
        con = sqlite3.connect(path)
        con.execute("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        con.executemany("INSERT INTO settings VALUES (?, ?)", [
            ("market_date", "2026-11-13"), ("market_van", "3.15"), ("market_reefer", "3.70"),
            ("market_flatbed", "3.60"), ("fuel_adjust", "0.02"), ("target", "2.80")])
        con.commit()
        con.close()
        db = Storage(path)
        try:
            manual = [o for o in db.observations() if o["source"] == "manual"]
            self.assertEqual(sorted((o["equipment"], o["value"]) for o in manual),
                             [("flatbed", 3.6), ("reefer", 3.7), ("van", 3.15)])
            self.assertEqual(db.settings()["target"], "2.80")
        finally:
            db.close()

    def old_company_db(self, rows):
        """A settings table as 2.1 left it, with one company_date for every company rate."""
        path = Path(self.tmp.name) / "company.db"
        con = sqlite3.connect(path)
        con.execute("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        con.executemany("INSERT INTO settings VALUES (?, ?)", rows)
        con.commit()
        con.close()
        return path

    def test_migrates_shared_company_date_to_each_saved_rate(self):
        path = self.old_company_db([
            ("rate_mode", "company"), ("company_van", "3.00"), ("company_reefer", "3.60"),
            ("company_flatbed", ""), ("company_by", "Mira"), ("company_date", "2026-10-30")])
        db = Storage(path)
        try:
            s = db.settings()
            self.assertEqual((s["company_van"], s["company_reefer"], s["company_flatbed"]), ("3.00", "3.60", ""))
            self.assertEqual((s["company_van_date"], s["company_reefer_date"], s["company_flatbed_date"]),
                             ("2026-10-30", "2026-10-30", ""))
            self.assertNotIn("company_date", s)
            db.update_settings({"company_reefer": "3.70", "company_reefer_date": "2026-11-09"})
        finally:
            db.close()

        # opening again doesn't redo it or undo later edits
        db = Storage(path)
        try:
            s = db.settings()
            self.assertEqual((s["company_van_date"], s["company_reefer_date"]), ("2026-10-30", "2026-11-09"))
            self.assertEqual(s["company_reefer"], "3.70")
        finally:
            db.close()

    def test_migration_keeps_per_type_dates_already_there(self):
        path = self.old_company_db([("company_van", "3.00"), ("company_date", "2026-10-30"),
                                    ("company_van_date", "2026-11-02")])
        db = Storage(path)
        try:
            self.assertEqual(db.settings()["company_van_date"], "2026-11-02")
        finally:
            db.close()

    def test_migration_without_a_shared_date(self):
        path = self.old_company_db([("company_van", "3.00"), ("company_date", "")])
        db = Storage(path)
        try:
            self.assertEqual(db.settings()["company_van_date"], "")
            self.assertEqual(db.settings()["company_van"], "3.00")
        finally:
            db.close()

    def test_quotes_newest_first_with_city_names(self):
        self.db.put_zip("60601", 41.88, -87.62, "Chicago, IL")
        first = self.db.add_quote("60601", "75201", "van", 968, 50, 2600)
        second = self.db.add_quote("30301", "33101", "reefer", 660, 0, 2100)
        self.assertEqual(first["pickup_name"], "Chicago, IL")
        self.assertIsNone(first["dropoff_name"])
        self.assertEqual([q["id"] for q in self.db.quotes()], [second["id"], first["id"]])

    def test_delete(self):
        q = self.db.add_quote("60601", "75201", "van", 968, 50, 2600)
        self.assertTrue(self.db.delete_quote(q["id"]))
        self.assertFalse(self.db.delete_quote(q["id"]))
        self.assertEqual(self.db.quotes(), [])

    def test_csv(self):
        self.db.add_quote("60601", "75201", "van", 968, 50, 2600)
        lines = self.db.quotes_csv().splitlines()
        self.assertEqual(len(lines), 2)
        self.assertTrue(lines[0].startswith("date,pickup,"))
        self.assertTrue(lines[0].endswith(",stops,status,final_rate,counter,broker,mc,notes"))
        self.assertTrue(lines[1].endswith(",968,50,2600.00,2.55,2.69,,quoted,,,,,"))

    def test_quote_with_stops(self):
        stops = [{"zip": "37203", "kind": "pickup", "rate": 900.0}, {"zip": "35203", "kind": "drop"}]
        q = self.db.add_quote("30318", "60601", "van", 1050, 6, 3300, stops)
        self.assertEqual(q["stops"], stops)
        self.assertEqual(self.db.quotes()[0]["stops"], stops)
        self.assertIn(',37203 pickup 900.00; 35203 drop,', self.db.quotes_csv().splitlines()[1])

    def test_quote_details_and_outcome(self):
        q = self.db.add_quote("60601", "75201", "van", 968, 50, 2600, counter=2900, broker="Acme Logistics",
                              mc="123456", notes="needs TWIC")
        self.assertEqual((q["status"], q["final_rate"], q["counter"], q["broker"], q["mc"], q["notes"], q["extras"]),
                         ("quoted", None, 2900, "Acme Logistics", "123456", "needs TWIC", 0))
        q = self.db.update_quote(q["id"], "booked", 2800, "needs TWIC")
        self.assertEqual((q["status"], q["final_rate"]), ("booked", 2800))
        q = self.db.update_quote(q["id"], "passed", 2800, "")
        self.assertEqual((q["status"], q["final_rate"], q["notes"]), ("passed", None, ""),
                         "an agreed rate only stays on a booked quote")
        self.assertIsNone(self.db.update_quote(999, "booked", None, ""))
        with self.assertRaises(ValueError):
            self.db.update_quote(q["id"], "won", None, "")
        with self.assertRaises(ValueError):
            self.db.add_quote("60601", "75201", "van", 968, 50, 2600, owner="me")

    def test_csv_text_cannot_run_as_a_formula(self):
        self.db.add_quote("60601", "75201", "van", 968, 50, 2600, broker='=HYPERLINK("http://x")',
                          notes="+1 call back", status="booked", final_rate=2650)
        row = self.db.quotes_csv().splitlines()[1]
        self.assertIn(""",booked,2650.00,,"'=HYPERLINK(""http://x"")",,'+1 call back""", row)

    def test_adds_stops_to_quotes_saved_before_2_4(self):
        path = Path(self.tmp.name) / "quotes.db"
        con = sqlite3.connect(path)
        con.execute("CREATE TABLE quotes (id INTEGER PRIMARY KEY, created REAL NOT NULL, pickup TEXT NOT NULL, "
                    "dropoff TEXT NOT NULL, equipment TEXT NOT NULL, loaded REAL NOT NULL, "
                    "deadhead REAL NOT NULL, rate REAL NOT NULL)")
        con.execute("INSERT INTO quotes VALUES (1, 1.0, '60601', '75201', 'van', 968, 50, 2600)")
        con.commit()
        con.close()
        db = Storage(path)
        try:
            self.assertEqual([(q["id"], q["rate"], q["stops"], q["status"], q["final_rate"], q["broker"])
                              for q in db.quotes()], [(1, 2600, [], "quoted", None, "")])
        finally:
            db.close()
        db = Storage(path)  # opening again leaves it alone
        try:
            self.assertEqual(len(db.quotes()), 1)
        finally:
            db.close()

    def test_caches(self):
        self.assertIsNone(self.db.get_zip("60601"))
        self.db.put_zip("60601", 41.88, -87.62, "Chicago, IL")
        self.assertEqual(self.db.get_zip("60601")["name"], "Chicago, IL")
        self.assertIsNone(self.db.get_route("60601", "75201"))
        self.db.put_route("60601", "75201", 967.9)
        self.assertEqual(self.db.get_route("60601", "75201"), 967.9)
        self.assertIsNone(self.db.get_route("75201", "60601"))


if __name__ == "__main__":
    unittest.main()
