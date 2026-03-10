// ===== 定数 =====
const PREF_ORDER = [
  "北海道","青森県","岩手県","宮城県","秋田県","山形県","福島県",
  "茨城県","栃木県","群馬県","埼玉県","千葉県","東京都","神奈川県",
  "新潟県","富山県","石川県","福井県","山梨県","長野県",
  "岐阜県","静岡県","愛知県","三重県",
  "滋賀県","京都府","大阪府","兵庫県","奈良県","和歌山県",
  "鳥取県","島根県","岡山県","広島県","山口県",
  "徳島県","香川県","愛媛県","高知県",
  "福岡県","佐賀県","長崎県","熊本県","大分県","宮崎県","鹿児島県",
  "沖縄県"
];

let originalShops = [];

// ===== Map 初期化 =====
const map = L.map("map", { zoomControl: false }).setView([36.5, 138], 5);

L.control.zoom({ position: "bottomright" }).addTo(map);

// ===== 現在地ボタン =====
const locateControl = L.control({ position: "bottomright" });

locateControl.onAdd = function(map) {
  const div = L.DomUtil.create("div", "leaflet-bar leaflet-control");

  div.innerHTML = `
    <a href="#" title="現在地" id="locateBtn" style="font-size:18px;">◎</a>
  `;

  div.onclick = function(e) {
    e.preventDefault();

    map.locate({
      setView: false,
      enableHighAccuracy: true
    });
  };

  return div;
};

locateControl.addTo(map);

let currentMarker;

map.on("locationfound", function(e) {

  // 現在地へズーム
  map.setView(e.latlng, 16);

  if (currentMarker) {
    map.removeLayer(currentMarker);
  }

  currentMarker = L.circleMarker(e.latlng, {
    radius: 8,
    color: "#007bff",
    fillColor: "#007bff",
    fillOpacity: 0.8
  }).addTo(map);

});

map.on("locationerror", function() {
  alert("位置情報を取得できませんでした");
});

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "&copy; OpenStreetMap contributors"
}).addTo(map);

const cluster = L.markerClusterGroup({
  disableClusteringAtZoom: 16
});
map.addLayer(cluster);

const normalIcon = new L.Icon.Default();

const addedIcon = L.icon({
  iconUrl: "https://maps.gstatic.com/mapfiles/ms2/micons/green-dot.png",
  iconSize: [24, 24],
  iconAnchor: [12, 24],
  popupAnchor: [0, -20]
});

const changedIcon = L.icon({
  iconUrl: "https://maps.gstatic.com/mapfiles/ms2/micons/orange-dot.png",
  iconSize: [24, 24],
  iconAnchor: [12, 24],
  popupAnchor: [0, -20]
});

const searchBox = document.getElementById("searchBox");
const prefFilter = document.getElementById("prefFilter");
const stats = document.getElementById("stats");

let addedIds = new Set();
let changedIds = new Set();

let hasUpdateUI = false;

// ===== フィルタ系 =====
function getSelectedFilters() {
  return [...document.querySelectorAll(".machineFilter:checked")].map(c => c.value);
}

function matchMachineFilter(m, filters) {
  if (!filters.length) return true;

  for (let i = 0; i < filters.length; i++) {
    const f = filters[i];

    if (f === "10+" && m >= 10) return true;

    if (f.includes("-")) {
      const [min, max] = f.split("-").map(Number);
      if (m >= min && m <= max) return true;
    } else if (Number(f) === m) {
      return true;
    }
  }

  return false;
}

