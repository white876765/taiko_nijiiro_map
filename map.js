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
const map = L.map("map", { zoomControl: false, maxZoom: 18 }).setView([36.5, 138], 5);

L.control.zoom({ position: "bottomright" }).addTo(map);

// ===== 現在地ボタン =====
const locateControl = L.control({ position: "bottomright" });

locateControl.onAdd = function(map) {
  const div = L.DomUtil.create("div", "leaflet-bar leaflet-control");
  div.innerHTML = `<a href="#" title="現在地" id="locateBtn" style="font-size:18px;">◎</a>`;
  div.onclick = function(e) {
    e.preventDefault();
    map.locate({ setView: false, enableHighAccuracy: true });
  };
  return div;
};
locateControl.addTo(map);

let currentMarker;
map.on("locationfound", function(e) {
  map.setView(e.latlng, 16);
  if (currentMarker) map.removeLayer(currentMarker);
  currentMarker = L.circleMarker(e.latlng, { radius: 8, color: "#007bff", fillColor: "#007bff", fillOpacity: 0.8 }).addTo(map);
});
map.on("locationerror", function() {
  alert("位置情報を取得できませんでした");
});

// ===== タイル =====
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "&copy; OpenStreetMap contributors" }).addTo(map);

// ===== クラスタ =====
const cluster = L.markerClusterGroup({ disableClusteringAtZoom: 16 });
map.addLayer(cluster);

// ===== アイコン =====
const normalIcon = new L.Icon.Default();

// ===== DOM参照 =====
const searchBox = document.getElementById("searchBox");
const prefFilter = document.getElementById("prefFilter");
const stats = document.getElementById("stats");

let hasUpdateInfo = false;
let filterOpen = false;
let historySelect = null;
let latestChangeDate = null;

// ===== フィルタ =====
function getSelectedFilters() { return [...document.querySelectorAll(".machineFilter:checked")].map(c=>c.value); }

function matchMachineFilter(m, filters) {
  if (!filters.length) return true;
  for (const f of filters) {
    if (f === "10+" && m >= 10) return true;
    if (f.includes("-")) {
      const [min, max] = f.split("-").map(Number);
      if (m >= min && m <= max) return true;
    } else if (Number(f) === m) return true;
  }
  return false;
}

// ===== マーカー描画 =====
function renderMap({ fitView = false } = {}) {
  cluster.clearLayers();
  const keyword = searchBox.value.toLowerCase();
  const pref = prefFilter.value;
  const filters = getSelectedFilters();
  let count=0, total=0, bounds=[];

  for (const shop of originalShops) {
    if (!shop.lat || !shop.lng) continue;
    if (pref !== "ALL" && shop.pref !== pref) continue;
    bounds.push([shop.lat, shop.lng]);
    if (!matchMachineFilter(shop.machines, filters)) continue;
    if (keyword && !shop.name.toLowerCase().includes(keyword)) continue;

    const marker = L.marker([shop.lat, shop.lng], { icon: normalIcon }).bindPopup(`<strong>${shop.name}</strong><br>${shop.address}<br>${shop.machines}台`);
    cluster.addLayer(marker);
    count++;
    total += shop.machines||0;
  }

  stats.textContent = `表示店舗数: ${count} / 台数合計: ${total}`;
  if (fitView) {
    if (pref === "ALL") map.setView([36.5,138],5);
    else if (bounds.length) map.fitBounds(bounds, { padding: [30,30], maxZoom:15 });
  }
}

// ===== モバイルUI =====
function isMobile() { return window.innerWidth < 768; }

function closeMobilePanels() {
  if (!isMobile()) return;
  const controls = document.getElementById("controls");
  const updateDetails = document.getElementById("updateDetails");
  if (controls) controls.style.display = "none";
  if (updateDetails) {
    updateDetails.style.display = "none";
    const toggle = document.getElementById("updateToggle");
    if (toggle) toggle.textContent = "▶ 変更内容を表示";
  }
  if (historySelect) historySelect.value = "";
  filterOpen = false;
  updateNoticeVisibility();
  enableMapInteraction();
}

