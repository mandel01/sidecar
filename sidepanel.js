// Side panel UI. Reads state from chrome.storage.local, asks the background
// worker to make every change, and re-renders whenever storage or tabs change.

import { COLOR_HEX, GROUP_COLORS, ICON_PRESETS, compactTitle, hostOf } from './shared.js';

const $ = id => document.getElementById(id);
const els = {
  favorites: $('favorites'),
  spaceIcon: $('space-icon'),
  spaceName: $('space-name'),
  pinned: $('pinned'),
  tabList: $('tab-list'),
  spaces: $('spaces'),
  menu: $('menu'),
  toast: $('toast'),
  dialog: $('dialog'),
};

const FALLBACK_ICON = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.5" fill="none" stroke="#8b8f97" stroke-width="1.3"/><path d="M1.5 8h13M8 1.5c2 2 2.6 4 2.6 6.5S10 12.5 8 14.5M8 1.5C6 3.5 5.4 5.5 5.4 8S6 12.5 8 14.5" fill="none" stroke="#8b8f97" stroke-width="1.1"/></svg>');
const FOLDER_CLOSED_PATH = '<path d="M1.5 4.5v8a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-6a1 1 0 0 0-1-1H8L6.5 3.5h-4a1 1 0 0 0-1 1Z"/>';
const FOLDER_SVG = {
  closed: `<svg class="folder-icon" viewBox="0 0 16 16">${FOLDER_CLOSED_PATH}</svg>`,
  open: '<svg class="folder-icon" viewBox="0 0 16 16"><path d="M1.5 12.5v-8a1 1 0 0 1 1-1h4L8 5h5a1 1 0 0 1 1 1v1.5"/><path d="M1.5 12.5l1.8-4.3a1 1 0 0 1 .9-.7h10.3a.6.6 0 0 1 .55.85l-1.75 4.55a1 1 0 0 1-.9.6H2.5a1 1 0 0 1-1-1Z"/></svg>',
  // Closed, but some of its tabs are open (and still listed under it).
  partial: `<svg class="folder-icon" viewBox="0 0 16 16">${FOLDER_CLOSED_PATH}<circle class="dot" cx="10.5" cy="9.5" r="2"/></svg>`,
};

let layout = null;
let runtime = null;
let tabs = new Map();
let windowId = null;
let editing = false;
let dirty = false;
let drag = null;
let pendingRename = null;

// ---------------------------------------------------------------------------
// Data

async function send(msg) {
  const res = await chrome.runtime.sendMessage(msg);
  if (!res || !res.ok) {
    const err = new Error(res ? res.error : 'No response from background');
    toast(err.message);
    throw err;
  }
  return res.result;
}

async function refresh() {
  const got = await chrome.storage.local.get(['layout', 'runtime']);
  layout = got.layout || null;
  runtime = got.runtime || null;
  tabs = new Map((await chrome.tabs.query({})).map(t => [t.id, t]));
  render();
}

let refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 40);
}

function currentSpace() {
  const id = runtime.windowSpace[windowId] || runtime.lastSpaceId;
  return layout.spaces.find(s => s.id === id) || layout.spaces[0];
}

const boundTab = entryId => {
  const b = runtime.bindings[entryId];
  return b ? tabs.get(b.tabId) : null;
};

function displayTitle(custom, live, storedTitle, url) {
  if (custom) return custom;
  const title = (live && live.title) || storedTitle;
  const u = (live && live.url) || url;
  if (layout.settings.compactTitles) return compactTitle(title, u);
  return title || hostOf(u) || 'New Tab';
}

