// Background service worker: the single owner of all state.
//
// State is split in two:
//   layout  - spaces, pinned trees, folders, favorites, settings. Synced to every
//             computer through chrome.storage.sync (gzipped + chunked).
//   runtime - this computer only: which Chrome tab belongs to which space, which
//             pinned/favorite entry is currently open in which tab, unpinned tabs,
//             tab groups, archived tabs.
//
// Every change goes through mutate(), which serializes work so Chrome events and
// side-panel requests never interleave. The side panel only reads storage and
// sends messages; it never writes state itself.

import { uid, findNode, removeNode, walk, normalizeLayout, sameUrl } from './shared.js';

// Storage keys keep the old "vtabs" name: renaming them would orphan existing synced layouts.
const META_KEY = 'vtabs_meta';
const CHUNK_PREFIX = 'vtabs_c';
const CHUNK_SIZE = 7000;          // chrome.storage.sync allows 8192 bytes per item
const RECONCILE_MS = 60_000;      // after a browser restart, re-match restored tabs for this long
const ARCHIVE_LIMIT = 200;

let cache = null;
let lastLayoutKey = '';
let reconcileUntil = 0;
let queue = Promise.resolve();
const recentlyRemoved = new Map(); // tabId -> time removed

// ---------------------------------------------------------------------------
// State plumbing

function mutate(fn) {
  const run = queue.then(async () => {
    const s = await load();
    const result = await fn(s);
    await persist(s);
    return result;
  });
  queue = run.catch(err => console.error('[sidecar]', err));
  return run;
}

function normalizeRuntime(r = {}) {
  return {
    bindings: r.bindings || {},          // entryId -> { tabId, url, lastActive }
    tabs: Array.isArray(r.tabs) ? r.tabs : [], // unpinned tab records, in display order
    windowSpace: r.windowSpace || {},    // windowId -> spaceId
    groups: r.groups || {},              // "windowId:spaceId" -> tab group id
    activeTab: r.activeTab || {},        // windowId -> active tab id
    archived: Array.isArray(r.archived) ? r.archived : [],
    stale: Array.isArray(r.stale) ? r.stale : [], // bindings waiting to be re-matched after restart
    lastSpaceId: r.lastSpaceId || null,
    sync: r.sync || { status: 'pending', at: 0, error: '', bytes: 0 },
  };
}

function layoutKey(layout) {
  return JSON.stringify({ ...layout, rev: 0 });
}

async function load() {
  if (cache) return cache;
  const got = await chrome.storage.local.get(['layout', 'runtime']);
  const s = { layout: normalizeLayout(got.layout), runtime: normalizeRuntime(got.runtime) };
  let remote = null;
  try {
    remote = await readSyncLayout();
  } catch (e) {
    console.warn('[sidecar] could not read synced layout', e);
  }
  if (remote && remote.rev > s.layout.rev) s.layout = normalizeLayout(remote);
  else if (!got.layout && !remote) s.layout.rev = 1;
  lastLayoutKey = layoutKey(s.layout);

  // storage.session is cleared when the browser restarts or the extension reloads,
  // which is exactly when tab ids may have changed.
  const { sessionReady } = await chrome.storage.session.get('sessionReady');
  if (!sessionReady) {
    await reconcileSession(s);
    reconcileUntil = Date.now() + RECONCILE_MS;
    await chrome.storage.session.set({ sessionReady: true });
  }
  pruneRuntime(s);
  cache = s;
  if (!remote || remote.rev < s.layout.rev) schedulePush();
  ensureAlarm();
  scheduleAllGroups();
  return s;
}

async function persist(s) {
  const key = layoutKey(s.layout);
  if (key !== lastLayoutKey) {
    s.layout.rev = Date.now();
    lastLayoutKey = key;
    schedulePush();
  }
  await chrome.storage.local.set({ layout: s.layout, runtime: s.runtime });
}

// ---------------------------------------------------------------------------
// Lookups

const tabUrl = t => t.url || t.pendingUrl || '';
const spaceById = (s, id) => s.layout.spaces.find(sp => sp.id === id);

function getWindowSpace(s, windowId) {
  const rt = s.runtime;
  const id = rt.windowSpace[windowId];
  if (id && spaceById(s, id)) return id;
  const fallback = spaceById(s, rt.lastSpaceId) ? rt.lastSpaceId : s.layout.spaces[0].id;
  if (windowId != null && windowId >= 0) rt.windowSpace[windowId] = fallback;
  return fallback;
}

function findInSpaces(s, id) {
  for (const sp of s.layout.spaces) {
    const f = findNode(sp.pinned, id);
    if (f) return { ...f, spaceId: sp.id };
  }
  return null;
}

// Pinned entry or favorite. spaceId is null for favorites.
function findEntry(s, id) {
  const fav = s.layout.favorites.find(f => f.id === id);
  if (fav) return { entry: fav, spaceId: null };
  const f = findInSpaces(s, id);
  if (f && f.node.type === 'tab') return { entry: f.node, spaceId: f.spaceId };
  return null;
}

