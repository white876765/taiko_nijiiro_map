const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const crypto = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, '..', 'map.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
const shops = ['added', 'changed', 'normal'].map(id => ({
  id, name: id, pref: '東京都', address: '東京都 千代田区', machines: 2, lat: 35, lng: 139
}));
const empty = { added: [], removed: [], machine_changed: [] };
const history = {
  '2026-11-23': empty,
  '2026-11-22': { added: [shops[0]], removed: [], machine_changed: [{ id: 'changed', before: 1, after: 2 }] }
};

function app() {
  const elements = new Map();
  function element(id = '') {
    return { id, style: {}, value: id === 'prefFilter' ? 'ALL' : '', textContent: '', innerHTML: '',
      listeners: {}, children: [], appendChild(child) { this.children.push(child); },
      addEventListener(type, callback) { this.listeners[type] = callback; } };
  }
  const checkboxes = ['1', '2', '3', '4', '5', '6-7', '8-9', '10+'].map(value => ({
    ...element(), value, checked: false
  }));
  const document = {
    getElementById(id) {
      if (!htmlIds.has(id)) return null;
      if (!elements.has(id)) elements.set(id, element(id));
      return elements.get(id);
    },
    createElement() { return element(); },
    querySelectorAll(selector) {
      if (selector === '.machineFilter') return checkboxes;
      if (selector === '.machineFilter:checked') return checkboxes.filter(box => box.checked);
      return [];
    }
  };
  const viewChanges = [];
  const map = {
    setView(center, zoom) { viewChanges.push({ type: 'setView', center, zoom }); return this; },
    addLayer() {}, on() {},
    fitBounds(bounds, options) { viewChanges.push({ type: 'fitBounds', bounds, options }); }
  };
  const cluster = { layers: [], clearLayers() { this.layers = []; }, addLayer(layer) { this.layers.push(layer); } };
  const control = () => ({ addTo() { return this; } });
  control.zoom = control;
  const pending = {};
  const context = vm.createContext({
    document, window: { innerWidth: 1200 }, console, Intl, Date, Set,
    fetch(url, options) {
      assert.equal(options.cache, 'no-cache');
      return new Promise(resolve => { pending[url] = resolve; });
    },
    L: { map: () => map, control, markerClusterGroup: () => cluster,
      tileLayer: () => ({ addTo() {} }), Icon: { Default: function () {} }, icon: options => options,
      marker: (coordinates, options) => ({ coordinates, icon: options.icon,
        bindPopup(content) { this.popup = content; return this; } }) }
  });
  vm.runInContext(source, context);
  return { elements, cluster, context, map, viewChanges, checkboxes,
    respond(url, value, status = 200) { pending[url]({ ok: status === 200, status, json: async () => value }); },
    ready: () => vm.runInContext('dataReady', context) };
}

test('HTML requests the matching script revision instead of a cached older script', () => {
  const revision = crypto.createHash('sha256').update(source.replace(/\r\n/g, '\n')).digest('hex').slice(0, 12);
  assert.ok(html.includes(`src="map.js?v=${revision}"`));
});

for (const first of ['shops', 'history']) {
  test(`all markers stay default blue when ${first} loads first`, async () => {
    const view = app();
    const respondShops = () => view.respond('data/shops_latest.json', {
      shops, fetched_at: '2026-11-23T01:02:03+09:00', last_changed_date: '2026-11-22'
    });
    const respondHistory = () => view.respond('data/updates.json', history);
    if (first === 'shops') { respondShops(); await Promise.resolve(); respondHistory(); }
    else { respondHistory(); await Promise.resolve(); respondShops(); }
    await view.ready();
    assert.equal(view.cluster.layers.length, 3);
    const defaultIcon = vm.runInContext("normalIcon", view.context);
    assert.ok(view.cluster.layers.every(layer => layer.icon === defaultIcon));
    assert.match(view.elements.get('lastFetched').textContent, /2026\/11\/23 01:02/);
    assert.match(view.elements.get('lastChanged').textContent, /2026-11-22/);
    const select = vm.runInContext('historySelect', view.context);
    select.value = '';
    select.onchange(); // Selecting the placeholder must not throw.
    select.value = '2026-11-23';
    select.onchange();
    assert.match(view.elements.get('modalDetails').innerHTML, /変更なし/);
    assert.ok(view.cluster.layers.every(layer => layer.icon === defaultIcon));
  });
}