function faviconFor(url, live) {
  if (live && live.favIconUrl && /^(https?|data):/.test(live.favIconUrl)) return live.favIconUrl;
  if (!url) return FALLBACK_ICON;
  return chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(url)}&size=32`);
}

const isActive = live => !!live && live.active && live.windowId === windowId;

// ---------------------------------------------------------------------------
// Rendering

function render() {
  if (!layout || !runtime) return;
  if (editing || drag) {
    dirty = true;
    return;
  }
  dirty = false;
  const space = currentSpace();
  document.documentElement.style.setProperty('--space', COLOR_HEX[space.color] || COLOR_HEX.grey);
  renderFavorites();
  renderHeader(space);
  renderPinned(space);
  renderUnpinned(space);
  renderSpaces(space);
  if (pendingRename) {
    const row = document.querySelector(`.row[data-id="${pendingRename}"]`);
    pendingRename = null;
    if (row) startRename(row);
  }
}

function makeIcon(src) {
  const img = document.createElement('img');
  img.className = 'favicon';
  img.alt = '';
  img.src = src;
  img.addEventListener('error', () => { img.src = FALLBACK_ICON; }, { once: true });
  return img;
}

function tabRow({ kind, id, title, url, live, asleep, depth, action, actionTitle }) {
  const row = document.createElement('div');
  row.className = 'row tab';
  row.draggable = true;
  Object.assign(row.dataset, { kind, id, type: 'tab', url: url || '' });
  row.style.setProperty('--depth', depth || 0);
  if (isActive(live)) row.classList.add('active');
  if (asleep) row.classList.add('asleep');
  row.title = `${title}\n${(live && live.url) || url}`;

  const name = document.createElement('span');
  name.className = 'title';
  name.textContent = title;
  row.append(makeIcon(faviconFor(url, live)), name);

  if (live && live.audible) {
    const a = document.createElement('span');
    a.className = 'audible';
    a.textContent = live.mutedInfo && live.mutedInfo.muted ? '🔇' : '🔊';
    row.append(a);
  }
  const btn = document.createElement('button');
  btn.className = 'hover-btn';
  btn.dataset.action = action;
  btn.title = actionTitle;
  btn.textContent = action === 'minimize' ? '−' : '×';
  row.append(btn);
  return row;
}

function renderFavorites() {
  els.favorites.replaceChildren(...layout.favorites.map(f => {
    const live = boundTab(f.id);
    const tile = document.createElement('div');
    tile.className = 'fav';
    tile.draggable = true;
    Object.assign(tile.dataset, { kind: 'fav', id: f.id, type: 'tab', url: f.url });
    tile.title = displayTitle(f.customTitle, live, f.title, f.url);
    if (live) tile.classList.add('open');
    if (isActive(live)) tile.classList.add('active');
    const img = makeIcon(faviconFor(f.url, live));
    img.className = '';
    tile.append(img);
    return tile;
  }));
}

function renderHeader(space) {
  els.spaceIcon.textContent = space.icon || '';
  els.spaceName.textContent = space.name;
}

const hasOpenTab = nodes => nodes.some(n => n.type === 'folder' ? hasOpenTab(n.children) : !!boundTab(n.id));

// openOnly: inside a closed folder, list just the open tabs (and folders leading to them).
function renderNodes(nodes, depth, out, openOnly = false) {
  for (const n of nodes) {
    if (n.type === 'folder') {
      const partial = (openOnly || n.collapsed) && hasOpenTab(n.children);
      if (openOnly && !partial) continue;
      const state = partial ? 'partial' : n.collapsed ? 'closed' : 'open';
      const wrap = document.createElement('div');
      wrap.className = 'folder-wrap';
      wrap.dataset.folder = n.id;
      const row = document.createElement('div');
      row.className = 'row folder' + (state === 'open' ? '' : ' collapsed') + (partial ? ' partial' : '');
      row.draggable = true;
      Object.assign(row.dataset, { kind: 'pinned', id: n.id, type: 'folder' });
      row.style.setProperty('--depth', depth);
      row.innerHTML = `${FOLDER_SVG[state]}<span class="title"></span>`;
      row.querySelector('.title').textContent = n.name;
      wrap.append(row);
      if (state !== 'closed') renderNodes(n.children, depth + 1, wrap, partial);
      out.append(wrap);
    } else {
      const live = boundTab(n.id);
      if (openOnly && !live) continue;
      out.append(tabRow({
        kind: 'pinned',
        id: n.id,
        title: displayTitle(n.customTitle, live, n.title, n.url),
        url: n.url,
        live,
        asleep: !live,
        depth,
        action: live ? 'minimize' : 'delete',
        actionTitle: live ? 'Close tab (stays pinned)' : 'Remove pinned tab',
      }));
    }
  }
}

function renderPinned(space) {
  els.pinned.replaceChildren();
  if (!space.pinned.length) {
    const hint = document.createElement('div');
    hint.className = 'empty-hint';
    hint.textContent = 'Drag tabs here to pin them';
    els.pinned.append(hint);
    return;
  }
  renderNodes(space.pinned, 0, els.pinned);
}

function renderUnpinned(space) {
  els.tabList.replaceChildren(...runtime.tabs.filter(r => r.spaceId === space.id).map(r => {
    const live = r.tabId != null ? tabs.get(r.tabId) : null;
    return tabRow({
      kind: 'tab',
      id: r.id,
      title: displayTitle(r.customTitle, live, r.title, r.url),
      url: r.url,
      live,
      asleep: !live,
      depth: 0,
      action: 'close',
      actionTitle: 'Close tab',
    });
  }));
}

function renderSpaces(space) {
  els.spaces.replaceChildren(...layout.spaces.map(sp => {
    const b = document.createElement('button');
    b.className = 'space-btn' + (sp.id === space.id ? ' current' : '');
    b.dataset.zone = 'space';
    b.dataset.spaceId = sp.id;
    b.title = sp.name;
    b.style.setProperty('--c', COLOR_HEX[sp.color] || COLOR_HEX.grey);
    if (sp.icon) b.textContent = sp.icon;
    else b.innerHTML = '<span class="dot"></span>';
    return b;
  }));
}

// ---------------------------------------------------------------------------
// Renaming

function startRename(row) {
  const titleEl = row.querySelector('.title');
  if (!titleEl) return;
  const { kind, id } = row.dataset;
  const item = lookup(kind, id);
  if (!item) return;
  editing = true;
  row.draggable = false;
  const input = document.createElement('input');
  input.className = 'rename';
  input.value = item.renameValue;
  input.placeholder = item.placeholder || '';
  titleEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = commit => {
    if (done) return;
    done = true;
    editing = false;
    if (commit && input.value.trim() !== item.renameValue) {
      send({ type: 'rename', kind: item.renameKind, id, name: input.value });
    }
    render();
    if (!dirty) refresh();
  };
  input.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', e => e.stopPropagation());
  input.addEventListener('dblclick', e => e.stopPropagation());
}

function renameSpaceInline() {
  const space = currentSpace();
  editing = true;
  const input = document.createElement('input');
  input.className = 'rename';
  input.value = space.name;
  els.spaceName.replaceChildren(input);
  input.focus();
  input.select();
  let done = false;
  const finish = commit => {
    if (done) return;
    done = true;
    editing = false;
    if (commit && input.value.trim()) send({ type: 'rename', kind: 'space', id: space.id, name: input.value });
    render();
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

// Finds the item behind a row, plus what renaming it means.
function lookup(kind, id) {
  if (kind === 'tab') {
    const r = runtime.tabs.find(x => x.id === id);
    if (!r) return null;
    const live = r.tabId != null ? tabs.get(r.tabId) : null;
    return { rec: r, live, url: (live && live.url) || r.url, renameKind: 'tab', renameValue: r.customTitle || '', placeholder: displayTitle('', live, r.title, r.url) };
  }
  if (kind === 'fav') {
    const f = layout.favorites.find(x => x.id === id);
    if (!f) return null;
    const live = boundTab(id);
    return { node: f, live, url: (live && live.url) || f.url, renameKind: 'entry', renameValue: f.customTitle || '', placeholder: displayTitle('', live, f.title, f.url) };
  }
  for (const sp of layout.spaces) {
    const found = findIn(sp.pinned, id);
    if (!found) continue;
    if (found.type === 'folder') return { node: found, folder: true, renameKind: 'folder', renameValue: found.name };
    const live = boundTab(id);
    return { node: found, live, url: (live && live.url) || found.url, renameKind: 'entry', renameValue: found.customTitle || '', placeholder: displayTitle('', live, found.title, found.url) };
  }
  return null;
}

function findIn(nodes, id) {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.type === 'folder') {
      const f = findIn(n.children, id);
      if (f) return f;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Context menu

function showMenu(x, y, items) {
  const menu = els.menu;
  menu.replaceChildren();
  for (const it of items) {
    if (!it) continue;
    if (it === '-') {
      menu.append(Object.assign(document.createElement('div'), { className: 'sep' }));
    } else if (it.label && !it.run) {
      menu.append(Object.assign(document.createElement('div'), { className: 'label', textContent: it.label }));
    } else {
      const b = document.createElement('button');
      b.className = 'item' + (it.danger ? ' danger' : '');
      b.textContent = it.text;
      b.addEventListener('click', () => {
        hideMenu();
        it.run();
      });
      menu.append(b);
    }
  }
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 4)) + 'px';
  menu.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 4)) + 'px';
}

function hideMenu() {
  els.menu.hidden = true;
}

function spaceTargets(kind, id, exclude) {
  const others = layout.spaces.filter(sp => sp.id !== exclude);
  if (!others.length) return [];
  return ['-', { label: 'Move to space' }, ...others.map(sp => ({
    text: `${sp.icon || '•'}  ${sp.name}`,
    run: () => send({ type: 'moveToSpace', kind, id, spaceId: sp.id }),
  }))];
}

function copy(url) {
  navigator.clipboard.writeText(url).then(() => toast('Link copied'));
}

function rowMenu(row, x, y) {
  const { kind, id } = row.dataset;
  const item = lookup(kind, id);
  if (!item) return;
  const space = currentSpace();
  const rename = { text: 'Rename', run: () => startRename(row) };

  if (kind === 'tab') {
    showMenu(x, y, [
      rename,
      { text: 'Pin tab', run: () => send({ type: 'pinTab', id }) },
      { text: 'Add to Favorites', run: () => send({ type: 'favorite', kind: 'tab', id }) },
      { text: 'Copy link', run: () => copy(item.url) },
      ...spaceTargets('tab', id, space.id),
      '-',
      { text: 'Close tab', danger: true, run: () => send({ type: 'closeTab', id }) },
    ]);
  } else if (kind === 'fav') {
    showMenu(x, y, [
      { text: 'Rename', run: () => renameFavorite(id, item) },
      { text: 'Copy link', run: () => copy(item.url) },
      item.live && { text: 'Set to current page', run: () => send({ type: 'setEntryUrl', id }) },
      { text: 'Edit URL…', run: () => editEntryUrl(id, item) },
      item.live && { text: 'Close tab (keep favorite)', run: () => send({ type: 'minimize', id }) },
      '-',
      { text: 'Move to pinned in this space', run: () => send({ type: 'unfavorite', id, windowId }) },
      { text: 'Remove from Favorites', danger: true, run: () => send({ type: 'deleteEntry', id }) },
    ]);
  } else if (item.folder) {
    showMenu(x, y, [
      rename,
      { text: 'New folder inside', run: () => newFolder(id) },
      ...spaceTargets('pinned', id, space.id),
      '-',
      { text: 'Delete folder and its tabs', danger: true, run: () => confirmAction(`Delete “${item.node.name}” and everything in it?`, () => send({ type: 'deleteEntry', id })) },
    ]);
  } else {
    showMenu(x, y, [
      rename,
      item.live && { text: 'Set pinned URL to current page', run: () => send({ type: 'setEntryUrl', id }) },
      { text: 'Edit pinned URL…', run: () => editEntryUrl(id, item) },
      { text: 'Copy link', run: () => copy(item.url) },
      { text: 'Add to Favorites', run: () => send({ type: 'favorite', kind: 'pinned', id }) },
      { text: 'Unpin', run: () => send({ type: 'unpin', id, windowId }) },
      ...spaceTargets('pinned', id, space.id),
      '-',
      item.live && { text: 'Close tab (stays pinned)', run: () => send({ type: 'minimize', id }) },
      { text: 'Delete pinned tab', danger: true, run: () => send({ type: 'deleteEntry', id }) },
    ]);
  }
}

function spaceMenu(x, y, space) {
  const i = layout.spaces.findIndex(s => s.id === space.id);
  showMenu(x, y, [
    { text: 'Edit space…', run: () => openSpaceDialog(space) },
    { text: 'New folder', run: () => newFolder(null) },
    { text: 'Archive unpinned tabs', run: () => send({ type: 'clearSpace', spaceId: space.id }) },
    i > 0 && { text: 'Move space left', run: () => send({ type: 'reorderSpace', id: space.id, dir: -1 }) },
    i < layout.spaces.length - 1 && { text: 'Move space right', run: () => send({ type: 'reorderSpace', id: space.id, dir: 1 }) },
    layout.spaces.length > 1 && '-',
    layout.spaces.length > 1 && { text: 'Delete space', danger: true, run: () => confirmDeleteSpace(space) },
  ]);
}

function renameFavorite(id, item) {
  const name = prompt('Name for this favorite (leave empty to use the page title):', item.renameValue);
  if (name !== null) send({ type: 'rename', kind: 'entry', id, name });
}

function editEntryUrl(id, item) {
  let url = prompt('URL:', item.node.url);
  if (url === null || !(url = url.trim())) return;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = 'https://' + url;
  try {
    url = new URL(url).href;
  } catch {
    toast('That isn’t a valid URL');
    return;
  }
  send({ type: 'setEntryUrl', id, url });
}

async function newFolder(parentId) {
  const id = await send({ type: 'newFolder', spaceId: currentSpace().id, parentId });
  pendingRename = id;
}

function confirmAction(text, run) {
  if (confirm(text)) run();
}

function confirmDeleteSpace(space) {
  confirmAction(`Delete the space “${space.name}”? Its pinned tabs, folders and open tabs will be closed and removed.`,
    () => send({ type: 'deleteSpace', id: space.id }));
}

// ---------------------------------------------------------------------------
// Dialogs

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function openDialog(html, onClose) {
  const d = els.dialog;
  d.innerHTML = html;
  d.returnValue = '';
  d.onclose = () => onClose && onClose(d.returnValue, d);
  d.showModal();
  return d;
}

function openSpaceDialog(space) {
  const isNew = !space;
  const used = new Set(layout.spaces.map(s => s.color));
  const data = space || {
    name: '',
    icon: ICON_PRESETS[layout.spaces.length % ICON_PRESETS.length],
    color: GROUP_COLORS.find(c => !used.has(c)) || 'grey',
  };
  const d = openDialog(`
    <form method="dialog">
      <h2>${isNew ? 'New space' : 'Edit space'}</h2>
      <label>Name<input type="text" name="name" required maxlength="40" placeholder="e.g. Travel"></label>
      <label>Icon (any emoji)<input type="text" name="icon" maxlength="8"></label>
      <div class="icon-grid">${ICON_PRESETS.map(i => `<button type="button" data-icon="${i}">${i}</button>`).join('')}</div>
      <div>Color</div>
      <div class="swatches" style="margin-top:6px">${GROUP_COLORS.map(c => `
        <label class="swatch" title="${c}" style="--c:${COLOR_HEX[c]}"><input type="radio" name="color" value="${c}"><span></span></label>`).join('')}
      </div>
      <div class="actions">
        <span class="spacer"></span>
        <button class="btn" value="cancel" formnovalidate>Cancel</button>
        <button class="btn primary" value="ok">${isNew ? 'Create' : 'Save'}</button>
      </div>
    </form>`, async (value, dlg) => {
    if (value !== 'ok') return;
    const f = dlg.querySelector('form');
    const payload = {
      name: f.elements.name.value.trim(),
      icon: f.elements.icon.value.trim(),
      color: f.elements.color.value || 'grey',
    };
    if (isNew) await send({ type: 'createSpace', windowId, ...payload });
    else await send({ type: 'updateSpace', id: space.id, ...payload });
  });
  const f = d.querySelector('form');
  f.elements.name.value = data.name;
  f.elements.icon.value = data.icon;
  f.querySelector(`input[value="${data.color}"]`).checked = true;
  d.querySelector('.icon-grid').addEventListener('click', e => {
    const b = e.target.closest('[data-icon]');
    if (b) f.elements.icon.value = b.dataset.icon;
  });
  f.elements.name.focus();
}

function timeAgo(t) {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

function openArchiveDialog() {
  const list = runtime.archived;
  const d = openDialog(`
    <h2>Archived tabs</h2>
    <p>Unpinned tabs that went unused for ${layout.settings.archiveHours || '∞'} hours, or were cleared. Click one to reopen it.</p>
    <div class="archive-list"></div>
    <div class="actions">
      ${list.length ? '<button class="btn danger" data-act="clear">Clear archive</button>' : ''}
      <span class="spacer"></span>
      <button class="btn" data-act="close">Done</button>
    </div>`);
  const box = d.querySelector('.archive-list');
  if (!list.length) box.innerHTML = '<p style="padding:0 6px">Nothing archived yet.</p>';
  list.forEach((a, index) => {
    const row = document.createElement('div');
    row.className = 'row';
    const sp = layout.spaces.find(s => s.id === a.spaceId);
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = a.title || hostOf(a.url);
    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = timeAgo(a.archivedAt);
    row.title = a.url;
    row.append(makeIcon(faviconFor(a.url)), title);
    if (sp && sp.icon) row.append(Object.assign(document.createElement('span'), { className: 'space-tag', textContent: sp.icon }));
    row.append(when);
    row.addEventListener('click', () => {
      d.close();
      send({ type: 'restoreArchived', index, windowId });
    });
    box.append(row);
  });
  d.querySelector('.actions').addEventListener('click', e => {
    const act = e.target.dataset.act;
    if (act === 'clear') send({ type: 'clearArchive' });
    if (act) d.close();
  });
}

function openSettingsDialog() {
  const st = layout.settings;
  const sync = runtime.sync || {};
  const bm = runtime.bookmarks || {};
  const syncText = sync.status === 'ok'
    ? `Synced ${timeAgo(sync.at)} ago · ${Math.round((sync.bytes || 0) / 1024 * 10) / 10} KB of 100 KB used`
    : sync.status === 'error' ? `Sync error: ${sync.error}` : 'Waiting to sync…';
  const d = openDialog(`
    <form method="dialog">
      <h2>Settings</h2>
      <label>Archive unpinned tabs after<br>
        <input type="number" class="short" name="archiveHours" min="0" step="1"> hours of no use <span style="color:var(--muted)">(0 = never)</span>
      </label>
      <label class="check"><input type="checkbox" name="compactTitles"> Compact tab names (drop “ - Site name” endings)</label>
      <label class="check"><input type="checkbox" name="groupTabsBySpace"> Mirror spaces as tab groups in Chrome’s tab strip</label>

      <h3>Sync</h3>
      <p>Spaces, pinned tabs, folders, favorites and settings sync through your Chrome account. Unpinned tabs stay on each computer.</p>
      <p class="sync-status"></p>
      <div class="actions" style="margin-top:6px">
        <button type="button" class="btn" data-act="sync">Sync now</button>
        <button type="button" class="btn" data-act="pull">Replace with synced layout</button>
      </div>

      <h3>iPhone &amp; iPad</h3>
      <p>Chrome on iOS can’t run extensions, but it does sync bookmarks. This keeps a copy of your favorites and pinned tabs in Other Bookmarks → Sidecar, one folder per space. Changes made inside that folder get overwritten.</p>
      <label class="check"><input type="checkbox" name="mirrorBookmarks"> Mirror to bookmarks from this computer <span style="color:var(--muted)">(turn on for one computer only)</span></label>
      <p class="bookmark-status" style="color:var(--muted)"></p>

      <h3>Backup</h3>
      <div class="actions" style="margin-top:6px">
        <button type="button" class="btn" data-act="export">Export…</button>
        <button type="button" class="btn" data-act="import">Import…</button>
        <input type="file" accept="application/json,.json" hidden>
      </div>

      <h3>Keyboard</h3>
      <p>⌘T / Ctrl+T opens a new tab in the current space. Space switching, pin and favorite shortcuts can be changed on Chrome’s shortcuts page.</p>
      <div class="actions" style="margin-top:6px">
        <button type="button" class="btn" data-act="shortcuts">Edit shortcuts…</button>
      </div>

      <div class="actions">
        <span style="color:var(--muted);font-size:12px">Sidecar v${chrome.runtime.getManifest().version}</span>
        <span class="spacer"></span>
        <button class="btn" value="cancel" formnovalidate>Cancel</button>
        <button class="btn primary" value="ok">Save</button>
      </div>
    </form>`, (value, dlg) => {
    if (value !== 'ok') return;
    const f = dlg.querySelector('form');
    send({
      type: 'updateSettings',
      settings: {
        archiveHours: Number(f.elements.archiveHours.value),
        compactTitles: f.elements.compactTitles.checked,
        groupTabsBySpace: f.elements.groupTabsBySpace.checked,
      },
    });
    if (f.elements.mirrorBookmarks.checked !== !!bm.enabled) {
      send({ type: 'setBookmarkMirror', enabled: f.elements.mirrorBookmarks.checked });
    }
  });
  const f = d.querySelector('form');
  f.elements.archiveHours.value = st.archiveHours;
  f.elements.compactTitles.checked = st.compactTitles;
  f.elements.groupTabsBySpace.checked = st.groupTabsBySpace;
  f.elements.mirrorBookmarks.checked = !!bm.enabled;
  d.querySelector('.bookmark-status').textContent = !bm.enabled ? ''
    : bm.error ? `Bookmark error: ${bm.error}`
    : bm.at ? `Updated ${timeAgo(bm.at)} ago` : 'Waiting to update…';
  const status = d.querySelector('.sync-status');
  status.textContent = syncText;
  const file = d.querySelector('input[type=file]');

  d.addEventListener('click', async e => {
    const act = e.target.dataset && e.target.dataset.act;
    if (act === 'sync') {
      status.textContent = 'Syncing…';
      const s = await send({ type: 'syncNow' });
      status.textContent = s.status === 'ok' ? 'Synced just now.' : `Sync error: ${s.error}`;
    } else if (act === 'pull') {
      if (confirm('Replace this computer’s spaces, pinned tabs and favorites with the last synced version?')) {
        await send({ type: 'pullSync' });
        d.close();
      }
    } else if (act === 'export') {
      const data = await send({ type: 'exportData' });
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `sidecar-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } else if (act === 'import') {
      file.click();
    } else if (act === 'shortcuts') {
      chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
    }
  });
  file.addEventListener('change', async () => {
    const f0 = file.files[0];
    if (!f0) return;
    try {
      const data = JSON.parse(await f0.text());
      if (!confirm('Replace your spaces, pinned tabs and favorites with this backup? It will also sync to your other computers.')) return;
      await send({ type: 'importData', data });
      d.close();
      toast('Backup imported');
    } catch (err) {
      toast('Could not import: ' + err.message);
    }
  });
}