function entryIdForTab(s, tabId) {
  for (const [id, b] of Object.entries(s.runtime.bindings)) if (b.tabId === tabId) return id;
  return null;
}

const recordForTab = (s, tabId) => s.runtime.tabs.find(r => r.tabId === tabId);

// spaceId for space tabs, null for favorites, undefined for unknown tabs.
function spaceOfTab(s, tabId) {
  const rec = recordForTab(s, tabId);
  if (rec) return rec.spaceId;
  const eid = entryIdForTab(s, tabId);
  if (eid) {
    const e = findEntry(s, eid);
    return e ? e.spaceId : undefined;
  }
  return undefined;
}

function lastActiveOf(s, tabId) {
  const rec = recordForTab(s, tabId);
  if (rec) return rec.lastActive || 0;
  const eid = entryIdForTab(s, tabId);
  return eid ? s.runtime.bindings[eid].lastActive || 0 : 0;
}

function entryIdsInSpace(space) {
  const ids = [];
  walk(space.pinned, n => { if (n.type === 'tab') ids.push(n.id); });
  return ids;
}

async function bestTabInSpace(s, windowId, spaceId, exclude) {
  const tabs = await chrome.tabs.query({ windowId }).catch(() => []);
  let best = null, bestTime = -1;
  for (const t of tabs) {
    if (exclude && exclude.has(t.id)) continue;
    if (spaceOfTab(s, t.id) !== spaceId) continue;
    const la = lastActiveOf(s, t.id);
    if (la > bestTime) { best = t.id; bestTime = la; }
  }
  return best;
}