function isAnyPanelOpen() {
  const controls = document.getElementById("controls");
  const updateDetails = document.getElementById("updateDetails");
  return (controls?.style.display === "block" || updateDetails?.style.display === "block");
}

function disableMapInteraction() { map.dragging.disable(); map.touchZoom.disable(); map.doubleClickZoom.disable(); map.scrollWheelZoom.disable(); map.boxZoom.disable(); map.keyboard.disable(); }
function enableMapInteraction() { map.dragging.enable(); map.touchZoom.enable(); map.doubleClickZoom.enable(); map.scrollWheelZoom.enable(); map.boxZoom.enable(); map.keyboard.enable(); }
function updateMapInteractionState() { if (!isMobile()) return; isAnyPanelOpen() ? disableMapInteraction() : enableMapInteraction(); }

// ===== 更新UI =====
function buildUpdateHTML(d) {
  const html=[];
  if (d.added?.length) { html.push("<strong>🟢追加店舗</strong><ul>"+d.added.map(s=>`<li>【${s.pref??"不明"}】${s.name}</li>`).join("")+"</ul>"); }
  if (d.removed?.length) { html.push("<strong>🔴削除店舗</strong><ul>"+d.removed.map(s=>`<li>【${s.pref??"不明"}】${s.name}</li>`).join("")+"</ul>"); }
  if (d.machine_changed?.length) { html.push("<strong>🟡台数変更</strong><ul>"+d.machine_changed.map(s=>`<li>【${s.pref??"不明"}】${s.name}：${s.before} → ${s.after}</li>`).join("")+"</ul>"); }
  return html.join("");
}

function updateNoticeVisibility() {
  const notice = document.getElementById("updateNotice");
  if(!notice) return;
  if(!hasUpdateInfo || filterOpen) notice.style.display="none";
  else notice.style.display="block";
}

// ===== モーダル =====
const modal=document.getElementById("updateModal");
const modalDetails=document.getElementById("modalDetails");

function showModal(title, htmlContent) { modalDetails.innerHTML=`<h3>${title}</h3>${htmlContent}`; modal.style.display="block"; }
function closeUpdateModal() { modal.style.display="none"; if(historySelect) historySelect.value=""; }

// ===== 取得日時・変更履歴 =====
function jstDate(date) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(date);
}

function hasChanges(update) {
  return Boolean(update?.added?.length || update?.removed?.length || update?.machine_changed?.length);
}

function renderUpdateInfo(history, fetchedAt, lastChangedDate, now = new Date()) {
  hasUpdateInfo = true;
  const fetched = fetchedAt ? new Date(fetchedAt) : null;
  const validFetched = fetched && !Number.isNaN(fetched.getTime());
  document.getElementById("lastFetched").textContent = validFetched
    ? "最終取得日時：" + new Intl.DateTimeFormat("ja-JP", {
        timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hourCycle: "h23"
      }).format(fetched) + "（日本時間）"
    : "最終取得日時：未記録（次回取得から表示）";
  document.getElementById("fetchStatus").textContent = validFetched && jstDate(fetched) !== jstDate(now)
    ? "本日はまだ取得されていません" : "";

  const dates = Object.keys(history ?? {}).sort().reverse();
  latestChangeDate = dates.find(date => hasChanges(history[date])) ?? null;
  const changedDate = lastChangedDate || latestChangeDate;
  document.getElementById("lastChanged").textContent = changedDate
    ? `最終変更日：${changedDate}`
    : history === null ? "変更履歴を読み込めませんでした"
    : "最終変更日：履歴内に変更なし";
  const summary = document.getElementById("updateSummary");
  const details = document.getElementById("updateDetails");
  const toggle = document.getElementById("updateToggle");
  const update = latestChangeDate ? history[latestChangeDate] : {};
  summary.textContent = latestChangeDate ? [
    `🟢追加 ${update.added?.length ?? 0}`,
    `🔴削除 ${update.removed?.length ?? 0}`,
    `🟡台数変更 ${update.machine_changed?.length ?? 0}`
  ].join(" / ") : "";
  details.innerHTML = buildUpdateHTML(update);
  toggle.style.display = latestChangeDate ? "inline-block" : "none";
  toggle.textContent = "▶ 変更内容を表示";

  const historyBox = document.getElementById("updateHistory");
  historyBox.innerHTML = dates.length ? "<strong>📅 更新履歴</strong><br>" : "";
  historySelect = null;
  if (dates.length) {
    historySelect = document.createElement("select");
    historySelect.style.marginTop = "4px";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "日付を選択";
    historySelect.appendChild(placeholder);
    dates.forEach(date => {
      const option = document.createElement("option");
      option.value = date;
      option.textContent = date;
      historySelect.appendChild(option);
    });
    historySelect.onchange = () => {
      const selectedDate = historySelect.value;
      if (!selectedDate || !history[selectedDate]) return;
      showModal(`${selectedDate}の変更`, buildUpdateHTML(history[selectedDate]) || "変更なし");
    };
    historyBox.appendChild(historySelect);
  }
  updateNoticeVisibility();
}

