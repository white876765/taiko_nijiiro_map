import requests
from bs4 import BeautifulSoup
from urllib.parse import urlparse, parse_qs, urljoin
from html import unescape
from datetime import datetime, timezone, timedelta
from pathlib import Path
import math
import subprocess
import tempfile
import json
import re
import os

BASE = "https://essential-truth-92204.appspot.com/S12"

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
LATEST = DATA_DIR / "shops_latest.json"
PREV = DATA_DIR / "shops_prev.json"
USER_AGENT = "TaikoMapUpdater/1.0 (+https://github.com/white876765/taiko_nijiiro_map)"
MAX_DROP_RATIO = 0.20


def create_session():
    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})
    return session


def get_page(session, url):
    response = session.get(url, timeout=30)
    print(f"HTTP {response.status_code}: {url} ({len(response.content)} bytes)", flush=True)
    response.raise_for_status()
    return BeautifulSoup(response.content, "html.parser")


def find_baseline():
    # 空データが既に公開されていても、最後の正常なスナップショットと比較する。
    for path in (LATEST, PREV):
        shops = load_shops(path)
        if shops:
            print(f"比較元: {path} ({len(shops)} 店舗)", flush=True)
            return shops
    result = subprocess.run(
        ["git", "log", "--format=%H", "--", "data/shops_latest.json"],
        cwd=ROOT, capture_output=True, text=True, check=True,
    )
    for revision in result.stdout.splitlines():
        snapshot = subprocess.run(
            ["git", "show", f"{revision}:data/shops_latest.json"],
            cwd=ROOT, capture_output=True, check=True,
        )
        shops = json.loads(snapshot.stdout)["shops"]
        if shops:
            print(f"比較元: Git {revision} ({len(shops)} 店舗)", flush=True)
            return shops
    raise RuntimeError("正常な比較元データがありません。Git履歴またはバックアップを確認してください")


def write_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                         suffix=".tmp", delete=False) as f:
            temporary = f.name
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(temporary, path)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)


def extract_pref(address):
    if not address:
        return None
    m = re.match(r"(北海道|.{2,3}県|東京都|大阪府|京都府)", address)
    return m.group(1) if m else None

def load_shops(path):
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as f:
        return json.load(f)["shops"]

def diff_shops(prev, curr):
    prev_map = {s["id"]: s for s in prev}
    curr_map = {s["id"]: s for s in curr}

    added = []
    removed = []
    machine_changed = []

    # 追加 & 変更
    for shop_id, curr_shop in curr_map.items():
        if shop_id not in prev_map:
            added.append(curr_shop)
        else:
            prev_shop = prev_map[shop_id]
            if prev_shop.get("machines") != curr_shop.get("machines"):
                machine_changed.append({
                    "id": shop_id,
                    "name": curr_shop["name"],
                    "pref": curr_shop.get("pref"),
                    "before": prev_shop.get("machines"),
                    "after": curr_shop.get("machines")
                })

    # 削除
    for shop_id, prev_shop in prev_map.items():
        if shop_id not in curr_map:
            removed.append(prev_shop)

    return added, removed, machine_changed

def write_summary(added, removed, machine_changed):
    lines = []
    lines.append("## 太鼓の達人 設置店舗 更新結果\n")

    lines.append(f"- 追加店舗: {len(added)}")
    lines.append(f"- 削除店舗: {len(removed)}")
    lines.append(f"- 台数変更: {len(machine_changed)}\n")

    # 追加店舗
    if added:
        lines.append("### 🟢 追加店舗")
        for s in added:
            machines = s.get("machines", "?")
            pref = s.get("pref", "不明")
            lines.append(
                f"- 【{pref}】{s['name']}（{machines}台）"
            )
        lines.append("")

    # 削除店舗
    if removed:
        lines.append("### 🔴 削除店舗")
        for s in removed:
            machines = s.get("machines", "?")
            pref = s.get("pref", "不明")
            lines.append(
                f"- 【{pref}】{s['name']}（{machines}台）"
            )
        lines.append("")

    # 台数変更
    if machine_changed:
        lines.append("### 🟡 台数変更")
        for c in machine_changed:
            before = c["before"] if c["before"] is not None else "?"
            after = c["after"] if c["after"] is not None else "?"
            pref = c.get("pref", "不明")
            lines.append(
                f"- 【{pref}】{c['name']}: {before} → {after}"
            )

    summary_text = "\n".join(lines)

    with open(ROOT / "diff_summary.md", "w", encoding="utf-8") as f:
        f.write(summary_text)

    print(summary_text)