// ===== 描画 =====
function renderMap() {
  cluster.clearLayers();

  const keyword = searchBox.value.toLowerCase();
  const pref = prefFilter.value;
  const filters = getSelectedFilters();

  let count = 0;
  let total = 0;
  const bounds = [];

  for (let i = 0; i < originalShops.length; i++) {
    const shop = originalShops[i];

    if (!shop.lat || !shop.lng) continue;
    if (pref !== "ALL" && shop.pref !== pref) continue;
    if (!matchMachineFilter(shop.machines, filters)) continue;
    if (keyword && !shop.name.toLowerCase().includes(keyword)) continue;

    let icon = normalIcon;
    if (addedIds.has(shop.id)) icon = addedIcon;
    else if (changedIds.has(shop.id)) icon = changedIcon;

    const marker = L.marker([shop.lat, shop.lng], { icon })
      .bindPopup(
        `<strong>${shop.name}</strong><br>${shop.address}<br>${shop.machines}台`
      );

    cluster.addLayer(marker);
    bounds.push([shop.lat, shop.lng]);

    count++;
    total += shop.machines || 0;
  }

  stats.textContent = `表示店舗数: ${count} / 台数合計: ${total}`;

  if (pref !== "ALL" && bounds.length) {
    map.fitBounds(bounds, { padding: [30, 30], maxZoom: 15 });
  } else {
    map.setView([36.5, 138], 5);
  }
}

map.on("click", () => {
  if (!isMobile()) return;

  closeMobilePanels();
});

["controls", "updateNotice"].forEach(id => {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener("click", e => e.stopPropagation());
});

function disableMapInteraction() {
  map.dragging.disable();
  map.touchZoom.disable();
  map.doubleClickZoom.disable();
  map.scrollWheelZoom.disable();
  map.boxZoom.disable();
  map.keyboard.disable();
}

function enableMapInteraction() {
  map.dragging.enable();
  map.touchZoom.enable();
  map.doubleClickZoom.enable();
  map.scrollWheelZoom.enable();
  map.boxZoom.enable();
  map.keyboard.enable();
}

function closeMobilePanels() {
  if (!isMobile()) return;

  const controls = document.getElementById("controls");
  const updateDetails = document.getElementById("updateDetails");
  const notice = document.getElementById("updateNotice");

  if (controls) controls.style.display = "none";

  if (updateDetails) {
    updateDetails.style.display = "none";
    const toggle = document.getElementById("updateToggle");
    if (toggle) toggle.textContent = "▶ 表示する";
  }

  // ★ ここを追加
  if (notice && hasUpdateUI) notice.style.display = "block";

  enableMapInteraction();
}

function isMobile() {
  return window.innerWidth < 768;
}

function isAnyPanelOpen() {
  const controls = document.getElementById("controls");
  const updateDetails = document.getElementById("updateDetails");

  return (
    controls?.style.display === "block" ||
    updateDetails?.style.display === "block"
  );
}

function updateMapInteractionState() {
  if (!isMobile()) return;

  if (isAnyPanelOpen()) {
    disableMapInteraction();
  } else {
    enableMapInteraction();
  }
}

function buildUpdateHTML(d){

  const html = [];

  if (d.added?.length) {
    html.push("<strong>🟢追加店舗</strong><ul>");
    d.added.forEach(s=>{
      html.push(`<li>【${s.pref ?? "不明"}】${s.name}</li>`);
    });
    html.push("</ul>");
  }

  if (d.removed?.length) {
    html.push("<strong>🔴削除店舗</strong><ul>");
    d.removed.forEach(s=>{
      html.push(`<li>【${s.pref ?? "不明"}】${s.name}</li>`);
    });
    html.push("</ul>");
  }

  if (d.machine_changed?.length) {
    html.push("<strong>🟡台数変更</strong><ul>");
    d.machine_changed.forEach(s=>{
      html.push(`<li>【${s.pref ?? "不明"}】${s.name}：${s.before} → ${s.after}</li>`);
    });
    html.push("</ul>");
  }

  return html.join("");
}

// ===== イベント =====
document.querySelectorAll(".machineFilter").forEach(cb =>
  cb.addEventListener("change", renderMap)
);
document.getElementById("searchBox").addEventListener("input", renderMap);
document.getElementById("prefFilter").addEventListener("change", renderMap);

document.getElementById("selectAll").onclick = () => {
  document.querySelectorAll(".machineFilter").forEach(c => c.checked = true);
  renderMap();
};
document.getElementById("clearAll").onclick = () => {
  document.querySelectorAll(".machineFilter").forEach(c => c.checked = false);
  renderMap();
};

