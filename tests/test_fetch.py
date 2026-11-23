import copy
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from datetime import datetime
from unittest.mock import Mock, patch

import requests
from bs4 import BeautifulSoup

from scripts import fetch


def sample_shops():
    return [dict(id=f"loc-{i}", loc_id=f"loc-{i}", name=f"Shop {i}", address="東京都 千代田区",
                 pref="東京都", machines=2, lat=35.0, lng=139.0,
                 area=f"JP-{i:02}") for i in range(1, 48)]


def legacy_shop(shop):
    old = {key: value for key, value in shop.items() if key not in ("id", "loc_id")}
    old["id"] = f"{shop['pref']}|{shop['name']}|{shop['lat']}|{shop['lng']}"
    return old


class FetchTests(unittest.TestCase):
    def test_loc_id_does_not_depend_on_name_address_or_coordinates(self):
        shop = sample_shops()[0]
        updated = dict(shop, name="New name", address="New address", lat=36, lng=140)
        self.assertEqual(fetch.make_shop_id(shop), fetch.make_shop_id(updated))
        for loc_id in (None, "", "invalid|id", "two ids", 123):
            with self.subTest(loc_id=loc_id), self.assertRaises(ValueError):
                fetch.make_shop_id(dict(shop, loc_id=loc_id))

    def test_legacy_migration_does_not_report_all_shops_as_added_or_removed(self):
        current = sample_shops()
        previous = [legacy_shop(shop) for shop in current]
        migrated = fetch.migrate_baseline(previous + [previous[0]], current)
        self.assertEqual(len(migrated), len(current))
        self.assertEqual(fetch.diff_shops(migrated, current), ([], [], [], []))
        self.assertEqual(migrated[0]["legacy_id"], previous[0]["id"])

    def test_migration_recognizes_individual_name_address_and_coordinate_changes(self):
        shop = sample_shops()[0]
        for field, value in (("name", "New name"), ("address", "New address"), ("lat", 36.0)):
            with self.subTest(field=field):
                current = dict(shop, **{field: value})
                previous = fetch.migrate_baseline([legacy_shop(shop)], [current])
                added, removed, machines, information = fetch.diff_shops(previous, [current])
                self.assertEqual((added, removed, machines), ([], [], []))
                self.assertEqual(len(information), 1)
                self.assertIn("coordinates" if field == "lat" else field, information[0]["changes"])

    def test_same_loc_id_records_all_metadata_changes_and_machine_change(self):
        previous = sample_shops()[0]
        current = dict(previous, name="Renamed", address="New address", lat=36, lng=140, machines=3)
        added, removed, machines, information = fetch.diff_shops([previous], [current])
        self.assertEqual((added, removed), ([], []))
        self.assertEqual((machines[0]["before"], machines[0]["after"]), (2, 3))
        self.assertEqual(information[0]["changes"]["coordinates"], {"before": [35.0, 139.0], "after": [36, 140]})
        self.assertEqual(set(information[0]["changes"]), {"name", "address", "coordinates"})

    def test_ambiguous_migration_is_rejected(self):
        shop = sample_shops()[0]
        current = [dict(shop, lat=36), dict(shop, id="other", loc_id="other", lat=37)]
        with self.assertRaises(RuntimeError):
            fetch.migrate_baseline([legacy_shop(shop)], current)
        # 完全一致する旧IDがある場合は、それを優先する。
        migrated = fetch.migrate_baseline([legacy_shop(shop)], [shop, current[1]])
        self.assertEqual(migrated[0]["id"], shop["id"])

    def test_many_old_shops_cannot_claim_one_loc_id(self):
        shop = sample_shops()[0]
        previous = [legacy_shop(shop), legacy_shop(dict(shop, lat=36))]
        with self.assertRaises(RuntimeError):
            fetch.migrate_baseline(previous, [shop])

    def test_unmatched_legacy_shop_is_a_removal_and_a_different_loc_id_is_an_addition(self):
        shop = sample_shops()[0]
        current = dict(shop, id="new", loc_id="new", name="Other", address="Elsewhere", lat=38)
        previous = fetch.migrate_baseline([legacy_shop(shop)], [current])
        added, removed, machines, information = fetch.diff_shops(previous, [current])
        self.assertEqual(added, [current])
        self.assertEqual(removed[0]["id"], legacy_shop(shop)["id"])
        self.assertEqual((machines, information), ([], []))

    def test_missing_or_duplicate_loc_id_in_detail_link_is_rejected(self):
        for href in ("./detail", "./detail?loc_id=a&loc_id=b", "https://example.com/detail?loc_id=a"):
            soup = BeautifulSoup(f'<dl><dt><a href="{href}">店</a></dt>'
                                 '<dd class="address">東京都 千代田区</dd><dd class="count">1台</dd></dl>', "html.parser")
            with self.subTest(href=href), patch.object(fetch, "get_page", return_value=soup), self.assertRaises(RuntimeError):
                fetch.fetch_list(Mock(), "JP-13")
    def test_http_error_is_not_parsed_as_empty_list(self):
        session = Mock()
        session.get.return_value = requests.Response()
        session.get.return_value.status_code = 403
        session.get.return_value._content = b"<h1>Forbidden</h1>"
        with self.assertRaises(requests.HTTPError):
            fetch.fetch_list(session, "JP-13")
        session.get.assert_called_once_with(f"{fetch.BASE}/list?area=JP-13", timeout=30)

    def test_maintenance_page_is_rejected(self):
        session = Mock()
        session.get.return_value = requests.Response()
        session.get.return_value.status_code = 200
        session.get.return_value._content = b"<html>Maintenance</html>"
        with self.assertRaises(RuntimeError):
            fetch.fetch_list(session, "JP-13")

    def test_utf8_shop_list_and_relative_url(self):
        session = Mock()
        response = requests.Response()
        response.status_code = 200
        response._content = ('<meta charset="utf-8"><dl>'
                             '<dt><a href="./detail?loc_id=abc">テスト店</a></dt>'
                             '<dd class="address">東京都 千代田区</dd>'
                             '<dd class="count">3台設置</dd></dl>').encode("utf-8")
        session.get.return_value = response
        shop, = fetch.fetch_list(session, "JP-13")
        self.assertEqual((shop["name"], shop["pref"], shop["machines"]),
                         ("テスト店", "東京都", 3))
        self.assertEqual(shop["detail_url"], f"{fetch.BASE}/detail?loc_id=abc")
        self.assertEqual((shop["id"], shop["loc_id"]), ("abc", "abc"))

    def test_empty_missing_area_and_twenty_percent_drop_are_rejected(self):
        baseline = sample_shops()
        for shops in ([], baseline[:-1], baseline * 4):
            with self.subTest(count=len(shops)), self.assertRaises(RuntimeError):
                fetch.validate_counts(shops, baseline * 5 if len(shops) > 47 else baseline)
        fetch.validate_counts(baseline, baseline)

    def test_identical_source_duplicates_are_deduplicated(self):
        entry = ('<dt><a href="./detail?loc_id=abc">テスト店</a></dt>'
                 '<dd class="address">東京都 千代田区</dd>'
                 '<dd class="count">3台設置</dd>')
        soup = BeautifulSoup('<dl>' + entry * 2 + '</dl>', "html.parser")
        with patch.object(fetch, "get_page", return_value=soup):
            self.assertEqual(len(fetch.fetch_list(Mock(), "JP-13")), 1)
        conflict = BeautifulSoup('<dl>' + entry + entry.replace('3台', '4台') + '</dl>', "html.parser")
        with patch.object(fetch, "get_page", return_value=conflict):
            with self.assertRaises(RuntimeError):
                fetch.fetch_list(Mock(), "JP-13")

    def test_empty_snapshots_use_last_nonempty_git_snapshot(self):
        baseline = sample_shops()
        results = [subprocess.CompletedProcess([], 0, "empty\nnormal\n"),
                   subprocess.CompletedProcess([], 0, b'{"shops": []}'),
                   subprocess.CompletedProcess([], 0, json.dumps({"shops": baseline}).encode())]
        with patch.object(fetch, "load_shops", return_value=[]), \
                patch.object(fetch.subprocess, "run", side_effect=results):
            recovered = fetch.find_baseline()
        self.assertEqual(fetch.diff_shops(recovered, baseline), ([], [], [], []))

    def test_route_button_coordinates_and_invalid_values(self):
        for query, valid in (("35.698009,139.772416", True), ("nan,139", False),
                             ("91,139", False), ("invalid", False),
                             ("35,139); malicious()", False)):
            with self.subTest(query=query):
                soup = BeautifulSoup(
                    f'<button id="routesearch_btn" onclick="routeSearch({query})"></button>',
                    "html.parser",
                )
                if valid:
                    self.assertEqual(fetch.parse_coordinates(soup), (35.698009, 139.772416))
                else:
                    with self.assertRaises(ValueError):
                        fetch.parse_coordinates(soup)

    def test_iframe_fallback_and_conflicting_coordinates(self):
        iframe = '<iframe id="gmap" src="https://www.google.com/maps?q=35,139&amp;zoom=16"></iframe>'
        self.assertEqual(fetch.parse_coordinates(BeautifulSoup(iframe, "html.parser")), (35, 139))
        button = '<button id="routesearch_btn" onclick="routeSearch(36,139)"></button>'
        with self.assertRaises(ValueError):
            fetch.parse_coordinates(BeautifulSoup(button + iframe, "html.parser"))
        with self.assertRaises(ValueError):
            fetch.parse_coordinates(BeautifulSoup('<iframe id="gmap" src=""></iframe>', "html.parser"))

    def test_coordinate_failure_does_not_mutate_shop(self):
        shop = dict(sample_shops()[0], detail_url=f"{fetch.BASE}/detail?loc_id=abc")
        original = shop.copy()
        with patch.object(fetch, "get_page", return_value=BeautifulSoup("Maintenance", "html.parser")):
            with self.assertRaises(RuntimeError):
                fetch.fetch_coordinates(Mock(), shop)
        self.assertEqual(shop, original)

    def run_in_temp(self, coordinate_error=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data = root / "data"
            data.mkdir()
            paths = [data / "shops_latest.json", data / "shops_prev.json",
                     data / "updates.json", root / "diff.json", root / "diff_summary.md"]
            for path in paths:
                path.write_text('{"shops": []}', encoding="utf-8")
            original = {p: p.read_bytes() for p in paths}
            baseline = sample_shops()
            with patch.multiple(fetch, ROOT=root, DATA_DIR=data, LATEST=paths[0], PREV=paths[1]), \
                    patch.object(fetch, "find_baseline", return_value=baseline), \
                    patch.object(fetch, "create_session"), \
                    patch.object(fetch, "fetch_list") as listing, \
                    patch.object(fetch, "fetch_coordinates") as coordinates:
                if coordinate_error:
                    listing.side_effect = lambda session, area: [copy.deepcopy(baseline[int(area[-2:]) - 1])]
                    coordinates.side_effect = RuntimeError("Coordinates failed")
                else:
                    listing.side_effect = requests.HTTPError("403")
                with self.assertRaises((RuntimeError, requests.HTTPError)):
                    fetch.main()
                self.assertEqual({p: p.read_bytes() for p in paths}, original)

    def test_http_failure_preserves_all_output_files(self):
        self.run_in_temp()

    def test_coordinate_failure_preserves_all_output_files(self):
        self.run_in_temp(coordinate_error=True)

    def test_success_restores_empty_latest_without_mass_additions(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data = root / "data"
            data.mkdir()
            latest, previous = data / "shops_latest.json", data / "shops_prev.json"
            latest.write_text('{"shops": []}', encoding="utf-8")
            baseline = sample_shops()
            with patch.multiple(fetch, ROOT=root, DATA_DIR=data, LATEST=latest, PREV=previous), \
                    patch.object(fetch, "find_baseline", return_value=baseline), \
                    patch.object(fetch, "create_session"), \
                    patch.object(fetch, "fetch_coordinates"), \
                    patch.object(fetch, "fetch_list", side_effect=lambda session, area:
                                 [copy.deepcopy(baseline[int(area[-2:]) - 1])]):
                fetch.main()
            self.assertEqual(fetch.load_shops(latest), baseline)
            self.assertEqual(fetch.load_shops(previous), baseline)
            self.assertFalse(json.loads((root / "diff.json").read_text(encoding="utf-8"))["has_update"])
            metadata = json.loads(latest.read_text(encoding="utf-8"))
            self.assertEqual(datetime.fromisoformat(metadata["fetched_at"]).utcoffset().total_seconds(), 9 * 3600)

    def test_last_change_date_survives_history_retention(self):
        with tempfile.TemporaryDirectory() as directory:
            data = Path(directory)
            latest = data / "shops_latest.json"
            latest.write_text(json.dumps({"shops": sample_shops(), "last_changed_date": "2026-10-01"}), encoding="utf-8")
            (data / "updates.json").write_text('{"2026-11-23": {"added": []}}', encoding="utf-8")
            with patch.multiple(fetch, DATA_DIR=data, LATEST=latest):
                self.assertEqual(fetch.last_changed_date("2026-11-23T12:00:00+09:00", False), "2026-10-01")
                self.assertEqual(fetch.last_changed_date("2026-11-23T12:00:00+09:00", True), "2026-11-23")

    def test_main_migrates_legacy_data_without_false_changes_and_keeps_history(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data = root / "data"
            data.mkdir()
            latest, previous = data / "shops_latest.json", data / "shops_prev.json"
            current = sample_shops()
            legacy = [legacy_shop(shop) for shop in current]
            latest.write_text(json.dumps({"shops": legacy}), encoding="utf-8")
            old_history = {"added": [legacy[0]], "removed": [], "machine_changed": []}
            (data / "updates.json").write_text(json.dumps({"2020-01-01": old_history}), encoding="utf-8")
            with patch.multiple(fetch, ROOT=root, DATA_DIR=data, LATEST=latest, PREV=previous), \
                    patch.object(fetch, "create_session"), patch.object(fetch, "fetch_coordinates"), \
                    patch.object(fetch, "fetch_list", side_effect=lambda session, area:
                                 [copy.deepcopy(current[int(area[-2:]) - 1])]):
                fetch.main()
            saved = json.loads(latest.read_text(encoding="utf-8"))
            self.assertEqual(saved["shops"], current)
            self.assertEqual(saved["last_changed_date"], "2020-01-01")
            migrated = fetch.load_shops(previous)
            self.assertEqual(migrated[0]["id"], current[0]["loc_id"])
            self.assertEqual(migrated[0]["legacy_id"], legacy[0]["id"])
            self.assertFalse(json.loads((root / "diff.json").read_text(encoding="utf-8"))["has_update"])
            history = json.loads((data / "updates.json").read_text(encoding="utf-8"))
            self.assertEqual(history["2020-01-01"], old_history)
            self.assertEqual(history[saved["fetched_at"][:10]]["shop_changed"], [])

    def test_metadata_only_change_updates_diff_history_and_last_change_date(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data = root / "data"
            data.mkdir()
            latest, previous = data / "shops_latest.json", data / "shops_prev.json"
            baseline = sample_shops()
            latest.write_text(json.dumps({"shops": baseline}), encoding="utf-8")
            current = copy.deepcopy(baseline)
            current[0]["name"] = "Renamed"
            with patch.multiple(fetch, ROOT=root, DATA_DIR=data, LATEST=latest, PREV=previous), \
                    patch.object(fetch, "create_session"), patch.object(fetch, "fetch_coordinates"), \
                    patch.object(fetch, "fetch_list", side_effect=lambda session, area:
                                 [copy.deepcopy(current[int(area[-2:]) - 1])]):
                fetch.main()
            saved = json.loads(latest.read_text(encoding="utf-8"))
            diff = json.loads((root / "diff.json").read_text(encoding="utf-8"))
            self.assertTrue(diff["has_update"])
            self.assertEqual((diff["added"], diff["removed"], diff["machine_changed"]), ([], [], []))
            self.assertEqual(diff["shop_changed"][0]["changes"]["name"], {"before": "Shop 1", "after": "Renamed"})
            self.assertEqual(saved["last_changed_date"], saved["fetched_at"][:10])
            history = json.loads((data / "updates.json").read_text(encoding="utf-8"))
            self.assertEqual(history[saved["last_changed_date"]]["shop_changed"], diff["shop_changed"])
            self.assertIn("Renamed", (root / "diff_summary.md").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
