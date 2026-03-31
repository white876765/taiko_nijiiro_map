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
const addedIcon = L.icon({ iconUrl: "https://maps.gstatic.com/mapfiles/ms2/micons/green-dot.png", iconSize:[24,24], iconAnchor:[12,24], popupAnchor:[0,-20] });
const changedIcon = L.icon({ iconUrl: "https://maps.gstatic.com/mapfiles/ms2/micons/orange-dot.png", iconSize:[24,24], iconAnchor:[12,24], popupAnchor:[0,-20] });

// ===== DOM参照 =====
const searchBox = document.getElementById("searchBox");
const prefFilter = document.getElementById("prefFilter");
const stats = document.getElementById("stats");

let addedIds = new Set();
let changedIds = new Set();
let hasUpdateHistory = false;
let filterOpen = false;
let historySelect = null;

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
function renderMap() {
  cluster.clearLayers();
  const keyword = searchBox.value.toLowerCase();
  const pref = prefFilter.value;
  const filters = getSelectedFilters();
  let count=0, total=0, bounds=[];

  for (const shop of originalShops) {
    if (!shop.lat || !shop.lng) continue;
    if (pref !== "ALL" && shop.pref !== pref) continue;
    if (!matchMachineFilter(shop.machines, filters)) continue;
    if (keyword && !shop.name.toLowerCase().includes(keyword)) continue;

    let icon = normalIcon;
    if (addedIds.has(shop.id)) icon = addedIcon;
    else if (changedIds.has(shop.id)) icon = changedIcon;

    const marker = L.marker([shop.lat, shop.lng], { icon }).bindPopup(`<strong>${shop.name}</strong><br>${shop.address}<br>${shop.machines}台`);
    cluster.addLayer(marker);
    bounds.push([shop.lat, shop.lng]);
    count++;
    total += shop.machines||0;
  }

  stats.textContent = `表示店舗数: ${count} / 台数合計: ${total}`;
  if (pref !== "ALL" && bounds.length) map.fitBounds(bounds, { padding: [30,30], maxZoom:15 });
  else map.setView([36.5,138],5);
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
    if (toggle) toggle.textContent = "▶ 表示する";
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
  if(!hasUpdateHistory || filterOpen) notice.style.display="none";
  else notice.style.display="block";
}

// ===== モーダル =====
const modal=document.getElementById("updateModal");
const modalDetails=document.getElementById("modalDetails");

function showModal(title, htmlContent) { modalDetails.innerHTML=`<h3>${title}</h3>${htmlContent}`; modal.style.display="block"; }
function closeUpdateModal() { modal.style.display="none"; if(historySelect) historySelect.value=""; }

// ===== ハイライト =====
function updateHighlight(update) { addedIds=new Set((update.added??[]).map(s=>s.id)); changedIds=new Set((update.machine_changed??[]).map(s=>s.id)); renderMap(); }

// ===== JSON 読み込み =====
fetch("data/shops_latest.json").then(r=>r.json()).then(data=>{
  originalShops=data.shops;
  originalShops.forEach(s=>{if(!s.pref && s.address) s.pref=s.address.split(" ")[0];});
  const prefs=new Set(originalShops.map(s=>s.pref));
  const select=document.getElementById("prefFilter");
  PREF_ORDER.forEach(p=>{if(prefs.has(p)){ const o=document.createElement("option"); o.value=p; o.textContent=p; select.appendChild(o);}});
  renderMap();
});

fetch("data/updates.json").then(r=>r.json()).then(history=>{
  const dates=Object.keys(history).sort().reverse();
  hasUpdateHistory = dates.length>0;
  updateNoticeVisibility();

  if(!dates.length) return;

  const notice = document.getElementById("updateNotice");
  const summary = document.getElementById("updateSummary");
  const details = document.getElementById("updateDetails");
  const toggle = document.getElementById("updateToggle");
  const historyBox=document.getElementById("updateHistory");

  const latestDate = dates[0];
  const d = history[latestDate];

  const hasRealUpdate=(d.added?.length>0)||(d.removed?.length>0)||(d.machine_changed?.length>0);

  // ===== 本日の更新タイトル・サマリー =====
  if (hasRealUpdate) {
    // 本日の更新あり
    notice.querySelector("strong").textContent = "📢 本日更新あり";
    const lines = [];
    if (d.added?.length) lines.push(`🟢追加 ${d.added.length}`);
    if (d.removed?.length) lines.push(`🔴削除 ${d.removed.length}`);
    if (d.machine_changed?.length) lines.push(`🟡台数変更 ${d.machine_changed.length}`);
    summary.textContent = lines.join(" / ");
    details.innerHTML = buildUpdateHTML(d);
    toggle.style.display = "inline-block";
  } else {
    // 本日の更新なし
    notice.querySelector("strong").textContent = "本日の更新なし";
    summary.textContent = "";
    details.innerHTML = "";
    toggle.style.display = "none"; // 本日の更新ボタンは非表示
  }

// ここで notice は常に表示
notice.style.display = "block";

  // 履歴プルダウン
  historySelect=document.createElement("select");
  historySelect.style.marginTop="4px";
  const defaultOption=document.createElement("option"); defaultOption.value=""; defaultOption.textContent="日付を選択"; historySelect.appendChild(defaultOption);
  dates.slice(1,8).forEach(date=>{ const opt=document.createElement("option"); opt.value=date; opt.textContent=date; historySelect.appendChild(opt); });
  historySelect.onchange=function(){
    const selectedDate = historySelect.value;
    const data=history[selectedDate];
    const html=buildUpdateHTML(data)||"更新なし";
    showModal(`${selectedDate}の更新`,html);
    
    // 本日の日付の場合はマーカーをハイライト、過去の日付の場合はクリア
    if (selectedDate === latestDate) {
      updateHighlight(data);
    } else {
      addedIds = new Set();
      changedIds = new Set();
      renderMap();
    }
  };
  historyBox.innerHTML="<strong>📅 更新履歴</strong><br>";
  historyBox.appendChild(historySelect);

}).catch(()=>{ console.log("updates.json not found"); hasUpdateHistory=false; updateNoticeVisibility(); });

// ===== イベント =====
document.querySelectorAll(".machineFilter").forEach(cb=>cb.addEventListener("change",renderMap));
searchBox.addEventListener("input",renderMap);
prefFilter.addEventListener("change",renderMap);

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
updateToggle?.addEventListener("click",e=>{ e.stopPropagation(); showModal("本日の更新", document.getElementById("updateDetails").innerHTML); });

// モーダル閉じる
modal?.addEventListener("click", e=>{ if(e.target===modal) closeUpdateModal(); });
closeModal?.addEventListener("click", ()=>closeUpdateModal());

// 地図タップでパネル閉じ
map.on("click",()=>{ if(isMobile()) closeMobilePanels(); });
["controls","updateNotice"].forEach(id=>document.getElementById(id)?.addEventListener("click", e=>e.stopPropagation()));