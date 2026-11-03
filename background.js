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

import { uid, findNode, removeNode, walk, normalizeLayout, sameUrl, tidySplits } from './shared.js';

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
    tabs: Array.isArray(r.tabs) ? r.tabs : [], // unpinned tab records, in display order (split halves share a splitId)
    windowSpace: r.windowSpace || {},    // windowId -> spaceId
    groups: r.groups || {},              // "windowId:spaceId" -> tab group id
    activeTab: r.activeTab || {},        // windowId -> active tab id
    archived: Array.isArray(r.archived) ? r.archived : [],
    stale: Array.isArray(r.stale) ? r.stale : [], // bindings waiting to be re-matched after restart
    lastSpaceId: r.lastSpaceId || null,
    sync: r.sync || { status: 'pending', at: 0, error: '', bytes: 0 },
    bookmarks: r.bookmarks || { enabled: false, folderId: null, at: 0, error: '' }, // mirror to Other Bookmarks
  };
}

// Page titles are left out: they change constantly (unread counts and the like),
// and giving each change a new revision made every computer's layout look newest,
// so it overwrote edits from other computers. Titles still save locally and ride
// along with the next real change.
function layoutKey(layout) {
  return JSON.stringify(layout, (k, v) => (k === 'rev' || k === 'title' ? undefined : v));
}