let toastTimer = null;
function toast(text) {
  els.toast.textContent = text;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, 2600);
}

// ---------------------------------------------------------------------------
// Clicks

const rowOf = target => target.closest('.row[data-id], .fav[data-id]');

document.addEventListener('click', e => {
  if (!els.menu.contains(e.target)) hideMenu();
  if (editing || els.dialog.open) return;

  const row = rowOf(e.target);
  const btn = e.target.closest('.hover-btn');
  if (row && btn) {
    const { id } = row.dataset;
    const type = { minimize: 'minimize', delete: 'deleteEntry', close: 'closeTab' }[btn.dataset.action];
    send({ type, id });
    return;
  }
  if (row) {
    if (row.dataset.type === 'folder') send({ type: 'toggleFolder', id: row.dataset.id });
    else send({ type: 'activate', kind: row.dataset.kind === 'tab' ? 'tab' : 'entry', id: row.dataset.id, windowId });
    return;
  }
  const spaceBtn = e.target.closest('.space-btn');
  if (spaceBtn) {
    send({ type: 'switchSpace', windowId, spaceId: spaceBtn.dataset.spaceId });
    return;
  }
  const id = e.target.closest('[id]')?.id;
  if (id === 'new-tab') send({ type: 'newTab', windowId });
  else if (id === 'clear-btn') send({ type: 'clearSpace', spaceId: currentSpace().id });
  else if (id === 'new-folder-btn') newFolder(null);
  else if (id === 'space-menu-btn') {
    const r = e.target.closest('button').getBoundingClientRect();
    spaceMenu(r.left, r.bottom + 4, currentSpace());
  } else if (id === 'add-space-btn') openSpaceDialog(null);
  else if (id === 'settings-btn') openSettingsDialog();
  else if (id === 'archive-btn') openArchiveDialog();
});