// ===== JSON 読み込み =====
async function loadJSON(url) {
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

async function loadData() {
  // 読み込み順にかかわらず、店舗と差分の両方がそろってから初回描画する。
  const [shopsResult, historyResult] = await Promise.allSettled([
    loadJSON("data/shops_latest.json"), loadJSON("data/updates.json")
  ]);
  const data = shopsResult.status === "fulfilled" ? shopsResult.value : null;
  const history = historyResult.status === "fulfilled" ? historyResult.value : null;
  renderUpdateInfo(history, data?.fetched_at, data?.last_changed_date);
  if (!data || !Array.isArray(data.shops)) {
    stats.textContent = "店舗データを読み込めませんでした";
    document.getElementById("fetchStatus").textContent = "店舗データの読み込みに失敗しました。再読み込みしてください。";
    return;
  }
  originalShops = data.shops;
  originalShops.forEach(shop => {
    if (!shop.pref && shop.address) shop.pref = shop.address.split(" ")[0];
  });
  const prefs = new Set(originalShops.map(shop => shop.pref));
  PREF_ORDER.forEach(pref => {
    if (prefs.has(pref)) {
      const option = document.createElement("option");
      option.value = pref;
      option.textContent = pref;
      prefFilter.appendChild(option);
    }
  });
  renderMap();
}

const dataReady = loadData();

// ===== イベント =====
document.querySelectorAll(".machineFilter").forEach(cb=>cb.addEventListener("change",renderMap));
searchBox.addEventListener("input",renderMap);
prefFilter.addEventListener("change",()=>renderMap({ fitView: true }));

document.getElementById("selectAll").onclick=()=>{ document.querySelectorAll(".machineFilter").forEach(c=>c.checked=true); renderMap(); };
document.getElementById("clearAll").onclick=()=>{ document.querySelectorAll(".machineFilter").forEach(c=>c.checked=false); renderMap(); };

document.getElementById("toggleControls").onclick=e=>{
  e.stopPropagation();
  const c=document.getElementById("controls");
  const open=c.style.display==="block";
  c.style.display=open?"none":"block";
  filterOpen=!open;
  updateNoticeVisibility();
  updateMapInteractionState();
};

const updateToggle=document.getElementById("updateToggle");
const closeModal=document.getElementById("closeModal");

// 「表示する」クリック
updateToggle?.addEventListener("click",e=>{ e.stopPropagation(); showModal(`${latestChangeDate}の変更`, document.getElementById("updateDetails").innerHTML); });

// モーダル閉じる
modal?.addEventListener("click", e=>{ if(e.target===modal) closeUpdateModal(); });
closeModal?.addEventListener("click", ()=>closeUpdateModal());

// 地図タップでパネル閉じ
map.on("click",()=>{ if(isMobile()) closeMobilePanels(); });
["controls","updateNotice"].forEach(id=>document.getElementById(id)?.addEventListener("click", e=>e.stopPropagation()));
