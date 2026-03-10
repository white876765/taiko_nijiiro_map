import requests
from bs4 import BeautifulSoup
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from webdriver_manager.chrome import ChromeDriverManager
from urllib.parse import urlparse, parse_qs
from html import unescape
from datetime import date
import time
import json
import re
import os
import shutil

BASE = "https://essential-truth-92204.appspot.com/S12"

options = Options()
options.add_argument("--headless=new")
options.add_argument("--no-sandbox")
options.add_argument("--disable-dev-shm-usage")
service = Service(ChromeDriverManager().install())
driver = webdriver.Chrome(options=options)

shops = []

DATA_DIR = "data"
LATEST = os.path.join(DATA_DIR, "shops_latest.json")
PREV = os.path.join(DATA_DIR, "shops_prev.json")

os.makedirs(DATA_DIR, exist_ok=True)

# 前回分を退避
if os.path.exists(LATEST):
    shutil.copy(LATEST, PREV)

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

    with open("diff_summary.md", "w", encoding="utf-8") as f:
        f.write(summary_text)

    print(summary_text)

def write_diff_json(added, removed, machine_changed):
    diff = {
        "date": date.today().isoformat(),
        "has_update": bool(added or removed or machine_changed),
        "added": added,
        "removed": removed,
        "machine_changed": machine_changed
    }


    with open("diff.json", "w", encoding="utf-8") as f:
        json.dump(diff, f, ensure_ascii=False, indent=2)

def update_history(added, removed, machine_changed):
    HISTORY = os.path.join(DATA_DIR, "updates.json")

    today = date.today().isoformat()

    today_diff = {
        "added": added,
        "removed": removed,
        "machine_changed": machine_changed
    }

    # 既存履歴読み込み
    if os.path.exists(HISTORY):
        with open(HISTORY, encoding="utf-8") as f:
            history = json.load(f)
    else:
        history = {}

    # 今日の履歴追加
    history[today] = today_diff

    # 新しい順に並べる
    history = dict(sorted(history.items(), reverse=True))

    # 7日分だけ残す
    history = dict(list(history.items())[:7])

    with open(HISTORY, "w", encoding="utf-8") as f:
        json.dump(history, f, ensure_ascii=False, indent=2)

def make_shop_id(shop):
    return f"{shop['pref']}|{shop['name']}|{shop['lat']}|{shop['lng']}"

for i in range(1, 48):
    area = f"JP-{i:02}"
    list_url = f"{BASE}/list?area={area}"
    print("取得中:", area)

    soup = BeautifulSoup(requests.get(list_url).text, "html.parser")

    for dt in soup.find_all("dt"):
        a = dt.find("a")
        if not a:
            continue

        name = a.text.strip()
        detail_url = BASE + "/" + a["href"].lstrip("./")

        address = machines = None
        for sib in dt.find_next_siblings():
            if sib.name == "dt":
                break   # 次の店舗に入ったら終了

            if sib.name == "dd":
                if "address" in sib.get("class", []):
                    address = sib.text.strip()

                if "count" in sib.get("class", []):
                    m = re.search(r"\d+", sib.text)
                    machines = int(m.group()) if m else None

        # ---- Seleniumで座標取得 ----
        lat = lng = None
        driver.get(detail_url)
        time.sleep(2)

        try:
            iframe = driver.find_element(By.ID, "gmap")
            pref = extract_pref(address)
            src = unescape(iframe.get_attribute("src"))
            qs = parse_qs(urlparse(src).query)
            lat, lng = map(float, qs["q"][0].split(","))
        except:
            pass

        shops.append({
            "id": None,  # 後で付与
            "name": name,
            "address": address,
            "pref": pref,
            "machines": machines,
            "lat": lat,
            "lng": lng,
            "area": area
        })

        print(f"  {name} | {machines}台 | {lat},{lng}")

driver.quit()

for shop in shops:
    shop["id"] = make_shop_id(shop)

with open(LATEST, "w", encoding="utf-8") as f:
    json.dump({"shops": shops}, f, ensure_ascii=False, indent=2)

print("完了:", len(shops), "店舗")

# 差分取得
prev_shops = load_shops(PREV)
curr_shops = shops

added, removed, machine_changed = diff_shops(prev_shops, curr_shops)

write_summary(added, removed, machine_changed)
write_diff_json(added, removed, machine_changed)
update_history(added, removed, machine_changed)