// Middle-click closes, like a normal tab strip.
document.addEventListener('auxclick', e => {
  if (e.button !== 1) return;
  const row = rowOf(e.target);
  if (!row || row.dataset.type === 'folder') return;
  if (row.dataset.kind === 'tab') send({ type: 'closeTab', id: row.dataset.id });
  else send({ type: 'minimize', id: row.dataset.id });
});

document.addEventListener('dblclick', e => {
  if (editing) return;
  if (e.target.closest('#space-name')) return renameSpaceInline();
  const row = rowOf(e.target);
  if (row && row.classList.contains('row') && e.target.closest('.title')) startRename(row);
});

document.addEventListener('contextmenu', e => {
  if (editing) return;
  e.preventDefault();
  const row = rowOf(e.target);
  if (row) return rowMenu(row, e.clientX, e.clientY);
  const spaceBtn = e.target.closest('.space-btn');
  if (spaceBtn) {
    const sp = layout.spaces.find(s => s.id === spaceBtn.dataset.spaceId);
    if (sp) spaceMenu(e.clientX, e.clientY, sp);
    return;
  }
  if (e.target.closest('#pinned, #space-header')) {
    showMenu(e.clientX, e.clientY, [
      { text: 'New folder', run: () => newFolder(null) },
      { text: 'Edit space…', run: () => openSpaceDialog(currentSpace()) },
    ]);
  }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') hideMenu();
});

