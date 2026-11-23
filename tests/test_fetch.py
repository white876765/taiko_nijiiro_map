import copy
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

import requests
from bs4 import BeautifulSoup

from scripts import fetch


def sample_shops():
    return [dict(id=str(i), name=f"Shop {i}", address="東京都 千代田区",
                 pref="東京都", machines=2, lat=35.0, lng=139.0,
                 area=f"JP-{i:02}") for i in range(1, 48)]


class FetchTests(unittest.TestCase):
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
        self.assertEqual(fetch.diff_shops(recovered, baseline), ([], [], []))

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


if __name__ == "__main__":
    unittest.main()