test('JST date boundary detects an out-of-date fetch', async () => {
  const view = app();
  view.respond('data/shops_latest.json', { shops });
  view.respond('data/updates.json', {});
  await view.ready();
  vm.runInContext(`renderUpdateInfo({}, '2026-11-22T14:59:00Z', '2026-11-01', new Date('2026-11-22T15:01:00Z'))`, view.context);
  assert.match(view.elements.get('fetchStatus').textContent, /本日はまだ取得/);
  assert.match(view.elements.get('lastChanged').textContent, /2026-11-01/);
  vm.runInContext(`renderUpdateInfo({}, '2026-11-22T15:00:00Z', null, new Date('2026-11-22T15:01:00Z'))`, view.context);
  assert.equal(view.elements.get('fetchStatus').textContent, '');
});

test('legacy data does not invent a fetch time', async () => {
  const view = app();
  view.respond('data/shops_latest.json', { shops });
  view.respond('data/updates.json', {});
  await view.ready();
  assert.match(view.elements.get('lastFetched').textContent, /未記録/);
  assert.equal(view.elements.get('updateToggle').style.display, 'none');
  assert.equal(view.cluster.layers.length, 3);
});

test('history HTTP failure still renders shops with normal markers', async () => {
  const view = app();
  view.respond('data/shops_latest.json', { shops });
  view.respond('data/updates.json', {}, 503);
  await view.ready();
  assert.equal(view.cluster.layers.length, 3);
  assert.ok(view.cluster.layers.every(layer => !layer.icon.iconUrl));
  assert.match(view.elements.get('lastChanged').textContent, /読み込めません/);
});

test('shop HTTP failure is visible instead of showing a successful update', async () => {
  const view = app();
  view.respond('data/shops_latest.json', {}, 503);
  view.respond('data/updates.json', history);
  await view.ready();
  assert.match(view.elements.get('stats').textContent, /読み込めません/);
  assert.match(view.elements.get('fetchStatus').textContent, /失敗/);
  assert.equal(view.cluster.layers.length, 0);
});

async function loadedApp() {
  const view = app();
  view.respond('data/shops_latest.json', { shops });
  view.respond('data/updates.json', history);
  await view.ready();
  view.map.setView([35.5, 139.5], 16); // Simulate a panned/zoomed or located view.
  view.viewChanges.length = 0;
  return view;
}

test('name and machine filters update results without changing the view', async () => {
  const view = await loadedApp();
  const search = view.elements.get('searchBox');
  search.value = 'added';
  search.listeners.input({ type: 'input' });
  assert.equal(view.cluster.layers.length, 1);
  view.checkboxes[0].checked = true; // No shop has only one machine.
  view.checkboxes[0].listeners.change({ type: 'change' });
  assert.equal(view.cluster.layers.length, 0);
  view.elements.get('selectAll').onclick();
  assert.equal(view.cluster.layers.length, 1);
  view.elements.get('clearAll').onclick();
  assert.equal(view.cluster.layers.length, 1);
  search.value = '';
  search.listeners.input({ type: 'input' });
  assert.equal(view.cluster.layers.length, 3);
  assert.equal(view.viewChanges.length, 0);
});

test('prefecture changes fit the region even when other filters match no shops', async () => {
  const view = await loadedApp();
  view.elements.get('searchBox').value = 'no matching name';
  const prefecture = view.elements.get('prefFilter');
  prefecture.value = '東京都';
  prefecture.listeners.change();
  assert.equal(view.cluster.layers.length, 0);
  assert.equal(view.viewChanges.length, 1);
  assert.equal(view.viewChanges[0].type, 'fitBounds');
  assert.equal(view.viewChanges[0].bounds.length, 3);
  view.viewChanges.length = 0;
  prefecture.value = 'ALL';
  prefecture.listeners.change();
  assert.equal(view.viewChanges[0].type, 'setView');
  assert.equal(view.viewChanges[0].zoom, 5);
});

test('initial data rendering preserves a view changed while data was loading', async () => {
  const view = app();
  view.map.setView([35.5, 139.5], 16);
  view.viewChanges.length = 0;
  view.respond('data/shops_latest.json', { shops });
  view.respond('data/updates.json', history);
  await view.ready();
  assert.equal(view.cluster.layers.length, 3);
  assert.equal(view.viewChanges.length, 0);
});