// Two-finger horizontal swipe switches spaces, like Arc.
let wheelAcc = 0;
let wheelLockUntil = 0;
let wheelResetTimer = null;
document.addEventListener('wheel', e => {
  if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) * 1.5 || els.dialog.open) return;
  clearTimeout(wheelResetTimer);
  wheelResetTimer = setTimeout(() => { wheelAcc = 0; }, 250);
  if (Date.now() < wheelLockUntil) return;
  wheelAcc += e.deltaX;
  if (Math.abs(wheelAcc) > 90) {
    send({ type: 'cycleSpace', windowId, dir: wheelAcc > 0 ? 1 : -1 });
    wheelAcc = 0;
    wheelLockUntil = Date.now() + 700;
  }
}, { passive: true });

// ---------------------------------------------------------------------------
// Drag and drop

let indicator = null;

function clearIndicator() {
  if (indicator) indicator.el.classList.remove(indicator.cls);
  indicator = null;
}

function computeDrop(e) {
  if (!drag) return null;
  // The divider is the natural place to drop when dragging a tab up to pin it.
  if (e.target.closest('#divider')) {
    return { el: els.pinned, cls: 'drop-zone', target: { zone: 'pinned', spaceId: currentSpace().id, position: 'end' } };
  }
  const zoneEl = e.target.closest('[data-zone]');
  if (!zoneEl) return null;
  const zone = zoneEl.dataset.zone;
  const spaceId = currentSpace().id;

  if (zone === 'space') {
    return { el: zoneEl, cls: 'drop-inside', target: { zone, spaceId: zoneEl.dataset.spaceId } };
  }
  if (drag.type === 'folder' && zone !== 'pinned') return null;

  const row = rowOf(e.target);
  if (row && zoneEl.contains(row)) {
    if (row.dataset.id === drag.id) return null;
    if (drag.type === 'folder' && row.closest(`[data-folder="${drag.id}"]`)) return null;
    const r = row.getBoundingClientRect();
    let position;
    if (row.classList.contains('fav')) {
      position = e.clientX - r.left < r.width / 2 ? 'before' : 'after';
    } else {
      const f = (e.clientY - r.top) / r.height;
      if (row.dataset.type === 'folder') {
        position = f < 0.28 ? 'before' : (f > 0.72 && row.classList.contains('collapsed') && !row.classList.contains('partial') ? 'after' : 'inside');
      } else {
        position = f < 0.5 ? 'before' : 'after';
      }
    }
    return { el: row, cls: 'drop-' + position, target: { zone, spaceId, refId: row.dataset.id, position } };
  }
  const atStart = !!e.target.closest('#new-tab');
  return { el: zoneEl, cls: 'drop-zone', target: { zone, spaceId, position: atStart ? 'start' : 'end' } };
}