async function tabExists(tabId) {
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Records (unpinned tabs)

function newRecord(tab, spaceId) {
  return {
    id: uid(),
    tabId: tab ? tab.id : null,
    spaceId,
    url: tab ? tabUrl(tab) : '',
    title: tab ? tab.title || '' : '',
    customTitle: '',
    lastActive: Date.now(),
  };
}

function insertRecordAt(s, rec, refId, position) {
  const list = s.runtime.tabs;
  const idx = refId ? list.findIndex(r => r.id === refId) : -1;
  if (idx >= 0) list.splice(position === 'after' ? idx + 1 : idx, 0, rec);
  else if (position === 'end') list.push(rec);
  else list.unshift(rec);
}

function removeRecord(s, id) {
  const i = s.runtime.tabs.findIndex(r => r.id === id);
  return i >= 0 ? s.runtime.tabs.splice(i, 1)[0] : null;
}

// After a restart, restored tabs get new ids. Match them back up by URL.
function tryClaim(s, tab, freshRec = null) {
  const url = tabUrl(tab);
  if (!url || url.startsWith('chrome://newtab')) return false;
  const rt = s.runtime;
  const si = rt.stale.findIndex(b => sameUrl(b.url, url) && findEntry(s, b.entryId) && !rt.bindings[b.entryId]);
  if (si >= 0) {
    const b = rt.stale.splice(si, 1)[0];
    rt.bindings[b.entryId] = { tabId: tab.id, url, lastActive: Date.now() };
    if (freshRec) removeRecord(s, freshRec.id);
    return true;
  }
  const rec = rt.tabs.find(r => r.tabId == null && r !== freshRec && sameUrl(r.url, url));
  if (rec) {
    rec.tabId = tab.id;
    rec.title = tab.title || rec.title;
    if (freshRec) removeRecord(s, freshRec.id);
    return true;
  }
  return false;
}

async function reconcileSession(s) {
  const rt = s.runtime;
  const tabs = await chrome.tabs.query({});
  const byId = new Map(tabs.map(t => [t.id, t]));
  const claimed = new Set();
  rt.stale = [];
  for (const [entryId, b] of Object.entries(rt.bindings)) {
    const t = byId.get(b.tabId);
    if (t && !claimed.has(t.id) && sameUrl(tabUrl(t), b.url)) claimed.add(t.id);
    else {
      delete rt.bindings[entryId];
      rt.stale.push({ entryId, url: b.url });
    }
  }
  for (const r of rt.tabs) {
    const t = r.tabId != null ? byId.get(r.tabId) : null;
    if (t && !claimed.has(t.id) && sameUrl(tabUrl(t), r.url)) claimed.add(t.id);
    else r.tabId = null;
  }
  const windows = new Set(tabs.map(t => t.windowId));
  for (const w of Object.keys(rt.windowSpace)) if (!windows.has(+w)) delete rt.windowSpace[w];
  for (const [key, gid] of Object.entries(rt.groups)) {
    const g = await chrome.tabGroups.get(gid).catch(() => null);
    if (!g) delete rt.groups[key];
  }
  for (const t of tabs) {
    if (claimed.has(t.id) || tryClaim(s, t)) continue;
    insertRecordAt(s, newRecord(t, getWindowSpace(s, t.windowId)), null, 'end');
  }
}

// Fix up anything that points at spaces or entries that no longer exist
// (e.g. after another computer deleted them).
function pruneRuntime(s) {
  const rt = s.runtime;
  const first = s.layout.spaces[0].id;
  for (const [entryId, b] of Object.entries(rt.bindings)) {
    if (findEntry(s, entryId)) continue;
    delete rt.bindings[entryId];
    const rec = newRecord(null, spaceById(s, rt.lastSpaceId) ? rt.lastSpaceId : first);
    Object.assign(rec, { tabId: b.tabId, url: b.url, lastActive: b.lastActive || Date.now() });
    rt.tabs.unshift(rec);
  }
  for (const r of rt.tabs) if (!spaceById(s, r.spaceId)) r.spaceId = first;
  for (const [w, id] of Object.entries(rt.windowSpace)) if (!spaceById(s, id)) delete rt.windowSpace[w];
  for (const key of Object.keys(rt.groups)) if (!spaceById(s, key.split(':')[1])) delete rt.groups[key];
  if (!spaceById(s, rt.lastSpaceId)) rt.lastSpaceId = null;
}

// Closes tabs without letting Chrome jump into another space: if a closing tab is
// active, first activate the most recent tab of the same space (or a new tab).
async function closeTabs(s, ids) {
  const set = new Set(ids.filter(id => id != null));
  if (!set.size) return;
  const live = (await chrome.tabs.query({})).filter(t => set.has(t.id));
  if (!live.length) return;
  for (const t of live) {
    if (!t.active) continue;
    const repl = await bestTabInSpace(s, t.windowId, getWindowSpace(s, t.windowId), set);
    if (repl != null) await chrome.tabs.update(repl, { active: true }).catch(() => {});
    else await chrome.tabs.create({ windowId: t.windowId }).catch(() => {});
  }
  for (const id of set) recentlyRemoved.set(id, Date.now());
  await chrome.tabs.remove(live.map(t => t.id)).catch(() => {});
}

async function archiveRecords(s, recs) {
  const now = Date.now();
  for (const r of recs) {
    removeRecord(s, r.id);
    if (r.url && !r.url.startsWith('chrome://newtab')) {
      s.runtime.archived.unshift({ url: r.url, title: r.customTitle || r.title, spaceId: r.spaceId, archivedAt: now });
    }
  }
  s.runtime.archived.length = Math.min(s.runtime.archived.length, ARCHIVE_LIMIT);
  await closeTabs(s, recs.map(r => r.tabId));
}

// ---------------------------------------------------------------------------
// Tab groups: each space is mirrored as one tab group per window. The current
// space's group is expanded, the others are collapsed, which keeps Chrome's
// horizontal tab strip tidy.

const groupTimers = new Map();

function scheduleGroups(windowId) {
  if (windowId == null || windowId < 0) return;
  clearTimeout(groupTimers.get(windowId));
  groupTimers.set(windowId, setTimeout(() => {
    groupTimers.delete(windowId);
    mutate(s => applyGroups(s, windowId));
  }, 200));
}

function scheduleAllGroups() {
  chrome.windows.getAll({ windowTypes: ['normal'] })
    .then(ws => ws.forEach(w => scheduleGroups(w.id)))
    .catch(() => {});
}

async function applyGroups(s, windowId) {
  if (!s.layout.settings.groupTabsBySpace) return;
  let win;
  try {
    win = await chrome.windows.get(windowId, { populate: true });
  } catch {
    return;
  }
  if (win.type !== 'normal') return;
  const current = getWindowSpace(s, windowId);
  const ours = new Set(Object.values(s.runtime.groups));
  const buckets = new Map();
  const loose = [];
  for (const t of win.tabs) {
    if (t.pinned) continue; // Chrome-pinned tabs cannot be grouped
    const sp = spaceOfTab(s, t.id);
    if (sp === undefined) continue;
    if (sp === null) {
      if (t.groupId !== -1 && ours.has(t.groupId)) loose.push(t.id);
      continue;
    }
    if (!buckets.has(sp)) buckets.set(sp, []);
    buckets.get(sp).push(t);
  }
  if (loose.length) await chrome.tabs.ungroup(loose).catch(() => {});
  // Expand the current space first so collapsing others never hides the active tab.
  const order = [...buckets.keys()].sort((a, b) => (b === current) - (a === current));
  for (const spId of order) {
    const space = spaceById(s, spId);
    if (!space) continue;
    const key = `${windowId}:${spId}`;
    const list = buckets.get(spId);
    let gid = s.runtime.groups[key];
    const group = gid != null ? await chrome.tabGroups.get(gid).catch(() => null) : null;
    if (!group || group.windowId !== windowId) gid = null;
    try {
      if (gid == null) {
        gid = await chrome.tabs.group({ tabIds: list.map(t => t.id), createProperties: { windowId } });
      } else {
        const missing = list.filter(t => t.groupId !== gid).map(t => t.id);
        if (missing.length) await chrome.tabs.group({ tabIds: missing, groupId: gid });
      }
    } catch (e) {
      console.warn('[sidecar] grouping failed', e);
      continue;
    }
    s.runtime.groups[key] = gid;
    const title = `${space.icon || ''} ${space.name}`.trim();
    const collapsed = spId !== current && !list.some(t => t.active);
    if (!group || group.id !== gid || group.title !== title || group.color !== space.color || group.collapsed !== collapsed) {
      await chrome.tabGroups.update(gid, { title, color: space.color, collapsed }).catch(e => console.warn(e));
    }
  }
}

async function ungroupAll(s) {
  const ours = new Set(Object.values(s.runtime.groups));
  const tabs = await chrome.tabs.query({});
  const ids = tabs.filter(t => ours.has(t.groupId)).map(t => t.id);
  if (ids.length) await chrome.tabs.ungroup(ids).catch(() => {});
  s.runtime.groups = {};
}

// ---------------------------------------------------------------------------
// Sync. The layout is gzipped, base64'd and split into chunks; a meta item
// carries the revision. Newest revision wins.

async function gzipB64(str) {
  const stream = new Blob([str]).stream().pipeThrough(new CompressionStream('gzip'));
  const buf = new Uint8Array(await new Response(stream).arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function gunzipB64(b64) {
  const buf = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

async function readSyncLayout() {
  const all = await chrome.storage.sync.get(null);
  const meta = all[META_KEY];
  if (!meta) return null;
  let data = '';
  for (let i = 0; i < meta.n; i++) {
    const c = all[CHUNK_PREFIX + i];
    if (typeof c !== 'string') throw new Error('synced layout is incomplete');
    data += c;
  }
  const layout = JSON.parse(await gunzipB64(data));
  if (layout.rev !== meta.rev) throw new Error('synced layout is mid-update');
  return layout;
}

let pushTimer = null;
function schedulePush(delay = 3000) {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => mutate(pushSync), delay);
}

async function pushSync(s) {
  const sync = s.runtime.sync;
  try {
    const data = await gzipB64(JSON.stringify(s.layout));
    const items = {};
    let n = 0;
    for (let i = 0; i < data.length; i += CHUNK_SIZE) items[CHUNK_PREFIX + n++] = data.slice(i, i + CHUNK_SIZE);
    items[META_KEY] = { rev: s.layout.rev, n };
    await chrome.storage.sync.set(items);
    const existing = Object.keys(await chrome.storage.sync.get(null));
    const extra = existing.filter(k => k.startsWith(CHUNK_PREFIX) && +k.slice(CHUNK_PREFIX.length) >= n);
    if (extra.length) await chrome.storage.sync.remove(extra);
    Object.assign(sync, { status: 'ok', at: Date.now(), error: '', bytes: await chrome.storage.sync.getBytesInUse(null) });
  } catch (e) {
    Object.assign(sync, { status: 'error', at: Date.now(), error: String(e.message || e) });
  }
}

function applyRemoteLayout(s, remote) {
  s.layout = normalizeLayout(remote);
  lastLayoutKey = layoutKey(s.layout);
  pruneRuntime(s);
  Object.assign(s.runtime.sync, { status: 'ok', at: Date.now(), error: '' });
  scheduleAllGroups();
}

function schedulePull(attempt = 0) {
  setTimeout(() => mutate(async s => {
    let remote;
    try {
      remote = await readSyncLayout();
    } catch {
      if (attempt < 5) schedulePull(attempt + 1); // other chunks are still arriving
      return;
    }
    if (remote && remote.rev > s.layout.rev) applyRemoteLayout(s, remote);
  }), 1500);
}

// ---------------------------------------------------------------------------
// Space switching

async function switchSpace(s, windowId, spaceId) {
  if (!spaceById(s, spaceId)) return;
  s.runtime.windowSpace[windowId] = spaceId;
  s.runtime.lastSpaceId = spaceId;
  const [active] = await chrome.tabs.query({ windowId, active: true });
  if (!active || spaceOfTab(s, active.id) !== spaceId) {
    const target = await bestTabInSpace(s, windowId, spaceId);
    if (target != null) await chrome.tabs.update(target, { active: true }).catch(() => {});
    else await chrome.tabs.create({ windowId }).catch(() => {});
  }
  scheduleGroups(windowId);
}

async function cycleSpace(s, windowId, dir) {
  const spaces = s.layout.spaces;
  const i = spaces.findIndex(sp => sp.id === getWindowSpace(s, windowId));
  await switchSpace(s, windowId, spaces[(i + dir + spaces.length) % spaces.length].id);
}

// ---------------------------------------------------------------------------
// Opening / closing entries

async function focusTab(tabId) {
  try {
    const t = await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(t.windowId, { focused: true });
    return true;
  } catch {
    return false;
  }
}

async function activate(s, { kind, id, windowId }) {
  if (kind === 'tab') {
    const r = s.runtime.tabs.find(x => x.id === id);
    if (!r) return;
    if (r.tabId != null && await focusTab(r.tabId)) return;
    const t = await chrome.tabs.create({ windowId, url: r.url || undefined, active: true });
    r.tabId = t.id;
    r.lastActive = Date.now();
  } else {
    const e = findEntry(s, id);
    if (!e) return;
    const b = s.runtime.bindings[id];
    if (b && await focusTab(b.tabId)) return;
    const t = await chrome.tabs.create({ windowId, url: e.entry.url, active: true });
    s.runtime.bindings[id] = { tabId: t.id, url: e.entry.url, lastActive: Date.now() };
  }
  scheduleGroups(windowId);
}

async function minimize(s, id) {
  const b = s.runtime.bindings[id];
  if (!b) return;
  delete s.runtime.bindings[id];
  await closeTabs(s, [b.tabId]);
}

function detachEntryNode(s, id) {
  const i = s.layout.favorites.findIndex(f => f.id === id);
  if (i >= 0) return s.layout.favorites.splice(i, 1)[0];
  for (const sp of s.layout.spaces) {
    const n = removeNode(sp.pinned, id);
    if (n) return n;
  }
  return null;
}

// Removes a pinned tab, folder (with contents) or favorite, closing its tabs.
async function deleteNode(s, id) {
  const node = detachEntryNode(s, id);
  if (!node) return;
  const ids = [];
  walk([node], n => {
    const b = s.runtime.bindings[n.id];
    if (b) {
      ids.push(b.tabId);
      delete s.runtime.bindings[n.id];
    }
  });
  await closeTabs(s, ids);
}

// ---------------------------------------------------------------------------
// Moving things around (drag and drop, context menu actions)

function insertList(list, node, refId, position) {
  const idx = refId ? list.findIndex(n => n.id === refId) : -1;
  if (idx >= 0) list.splice(position === 'after' ? idx + 1 : idx, 0, node);
  else if (position === 'start') list.unshift(node);
  else list.push(node);
}

function insertTree(nodes, node, refId, position) {
  const f = refId ? findNode(nodes, refId) : null;
  if (!f) {
    if (position === 'start') nodes.unshift(node);
    else nodes.push(node);
  } else if (position === 'inside' && f.node.type === 'folder') {
    f.node.children.unshift(node);
    f.node.collapsed = false;
  } else {
    f.list.splice(position === 'after' ? f.index + 1 : f.index, 0, node);
  }
}

// item:   { kind: 'fav' | 'pinned' | 'tab', id }
// target: { zone: 'favorites' | 'pinned' | 'unpinned' | 'space', spaceId, refId?, position? }
async function move(s, item, target) {
  const rt = s.runtime;
  const { zone } = target;
  if (target.spaceId && !spaceById(s, target.spaceId)) return;
  if (target.refId === item.id) return;

  let src;
  if (item.kind === 'fav') {
    const node = s.layout.favorites.find(f => f.id === item.id);
    if (node) src = { node };
  } else if (item.kind === 'pinned') {
    const f = findInSpaces(s, item.id);
    if (f) src = { node: f.node };
  } else if (item.kind === 'tab') {
    const rec = rt.tabs.find(r => r.id === item.id);
    if (rec) src = { rec };
  }
  if (!src) return;

  const isFolder = src.node && src.node.type === 'folder';
  if (isFolder && (zone === 'favorites' || zone === 'unpinned')) throw new Error('Folders can only live in the pinned section.');
  if (isFolder && target.refId && findNode(src.node.children, target.refId)) return; // into itself

  // Unpinned tab staying unpinned: reorder or change space.
  if (src.rec && (zone === 'unpinned' || zone === 'space')) {
    removeRecord(s, src.rec.id);
    src.rec.spaceId = target.spaceId;
    insertRecordAt(s, src.rec, zone === 'unpinned' ? target.refId : null, zone === 'unpinned' ? target.position : 'start');
    scheduleAllGroups();
    return;
  }

  // Everything else becomes (or stays) an entry node.
  let node;
  if (src.rec) {
    removeRecord(s, src.rec.id);
    node = { id: uid(), type: 'tab', url: src.rec.url, title: src.rec.title, customTitle: src.rec.customTitle || '' };
    if (src.rec.tabId != null) rt.bindings[node.id] = { tabId: src.rec.tabId, url: src.rec.url, lastActive: src.rec.lastActive };
  } else {
    node = detachEntryNode(s, src.node.id);
  }

  if (zone === 'unpinned') {
    const b = rt.bindings[node.id];
    delete rt.bindings[node.id];
    const rec = newRecord(null, target.spaceId);
    Object.assign(rec, {
      tabId: b ? b.tabId : null,
      url: b ? b.url : node.url,
      title: node.title,
      customTitle: node.customTitle || '',
    });
    insertRecordAt(s, rec, target.refId, target.position);
  } else if (zone === 'favorites') {
    insertList(s.layout.favorites, node, target.refId, target.position);
  } else if (zone === 'pinned') {
    insertTree(spaceById(s, target.spaceId).pinned, node, target.refId, target.position);
  } else if (zone === 'space') {
    spaceById(s, target.spaceId).pinned.push(node);
  }
  scheduleAllGroups();
}

// ---------------------------------------------------------------------------
// Messages from the side panel

const handlers = {
  ping: () => true,

  activate: (s, m) => activate(s, m),
  minimize: (s, m) => minimize(s, m.id),
  deleteEntry: (s, m) => deleteNode(s, m.id),
  closeTab: async (s, m) => {
    const r = removeRecord(s, m.id);
    if (r) await closeTabs(s, [r.tabId]);
  },
  newTab: (s, m) => chrome.tabs.create({ windowId: m.windowId }),

  rename: (s, { kind, id, name }) => {
    name = String(name || '').trim();
    if (kind === 'space') {
      const sp = spaceById(s, id);
      if (sp && name) sp.name = name;
    } else if (kind === 'tab') {
      const r = s.runtime.tabs.find(x => x.id === id);
      if (r) r.customTitle = name;
    } else {
      const fav = s.layout.favorites.find(f => f.id === id);
      const node = fav || findInSpaces(s, id)?.node;
      if (!node) return;
      if (node.type === 'folder') node.name = name || node.name;
      else node.customTitle = name;
    }
    scheduleAllGroups();
  },

  setEntryUrl: async (s, { id }) => {
    const e = findEntry(s, id);
    const b = s.runtime.bindings[id];
    if (!e || !b) return;
    const t = await chrome.tabs.get(b.tabId).catch(() => null);
    if (!t) return;
    e.entry.url = t.url;
    e.entry.title = t.title || e.entry.title;
    b.url = t.url;
  },

  newFolder: (s, { spaceId, parentId }) => {
    const sp = spaceById(s, spaceId);
    if (!sp) return null;
    const folder = { id: uid(), type: 'folder', name: 'New Folder', collapsed: false, children: [] };
    const parent = parentId ? findNode(sp.pinned, parentId)?.node : null;
    if (parent && parent.type === 'folder') {
      parent.children.unshift(folder);
      parent.collapsed = false;
    } else {
      sp.pinned.unshift(folder);
    }
    return folder.id;
  },

  toggleFolder: (s, { id }) => {
    const f = findInSpaces(s, id);
    if (f && f.node.type === 'folder') f.node.collapsed = !f.node.collapsed;
  },

  move: (s, { item, target }) => move(s, item, target),

  pinTab: (s, { id }) => {
    const r = s.runtime.tabs.find(x => x.id === id);
    if (r) return move(s, { kind: 'tab', id }, { zone: 'pinned', spaceId: r.spaceId, position: 'end' });
  },
  unpin: (s, { id, windowId }) => {
    const f = findInSpaces(s, id);
    const spaceId = f ? f.spaceId : getWindowSpace(s, windowId);
    const kind = f ? 'pinned' : 'fav';
    return move(s, { kind, id }, { zone: 'unpinned', spaceId, position: 'start' });
  },
  favorite: (s, { kind, id }) => move(s, { kind, id }, { zone: 'favorites', position: 'end' }),
  unfavorite: (s, { id, windowId }) =>
    move(s, { kind: 'fav', id }, { zone: 'pinned', spaceId: getWindowSpace(s, windowId), position: 'end' }),
  moveToSpace: (s, { kind, id, spaceId }) => move(s, { kind, id }, { zone: 'space', spaceId }),

  switchSpace: (s, { windowId, spaceId }) => switchSpace(s, windowId, spaceId),
  cycleSpace: (s, { windowId, dir }) => cycleSpace(s, windowId, dir),

  createSpace: async (s, { windowId, name, icon, color }) => {
    const sp = { id: uid(), name: name || 'Space', icon: icon || '', color: color || 'grey', pinned: [] };
    s.layout.spaces.push(sp);
    if (windowId != null) await switchSpace(s, windowId, sp.id);
    return sp.id;
  },

  updateSpace: (s, { id, name, icon, color }) => {
    const sp = spaceById(s, id);
    if (!sp) return;
    if (name) sp.name = name;
    if (icon != null) sp.icon = icon;
    if (color) sp.color = color;
    scheduleAllGroups();
  },

  reorderSpace: (s, { id, dir }) => {
    const list = s.layout.spaces;
    const i = list.findIndex(sp => sp.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
  },

  deleteSpace: async (s, { id }) => {
    const rt = s.runtime;
    const sp = spaceById(s, id);
    if (!sp || s.layout.spaces.length < 2) throw new Error('You need at least one space.');
    const other = s.layout.spaces.find(x => x.id !== id).id;
    for (const [w, spaceId] of Object.entries(rt.windowSpace)) {
      if (spaceId === id) await switchSpace(s, +w, other);
    }
    const tabIds = [];
    for (const eid of entryIdsInSpace(sp)) {
      if (rt.bindings[eid]) tabIds.push(rt.bindings[eid].tabId);
      delete rt.bindings[eid];
    }
    for (const r of rt.tabs.filter(r => r.spaceId === id)) {
      tabIds.push(r.tabId);
      removeRecord(s, r.id);
    }
    s.layout.spaces = s.layout.spaces.filter(x => x.id !== id);
    await closeTabs(s, tabIds);
    pruneRuntime(s);
  },

  clearSpace: (s, { spaceId }) => archiveRecords(s, s.runtime.tabs.filter(r => r.spaceId === spaceId)),

  restoreArchived: async (s, { index, windowId }) => {
    const a = s.runtime.archived.splice(index, 1)[0];
    if (a) await chrome.tabs.create({ windowId, url: a.url, active: true });
  },
  clearArchive: s => { s.runtime.archived = []; },

  updateSettings: async (s, { settings }) => {
    const before = s.layout.settings.groupTabsBySpace;
    Object.assign(s.layout.settings, settings);
    const hours = Number(s.layout.settings.archiveHours);
    s.layout.settings.archiveHours = Number.isFinite(hours) && hours > 0 ? hours : 0;
    if (before && !s.layout.settings.groupTabsBySpace) await ungroupAll(s);
    if (!before && s.layout.settings.groupTabsBySpace) scheduleAllGroups();
  },

  exportData: s => ({ app: 'sidecar', version: 1, exportedAt: new Date().toISOString(), layout: s.layout }),

  importData: (s, { data }) => {
    const layout = data && data.layout ? data.layout : data;
    if (!layout || !Array.isArray(layout.spaces)) throw new Error('That file does not look like a Sidecar export.');
    s.layout = normalizeLayout(layout);
    s.runtime.bindings = {};
    pruneRuntime(s);
    lastLayoutKey = ''; // force a new revision so it syncs out
    scheduleAllGroups();
  },

  syncNow: async s => {
    clearTimeout(pushTimer);
    await pushSync(s);
    return s.runtime.sync;
  },

  pullSync: async s => {
    const remote = await readSyncLayout();
    if (!remote) throw new Error('Nothing has been synced yet.');
    applyRemoteLayout(s, remote);
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = handlers[msg && msg.type];
  if (!handler) return false;
  mutate(s => handler(s, msg)).then(
    result => sendResponse({ ok: true, result }),
    err => sendResponse({ ok: false, error: String(err && err.message || err) }),
  );
  return true;
});

// ---------------------------------------------------------------------------
// Chrome events

chrome.tabs.onCreated.addListener(tab => mutate(async s => {
  if (recordForTab(s, tab.id) || entryIdForTab(s, tab.id)) return;
  if (Date.now() < reconcileUntil && tryClaim(s, tab)) return;
  let spaceId = null;
  let after = null;
  if (tab.openerTabId != null) {
    const opener = recordForTab(s, tab.openerTabId);
    if (opener) {
      spaceId = opener.spaceId;
      after = opener.id;
    } else {
      const sp = spaceOfTab(s, tab.openerTabId);
      if (sp) spaceId = sp;
    }
  }
  if (!spaceId) spaceId = getWindowSpace(s, tab.windowId);
  const rec = newRecord(tab, spaceId);
  if (Date.now() < reconcileUntil) rec.fresh = true;
  insertRecordAt(s, rec, after, after ? 'after' : 'start');
  scheduleGroups(tab.windowId);
}));

chrome.tabs.onRemoved.addListener((tabId, info) => {
  const now = Date.now();
  for (const [id, t] of recentlyRemoved) if (now - t > 5000) recentlyRemoved.delete(id);
  recentlyRemoved.set(tabId, now);
  mutate(async s => {
    const eid = entryIdForTab(s, tabId);
    if (eid) delete s.runtime.bindings[eid];
    const rec = recordForTab(s, tabId);
    if (rec) {
      // Closing a whole window (or quitting) keeps its tabs as sleeping entries.
      if (info.isWindowClosing) rec.tabId = null;
      else removeRecord(s, rec.id);
    }
  });
});

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (!('url' in change) && !('title' in change)) return;
  mutate(async s => {
    const rec = recordForTab(s, tabId);
    if (rec) {
      if (change.url && rec.fresh && Date.now() < reconcileUntil && tryClaim(s, tab, rec)) return;
      rec.url = tab.url || rec.url;
      rec.title = tab.title || rec.title;
      return;
    }
    const eid = entryIdForTab(s, tabId);
    if (!eid) return;
    const b = s.runtime.bindings[eid];
    b.url = tab.url || b.url;
    const e = findEntry(s, eid);
    if (e && tab.title && tab.title !== tab.url && sameUrl(tab.url, e.entry.url)) e.entry.title = tab.title;
  });
});

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => mutate(async s => {
  const rt = s.runtime;
  const now = Date.now();
  const prev = rt.activeTab[windowId];
  rt.activeTab[windowId] = tabId;

  let spaceId;
  const rec = recordForTab(s, tabId);
  const eid = entryIdForTab(s, tabId);
  if (rec) {
    rec.lastActive = now;
    spaceId = rec.spaceId;
  } else if (eid) {
    rt.bindings[eid].lastActive = now;
    spaceId = findEntry(s, eid)?.spaceId;
  }
  if (!spaceId) return; // favorites and unknown tabs don't change the space
  const current = getWindowSpace(s, windowId);
  if (spaceId === current) return;

  // Chrome picks a neighbouring tab when you close the active one. If that
  // neighbour is in another space, stay in this space instead.
  const closedPrev = prev != null && prev !== tabId && (recentlyRemoved.has(prev) || !(await tabExists(prev)));
  if (closedPrev) {
    const repl = await bestTabInSpace(s, windowId, current, new Set([prev, tabId]));
    if (repl != null) {
      await chrome.tabs.update(repl, { active: true }).catch(() => {});
      return;
    }
  }
  rt.windowSpace[windowId] = spaceId;
  rt.lastSpaceId = spaceId;
  scheduleGroups(windowId);
}));

chrome.tabs.onAttached.addListener((tabId, { newWindowId }) => mutate(async s => {
  const sp = spaceOfTab(s, tabId);
  const tabs = await chrome.tabs.query({ windowId: newWindowId });
  if (sp && tabs.length === 1) s.runtime.windowSpace[newWindowId] = sp; // dragged out into a new window
  scheduleGroups(newWindowId);
}));

chrome.windows.onFocusChanged.addListener(windowId => {
  if (windowId < 0) return;
  mutate(async s => {
    if (s.runtime.windowSpace[windowId]) s.runtime.lastSpaceId = s.runtime.windowSpace[windowId];
  });
});

chrome.windows.onRemoved.addListener(windowId => mutate(async s => {
  delete s.runtime.windowSpace[windowId];
  delete s.runtime.activeTab[windowId];
  for (const key of Object.keys(s.runtime.groups)) if (key.startsWith(`${windowId}:`)) delete s.runtime.groups[key];
}));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes[META_KEY]) schedulePull();
});