async function load() {
  if (cache) return cache;
  const got = await chrome.storage.local.get(['layout', 'runtime']);
  const s = { layout: normalizeLayout(got.layout), runtime: normalizeRuntime(got.runtime) };
  let remote = null;
  let remoteUnreadable = false;
  try {
    remote = await readSyncLayout();
  } catch (e) {
    console.warn('[sidecar] could not read synced layout', e);
    remoteUnreadable = true;
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
  // An unreadable remote may be a newer layout still arriving: don't push over it.
  if (remoteUnreadable) schedulePull();
  else if (!remote || remote.rev < s.layout.rev) schedulePush();
  ensureAlarm();
  scheduleAllGroups();
  if (s.runtime.bookmarks.enabled) scheduleBookmarks();
  return s;
}

async function persist(s) {
  for (const sp of s.layout.spaces) tidySplits(sp.pinned);
  tidySplitRecords(s);
  const key = layoutKey(s.layout);
  if (key !== lastLayoutKey) {
    s.layout.rev = Date.now();
    lastLayoutKey = key;
    schedulePush();
    if (s.runtime.bookmarks.enabled) scheduleBookmarks();
  }
  await chrome.storage.local.set({ layout: s.layout, runtime: s.runtime });
}

// ---------------------------------------------------------------------------
// Lookups

const tabUrl = t => t.url || t.pendingUrl || '';
// Sidecar's newtab.html can show up under either URL.
const isNewTabUrl = url => url.startsWith('chrome://newtab') || url.startsWith(chrome.runtime.getURL('newtab.html'));
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
  if (!url || isNewTabUrl(url)) return false;
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
    if (r.url && !isNewTabUrl(r.url)) {
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
    // Another computer's newer layout may have landed before we pulled it.
    const remote = await readSyncLayout().catch(() => null);
    if (remote && remote.rev > s.layout.rev) {
      applyRemoteLayout(s, remote);
      return;
    }
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
  if (s.runtime.bookmarks.enabled) scheduleBookmarks();
}

let pullTimer = null;
function schedulePull(attempt = 0) {
  clearTimeout(pullTimer);
  pullTimer = setTimeout(() => mutate(async s => {
    let remote;
    try {
      remote = await readSyncLayout();
    } catch {
      if (attempt < 5) schedulePull(attempt + 1); // other chunks are still arriving
      return;
    }
    if (remote && remote.rev > s.layout.rev) applyRemoteLayout(s, remote);
    else if (!remote || remote.rev < s.layout.rev) schedulePush();
  }), 1500);
}

// ---------------------------------------------------------------------------
// Bookmarks mirror. Keeps Other Bookmarks/Sidecar in step with the layout so
// pinned tabs and favorites reach Chrome on iOS, which can't run extensions.
// The folder is Sidecar's: edits made inside it get overwritten.

const BOOKMARK_FOLDER = 'Sidecar';

let bookmarkTimer = null;
function scheduleBookmarks(delay = 3000) {
  clearTimeout(bookmarkTimer);
  bookmarkTimer = setTimeout(() => mutate(mirrorBookmarks), delay);
}

function bookmarkTree(layout) {
  // Bookmarks can't show a split view, so its two tabs are listed in its place.
  const nodes = list => list.flatMap(n => n.type === 'split' ? nodes(n.children)
    : n.type === 'folder' ? [{ title: n.name, children: nodes(n.children) }]
    : [{ title: n.customTitle || n.title || n.url, url: n.url }]).filter(n => n.children || n.url);
  return [
    { title: '★ Favorites', children: nodes(layout.favorites) },
    ...layout.spaces.map(sp => ({ title: `${sp.icon} ${sp.name}`.trim(), children: nodes(sp.pinned) })),
  ];
}

async function otherBookmarksId() {
  const [root] = await chrome.bookmarks.getTree();
  const other = root.children.find(n => n.folderType === 'other') || root.children.find(n => n.id === '2') || root.children[1];
  return other.id;
}

async function mirrorFolderId(bm) {
  if (bm.folderId) {
    const [f] = await chrome.bookmarks.get(bm.folderId).catch(() => []);
    if (f && !f.url) return f.id;
  }
  const parentId = await otherBookmarksId();
  // Adopt a folder another computer already made, rather than adding a duplicate.
  const existing = (await chrome.bookmarks.getChildren(parentId)).find(b => !b.url && b.title === BOOKMARK_FOLDER);
  const f = existing || await chrome.bookmarks.create({ parentId, title: BOOKMARK_FOLDER });
  return f.id;
}

// Updates parentId's children in place to match `desired`, reusing bookmarks
// where possible (folders by title, links by URL) so sync sees small changes.
async function syncBookmarkFolder(parentId, desired) {
  const pool = await chrome.bookmarks.getChildren(parentId);
  const matches = desired.map(d => {
    const i = pool.findIndex(b => d.children ? !b.url && b.title === d.title : b.url === d.url);
    return i < 0 ? null : pool.splice(i, 1)[0];
  });
  for (const b of pool) await (b.url ? chrome.bookmarks.remove(b.id) : chrome.bookmarks.removeTree(b.id));
  const order = (await chrome.bookmarks.getChildren(parentId)).map(b => b.id);
  let i = 0;
  for (const [k, d] of desired.entries()) {
    let b = matches[k];
    if (!b) {
      b = await chrome.bookmarks.create({ parentId, index: i, title: d.title, url: d.url }).catch(() => null);
      if (!b) continue; // a URL Chrome won't bookmark
      order.splice(i, 0, b.id);
    } else {
      if (b.title !== d.title) await chrome.bookmarks.update(b.id, { title: d.title });
      if (order[i] !== b.id) {
        await chrome.bookmarks.move(b.id, { parentId, index: i });
        order.splice(order.indexOf(b.id), 1);
        order.splice(i, 0, b.id);
      }
    }
    if (d.children) await syncBookmarkFolder(b.id, d.children);
    i++;
  }
}

async function mirrorBookmarks(s) {
  const bm = s.runtime.bookmarks;
  if (!bm.enabled) return;
  try {
    bm.folderId = await mirrorFolderId(bm);
    await syncBookmarkFolder(bm.folderId, bookmarkTree(s.layout));
    Object.assign(bm, { at: Date.now(), error: '' });
  } catch (e) {
    Object.assign(bm, { at: Date.now(), error: String(e.message || e) });
  }
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
  let tabId;
  if (kind === 'tab') {
    const r = s.runtime.tabs.find(x => x.id === id);
    if (!r) return;
    if (r.tabId == null || !await focusTab(r.tabId)) {
      const t = await chrome.tabs.create({ windowId, url: r.url || undefined, active: true });
      r.tabId = t.id;
      r.lastActive = Date.now();
    }
    tabId = r.tabId;
  } else {
    const e = findEntry(s, id);
    if (!e) return;
    const b = s.runtime.bindings[id];
    if (!b || !await focusTab(b.tabId)) {
      const t = await chrome.tabs.create({ windowId, url: e.entry.url, active: true });
      s.runtime.bindings[id] = { tabId: t.id, url: e.entry.url, lastActive: Date.now() };
    }
    tabId = s.runtime.bindings[id].tabId;
  }
  // Opening either side of a split view brings back both, side by side.
  const split = splitOfTab(s, tabId);
  if (split) {
    await openSplit(s, split, windowId);
    await focusTab(tabId);
  }
  scheduleGroups(windowId);
}

// Closes an entry's tab, or both tabs of a pinned split, keeping them pinned.
async function minimize(s, id) {
  const node = findInSpaces(s, id)?.node;
  const ids = node && node.type === 'split' ? node.children.map(c => c.id) : [id];
  const tabIds = [];
  for (const eid of ids) {
    const b = s.runtime.bindings[eid];
    if (!b) continue;
    delete s.runtime.bindings[eid];
    tabIds.push(b.tabId);
  }
  await closeTabs(s, tabIds);
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

// Unpinned record -> pinned entry node, keeping its open tab.
function recordToNode(s, rec) {
  const node = { id: uid(), type: 'tab', url: rec.url, title: rec.title, customTitle: rec.customTitle || '' };
  if (rec.tabId != null) s.runtime.bindings[node.id] = { tabId: rec.tabId, url: rec.url, lastActive: rec.lastActive };
  return node;
}

// Pinned entry node -> unpinned record, keeping its open tab.
function nodeToRecord(s, node, spaceId) {
  const b = s.runtime.bindings[node.id];
  delete s.runtime.bindings[node.id];
  const rec = newRecord(null, spaceId);
  Object.assign(rec, {
    tabId: b ? b.tabId : null,
    url: b ? b.url : node.url,
    title: node.title,
    customTitle: node.customTitle || '',
  });
  return rec;
}

// item:   { kind: 'fav' | 'pinned' | 'tab' | 'split', id }
// target: { zone: 'favorites' | 'pinned' | 'unpinned' | 'space', spaceId, refId?, position? }
async function move(s, item, target) {
  const rt = s.runtime;
  const { zone } = target;
  if (target.spaceId && !spaceById(s, target.spaceId)) return;
  // Nothing goes inside a split view: land next to it instead.
  const host = target.refId && splitOfEntry(s, target.refId);
  if (host) target = { ...target, refId: host.node.id, position: target.position === 'before' ? 'before' : 'after' };
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
  } else if (item.kind === 'split') {
    const f = findInSpaces(s, item.id);
    const recs = splitRecords(s, item.id);
    if (f && f.node.type === 'split') src = { node: f.node };
    else if (recs.length === 2) src = { recs };
  }
  if (!src) return;

  const isFolder = src.node && src.node.type === 'folder';
  if (isFolder && (zone === 'favorites' || zone === 'unpinned')) throw new Error('Folders can only live in the pinned section.');
  if (isFolder && target.refId && findNode(src.node.children, target.refId)) return; // into itself
  if (item.kind === 'split' && zone === 'favorites') throw new Error('Split views can’t go in Favorites.');

  // Unpinned tab (or split) staying unpinned: reorder or change space.
  const recs = src.rec ? [src.rec] : src.recs;
  if (recs && (zone === 'unpinned' || zone === 'space')) {
    for (const r of recs) {
      removeRecord(s, r.id);
      r.spaceId = target.spaceId;
    }
    insertRecordAt(s, recs[0], zone === 'unpinned' ? target.refId : null, zone === 'unpinned' ? target.position : 'start');
    if (recs[1]) insertRecordAt(s, recs[1], recs[0].id, 'after');
    scheduleAllGroups();
    return;
  }

  // Everything else becomes (or stays) an entry node.
  let node;
  if (src.rec) {
    removeRecord(s, src.rec.id);
    node = recordToNode(s, src.rec);
  } else if (src.recs) {
    for (const r of src.recs) removeRecord(s, r.id);
    node = { id: item.id, type: 'split', children: src.recs.map(r => recordToNode(s, r)) };
  } else {
    node = detachEntryNode(s, src.node.id);
  }

  if (zone === 'unpinned') {
    const isSplit = node.type === 'split';
    const out = (isSplit ? node.children : [node]).map(n => nodeToRecord(s, n, target.spaceId));
    if (isSplit) for (const r of out) r.splitId = node.id;
    insertRecordAt(s, out[0], target.refId, target.position);
    if (out[1]) insertRecordAt(s, out[1], out[0].id, 'after');
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
// Split view: two tabs side by side, using Chrome's own split view (Chrome 155+).
// A pinned split is a { type: 'split', children: [left, right] } node, synced and
// kept like any pinned tab. An unpinned split is two adjacent records sharing a
// splitId; they archive together. Chrome can't report or set where the divider
// sits, so the arrangement kept is which tab is on which side.

const NO_SPLIT = -1; // chrome.tabs.SPLIT_VIEW_ID_NONE
const canSplit = () => typeof chrome.tabs.createSplit === 'function';

const splitRecords = (s, splitId) => s.runtime.tabs.filter(r => r.splitId === splitId);

// The pinned split node holding an entry, if any.
function splitOfEntry(s, entryId) {
  for (const sp of s.layout.spaces) {
    let node = null;
    walk(sp.pinned, n => { if (!node && n.type === 'split' && n.children.some(c => c.id === entryId)) node = n; });
    if (node) return { node, spaceId: sp.id };
  }
  return null;
}

// A split as { kind: 'pinned' | 'tab', id, spaceId, halves }, halves left first,
// each { tabId, url, bind(tabId) } where bind records a newly opened tab.
function splitById(s, id) {
  const rt = s.runtime;
  const f = findInSpaces(s, id);
  if (f && f.node.type === 'split') {
    return {
      kind: 'pinned', id, spaceId: f.spaceId,
      halves: f.node.children.map(c => ({
        tabId: rt.bindings[c.id]?.tabId ?? null,
        url: c.url,
        bind: tabId => { rt.bindings[c.id] = { tabId, url: c.url, lastActive: Date.now() }; },
      })),
    };
  }
  const recs = splitRecords(s, id);
  if (recs.length !== 2) return null;
  return {
    kind: 'tab', id, spaceId: recs[0].spaceId,
    halves: recs.map(r => ({ tabId: r.tabId, url: r.url, bind: tabId => { r.tabId = tabId; r.lastActive = Date.now(); } })),
  };
}

// The split a Chrome tab belongs to in Sidecar, if any.
function splitOfTab(s, tabId) {
  const rec = recordForTab(s, tabId);
  if (rec) return rec.splitId ? splitById(s, rec.splitId) : null;
  const eid = entryIdForTab(s, tabId);
  const f = eid && splitOfEntry(s, eid);
  return f ? splitById(s, f.node.id) : null;
}

// Unpinned split halves sit next to each other, in the same space. One whose
// other side has gone (closed, or moved away) is a plain tab again.
function tidySplitRecords(s) {
  const list = s.runtime.tabs;
  const count = {};
  for (const r of list) if (r.splitId) count[r.splitId] = (count[r.splitId] || 0) + 1;
  for (const r of list) if (r.splitId && count[r.splitId] !== 2) delete r.splitId;
  for (let i = 0; i < list.length - 1; i++) {
    const id = list[i].splitId;
    if (!id) continue;
    if (list[i + 1].splitId !== id) list.splice(i + 1, 0, ...list.splice(list.findIndex((r, k) => k > i && r.splitId === id), 1));
    list[i + 1].spaceId = list[i].spaceId;
    i++;
  }
}

// Turns a split back into two separate tabs, in place (Sidecar's side only).
function dissolveSplit(s, split) {
  if (split.kind === 'tab') {
    for (const r of splitRecords(s, split.id)) delete r.splitId;
    return;
  }
  const f = findInSpaces(s, split.id);
  if (f) f.list.splice(f.index, 1, ...f.node.children);
}

function reverseSplit(s, split) {
  if (split.kind === 'tab') {
    const [a, b] = splitRecords(s, split.id);
    removeRecord(s, b.id);
    insertRecordAt(s, b, a.id, 'before');
  } else {
    findInSpaces(s, split.id).node.children.reverse();
  }
}

// Shows two open tabs in Chrome's split view, left then right. Chrome needs
// them adjacent, in the same window, group and pinned state, so line them up first.
async function ensureSplit(leftId, rightId) {
  if (!canSplit()) return;
  const get = id => chrome.tabs.get(id).catch(() => null);
  let [l, r] = await Promise.all([get(leftId), get(rightId)]);
  if (!l || !r) return;
  if (l.splitViewId > NO_SPLIT && l.splitViewId === r.splitViewId && l.index < r.index) return;
  for (const id of new Set([l.splitViewId, r.splitViewId])) {
    if (id > NO_SPLIT) await chrome.tabs.unsplit(id).catch(() => {});
  }
  if (r.windowId !== l.windowId) await chrome.tabs.move(r.id, { windowId: l.windowId, index: -1 });
  if (r.pinned !== l.pinned) await chrome.tabs.update(r.id, { pinned: l.pinned });
  r = await get(r.id);
  if (r.groupId !== l.groupId) {
    if (l.groupId === -1) await chrome.tabs.ungroup(r.id);
    else await chrome.tabs.group({ tabIds: r.id, groupId: l.groupId });
  }
  [l, r] = await Promise.all([get(l.id), get(r.id)]);
  if (r.index !== l.index + 1) await chrome.tabs.move(r.id, { index: r.index < l.index ? l.index : l.index + 1 });
  await chrome.tabs.createSplit([l.id, r.id]);
}

// Opens whichever sides of a split are closed, then splits them in Chrome.
async function openSplit(s, split, windowId) {
  const open = split.halves.find(h => h.tabId != null);
  const t = open && await chrome.tabs.get(open.tabId).catch(() => null);
  if (t) windowId = t.windowId;
  for (const h of split.halves) {
    if (h.tabId != null && await tabExists(h.tabId)) continue;
    const created = await chrome.tabs.create({ windowId, url: h.url || undefined, active: false });
    h.bind(created.id);
    h.tabId = created.id;
  }
  await ensureSplit(split.halves[0].tabId, split.halves[1].tabId);
}

// Drag and drop of one tab onto another, after the side panel's confirmation.
// The split lives where the target tab is: kept if pinned, archived if not.
// target: { kind: 'pinned' | 'tab', id, side: 'left' | 'right' } (the dragged tab's side)
async function makeSplit(s, item, target, windowId) {
  if (!canSplit()) throw new Error('Split view needs Chrome 155 or newer.');
  const rt = s.runtime;
  if (item.id === target.id || item.kind === 'fav') return;
  if (item.kind === 'tab' && rt.tabs.find(r => r.id === item.id)?.splitId) return;
  if (item.kind === 'pinned' && (findInSpaces(s, item.id)?.node.type !== 'tab' || splitOfEntry(s, item.id))) return;
  const position = target.side === 'left' ? 'before' : 'after';
  let split;
  if (target.kind === 'tab') {
    const rec = rt.tabs.find(r => r.id === target.id);
    if (!rec || rec.splitId) return;
    await move(s, item, { zone: 'unpinned', spaceId: rec.spaceId, refId: rec.id, position });
    const i = rt.tabs.indexOf(rec);
    const other = rt.tabs[position === 'before' ? i - 1 : i + 1];
    if (!other || other.splitId) return;
    rec.splitId = other.splitId = uid();
    split = splitById(s, rec.splitId);
  } else {
    const f = findInSpaces(s, target.id);
    if (!f || f.node.type !== 'tab' || splitOfEntry(s, target.id)) return;
    await move(s, item, { zone: 'pinned', spaceId: f.spaceId, refId: target.id, position });
    const g = findNode(spaceById(s, f.spaceId).pinned, target.id);
    const start = position === 'before' ? g.index - 1 : g.index;
    const pair = g.list.slice(start, start + 2);
    if (start < 0 || pair.length !== 2 || pair.some(n => n.type !== 'tab')) return;
    const node = { id: uid(), type: 'split', children: pair };
    g.list.splice(start, 2, node);
    split = splitById(s, node.id);
  }
  await openSplit(s, split, windowId);
  const shown = split.halves[position === 'before' ? 1 : 0].tabId;
  if (shown != null) await focusTab(shown);
  scheduleAllGroups();
}

// "Separate split view": two ordinary tabs again, in Sidecar and in Chrome.
async function separateSplit(s, id) {
  const split = splitById(s, id);
  if (!split) return;
  const t = split.halves[0].tabId != null && await chrome.tabs.get(split.halves[0].tabId).catch(() => null);
  if (t && t.splitViewId > NO_SPLIT) await chrome.tabs.unsplit(t.splitViewId).catch(() => {});
  dissolveSplit(s, split);
}

async function swapSplit(s, id) {
  const split = splitById(s, id);
  if (!split) return;
  reverseSplit(s, split);
  const [a, b] = split.halves;
  if (a.tabId != null && b.tabId != null) await ensureSplit(b.tabId, a.tabId);
}

// Chrome's own split view controls report through tabs.onUpdated. Wait a moment
// so a tab that closed is already gone, then bring Sidecar in line with Chrome.
// Sidecar's own split changes land here too, and are already in line.
const splitTimers = new Map();
function scheduleSplitCheck(tabId) {
  clearTimeout(splitTimers.get(tabId));
  splitTimers.set(tabId, setTimeout(() => {
    splitTimers.delete(tabId);
    mutate(s => syncSplitFromChrome(s, tabId));
  }, 400));
}

async function syncSplitFromChrome(s, tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return;
  const ours = splitOfTab(s, tabId);
  if (tab.splitViewId === NO_SPLIT) {
    if (!ours) return;
    // Closing one side ends Chrome's split, but the pair stays together in
    // Sidecar (pinned) or tidies itself away (unpinned). Only both sides still
    // open means the split was separated.
    const other = ours.halves.find(h => h.tabId !== tabId);
    if (other.tabId != null && !recentlyRemoved.has(other.tabId) && await tabExists(other.tabId)) dissolveSplit(s, ours);
    return;
  }
  const pair = (await chrome.tabs.query({ windowId: tab.windowId, splitViewId: tab.splitViewId })).sort((a, b) => a.index - b.index);
  if (pair.length !== 2) return;
  const [left, right] = pair.map(t => t.id);
  if (ours && ours.halves.every(h => h.tabId === left || h.tabId === right)) {
    if (ours.halves[0].tabId !== left) reverseSplit(s, ours); // sides swapped in Chrome
    return;
  }
  if (ours) dissolveSplit(s, ours);
  const theirs = splitOfTab(s, tabId === left ? right : left);
  if (theirs) dissolveSplit(s, theirs);
  adoptSplit(s, pair[0], pair[1]);
}

// A split made in Chrome joins the sidebar when both tabs are in the same
// section of the same space. A pinned tab split with an unpinned tab it opened
// (say, "open link in split view") becomes a pinned split; drag it below the
// line to let it archive. Any other mix stays as two rows.
function adoptSplit(s, leftTab, rightTab) {
  const leftId = leftTab.id, rightId = rightTab.id;
  const a = recordForTab(s, leftId), b = recordForTab(s, rightId);
  if (a && b) {
    if (a.spaceId !== b.spaceId) return;
    removeRecord(s, b.id);
    insertRecordAt(s, b, a.id, 'after');
    a.splitId = b.splitId = uid();
    return;
  }
  const ea = entryIdForTab(s, leftId), eb = entryIdForTab(s, rightId);
  const fa = ea && findInSpaces(s, ea), fb = eb && findInSpaces(s, eb);
  const rec = a || b;
  const pinnedSide = fa || fb;
  if (rec && pinnedSide && !(fa && fb)) {
    const [pinnedTab, recTab] = a ? [rightTab, leftTab] : [leftTab, rightTab];
    if (recTab.openerTabId !== pinnedTab.id || rec.spaceId !== pinnedSide.spaceId) return;
    removeRecord(s, rec.id);
    const node = recordToNode(s, rec);
    const children = a ? [node, pinnedSide.node] : [pinnedSide.node, node];
    pinnedSide.list.splice(pinnedSide.index, 1, { id: uid(), type: 'split', children });
    return;
  }
  if (!fa || !fb || fa.spaceId !== fb.spaceId) return;
  const pinned = spaceById(s, fa.spaceId).pinned;
  const right = removeNode(pinned, eb);
  const f = findNode(pinned, ea);
  f.list.splice(f.index, 1, { id: uid(), type: 'split', children: [f.node, right] });
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

  setEntryUrl: async (s, { id, url }) => {
    const e = findEntry(s, id);
    const b = s.runtime.bindings[id];
    if (!e) return;
    if (url) {
      // A typed URL: store it, and take an open tab there so it matches.
      e.entry.url = url;
      e.entry.title = url;
      if (b) await chrome.tabs.update(b.tabId, { url }).catch(() => {});
      return;
    }
    if (!b) return;
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
  split: (s, { item, target, windowId }) => makeSplit(s, item, target, windowId),
  unsplit: (s, { id }) => separateSplit(s, id),
  swapSplit: (s, { id }) => swapSplit(s, id),

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

  setBookmarkMirror: async (s, { enabled }) => {
    s.runtime.bookmarks.enabled = !!enabled;
    if (enabled) await mirrorBookmarks(s);
    return s.runtime.bookmarks;
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
  if ('splitViewId' in change) scheduleSplitCheck(tabId);
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
  // Chunks can arrive after the meta item, so any of them restarts the pull.
  if (area === 'sync' && Object.keys(changes).some(k => k === META_KEY || k.startsWith(CHUNK_PREFIX))) schedulePull();
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
    const unused = r => now - (r.lastActive || 0) > limit && !activeIds.has(r.tabId) && !audible.has(r.tabId);
    // Both sides of a split view are on screen together, so they archive together.
    const expired = s.runtime.tabs.filter(r => unused(r) && (!r.splitId || splitRecords(s, r.splitId).every(unused)));
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
  const split = splitOfTab(s, active.id);
  if (split) {
    // A split view pins and unpins as a pair, and can't be a favorite.
    if (command !== 'toggle-pin') return;
    const target = split.kind === 'tab'
      ? { zone: 'pinned', spaceId: split.spaceId, position: 'end' }
      : { zone: 'unpinned', spaceId: split.spaceId, position: 'start' };
    return move(s, { kind: 'split', id: split.id }, target);
  }
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
