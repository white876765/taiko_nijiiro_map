const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'map.js'), 'utf8');
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
      children: [], appendChild(child) { this.children.push(child); }, addEventListener() {} };
  }
  const document = {
    getElementById(id) { if (!elements.has(id)) elements.set(id, element(id)); return elements.get(id); },
    createElement() { return element(); }, querySelectorAll() { return []; }
  };
  const map = { setView() { return this; }, addLayer() {}, on() {}, fitBounds() {} };
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
      marker: (coordinates, options) => ({ coordinates, icon: options.icon, bindPopup() { return this; } }) }
  });
  vm.runInContext(source, context);
  return { elements, cluster, context,
    respond(url, value, status = 200) { pending[url]({ ok: status === 200, status, json: async () => value }); },
    ready: () => vm.runInContext('dataReady', context) };
}

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