// ---------------------------------------------------------------------------
// Auto-archive unpinned tabs

function ensureAlarm() {
  chrome.alarms.get('archive').then(a => {
    if (!a) chrome.alarms.create('archive', { periodInMinutes: 5 });
  });
}

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== 'archive') return;
  mutate(async s => {
    const now = Date.now();
    const activeIds = new Set((await chrome.tabs.query({ active: true })).map(t => t.id));
    const audible = new Set((await chrome.tabs.query({ audible: true })).map(t => t.id));
    for (const r of s.runtime.tabs) if (activeIds.has(r.tabId)) r.lastActive = now;
    for (const b of Object.values(s.runtime.bindings)) if (activeIds.has(b.tabId)) b.lastActive = now;
    if (now > reconcileUntil) {
      s.runtime.stale = [];
      for (const r of s.runtime.tabs) delete r.fresh;
    }
    const hours = Number(s.layout.settings.archiveHours);
    if (!hours || hours <= 0) return;
    const limit = hours * 3600_000;
    const expired = s.runtime.tabs.filter(r =>
      now - (r.lastActive || 0) > limit && !activeIds.has(r.tabId) && !audible.has(r.tabId));
    if (expired.length) await archiveRecords(s, expired);
  });
});

// ---------------------------------------------------------------------------
// Keyboard shortcuts (chrome://extensions/shortcuts)

