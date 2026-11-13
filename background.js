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

import { uid, findNode, removeNode, walk, normalizeLayout, sameUrl, tidySplits, compactTitle, hostOf, isNewTabUrl } from './shared.js';
import { mergeArcImport, SYNC_LIMIT } from './arcimport.js';

// Storage keys keep the old "vtabs" name: renaming them would orphan existing synced layouts.
const META_KEY = 'vtabs_meta';
const CHUNK_PREFIX = 'vtabs_c';
const CHUNK_SIZE = 7000;          // chrome.storage.sync allows 8192 bytes per item
const RECONCILE_MS = 60_000;      // after a browser restart, re-match restored tabs for this long
const ARCHIVE_LIMIT = 500;
const ARCHIVE_MIN_OPEN_MS = 30_000; // closed tabs open for less than this aren't archived

let cache = null;
let lastLayoutKey = '';
let reconcileUntil = 0;
// Chrome restoring tabs after a restart looks like tabs opened from outside, so
// Smart Spaces waits this out. Only a real browser start, not reloading Sidecar
// (which also starts a reconcile).
let browserStartUntil = 0;
let queue = Promise.resolve();
const recentlyRemoved = new Map(); // tabId -> time removed

// ---------------------------------------------------------------------------
// State plumbing

function mutate(fn) {
  const run = queue.then(async () => {
    const s = await load();
    const result = await fn(s);
    await persist(s);
    // The change is saved (so the sidebar can redraw) before Undo's copy of it,
    // which is the bigger, slower write.
    if (undoDirty) {
      undoDirty = false;
      saveUndoSoon();
    }
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
    mru: Array.isArray(r.mru) ? r.mru : [], // tab ids, most recently used first (for the tab switcher)
    archived: Array.isArray(r.archived) ? r.archived : [],
    muteMode: !!r.muteMode,              // Mute All Tabs is on: tabs start muted until Unmute All
    stale: Array.isArray(r.stale) ? r.stale : [], // bindings waiting to be re-matched after restart
    lastSpaceId: r.lastSpaceId || null,
    sync: r.sync || { status: 'pending', at: 0, error: '', bytes: 0 }, // + size, titleBytes: see pushSync
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
  if (remote && remote.rev > s.layout.rev) s.layout = normalizeLayout(withLocalTitles(remote, s.layout));
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

function tidy(s) {
  for (const sp of s.layout.spaces) tidySplits(sp.pinned);
  tidySplitRecords(s);
}

async function persist(s) {
  tidy(s);
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
    openedAt: Date.now(),
  };
}

// Smart Spaces: the space this URL belongs in, if any.
// 1. A rule: its site matches that host and its subdomains ("www." ignored), and
//    a path in it must start the URL's path. Rules are checked in order.
// 2. Otherwise, the one space with a pinned tab on the same site. A site pinned
//    in more than one space gives no answer.
function smartSpaceFor(s, url) {
  const host = siteOf(url);
  if (!host) return null;
  const path = new URL(url).pathname.toLowerCase();
  for (const r of s.layout.settings.smartSpaceRules || []) {
    const [site, ...rest] = r.site.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split('/');
    if (!site || (host !== site && !host.endsWith(`.${site}`))) continue;
    if (rest.length && !path.startsWith(`/${rest.join('/')}`)) continue;
    if (spaceById(s, r.spaceId)) return r.spaceId;
  }
  const spaces = s.layout.spaces.filter(sp => {
    let found = false;
    walk(sp.pinned, n => { if (!found && n.type === 'tab' && siteOf(n.url) === host) found = true; });
    return found;
  });
  return spaces.length === 1 ? spaces[0].id : null;
}

// A web page's host without "www.", or '' for anything else.
function siteOf(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.hostname.toLowerCase().replace(/^www\./, '') : '';
  } catch {
    return '';
  }
}

const SMART_WAIT_MS = 5000;        // how long a tab opened without its URL yet can still be sent on
const SMART_LEARN_MS = 10 * 60000; // how long a tab opened from outside can teach a rule

// Moving a tab opened from outside to another space, as the first thing done
// with it, saves a rule for its site: that space, ahead of any other rule.
function learnSmartSpace(s, recs, spaceId) {
  for (const r of recs) {
    if (!r.smartLearnUntil || !spaceId || spaceId === r.spaceId) continue;
    const learn = Date.now() < r.smartLearnUntil;
    delete r.smartLearnUntil;
    const site = learn && siteOf(r.url);
    if (!site) continue;
    const rules = s.layout.settings.smartSpaceRules || [];
    s.layout.settings.smartSpaceRules = [{ site, spaceId }, ...rules.filter(x => x.site.toLowerCase() !== site)];
  }
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

// Adds records to the top of the archive. A URL is listed once: archiving it
// again moves it to the top.
function addToArchive(s, recs) {
  const now = Date.now();
  for (const r of recs) {
    if (!r.url || isNewTabUrl(r.url)) continue;
    s.runtime.archived = s.runtime.archived.filter(a => a.url !== r.url);
    s.runtime.archived.unshift({ url: r.url, title: r.customTitle || r.title, spaceId: r.spaceId, archivedAt: now });
  }
  s.runtime.archived.length = Math.min(s.runtime.archived.length, ARCHIVE_LIMIT);
}

async function archiveRecords(s, recs) {
  for (const r of recs) removeRecord(s, r.id);
  addToArchive(s, recs);
  await closeTabs(s, recs.map(r => r.tabId));
}

// An unpinned tab closed by hand goes to the archive too, unless it was only
// open briefly (a quick lookup, a sign-in popup). Records from before openedAt
// existed count as open long enough.
function archiveClosed(s, rec) {
  if (rec && Date.now() - (rec.openedAt || 0) >= ARCHIVE_MIN_OPEN_MS) addToArchive(s, [rec]);
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

// What a gzipped, base64'd layout takes in sync storage: the chunks, their
// keys and quotes, and the meta item. (Matches syncSize() in arcimport.js.)
const syncBytes = b64 => b64.length + Math.ceil(b64.length / CHUNK_SIZE) * 12 + 40;

// With page titles left out (Settings: "Sync page titles" off). Each computer
// keeps its own titles; withLocalTitles() puts them back on what arrives.
function withoutTitles(layout) {
  const out = structuredClone(layout);
  walk(out.favorites, n => { if (n.type === 'tab') n.title = ''; });
  for (const sp of out.spaces) walk(sp.pinned, n => { if (n.type === 'tab') n.title = ''; });
  return out;
}

function withLocalTitles(remote, local) {
  const titles = new Map();
  const note = n => { if (n.type === 'tab' && n.title) titles.set(n.id, n.title); };
  walk(local.favorites || [], note);
  for (const sp of local.spaces || []) walk(sp.pinned || [], note);
  const fill = n => { if (n && n.type === 'tab' && !n.title && titles.has(n.id)) n.title = titles.get(n.id); };
  walk(remote.favorites || [], fill);
  for (const sp of remote.spaces || []) walk(sp.pinned || [], fill);
  return remote;
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
    // Measured before saving, so the sidebar can warn as the limit nears and
    // a layout that's too big isn't sent (Chrome would refuse it anyway).
    const full = await gzipB64(JSON.stringify(s.layout));
    const bare = await gzipB64(JSON.stringify(withoutTitles(s.layout)));
    const data = s.layout.settings.syncTitles === false ? bare : full;
    sync.size = syncBytes(data);
    sync.titleBytes = syncBytes(full) - syncBytes(bare); // what titles take, or would
    if (sync.size > SYNC_LIMIT) {
      Object.assign(sync, { status: 'over', at: Date.now(), error: 'Over Chrome’s 100 KB sync limit' });
      return;
    }
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
    const msg = String(e.message || e);
    Object.assign(sync, { status: /quota/i.test(msg) ? 'over' : 'error', at: Date.now(), error: msg });
  }
}

function applyRemoteLayout(s, remote) {
  s.layout = normalizeLayout(withLocalTitles(remote, s.layout));
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
    f.node.children.push(node);
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
  if (src.rec || src.recs) learnSmartSpace(s, src.rec ? [src.rec] : src.recs, target.spaceId);

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

// Several items at once, kept in the order given (the sidebar's order). Each one
// lands at the same spot, so where a landing pushes the last one down, go in reverse.
async function moveMany(s, items, target) {
  if (target.zone === 'space') {
    // Pinned ones go to the end of the space's pinned tabs, unpinned ones to the top of its tabs.
    for (const it of items.filter(i => i.kind !== 'tab')) await move(s, it, target);
    for (const it of items.filter(i => i.kind === 'tab').reverse()) await move(s, it, target);
    return;
  }
  const reverse = ['after', 'start'].includes(target.position);
  for (const it of reverse ? [...items].reverse() : items) await move(s, it, target);
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
// Tab switcher, like ⌘Tab for tabs. The "switch-tab" shortcut (⌘E recommended) opens a
// small window listing open tabs, most recently used first; pressing it again
// while the window is up moves down the list. switcher.js does the rest.

const MRU_LIMIT = 300;
const SWITCHER_URL = 'switcher.html';
const SWITCHER_ROW = 36;   // keep in step with switcher.css and switcher.js
const SWITCHER_ROWS = 12;  // rows shown before the list scrolls (also in switcher.js)
const COMMAND_BAR_URL = 'commandbar.html';
let switcherWindowId = null;
let switcherFrom = null; // the window the switcher was opened from
let commandBarWindowId = null;
let lastNormalWindow = null; // last focused window with a Sidecar tab in it

// The switcher and command bar are Sidecar's own popup windows, not tabs to manage.
const isPopupTab = tab => tab.windowId === switcherWindowId || tab.windowId === commandBarWindowId ||
  [SWITCHER_URL, COMMAND_BAR_URL].some(p => tabUrl(tab).startsWith(chrome.runtime.getURL(p)));

// A popup window centred near the top of the window it was opened from.
async function popupProps(url, windowId, width, height) {
  const props = { url, type: 'popup', focused: true, width, height };
  const base = await chrome.windows.get(windowId).catch(() => null);
  if (base && base.left != null) {
    props.left = Math.round(base.left + (base.width - width) / 2);
    props.top = Math.round(base.top + (base.height - height) / 3);
  }
  return props;
}

function touchMru(s, tabId) {
  if (!recordForTab(s, tabId) && !entryIdForTab(s, tabId)) return; // not a tab in a normal window
  s.runtime.mru = [tabId, ...s.runtime.mru.filter(id => id !== tabId)].slice(0, MRU_LIMIT);
}

async function openSwitcher(windowId, at) {
  if (switcherWindowId != null) {
    if (await chrome.windows.get(switcherWindowId).catch(() => null)) {
      chrome.runtime.sendMessage({ type: 'switcherNext' }).catch(() => {});
      return;
    }
    switcherWindowId = null;
  }
  const count = (await chrome.tabs.query({ windowType: 'normal' })).filter(t => !isNewTabUrl(tabUrl(t))).length;
  const height = Math.min(Math.max(count, 2), SWITCHER_ROWS) * SWITCHER_ROW + 16 + 28; // rows + padding + title bar
  const url = at == null ? SWITCHER_URL : `${SWITCHER_URL}?at=${at}`;
  if (at == null) switcherFrom = windowId; // reopened after ⌘W: still the first window
  switcherWindowId = (await chrome.windows.create(await popupProps(url, windowId, 480, height))).id;
}

// ⌘W in the switcher closes the selected tab, and the switcher stays up on the
// rest. Chrome keeps ⌘W for itself, so the page never sees it: Chrome closes the
// switcher's own tab instead. That's told apart from the switcher closing any
// other way (Esc, a switch, its close button), which closes the whole window.
let switcherSel = null; // { tabId, index } of the selected row, as the page reports it

chrome.runtime.onMessage.addListener(msg => {
  if (msg && msg.type === 'switcherSelect') switcherSel = msg;
});

chrome.tabs.onRemoved.addListener(async (tabId, { windowId, isWindowClosing }) => {
  if (windowId !== switcherWindowId || isWindowClosing) return;
  switcherWindowId = null;
  const sel = switcherSel;
  switcherSel = null;
  const tab = sel && await chrome.tabs.get(sel.tabId).catch(() => null);
  if (!tab) return;
  await chrome.tabs.remove(tab.id).catch(() => {});
  await openSwitcher(tab.windowId, sel.index);
});

async function closeSwitcher() {
  const id = switcherWindowId;
  switcherWindowId = null;
  if (id != null) await chrome.windows.remove(id).catch(() => {});
}

// Open tabs in switcher order, named as the sidebar names them.
async function switcherList(s) {
  const open = await chrome.tabs.query({ windowType: 'normal' });
  const byId = new Map(open.map(t => [t.id, t]));
  // Tabs never used since Sidecar started go last, in tab strip order.
  s.runtime.mru = [...new Set([...s.runtime.mru.filter(id => byId.has(id)), ...open.map(t => t.id)])].slice(0, MRU_LIMIT);
  // Blank New Tabs aren't worth switching to. The first entry is the tab you're
  // on, marked so the switcher can start one below it.
  const current = s.runtime.mru[0];
  return s.runtime.mru.filter(id => !isNewTabUrl(tabUrl(byId.get(id)))).map(id => {
    const t = byId.get(id);
    const url = tabUrl(t);
    const eid = entryIdForTab(s, t.id);
    const custom = recordForTab(s, t.id)?.customTitle || (eid && findEntry(s, eid)?.entry.customTitle) || '';
    const spaceId = spaceOfTab(s, t.id);
    const space = spaceId ? spaceById(s, spaceId) : null;
    return {
      tabId: t.id,
      title: custom || (s.layout.settings.compactTitles ? compactTitle(t.title, url) : t.title || hostOf(url) || 'New Tab'),
      url,
      favIconUrl: t.favIconUrl || '',
      space: spaceId === null ? '★' : space ? space.icon || space.name : '',
      color: space ? space.color : null,
      current: id === current,
    };
  });
}

// ---------------------------------------------------------------------------
// Command bar, like Arc's: the "command-bar" shortcut (⌘T recommended) opens a
// small window to type a URL or search, find a tab, or run a command on the
// current tab. commandbar.js lists the commands; runBarAction carries them out.

const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

async function openCommandBar(windowId) {
  if (commandBarWindowId != null) return closeCommandBar(); // the shortcut again closes it
  const url = `${COMMAND_BAR_URL}?window=${windowId}`;
  commandBarWindowId = (await chrome.windows.create(await popupProps(url, windowId, 600, 470))).id;
}

async function closeCommandBar(id = commandBarWindowId) {
  if (id === commandBarWindowId) commandBarWindowId = null;
  if (id != null) await chrome.windows.remove(id).catch(() => {});
}

// The tab a command acts on, and how Sidecar knows it.
async function barTarget(s, windowId) {
  const [tab] = await chrome.tabs.query({ windowId, active: true }).catch(() => []);
  if (!tab) return {};
  const rec = recordForTab(s, tab.id);
  const eid = entryIdForTab(s, tab.id);
  const fav = !!eid && s.layout.favorites.some(f => f.id === eid);
  const split = splitOfTab(s, tab.id);
  // As move() names it.
  const item = split ? { kind: 'split', id: split.id } : rec ? { kind: 'tab', id: rec.id } : eid ? { kind: fav ? 'fav' : 'pinned', id: eid } : null;
  return { tab, rec, eid, fav, split, item };
}

async function commandBarData(s, windowId) {
  const { tab, eid, fav, split, item } = await barTarget(s, windowId);
  const url = tab ? tabUrl(tab) : '';
  const tabs = (await switcherList(s)).filter(t => t.tabId !== tab?.id);
  // Pinned tabs and favorites that aren't open can be found and opened too.
  const entries = [];
  const addEntry = (n, space) => {
    if (n.type !== 'tab' || s.runtime.bindings[n.id]) return;
    entries.push({ id: n.id, title: n.customTitle || n.title || hostOf(n.url), url: n.url, space: space ? space.icon || space.name : '★', color: space?.color });
  };
  for (const f of s.layout.favorites) addEntry(f, null);
  for (const sp of s.layout.spaces) walk(sp.pinned, n => addEntry(n, sp));
  const splitWith = !split && !fav && item && canSplit()
    ? tabs.find(t => !splitOfTab(s, t.tabId) && (recordForTab(s, t.tabId) || findInSpaces(s, entryIdForTab(s, t.tabId))))
    : null;
  const entry = eid && !fav ? findEntry(s, eid)?.entry : null;
  return {
    ctx: {
      tabId: tab?.id ?? null,
      page: !!tab && !isNewTabUrl(url),
      url,
      title: tab?.title || '',
      inSidecar: !!item,
      pinned: !!entry || split?.kind === 'pinned',
      favorite: fav,
      unpinned: item?.kind === 'tab' || split?.kind === 'tab',
      split: !!split,
      movedFromPin: !!entry && !sameUrl(entry.url, url),
      splitWith: splitWith ? { tabId: splitWith.tabId, title: splitWith.title } : null,
      spaceId: getWindowSpace(s, windowId),
      undo: (await undoList()).at(-1)?.label || '',
      muteMode: s.runtime.muteMode,
      anyMuted: (await chrome.tabs.query({ muted: true })).length > 0,
    },
    spaces: s.layout.spaces.map(sp => ({ id: sp.id, name: sp.name, icon: sp.icon, color: sp.color })),
    tabs,
    entries,
    // Archived tabs can be found too; each is known by when it was archived plus its URL.
    archived: s.runtime.archived.map(a => {
      const space = spaceById(s, a.spaceId);
      return { key: archiveKey(a), title: a.title || hostOf(a.url), url: a.url, space: space ? space.icon || space.name : '', color: space?.color };
    }),
  };
}

async function runBarAction(s, windowId, action, arg) {
  await chrome.windows.update(windowId, { focused: true }).catch(() => {});
  const { tab, rec, eid, fav, split, item } = await barTarget(s, windowId);
  const id = tab?.id;
  // A typed URL or search opens in a new tab, or in this one if it's a blank New Tab.
  const blankTab = async () => (tab && isNewTabUrl(tabUrl(tab)) ? tab : chrome.tabs.create({ windowId, active: true }));
  switch (action) {
    case 'open-url': return chrome.tabs.update((await blankTab()).id, { url: arg });
    case 'search': return chrome.search.query({ text: arg, tabId: (await blankTab()).id });
    case 'focus-tab': return focusTab(arg);
    case 'open-entry': return activate(s, { kind: 'pinned', id: arg, windowId });
    case 'restore-archived': {
      // Back into the space it was archived from.
      const i = s.runtime.archived.findIndex(a => archiveKey(a) === arg);
      if (i < 0) return;
      const [a] = s.runtime.archived.splice(i, 1);
      if (spaceById(s, a.spaceId)) await switchSpace(s, windowId, a.spaceId);
      return chrome.tabs.create({ windowId, url: a.url, active: true });
    }
    case 'open-page': return chrome.tabs.create({ windowId, url: arg });
    case 'screenshot': {
      // Just the page: no tab strip, toolbar or side panel. Named like a macOS screenshot.
      const url = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
      const d = new Date();
      const p = n => String(n).padStart(2, '0');
      const filename = `Screenshot ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} at ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}.png`;
      return chrome.downloads.download({ url, filename, conflictAction: 'uniquify' });
    }
    case 'undo': return undo(s, windowId);
    case 'next-space': return cycleSpace(s, windowId, 1);
    case 'prev-space': return cycleSpace(s, windowId, -1);
    case 'focus-space': return switchSpace(s, windowId, arg);
    case 'new-space': return handlers.createSpace(s, { windowId, name: arg });
    case 'clear-unpinned': return handlers.clearSpace(s, { spaceId: getWindowSpace(s, windowId) });
    case 'clear-archive': return handlers.clearArchive(s);
    case 'mute-all': return handlers.setMuteMode(s, { on: true });
    case 'unmute-all': return handlers.setMuteMode(s, { on: false });
    // Everything Chrome keeps about where you've been, for all time, then
    // Sidecar's own copies. Passwords, autofill, bookmarks and tabs stay.
    case 'clear-all-data':
      await chrome.browsingData.remove({ since: 0 }, {
        history: true, downloads: true, cookies: true, cache: true, cacheStorage: true,
        localStorage: true, indexedDB: true, serviceWorkers: true, fileSystems: true,
      });
      return handlers.clearArchive(s);
    case 'new-window': return chrome.windows.create({});
    case 'new-incognito': return chrome.windows.create({ incognito: true });
    case 'minimize-window': return chrome.windows.update(windowId, { state: 'minimized' });
    case 'close-window': return chrome.windows.remove(windowId);
    case 'fullscreen': {
      const w = await chrome.windows.get(windowId);
      return chrome.windows.update(windowId, { state: w.state === 'fullscreen' ? 'normal' : 'fullscreen' });
    }
  }
  if (id == null) return;
  switch (action) {
    case 'reload': return chrome.tabs.reload(id);
    case 'back': return chrome.tabs.goBack(id).catch(() => {});
    case 'forward': return chrome.tabs.goForward(id).catch(() => {});
    case 'duplicate': return chrome.tabs.duplicate(id);
    // Cookies go for the whole site (mail.google.com clears all of google.com),
    // along with what the site has stored. Then a reload shows the result.
    case 'clear-site-cookies':
    case 'clear-site-cache': {
      const url = tabUrl(tab);
      if (!/^https?:/.test(url)) return;
      const types = action === 'clear-site-cache'
        ? { cache: true }
        : { cookies: true, localStorage: true, indexedDB: true, serviceWorkers: true, cacheStorage: true, fileSystems: true };
      await chrome.browsingData.remove({ origins: [new URL(url).origin] }, types);
      return chrome.tabs.reload(id, { bypassCache: true });
    }
    case 'close-tab':
      // Off the sidebar first, so undoing puts it back.
      if (rec) archiveClosed(s, removeRecord(s, rec.id));
      else if (eid) delete s.runtime.bindings[eid];
      return closeTabs(s, [id]);
    case 'zoom-in':
    case 'zoom-out': {
      const z = await chrome.tabs.getZoom(id);
      const next = action === 'zoom-in' ? ZOOM_STEPS.find(v => v > z + 0.001) : ZOOM_STEPS.findLast(v => v < z - 0.001);
      return next && chrome.tabs.setZoom(id, next);
    }
    case 'zoom-reset': return chrome.tabs.setZoom(id, 0);
    case 'toggle-pin':
    case 'toggle-favorite': return runCommand(s, action, tab);
    case 'archive-tab':
      if (rec) return archiveRecords(s, rec.splitId ? splitRecords(s, rec.splitId) : [rec]);
      return;
    case 'rename':
      if (rec) return handlers.rename(s, { kind: 'tab', id: rec.id, name: arg });
      if (eid) return handlers.rename(s, { kind: 'pinned', id: eid, name: arg });
      return;
    case 'reset-pin': {
      const e = eid && !fav && findEntry(s, eid);
      return e && chrome.tabs.update(id, { url: e.entry.url });
    }
    case 'replace-pin': return eid && !fav && handlers.setEntryUrl(s, { id: eid });
    case 'move-to-space':
      if (!item) return;
      await move(s, item, { zone: 'space', spaceId: arg });
      return switchSpace(s, windowId, arg); // follow the tab there
    case 'split-with': {
      const otherRec = recordForTab(s, arg);
      const otherEid = entryIdForTab(s, arg);
      const other = otherRec ? { kind: 'tab', id: otherRec.id } : otherEid ? { kind: 'pinned', id: otherEid } : null;
      if (!other || !item || item.kind === 'split' || item.kind === 'fav') return;
      return makeSplit(s, other, { ...item, side: 'right' }, windowId);
    }
    case 'unsplit': return split && separateSplit(s, split.id);
    case 'swap-split': return split && swapSplit(s, split.id);
  }
}

// ---------------------------------------------------------------------------
// Undo. Each action from the sidebar, the command bar or a shortcut, and each
// tab closed in Chrome, keeps a copy of the state from just before and just
// after it. Undoing is a three-way merge, like git revert: what the action
// changed goes back, and whatever changed since (titles, new tabs, edits from
// another computer) stays. Tabs it closed reopen from Chrome's recently closed
// list, so they keep their history, and tabs it opened close. Newest first, this
// computer only, kept in storage.session so a browser restart clears it.
//
// To keep each action cheap, a copy leaves out the parts the action didn't
// change (spaces, favorites, rules, archive; unpinned tabs and bindings are
// small and always kept), and each entry is stored under its own key, so an
// action writes only its own entry plus the short list of keys.

const UNDO_LIMIT = 20;
const UNDO_BYTES = 4_000_000; // of storage.session's 10 MB
let undoStack = null;

const archiveKey = a => `${a.archivedAt} ${a.url}`;

// Parts of a copy left out when an action didn't change them. Unpinned tabs and
// bindings are always kept: they're small, and undoing needs exactly what they
// were before the action.
const UNDO_OPTIONAL = ['spaces', 'favorites', 'rules', 'archived'];

function undoState(s) {
  return structuredClone({
    spaces: s.layout.spaces,
    favorites: s.layout.favorites,
    rules: s.layout.settings.smartSpaceRules || [],
    tabs: s.runtime.tabs,
    bindings: s.runtime.bindings,
    archived: s.runtime.archived.map(a => ({ ...a, id: archiveKey(a) })),
  });
}

function heldTabs(st) {
  const ids = new Set();
  for (const r of st.tabs) if (r.tabId != null) ids.add(r.tabId);
  for (const b of Object.values(st.bindings)) ids.add(b.tabId);
  return ids;
}

// Split views as [leftTabId, rightTabId], both open.
function splitPairs(st) {
  const bySplit = {};
  for (const r of st.tabs) if (r.splitId) (bySplit[r.splitId] ||= []).push(r.tabId);
  const pairs = Object.values(bySplit).filter(p => p.length === 2);
  for (const sp of st.spaces) {
    walk(sp.pinned, n => {
      if (n.type === 'split' && n.children.length === 2) pairs.push(n.children.map(c => st.bindings[c.id]?.tabId));
    });
  }
  return pairs.filter(p => p.every(id => id != null));
}

const liveTabs = async () => new Map((await chrome.tabs.query({}).catch(() => [])).map(t => [t.id, t]));

const isPlain = v => v !== null && typeof v === 'object' && !Array.isArray(v);

function deepEqual(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every(k => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
}

// Whether something is there after the undo: as before the action, unless it
// came or went since.
const keepAfterUndo = (inB, inA, inN) => (inA === inN ? inB : inN);

// b: before the action, a: just after it, n: now.
function merge3(b, a, n) {
  if (deepEqual(n, a)) return structuredClone(b);
  if (deepEqual(b, a)) return n;
  if (isPlain(b) && isPlain(a) && isPlain(n)) {
    const out = {};
    for (const k of new Set([...Object.keys(b), ...Object.keys(a), ...Object.keys(n)])) {
      const v = mergeItem(k, new Map(Object.entries(b)), new Map(Object.entries(a)), new Map(Object.entries(n)));
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  const keyed = v => Array.isArray(v) && v.every(x => isPlain(x) && typeof x.id === 'string');
  if (keyed(b) && keyed(a) && keyed(n)) return mergeList(b, a, n);
  return n;
}

function mergeItem(k, mb, ma, mn) {
  const inB = mb.has(k), inA = ma.has(k), inN = mn.has(k);
  if (!keepAfterUndo(inB, inA, inN)) return undefined;
  if (!inB) return mn.get(k);
  if (!inN) return structuredClone(mb.get(k));
  return inA ? merge3(mb.get(k), ma.get(k), mn.get(k)) : mn.get(k);
}

// Lists of things with ids (spaces, pinned trees, records). Order: as before the
// action, unless it has been reordered since.
function mergeList(b, a, n) {
  const byId = l => new Map(l.map(x => [x.id, x]));
  const mb = byId(b), ma = byId(a), mn = byId(n);
  const out = new Map();
  for (const id of new Set([...mb.keys(), ...ma.keys(), ...mn.keys()])) {
    const v = mergeItem(id, mb, ma, mn);
    if (v !== undefined) out.set(id, v);
  }
  const ids = l => l.map(x => x.id);
  const reordered = !deepEqual(ids(a).filter(id => mn.has(id)), ids(n).filter(id => ma.has(id)));
  const [first, second] = reordered ? [ids(n), ids(b)] : [ids(b), ids(n)];
  const order = first.filter(id => out.has(id));
  let at = -1;
  for (const id of second) {
    const i = order.indexOf(id);
    if (i >= 0) at = i;
    else if (out.has(id)) order.splice(++at, 0, id);
  }
  return order.map(id => out.get(id));
}

const savedUndoKeys = new Set(); // entries already in storage.session

async function undoList() {
  if (!undoStack) {
    const { undoKeys = [] } = await chrome.storage.session.get('undoKeys').catch(() => ({}));
    const got = undoKeys.length ? await chrome.storage.session.get(undoKeys).catch(() => ({})) : {};
    undoStack = undoKeys.map(k => got[k]).filter(Boolean);
    for (const e of undoStack) savedUndoKeys.add(e.key);
    chrome.storage.session.remove('undo').catch(() => {}); // the whole list, as versions before 1.2.4 kept it
  }
  return undoStack;
}

// Set when an action adds an Undo entry; mutate() then saves the list after
// the change itself. Saves run one at a time, and one already waiting covers
// any entries added meanwhile (it saves the list as it is when it runs).
let undoDirty = false;
let undoSaving = Promise.resolve();
let undoSaveWaiting = false;
function saveUndoSoon() {
  if (undoSaveWaiting) return;
  undoSaveWaiting = true;
  undoSaving = undoSaving.then(() => {
    undoSaveWaiting = false;
    return saveUndo();
  });
}

// Writes the entries not stored yet and the list of keys, then removes
// entries that have dropped off (oldest first, past 20 or 4 MB) or been undone.
async function saveUndo() {
  const stack = await undoList();
  for (const e of stack) if (e.size == null) e.size = JSON.stringify(e).length;
  let bytes = stack.reduce((n, e) => n + e.size, 0);
  while (stack.length > UNDO_LIMIT || (stack.length > 1 && bytes > UNDO_BYTES)) bytes -= stack.shift().size;
  const items = { undoKeys: stack.map(e => e.key), undoLabel: stack.at(-1)?.label || '' };
  for (const e of stack) if (!savedUndoKeys.has(e.key)) items[e.key] = e;
  try {
    await chrome.storage.session.set(items);
    for (const e of stack) savedUndoKeys.add(e.key);
    const kept = new Set(items.undoKeys);
    const gone = [...savedUndoKeys].filter(k => !kept.has(k));
    if (gone.length) {
      await chrome.storage.session.remove(gone);
      for (const k of gone) savedUndoKeys.delete(k);
    }
  } catch (e) {
    console.warn('[sidecar] could not save undo', e);
  }
}

async function clearUndo() {
  (await undoList()).length = 0; // loaded first, so stored entries are known and get removed
  await saveUndo();
}

// Runs an action, keeping what's needed to undo it. closedTabId: a tab Chrome
// already closed, which the action is tidying up after.
async function recordUndo(s, label, fn, closedTabId = null) {
  if (!label) return fn(s);
  const before = undoState(s);
  const liveBefore = await liveTabs();
  const result = await fn(s);
  tidy(s); // as persist() will, so the copy matches what's saved
  const after = undoState(s);
  if (deepEqual(before, after)) return result;
  const liveAfter = await liveTabs();
  const closed = [...heldTabs(before)].filter(id => (liveBefore.has(id) || id === closedTabId) && !liveAfter.has(id));
  // A blank New Tab opened in passing (closing the last tab of a space) stays.
  const opened = [...liveAfter.values()].filter(t => !liveBefore.has(t.id) && !isPopupTab(t) && !isNewTabUrl(tabUrl(t))).map(t => t.id);
  const afterSplits = splitPairs(after); // what undoing compares Chrome's split views against
  // Parts the action didn't change aren't kept: undoing leaves them as they are now.
  for (const k of UNDO_OPTIONAL) {
    if (deepEqual(before[k], after[k])) {
      delete before[k];
      delete after[k];
    }
  }
  const entry = { key: `undo:${uid()}`, label, at: Date.now(), before, after, afterSplits, closed, opened };
  (await undoList()).push(entry);
  undoDirty = true; // saved by mutate() once the change itself is
  return result;
}

// A recently closed tab with this URL, reopened with its history; otherwise a new tab.
async function reopenTab(url, windowId, used) {
  const recent = await chrome.sessions.getRecentlyClosed().catch(() => []);
  const hit = recent.map(e => e.tab).find(t => t && t.sessionId && !used.has(t.sessionId) && sameUrl(t.url, url));
  if (hit) {
    used.add(hit.sessionId);
    const restored = await chrome.sessions.restore(hit.sessionId).catch(() => null);
    if (restored?.tab) return restored.tab.id;
  }
  const t = await chrome.tabs.create({ windowId, url: url || undefined, active: false }).catch(() => null);
  return t ? t.id : null;
}

const isOurPopup = e => e.window && e.window.tabs.every(t => [SWITCHER_URL, COMMAND_BAR_URL].some(p => (t.url || '').startsWith(chrome.runtime.getURL(p))));

// Returns what to tell the user.
async function undo(s, windowId) {
  if (windowId == null) windowId = (await chrome.windows.getLastFocused().catch(() => null))?.id;
  const stack = await undoList();
  const entry = stack.at(-1);
  // A window closed since isn't something Sidecar keeps: it comes back first, as
  // Chrome's own reopen would bring it. With nothing to undo, so does a tab.
  const recent = (await chrome.sessions.getRecentlyClosed().catch(() => [])).find(e => !isOurPopup(e));
  if (recent && (entry ? recent.window && recent.lastModified * 1000 > entry.at : true)) {
    await chrome.sessions.restore((recent.window || recent.tab).sessionId);
    return recent.window ? 'Closed Window Reopened' : 'Closed Tab Reopened';
  }
  if (!entry) return 'Nothing to Undo';
  stack.pop();
  await saveUndo();
  await applyUndo(s, entry, windowId);
  return `${entry.label} Undone`;
}

async function applyUndo(s, { before, after, afterSplits, closed, opened }, windowId) {
  const now = undoState(s);
  const st = {};
  for (const k of Object.keys(before)) st[k] = merge3(before[k], after[k], now[k]);
  for (const k of UNDO_OPTIONAL) if (!(k in st)) st[k] = now[k]; // left out: the action didn't change it
  if (!st.spaces.length) st.spaces = now.spaces;

  // Each pinned entry and each tab in one place only.
  const seen = new Set();
  const dedupe = nodes => nodes.filter(n => {
    if (seen.has(n.id)) return false;
    seen.add(n.id);
    if (n.children) n.children = dedupe(n.children);
    return true;
  });
  for (const sp of st.spaces) sp.pinned = dedupe(sp.pinned);
  st.favorites = dedupe(st.favorites);

  // Tabs the action opened close again, along with whatever has listed them since.
  const openedSet = new Set(opened);
  const beforeRec = new Map(before.tabs.map(r => [r.id, r]));
  st.tabs = st.tabs.filter(r => !openedSet.has(r.tabId) || beforeRec.get(r.id)?.tabId === r.tabId);
  for (const [eid, b] of Object.entries(st.bindings)) {
    if (openedSet.has(b.tabId) && before.bindings[eid]?.tabId !== b.tabId) delete st.bindings[eid];
  }

  const live = await liveTabs();
  const held = new Set();
  const reopen = [];
  const closedSet = new Set(closed);
  for (const r of st.tabs) {
    if (r.tabId == null) continue;
    if (held.has(r.tabId)) r.tabId = null;
    else if (live.has(r.tabId)) held.add(r.tabId);
    else if (closedSet.has(r.tabId)) reopen.push({ url: r.url, bind: id => { r.tabId = id; } });
    else r.tabId = null;
  }
  for (const [eid, b] of Object.entries(st.bindings)) {
    if (held.has(b.tabId)) delete st.bindings[eid];
    else if (live.has(b.tabId)) held.add(b.tabId);
    else if (closedSet.has(b.tabId)) reopen.push({ url: b.url, bind: id => { b.tabId = id; } });
    else delete st.bindings[eid];
  }

  s.layout.spaces = st.spaces;
  s.layout.favorites = st.favorites;
  s.layout.settings.smartSpaceRules = st.rules;
  s.runtime.tabs = st.tabs;
  s.runtime.bindings = st.bindings;
  if ('archived' in before) s.runtime.archived = st.archived.map(({ id, ...a }) => a).slice(0, ARCHIVE_LIMIT);

  // An open tab the undo would leave out of the sidebar stays, as a new unpinned tab.
  for (const id of heldTabs(now)) {
    const t = live.get(id);
    if (t && !held.has(id) && !openedSet.has(id)) insertRecordAt(s, newRecord(t, getWindowSpace(s, t.windowId)), null, 'start');
  }
  await closeTabs(s, opened.filter(id => live.has(id) && !held.has(id)));

  const used = new Set();
  for (const h of reopen) {
    const id = await reopenTab(h.url, windowId, used);
    if (id != null) h.bind(id);
  }
  // Bindings may point at entries that no longer exist: those tabs become unpinned tabs.
  pruneRuntime(s);

  // Chrome's split views follow.
  if (canSplit()) {
    const key = p => p.join(' ');
    const wanted = splitPairs({ spaces: s.layout.spaces, tabs: s.runtime.tabs, bindings: s.runtime.bindings });
    const had = afterSplits || splitPairs(after);
    const wantedKeys = new Set(wanted.map(key));
    const hadKeys = new Set(had.map(key));
    for (const [l] of had.filter(p => !wantedKeys.has(key(p)) && !wantedKeys.has(key([...p].reverse())))) {
      const t = await chrome.tabs.get(l).catch(() => null);
      if (t && t.splitViewId > NO_SPLIT) await chrome.tabs.unsplit(t.splitViewId).catch(() => {});
    }
    for (const [l, r] of wanted.filter(p => !hadKeys.has(key(p)))) await ensureSplit(l, r).catch(() => {});
  }

  // Something going back to another space: follow it there, as moving it did.
  const where = st => {
    const m = new Map(st.tabs.map(r => [r.id, { spaceId: r.spaceId, tabId: r.tabId }]));
    for (const sp of st.spaces) walk(sp.pinned, n => { if (n.type === 'tab') m.set(n.id, { spaceId: sp.id, tabId: st.bindings[n.id]?.tabId }); });
    return m;
  };
  const was = where(now);
  const back = [...where({ spaces: s.layout.spaces, tabs: s.runtime.tabs, bindings: s.runtime.bindings })]
    .find(([id, w]) => was.has(id) && was.get(id).spaceId !== w.spaceId)?.[1];
  if (back && windowId != null) {
    await switchSpace(s, windowId, back.spaceId);
    const t = back.tabId != null && await chrome.tabs.get(back.tabId).catch(() => null);
    if (t && t.windowId === windowId) await chrome.tabs.update(t.id, { active: true }).catch(() => {});
  }
  scheduleAllGroups();
}

// What each undoable message is called, from the state before it runs. Short,
// so "… Undone" fits in the sidebar's toast.
const tabsWord = n => (n === 1 ? 'Tab' : 'Tabs');
const toSpace = (s, spaceId) => `Move to ${spaceById(s, spaceId)?.name || 'Space'}`;
const isPinnedItem = (s, it) => it.kind === 'pinned' || it.kind === 'fav' || (it.kind === 'split' && !!findInSpaces(s, it.id));

function moveLabel(s, items, target) {
  if (target.zone === 'space') return toSpace(s, target.spaceId);
  if (target.zone === 'favorites') return 'Add to Favorites';
  if (target.zone === 'pinned' && items.some(it => it.kind !== 'pinned')) return 'Move to Pinned';
  if (target.zone === 'unpinned' && items.some(it => isPinnedItem(s, it))) return 'Move to Unpinned';
  return `Move ${tabsWord(items.length)}`;
}

function deleteLabel(s, id) {
  const node = findInSpaces(s, id)?.node;
  return node?.type === 'folder' ? 'Delete Folder' : 'Delete Pinned Tab';
}

const UNDO_LABELS = {
  minimize: () => 'Close Tab',
  closeTab: () => 'Close Tab',
  deleteEntry: (s, m) => deleteLabel(s, m.id),
  rename: (s, m) => (m.kind === 'space' ? 'Rename Space' : 'Rename'),
  setEntryUrl: () => 'Change Pinned URL',
  newFolder: () => 'New Folder',
  move: (s, m) => moveLabel(s, [m.item], m.target),
  moveMany: (s, m) => moveLabel(s, m.items, m.target),
  closeMany: (s, m) => `Close ${tabsWord(m.items.length)}`,
  deleteMany: (s, m) => (m.items.length === 1 && m.items[0].kind !== 'tab' ? deleteLabel(s, m.items[0].id) : 'Delete'),
  duplicateMany: (s, m) => `Duplicate ${tabsWord(m.items.length)}`,
  folderFrom: () => 'New Folder',
  split: () => 'Split View',
  unsplit: () => 'Separate Split View',
  swapSplit: () => 'Swap Split Sides',
  pinTab: () => 'Pin Tab',
  unpin: () => 'Unpin Tab',
  favorite: () => 'Add to Favorites',
  unfavorite: () => 'Remove from Favorites',
  moveToSpace: (s, m) => toSpace(s, m.spaceId),
  createSpace: () => 'New Space',
  importArc: () => 'Import from Arc',
  updateSpace: () => 'Edit Space',
  reorderSpace: () => 'Move Space',
  deleteSpace: () => 'Delete Space',
  clearSpace: () => 'Clear Unpinned Tabs',
  restoreArchived: () => 'Reopen from Archive',
  commandBarRun: (s, m) => barUndoLabel(s, m.windowId, m.action, m.arg),
};

// Command bar actions and shortcuts act on the current tab.
async function barUndoLabel(s, windowId, action, arg) {
  const fixed = {
    'restore-archived': 'Reopen from Archive',
    'new-space': 'New Space',
    'clear-unpinned': 'Clear Unpinned Tabs',
    unsplit: 'Separate Split View',
    'swap-split': 'Swap Split Sides',
    'split-with': 'Split View',
    duplicate: 'Duplicate Tab',
    'close-tab': 'Close Tab',
    'archive-tab': 'Archive Tab',
    rename: 'Rename',
    'replace-pin': 'Change Pinned URL',
  }[action];
  if (fixed) return fixed;
  if (action === 'move-to-space') return toSpace(s, arg);
  if (action !== 'toggle-pin' && action !== 'toggle-favorite') return null;
  const { tab, rec, fav } = await barTarget(s, windowId);
  if (!tab) return null;
  if (action === 'toggle-pin') return rec ? 'Pin Tab' : 'Unpin Tab';
  return fav ? 'Remove from Favorites' : 'Add to Favorites';
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
    archiveClosed(s, r);
    if (r) await closeTabs(s, [r.tabId]);
  },
  newTab: (s, m) => chrome.tabs.create({ windowId: m.windowId }),
  undo: (s, { windowId }) => undo(s, windowId),

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

  // At the bottom of the space's pinned tabs or of a parent folder, or
  // just above the pinned node beforeId.
  newFolder: (s, { spaceId, parentId, beforeId }) => {
    const sp = spaceById(s, spaceId);
    if (!sp) return null;
    const folder = { id: uid(), type: 'folder', name: 'New Folder', collapsed: false, children: [] };
    const parent = parentId ? findNode(sp.pinned, parentId)?.node : null;
    if (parent && parent.type === 'folder') {
      parent.children.push(folder);
      parent.collapsed = false;
    } else if (beforeId) {
      insertTree(sp.pinned, folder, splitOfEntry(s, beforeId)?.node.id || beforeId, 'before');
    } else {
      sp.pinned.push(folder);
    }
    return folder.id;
  },

  toggleFolder: (s, { id }) => {
    const f = findInSpaces(s, id);
    if (f && f.node.type === 'folder') f.node.collapsed = !f.node.collapsed;
  },

  move: (s, { item, target, windowId }) => handlers.moveMany(s, { items: [item], target, windowId }),
  // Returns the Smart Spaces rules this taught, if any, so the sidebar can offer Undo.
  moveMany: async (s, { items, target, windowId }) => {
    const before = s.layout.settings.smartSpaceRules || [];
    await moveMany(s, items, target);
    // Dropped on a space icon: follow it there.
    if (target.zone === 'space' && windowId != null) await switchSpace(s, windowId, target.spaceId);
    const learned = (s.layout.settings.smartSpaceRules || []).filter(r => !before.includes(r));
    if (!learned.length) return null;
    const sp = spaceById(s, target.spaceId);
    return { sites: learned.map(r => r.site), space: sp ? `${sp.icon ? sp.icon + ' ' : ''}${sp.name}` : '', before };
  },
  setSmartSpaceRules: (s, { rules }) => { s.layout.settings.smartSpaceRules = rules; },

  // Several selected tabs: kind 'tab' (unpinned) or 'pinned'.
  // Pinned ones close but stay pinned, like their − button.
  closeMany: async (s, { items }) => {
    for (const { kind, id } of items) {
      if (kind === 'tab') await handlers.closeTab(s, { id });
      else await minimize(s, id);
    }
    // Folders whose tabs were just closed fold up.
    const closed = new Set(items.filter(i => i.kind !== 'tab').map(i => i.id));
    const fold = nodes => nodes.reduce((hit, n) => {
      if (n.type !== 'folder') return hit || closed.has(n.id);
      if (fold(n.children)) { n.collapsed = true; return true; }
      return hit;
    }, false);
    if (closed.size) for (const sp of s.layout.spaces) fold(sp.pinned);
  },
  // Unpinned tabs close; pinned tabs and folders (with everything in them) go.
  deleteMany: async (s, { items }) => {
    for (const { kind, id } of items) {
      if (kind === 'tab') await handlers.closeTab(s, { id });
      else await deleteNode(s, id);
    }
  },
  duplicateMany: async (s, { items, windowId }) => {
    for (const { kind, id } of items) {
      const rec = kind === 'tab' ? s.runtime.tabs.find(r => r.id === id) : null;
      const tabId = rec ? rec.tabId : s.runtime.bindings[id]?.tabId;
      const url = rec ? rec.url : findEntry(s, id)?.entry.url;
      if (tabId != null && await chrome.tabs.duplicate(tabId).catch(() => null)) continue;
      if (url) await chrome.tabs.create({ windowId, url, active: false }).catch(() => {});
    }
  },
  // Where the topmost pinned item was (items come in sidebar order), else at
  // the bottom of the pinned tabs.
  folderFrom: async (s, { items, spaceId }) => {
    const sp = spaceById(s, spaceId);
    const top = sp && items.find(it => it.kind !== 'tab' && findNode(sp.pinned, it.id));
    const id = handlers.newFolder(s, { spaceId, parentId: null, beforeId: top?.id });
    if (id) await moveMany(s, items, { zone: 'pinned', spaceId, refId: id, position: 'inside' });
    return id;
  },
  split: (s, { item, target, windowId }) => makeSplit(s, item, target, windowId),
  unsplit: (s, { id }) => separateSplit(s, id),
  swapSplit: (s, { id }) => swapSplit(s, id),

  switcherList: s => switcherList(s),
  switcherCommit: async (s, { tabId }) => {
    await closeSwitcher();
    await focusTab(tabId);
  },
  switcherClose: async (s, { back }) => {
    await closeSwitcher();
    if (back && switcherFrom != null) await chrome.windows.update(switcherFrom, { focused: true }).catch(() => {});
  },
  switcherCloseTab: (s, { tabId }) => chrome.tabs.remove(tabId).catch(() => {}),

  commandBarData: (s, { windowId }) => commandBarData(s, windowId),
  commandBarRun: async (s, { windowId, action, arg }, sender) => {
    await closeCommandBar(sender.tab?.windowId);
    return runBarAction(s, windowId, action, arg);
  },
  commandBarClose: (s, m, sender) => closeCommandBar(sender.tab?.windowId),

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
  moveToSpace: (s, { kind, id, spaceId }) => handlers.moveMany(s, { items: [{ kind, id }], target: { zone: 'space', spaceId } }),

  switchSpace: (s, { windowId, spaceId }) => switchSpace(s, windowId, spaceId),
  cycleSpace: (s, { windowId, dir }) => cycleSpace(s, windowId, dir),

  // From the Import from Arc page: the links picked there, merged in (see arcimport.js).
  importArc: (s, { plan }) => {
    const { layout, added } = mergeArcImport(s.layout, plan);
    s.layout = normalizeLayout({ ...layout, rev: s.layout.rev });
    return added;
  },

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
  // Undo goes too: its copies hold the archive (and closed tabs' URLs), and
  // clearing is meant to leave nothing behind.
  toggleMute: async (s, { tabId }) => {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (t) await chrome.tabs.update(tabId, { muted: !t.mutedInfo?.muted });
  },
  // Mute All Tabs mutes what's open and turns on Mute Mode, so new tabs start
  // muted too. Unmute All turns it off and unmutes everything.
  setMuteMode: async (s, { on }) => {
    s.runtime.muteMode = on;
    const list = await chrome.tabs.query({ muted: !on });
    await Promise.all(list.map(t => chrome.tabs.update(t.id, { muted: on }).catch(() => {})));
  },
  clearArchive: async s => {
    s.runtime.archived = [];
    await clearUndo();
  },

  updateSettings: async (s, { settings }) => {
    const before = s.layout.settings.groupTabsBySpace;
    Object.assign(s.layout.settings, settings);
    const rules = Array.isArray(s.layout.settings.smartSpaceRules) ? s.layout.settings.smartSpaceRules : [];
    s.layout.settings.smartSpaceRules = rules
      .filter(r => r && typeof r.site === 'string' && r.site.trim() && spaceById(s, r.spaceId))
      .map(r => ({ site: r.site.trim(), spaceId: r.spaceId }));
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

  importData: async (s, { data }) => {
    const layout = data && data.layout ? data.layout : data;
    if (!layout || !Array.isArray(layout.spaces)) throw new Error('That file does not look like a Sidecar export.');
    await clearUndo(); // undoing into the replaced layout would make a mess of both
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
  mutate(async s => recordUndo(s, await UNDO_LABELS[msg.type]?.(s, msg), st => handler(st, msg, sender))).then(
    result => sendResponse({ ok: true, result }),
    err => sendResponse({ ok: false, error: String(err && err.message || err) }),
  );
  return true;
});

// ---------------------------------------------------------------------------
// Chrome events

chrome.tabs.onCreated.addListener(tab => mutate(async s => {
  // Mute Mode: every new tab starts muted. One you unmute yourself stays unmuted.
  if (s.runtime.muteMode && !tab.mutedInfo?.muted) await chrome.tabs.update(tab.id, { muted: true }).catch(() => {});
  if (isPopupTab(tab)) return;
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
  // Maybe a link from another app, for Smart Spaces. New Tabs never are.
  if (Date.now() >= browserStartUntil && !isNewTabUrl(tabUrl(tab))) setTimeout(() => smartCheck(tab.id), SMART_CHECK_MS);
}));

// Smart Spaces apply to tabs opened from outside Chrome: links from other apps,
// bookmarks opened in a new tab. Chrome gives those an opener too (whatever tab
// was active), so they're told apart from links clicked in Chrome by Chrome not
// reporting a page that opened them. That report can come after onCreated,
// hence the wait.
const SMART_CHECK_MS = 250;
const openedFromPage = new Map(); // tabId -> when a page opened it

chrome.webNavigation?.onCreatedNavigationTarget.addListener(({ tabId }) => {
  const now = Date.now();
  for (const [id, t] of openedFromPage) if (now - t > 60_000) openedFromPage.delete(id);
  openedFromPage.set(tabId, now);
});

function smartCheck(tabId) {
  if (openedFromPage.has(tabId)) return;
  mutate(async s => {
    const rec = recordForTab(s, tabId);
    const tab = rec && await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return;
    rec.smartLearnUntil = Date.now() + SMART_LEARN_MS;
    const url = tabUrl(tab);
    if (!url || url === 'about:blank') rec.smartUntil = Date.now() + SMART_WAIT_MS; // its URL comes later
    else await smartRoute(s, rec, tab, url);
  });
}

// Moves a tab's record to the space Smart Spaces picks for the URL, if another.
async function smartRoute(s, rec, tab, url) {
  const spaceId = !isNewTabUrl(url) && smartSpaceFor(s, url);
  if (!spaceId || spaceId === rec.spaceId) return;
  removeRecord(s, rec.id);
  rec.spaceId = spaceId;
  insertRecordAt(s, rec, null, 'start');
  if (tab.active) await switchSpace(s, tab.windowId, spaceId);
  scheduleGroups(tab.windowId);
}

chrome.tabs.onRemoved.addListener((tabId, info) => {
  const now = Date.now();
  for (const [id, t] of recentlyRemoved) if (now - t > 5000) recentlyRemoved.delete(id);
  // Sidecar closing a tab is part of an action, which keeps its own undo.
  const ours = recentlyRemoved.has(tabId);
  recentlyRemoved.set(tabId, now);
  mutate(async s => {
    s.runtime.mru = s.runtime.mru.filter(id => id !== tabId);
    const eid = entryIdForTab(s, tabId);
    const rec = recordForTab(s, tabId);
    const label = (rec || eid) && !ours && !info.isWindowClosing ? 'Close Tab' : null;
    await recordUndo(s, label, () => {
      if (eid) delete s.runtime.bindings[eid];
      if (rec) {
        // Closing a whole window (or quitting) keeps its tabs as sleeping entries.
        if (info.isWindowClosing) rec.tabId = null;
        else archiveClosed(s, removeRecord(s, rec.id));
      }
    }, tabId);
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
      if (change.url && rec.smartUntil) {
        const waiting = Date.now() < rec.smartUntil;
        delete rec.smartUntil;
        if (waiting) await smartRoute(s, rec, tab, change.url);
      }
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
  touchMru(s, tabId);

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
    // Going to another window makes its tab the most recent one. Coming back
    // from the switcher (or any popup) to the same window doesn't count.
    if (windowId === lastNormalWindow) return;
    const [active] = await chrome.tabs.query({ windowId, active: true });
    if (active && (recordForTab(s, active.id) || entryIdForTab(s, active.id))) {
      lastNormalWindow = windowId;
      touchMru(s, active.id);
    }
  });
});

chrome.windows.onRemoved.addListener(windowId => {
  if (windowId === switcherWindowId) switcherWindowId = null;
  if (windowId === commandBarWindowId) commandBarWindowId = null;
  mutate(s => forgetWindow(s, windowId));
});

async function forgetWindow(s, windowId) {
  delete s.runtime.windowSpace[windowId];
  delete s.runtime.activeTab[windowId];
  for (const key of Object.keys(s.runtime.groups)) if (key.startsWith(`${windowId}:`)) delete s.runtime.groups[key];
}

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

chrome.commands.onCommand.addListener((command, tab) => {
  // The switcher is already open: pass the press straight on, without waiting
  // behind other state changes, so each press moves the list right away.
  if (command === 'switch-tab' && switcherWindowId != null) {
    chrome.runtime.sendMessage({ type: 'switcherNext' }).catch(() => {});
    return;
  }
  mutate(async s => {
    const windowId = tab ? tab.windowId : (await chrome.windows.getLastFocused().catch(() => null))?.id;
    const label = ['toggle-pin', 'toggle-favorite'].includes(command) && windowId != null ? await barUndoLabel(s, windowId, command) : null;
    return recordUndo(s, label, st => runCommand(st, command, tab));
  });
});

async function runCommand(s, command, tab) {
  const windowId = tab ? tab.windowId : (await chrome.windows.getLastFocused()).id;
  if (command === 'switch-tab') return openSwitcher(windowId);
  if (command === 'command-bar') return openCommandBar(windowId);
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
}

// ---------------------------------------------------------------------------
// Startup

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  mutate(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  browserStartUntil = Date.now() + RECONCILE_MS;
  mutate(() => {});
});
