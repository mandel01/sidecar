// Command bar window, opened by the "command-bar" shortcut (⌘T recommended).
// Type a URL to go there, or words to search, find an open tab or a pinned
// tab, or run a command on the current tab. ↑/↓ choose, Enter runs, Esc or the
// shortcut again closes. Commands that need a name (Rename, New Space) ask for
// it in the same box.

import { COLOR_HEX, faviconFor, hostOf } from './shared.js';

const windowId = Number(new URLSearchParams(location.search).get('window'));
const input = document.getElementById('q');
const list = document.getElementById('list');
const MAX_RESULTS = 40;

let data = null;   // from the background: current tab, spaces, open tabs, closed pins
let items = [];
let sel = 0;
let asking = null; // the command waiting for a name, if any
let done = false;

const spaceLabel = sp => `${sp.icon ? sp.icon + ' ' : ''}${sp.name}`;

// Every command that makes sense for the current tab. `extra` ones only show
// up when typed for, to keep the starting list short.
function commands() {
  const c = data?.ctx || {};
  const spaces = data?.spaces || [];
  const others = spaces.filter(sp => sp.id !== c.spaceId);
  const cmd = (show, name, icon, action, more = {}) => (show ? [{ name, icon, action, ...more }] : []);
  return [
    ...cmd(c.page, 'Copy Current URL', '⎘', null, { keys: 'link clipboard', local: () => navigator.clipboard.writeText(c.url) }),
    ...cmd(c.page, 'Duplicate Current Tab', '⧉', 'duplicate'),
    ...cmd(true, 'Reopen Last Closed Tab', '↺', 'reopen-closed', { keys: 'restore undo' }),
    ...cmd(c.inSidecar && !c.favorite, c.pinned ? 'Unpin Tab' : 'Pin Tab', c.pinned ? '⊖' : '⊕', 'toggle-pin'),
    ...cmd(c.inSidecar && !c.split, c.favorite ? 'Remove from Favorites' : 'Add to Favorites', c.favorite ? '☆' : '★', 'toggle-favorite', { keys: 'favorite' }),
    ...cmd(c.inSidecar && !c.split, 'Rename Tab…', '✎', 'rename', { prompt: { placeholder: 'New name (leave empty to use the page title)', value: c.title } }),
    ...cmd(c.pinned && !c.split && c.movedFromPin, 'Go Back to Pinned Page', '⟲', 'reset-pin', { keys: 'reset tab' }),
    ...cmd(c.pinned && !c.split && c.movedFromPin, 'Replace Pin with Current Page', '⇪', 'replace-pin', { keys: 'update' }),
    ...cmd(c.unpinned, 'Archive Tab', '⤓', 'archive-tab'),
    ...cmd(c.page || c.inSidecar, 'Close Tab', '✕', 'close-tab'),
    ...cmd(!!c.splitWith, `Split View with “${c.splitWith?.title}”`, '◫', 'split-with', { arg: c.splitWith?.tabId, keys: 'add split view side by side' }),
    ...cmd(c.split, 'Separate Split View', '▢', 'unsplit', { keys: 'remove split view' }),
    ...cmd(c.split, 'Swap Split Sides', '⇄', 'swap-split', { keys: 'split view' }),
    ...cmd(c.page, 'Reload Page', '↻', 'reload', { keys: 'refresh' }),
    ...cmd(c.page, 'Go Back', '←', 'back', { keys: 'history' }),
    ...cmd(c.page, 'Go Forward', '→', 'forward', { keys: 'history' }),
    ...cmd(c.page, 'Zoom In', '+', 'zoom-in', { keys: 'bigger larger' }),
    ...cmd(c.page, 'Zoom Out', '−', 'zoom-out', { keys: 'smaller' }),
    ...cmd(c.page, 'Zoom to Actual Size', '=', 'zoom-reset', { keys: 'reset 100%' }),
    ...cmd(spaces.length > 1, 'Next Space', '›', 'next-space'),
    ...cmd(spaces.length > 1, 'Previous Space', '‹', 'prev-space'),
    ...others.map(sp => ({ name: `Go to ${spaceLabel(sp)}`, icon: '›', action: 'focus-space', arg: sp.id, keys: 'space switch focus', color: sp.color, extra: true })),
    ...(c.inSidecar ? others : []).map(sp => ({ name: `Move Tab to ${spaceLabel(sp)}`, icon: '↪', action: 'move-to-space', arg: sp.id, keys: 'space pin', color: sp.color, extra: true })),
    ...cmd(true, 'New Space…', '+', 'new-space', { keys: 'create', prompt: { placeholder: 'Name of the new space' } }),
    ...cmd(true, 'Clear Unpinned Tabs', '⌫', 'clear-unpinned', { keys: 'archive all today' }),
    ...cmd(true, 'Open Sidebar', '▤', null, { keys: 'side panel sidecar', local: () => chrome.sidePanel.open({ windowId }) }),
    ...cmd(true, 'New Window', '□', 'new-window'),
    ...cmd(true, 'New Incognito Window', '◐', 'new-incognito', { keys: 'private' }),
    ...cmd(true, 'Minimize Window', '–', 'minimize-window'),
    ...cmd(true, 'Close Window', '✕', 'close-window'),
    ...cmd(true, 'Toggle Full Screen', '⛶', 'fullscreen', { keys: 'enter exit' }),
    ...cmd(true, 'History', '◷', 'open-page', { arg: 'chrome://history', keys: 'view' }),
    ...cmd(true, 'Downloads', '↓', 'open-page', { arg: 'chrome://downloads' }),
    ...cmd(true, 'Bookmarks', '★', 'open-page', { arg: 'chrome://bookmarks', keys: 'manager' }),
    ...cmd(true, 'Extensions', '⚙', 'open-page', { arg: 'chrome://extensions', keys: 'manage' }),
    ...cmd(true, 'Keyboard Shortcuts', '⌨', 'open-page', { arg: 'chrome://extensions/shortcuts', keys: 'extension keys' }),
    ...cmd(true, 'Settings', '⚙', 'open-page', { arg: 'chrome://settings', keys: 'preferences' }),
  ];
}