def write_diff_json(added, removed, machine_changed):
    JST = timezone(timedelta(hours=9))
    today_jst = datetime.now(JST).date().isoformat()
    diff = {
        "date": today_jst,
        "has_update": bool(added or removed or machine_changed),
        "added": added,
        "removed": removed,
        "machine_changed": machine_changed
    }


    write_json(ROOT / "diff.json", diff)

def update_history(added, removed, machine_changed):
    HISTORY = os.path.join(DATA_DIR, "updates.json")

    JST = timezone(timedelta(hours=9))
    today = datetime.now(JST).date().isoformat()

    today_diff = {
        "added": added,
        "removed": removed,
        "machine_changed": machine_changed
    }

    # 既存履歴読み込み
    if os.path.exists(HISTORY) and os.path.getsize(HISTORY) > 0:
        try:
            with open(HISTORY, encoding="utf-8") as f:
                history = json.load(f)
        except json.JSONDecodeError:
            history = {}
    else:
        history = {}

    # 今日の履歴追加
    history[today] = today_diff

    # 新しい順
    history = dict(sorted(history.items(), reverse=True))

    # 7日保持
    history = dict(list(history.items())[:7])

    write_json(HISTORY, history)

def make_shop_id(shop):
    return f"{shop['pref']}|{shop['name']}|{shop['lat']}|{shop['lng']}"


def last_changed_date(fetched_at, has_changes):
    if has_changes:
        return fetched_at[:10]
    if LATEST.exists():
        previous = json.loads(LATEST.read_text(encoding="utf-8"))
        if previous.get("shops") and previous.get("last_changed_date"):
            return previous["last_changed_date"]
    history_path = DATA_DIR / "updates.json"
    if history_path.exists():
        history = json.loads(history_path.read_text(encoding="utf-8"))
        return next((day for day in sorted(history, reverse=True)
                     if any(history[day].get(key) for key in
                            ("added", "removed", "machine_changed"))), None)
    return None

def fetch_list(session, area):
    url = f"{BASE}/list?area={area}"
    soup = get_page(session, url)
    shops = []
    seen = {}
    for dt in soup.find_all("dt"):
        a = dt.find("a", href=True)
        if not a:
            continue
        address = machines = None
        for sibling in dt.find_next_siblings():
            if sibling.name == "dt":
                break
            if sibling.name == "dd":
                if "address" in sibling.get("class", []):
                    address = sibling.get_text(strip=True)
                if "count" in sibling.get("class", []):
                    match = re.search(r"\d+", sibling.get_text())
                    machines = int(match.group()) if match else None
        name = a.get_text(strip=True)
        pref = extract_pref(address)
        if not name or not pref or machines is None or machines < 1:
            raise RuntimeError(f"店舗情報が不正です: {url} / {name}")
        shop = {
            "name": name, "address": address, "pref": pref,
            "machines": machines, "area": area,
            "detail_url": urljoin(url, a["href"]),
        }
        detail_url = shop["detail_url"]
        if detail_url in seen:
            if seen[detail_url] != shop:
                raise RuntimeError(f"同じ詳細URLに異なる店舗情報があります: {detail_url}")
            print(f"重複掲載を除外: {name} / {detail_url}", flush=True)
            continue
        seen[detail_url] = shop
        shops.append(shop)
    print(f"{area}: {len(shops)} 店舗", flush=True)
    if not shops:
        raise RuntimeError(f"店舗一覧が空です: {url}")
    return shops


