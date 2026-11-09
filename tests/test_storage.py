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

        # Opening again doesn't redo it or undo later edits.
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
        self.assertTrue(lines[1].endswith(",968,50,2600.00,2.55,2.69"))

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