test('metadata-only changes appear in the summary and history with escaped values', async () => {
  const view = app();
  const update = { added: [], removed: [], machine_changed: [], shop_changed: [{
    id: 'loc-1', name: 'New <name>', pref: '東京都', changes: {
      name: { before: 'Old & name', after: 'New <name>' },
      address: { before: 'Old address', after: 'New address' },
      coordinates: { before: [35, 139], after: [36, 140] }
    }
  }] };
  view.respond('data/shops_latest.json', { shops });
  view.respond('data/updates.json', { '2026-11-23': update });
  await view.ready();
  assert.match(view.elements.get('lastChanged').textContent, /2026-11-23/);
  assert.match(view.elements.get('updateSummary').textContent, /店舗情報変更 1/);
  const content = view.elements.get('updateDetails').innerHTML;
  assert.match(content, /New &lt;name&gt;/);
  assert.match(content, /Old &amp; name/);
  assert.match(content, /住所/);
  assert.match(content, /座標：35, 139 → 36, 140/);
  assert.ok(!content.includes('New <name>'));
  const select = vm.runInContext('historySelect', view.context);
  select.value = '2026-11-23';
  select.onchange();
  assert.match(view.elements.get('modalDetails').innerHTML, /店舗情報変更/);
});

test('directions button opens the shop coordinates without preset origin or travel mode', async () => {
  const view = app();
  const shop = { ...shops[0], name: '店 <A>', address: '住所 & ビル', lat: 43.054536, lng: 141.354524 };
  view.respond('data/shops_latest.json', { shops: [shop] });
  view.respond('data/updates.json', {});
  await view.ready();
  const popup = view.cluster.layers[0].popup;
  assert.equal((popup.match(/<a\b/g) ?? []).length, 1);
  assert.match(popup, /class="shop-directions"/);
  assert.match(popup, /aria-label="経路検索（Googleマップ、新しいタブで開く）"/);
  assert.match(popup, /<svg[^>]*aria-hidden="true"/);
  assert.match(popup, /target="_blank" rel="noopener noreferrer"/);
  assert.match(popup, /店 &lt;A&gt;/);
  assert.match(popup, /住所 &amp; ビル/);
  const url = new URL(popup.match(/href="([^"]+)"/)[1].replaceAll('&amp;', '&'));
  assert.equal(url.origin, 'https://www.google.com');
  assert.equal(url.pathname, '/maps/dir/');
  assert.equal(url.searchParams.get('api'), '1');
  assert.equal(url.searchParams.get('destination'), '43.054536,141.354524');
  assert.equal(url.searchParams.has('origin'), false);
  assert.equal(url.searchParams.has('travelmode'), false);
});

test('popup links to the official store detail using loc_id and keeps machine count in the actions row', async () => {
  const view = app();
  const shop = { ...shops[0], id: 'store_123-A', loc_id: 'store_123-A' };
  view.respond('data/shops_latest.json', { shops: [shop] });
  view.respond('data/updates.json', {});
  await view.ready();
  const popup = view.cluster.layers[0].popup;
  assert.equal((popup.match(/<a\b/g) ?? []).length, 2);
  assert.match(popup, /shop-popup-actions"><span>2台<\/span>/);
  assert.match(popup, /class="shop-official"/);
  assert.match(popup, /公式の設置店舗情報 ↗/);
  const official = popup.match(/<a class="shop-official"[^>]+>/)[0];
  const url = new URL(official.match(/href="([^"]+)"/)[1]);
  assert.equal(url.origin, 'https://essential-truth-92204.appspot.com');
  assert.equal(url.pathname, '/S12/detail');
  assert.equal(url.searchParams.get('loc_id'), shop.loc_id);
  assert.match(official, /target="_blank" rel="noopener noreferrer"/);
  assert.ok(popup.indexOf('class="shop-official"') > popup.indexOf('class="shop-directions"'));
});

test('legacy or invalid loc_id does not produce a broken official link', async () => {
  for (const loc_id of [undefined, '', 'bad"><script>']) {
    const view = app();
    view.respond('data/shops_latest.json', { shops: [{ ...shops[0], loc_id }] });
    view.respond('data/updates.json', {});
    await view.ready();
    assert.ok(!view.cluster.layers[0].popup.includes('shop-official'));
    assert.match(view.cluster.layers[0].popup, /shop-directions/);
  }
});