def validate_counts(shops, baseline):
    if not shops:
        raise RuntimeError("取得結果が0件のため更新を中止します")
    if baseline and len(shops) <= len(baseline) * (1 - MAX_DROP_RATIO):
        raise RuntimeError(
            f"全国: 店舗数が20%以上減少 ({len(baseline)} → {len(shops)})。更新を中止します"
        )
    areas = {s["area"] for s in shops}
    for i in range(1, 48):
        area = f"JP-{i:02}"
        if area not in areas:
            raise RuntimeError(f"{area}: 店舗が0件です")


def parse_coordinates(soup):
    # 公式ページのルート検索ボタンには、地図と同じ座標が埋め込まれている。
    # JavaScriptは実行せず、決まった形式の数値のみを読み取る。
    button = soup.find(id="routesearch_btn")
    sources = []
    if button is not None:
        match = re.fullmatch(
            r"\s*routeSearch\(\s*([^,()]+)\s*,\s*([^,()]+)\s*\)\s*;?\s*",
            button.get("onclick", ""),
        )
        if not match:
            raise ValueError("ルート検索ボタンの座標形式が不正です")
        sources.append(tuple(map(float, match.groups())))
    iframe = soup.find(id="gmap")
    if iframe is not None and iframe.get("src"):
        query = parse_qs(urlparse(unescape(iframe["src"])).query)
        if "q" in query:
            sources.append(tuple(map(float, query["q"][0].split(","))))
    if not sources:
        raise ValueError("詳細ページに座標がありません")
    for coordinates in sources:
        if len(coordinates) != 2:
            raise ValueError("座標の形式が不正です")
        lat, lng = coordinates
        if not (math.isfinite(lat) and math.isfinite(lng)
                and -90 <= lat <= 90 and -180 <= lng <= 180):
            raise ValueError("座標が範囲外です")
        if coordinates != sources[0]:
            raise ValueError("ルート検索と地図の座標が一致しません")
    return sources[0]


def fetch_coordinates(session, shop):
    url = shop["detail_url"]
    try:
        soup = get_page(session, url)
        lat, lng = parse_coordinates(soup)
        shop.update(lat=lat, lng=lng)
        shop["id"] = make_shop_id(shop)
        del shop["detail_url"]
        print(f"  {shop['name']} | {shop['machines']}台 | {lat},{lng}", flush=True)
    except Exception as error:
        raise RuntimeError(f"座標取得に失敗: {shop['name']} / {url}") from error


def main():
    baseline = find_baseline()
    shops = []
    with create_session() as session:
        for i in range(1, 48):
            shops.extend(fetch_list(session, f"JP-{i:02}"))
        # 全一覧の検証を先に済ませ、異常時は詳細ページを巡回しない。
        validate_counts(shops, baseline)
        for shop in shops:
            fetch_coordinates(session, shop)
    if len({s["id"] for s in shops}) != len(shops):
        raise RuntimeError("店舗IDが重複しているため更新を中止します")
    added, removed, machine_changed = diff_shops(baseline, shops)
    # 取得・検証に成功するまでは既存ファイルに触らない。
    fetched_at = datetime.now(timezone(timedelta(hours=9))).isoformat(timespec="seconds")
    changed_date = last_changed_date(fetched_at, bool(added or removed or machine_changed))
    write_json(PREV, {"shops": baseline})
    write_json(LATEST, {"fetched_at": fetched_at, "last_changed_date": changed_date, "shops": shops})
    write_summary(added, removed, machine_changed)
    write_diff_json(added, removed, machine_changed)
    update_history(added, removed, machine_changed)
    print(f"完了: {len(shops)} 店舗", flush=True)


if __name__ == "__main__":
    main()