document.addEventListener('dragstart', e => {
  const src = e.target.closest && e.target.closest('[draggable="true"][data-id]');
  if (!src || editing) return;
  hideMenu();
  const d = drag = { kind: src.dataset.kind, id: src.dataset.id, type: src.dataset.type };
  e.dataTransfer.effectAllowed = 'move';
  if (src.dataset.url) {
    e.dataTransfer.setData('text/uri-list', src.dataset.url);
    e.dataTransfer.setData('text/plain', src.dataset.url);
  } else {
    e.dataTransfer.setData('text/plain', src.dataset.id);
  }
  // Changing layout during dragstart (body.dragging expands an empty Favorites bar)
  // makes Chrome cancel the drag, so wait a frame, and skip if it already ended.
  requestAnimationFrame(() => {
    if (drag !== d) return;
    document.body.classList.add('dragging');
    src.classList.add('drag-src');
  });
});

document.addEventListener('dragover', e => {
  const drop = computeDrop(e);
  if (!drop) {
    clearIndicator();
    return;
  }
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  if (!indicator || indicator.el !== drop.el || indicator.cls !== drop.cls) {
    clearIndicator();
    drop.el.classList.add(drop.cls);
    indicator = drop;
  }
});

document.addEventListener('drop', e => {
  const drop = computeDrop(e);
  if (!drop) return;
  e.preventDefault();
  const item = { kind: drag.kind, id: drag.id };
  endDrag();
  send({ type: 'move', item, target: drop.target });
});

function endDrag() {
  clearIndicator();
  drag = null;
  document.body.classList.remove('dragging');
  document.querySelectorAll('.drag-src').forEach(n => n.classList.remove('drag-src'));
  if (dirty) refresh();
}

document.addEventListener('dragend', endDrag);

// ---------------------------------------------------------------------------
// Start

async function init() {
  windowId = (await chrome.windows.getCurrent()).id;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') scheduleRefresh();
  });
  for (const ev of [chrome.tabs.onUpdated, chrome.tabs.onActivated, chrome.tabs.onRemoved,
    chrome.tabs.onCreated, chrome.tabs.onAttached, chrome.tabs.onDetached]) {
    ev.addListener(scheduleRefresh);
  }
  await send({ type: 'ping' }).catch(() => {}); // wakes the worker so state exists
  await refresh();
}

init();