// What was typed, if it looks like an address rather than words to search for.
function asUrl(q) {
  if (/\s/.test(q)) return null;
  if (/^[a-z][\w+.-]*:\/\//i.test(q) || /^(about|chrome|data|file|mailto|view-source):/i.test(q)) return q;
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?([/?#]|$)/i.test(q)) return `http://${q}`;
  if (/^[\w-]+(\.[\w-]+)*\.[a-z]{2,}(:\d+)?([/?#]|$)/i.test(q)) return `https://${q}`;
  return null;
}

// Every typed word has to appear; words at the start of the name, or of a word
// in it, count for more.
function score(text, words) {
  const t = text.toLowerCase();
  let total = 0;
  for (const w of words) {
    const i = t.indexOf(w);
    if (i < 0) return 0;
    total += i === 0 ? 3 : /[\s/.\-“]/.test(t[i - 1]) ? 2 : 1;
  }
  return total;
}

function build() {
  const q = input.value.trim();
  const fromCommand = c => ({ title: c.name, glyph: c.icon, color: c.color, hint: '', cmd: c });
  if (!q) return commands().filter(c => !c.extra).map(fromCommand);

  const words = q.toLowerCase().split(/\s+/);
  const found = [];
  const add = (text, rank, item) => {
    const sc = score(text, words);
    if (sc) found.push({ sc, rank, item });
  };
  for (const c of commands()) add(`${c.name} ${c.keys || ''}`, 0, fromCommand(c));
  for (const t of data?.tabs || []) {
    add(`${t.title} ${hostOf(t.url)}`, 1, { title: t.title, url: t.url, live: t, hint: `${hostOf(t.url)}  ${t.space}`, color: t.color, cmd: { action: 'focus-tab', arg: t.tabId } });
  }
  for (const e of data?.entries || []) {
    add(`${e.title} ${hostOf(e.url)}`, 2, { title: e.title, url: e.url, hint: `Pinned  ${e.space}`, color: e.color, cmd: { action: 'open-entry', arg: e.id } });
  }
  found.sort((a, b) => b.sc - a.sc || a.rank - b.rank);

  const out = [];
  const url = asUrl(q);
  if (url) out.push({ title: url, url, hint: 'Open', cmd: { action: 'open-url', arg: url } });
  out.push(...found.slice(0, MAX_RESULTS).map(f => f.item));
  out.push({ title: `Search for “${q}”`, glyph: '⌕', hint: '', cmd: { action: 'search', arg: q } });
  return out;
}

function render() {
  items = asking
    ? [{ title: asking.name.replace('…', ''), glyph: asking.icon, hint: 'Enter to save · Esc to go back', cmd: null }]
    : build();
  sel = 0;
  list.replaceChildren(...items.map((it, i) => {
    const row = document.createElement('div');
    row.className = 'row';
    if (it.color) row.style.setProperty('--c', COLOR_HEX[it.color]);
    let icon;
    if (it.url) {
      icon = document.createElement('img');
      icon.alt = '';
      icon.src = faviconFor(it.url, it.live);
    } else {
      icon = document.createElement('span');
      icon.textContent = it.glyph || '';
    }
    icon.className = 'icon';
    const title = Object.assign(document.createElement('span'), { className: 'title', textContent: it.title });
    const hint = Object.assign(document.createElement('span'), { className: 'hint', textContent: it.hint });
    row.append(icon, title, hint);
    row.addEventListener('mousedown', e => e.preventDefault()); // keep the cursor in the box
    row.addEventListener('click', () => { select(i); choose(); });
    return row;
  }));
  select(0);
}

function select(i) {
  list.children[sel]?.classList.remove('selected');
  sel = items.length ? (i + items.length) % items.length : 0;
  const row = list.children[sel];
  if (!row) return;
  row.classList.add('selected');
  row.scrollIntoView({ block: 'nearest' });
}

function send(msg) {
  done = true;
  chrome.runtime.sendMessage(msg);
}

async function choose() {
  if (done) return;
  if (asking) return send({ type: 'commandBarRun', windowId, action: asking.action, arg: input.value.trim() });
  const c = items[sel]?.cmd;
  if (!c) return;
  if (c.prompt) {
    asking = c;
    input.value = c.prompt.value || '';
    input.placeholder = c.prompt.placeholder;
    input.select();
    return render();
  }
  if (c.local) {
    done = true;
    await Promise.resolve(c.local()).catch(() => {});
    return chrome.runtime.sendMessage({ type: 'commandBarClose' });
  }
  send({ type: 'commandBarRun', windowId, action: c.action, arg: c.arg });
}

input.addEventListener('input', () => { if (!asking) render(); });

addEventListener('keydown', e => {
  if (e.isComposing) return;
  if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
    e.preventDefault();
    select(sel + 1);
  } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
    e.preventDefault();
    select(sel - 1);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    choose();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    if (asking) {
      asking = null;
      input.value = '';
      input.placeholder = 'Type a URL, search, or find a tab or command';
      render();
    } else if (!done) {
      send({ type: 'commandBarClose' });
    }
  }
});

addEventListener('blur', () => { if (!done) send({ type: 'commandBarClose' }); });

render(); // a typed URL or search works before the rest arrives
input.focus();
const res = await chrome.runtime.sendMessage({ type: 'commandBarData', windowId });
data = (res && res.ok && res.result) || null;
if (!asking) render();