document.getElementById("toggleControls").onclick = e => {
  e.stopPropagation();

  const c = document.getElementById("controls");
  const notice = document.getElementById("updateNotice");
  const open = c.style.display === "block";

  c.style.display = open ? "none" : "block";

  // ★ フィルタ開いてる間は通知を隠す
  if (!open) {
    notice.style.display = "none";
  } else {
    notice.style.display = "block";
  }

  updateMapInteractionState();
};

// ===== JSON 読み込み =====
fetch("data/shops_latest.json")
  .then(r => r.json())
  .then(data => {
    originalShops = data.shops;
    originalShops.forEach(s => {
      if (!s.pref && s.address) s.pref = s.address.split(" ")[0];
    });

    const prefs = new Set(originalShops.map(s => s.pref));
    const select = document.getElementById("prefFilter");

    PREF_ORDER.forEach(p => {
      if (prefs.has(p)) {
        const o = document.createElement("option");
        o.value = p;
        o.textContent = p;
        select.appendChild(o);
      }
    });

    renderMap();
  });

fetch("data/updates.json")
  .then(r => r.json())
  .then(history => {

    const dates = Object.keys(history).sort().reverse();

    if (!dates.length) return;

    const latestDate = dates[0];
    const d = history[latestDate];

    const notice  = document.getElementById("updateNotice");
    const summary = document.getElementById("updateSummary");
    const details = document.getElementById("updateDetails");
    const historyBox = document.getElementById("updateHistory");

    // ===== 更新判定 =====
    const hasRealUpdate =
      (d.added?.length ?? 0) > 0 ||
      (d.removed?.length ?? 0) > 0 ||
      (d.machine_changed?.length ?? 0) > 0;

    if (!hasRealUpdate) {
      notice.style.display = "none";
      hasUpdateUI = false;
      return;
    }

    notice.style.display = "block";
    hasUpdateUI = true;

    // ===== 地図ハイライト用 =====
    addedIds   = new Set(d.added.map(s => s.id));
    changedIds = new Set(d.machine_changed.map(s => s.id));

    // ===== サマリー =====
    const lines = [];
    if (d.added.length) lines.push(`🟢追加 ${d.added.length}`);
    if (d.removed.length) lines.push(`🔴削除 ${d.removed.length}`);
    if (d.machine_changed.length) lines.push(`🟡台数変更 ${d.machine_changed.length}`);
    summary.textContent = lines.join(" / ");

    // ===== 今日の詳細 =====
    details.innerHTML = buildUpdateHTML(d);

    // ===== 履歴ボタン =====
    historyBox.innerHTML = "<strong>📅 更新履歴</strong><br>";

    dates.slice(0,7).forEach(date => {

      const btn = document.createElement("button");
      btn.textContent = date;
      btn.style.margin = "2px";

      btn.onclick = () => {

        const data = history[date];

        // 地図ハイライト更新
        addedIds   = new Set(data.added.map(s=>s.id));
        changedIds = new Set(data.machine_changed.map(s=>s.id));
        renderMap();

        // モーダル表示
        modalDetails.innerHTML =
          `<h3>${date}の更新</h3>` +
          buildUpdateHTML(data);

        modal.style.display = "block";

      };

      historyBox.appendChild(btn);

    });

    renderMap();

  })
  .catch(() => {
    console.log("updates.json not found");

    const notice = document.getElementById("updateNotice");
    if (notice) notice.style.display = "none";
    hasUpdateUI = false;
  });

const updateToggle = document.getElementById("updateToggle");
const updateDetails = document.getElementById("updateDetails");
const modal = document.getElementById("updateModal");
const modalDetails = document.getElementById("modalDetails");
const closeModal = document.getElementById("closeModal");

// 「表示する」クリック
updateToggle.addEventListener("click", (e) => {
  e.stopPropagation();
  modalDetails.innerHTML = updateDetails.innerHTML;
  modal.style.display = "block";
});

// 背景クリックで閉じる
modal.addEventListener("click", (e) => {
  if (e.target === modal) {
    modal.style.display = "none";
  }
});

// ×ボタンで閉じる
closeModal.addEventListener("click", () => {
  modal.style.display = "none";
});