chrome.commands.onCommand.addListener((command, tab) => mutate(async s => {
  const windowId = tab ? tab.windowId : (await chrome.windows.getLastFocused()).id;
  const [active] = tab ? [tab] : await chrome.tabs.query({ windowId, active: true });
  if (command === 'next-space') return cycleSpace(s, windowId, 1);
  if (command === 'prev-space') return cycleSpace(s, windowId, -1);
  if (!active) return;
  const rec = recordForTab(s, active.id);
  const eid = entryIdForTab(s, active.id);
  if (command === 'toggle-pin') {
    if (rec) return move(s, { kind: 'tab', id: rec.id }, { zone: 'pinned', spaceId: rec.spaceId, position: 'end' });
    if (eid) return handlers.unpin(s, { id: eid, windowId });
  }
  if (command === 'toggle-favorite') {
    if (rec) return move(s, { kind: 'tab', id: rec.id }, { zone: 'favorites', position: 'end' });
    if (eid && s.layout.favorites.some(f => f.id === eid)) return handlers.unfavorite(s, { id: eid, windowId });
    if (eid) return move(s, { kind: 'pinned', id: eid }, { zone: 'favorites', position: 'end' });
  }
}));

// ---------------------------------------------------------------------------
// Startup

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  mutate(() => {});
});
chrome.runtime.onStartup.addListener(() => mutate(() => {}));
