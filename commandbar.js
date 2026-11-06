// Command bar window, opened by the "command-bar" shortcut (⌘T recommended).
// Type a URL to go there, or words to search, find an open, pinned or archived
// tab, or run a command on the current tab. ↑/↓ choose, Enter runs, Esc or the
// shortcut again closes. Commands that need a name (Rename, New Space) ask for
// it in the same box. Typing also lists sites from your history and, unless
// turned off in Settings, Google's suggestions.

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
let moved = false; // picked a row with ↑/↓ since the last keystroke

const spaceLabel = sp => `${sp.icon ? sp.icon + ' ' : ''}${sp.name}`;

// Runs inside the page (each frame). Floats the biggest playing video, or puts
// back the one already floating. Chrome only allows it straight after a key
// press or click, so it's injected from here, not from the background.
function togglePictureInPicture() {
  if (document.pictureInPictureElement) return document.exitPictureInPicture();
  const area = v => v.clientWidth * v.clientHeight;
  const videos = [...document.querySelectorAll('video')].filter(v => v.readyState > 0 && area(v) > 0);
  const playing = videos.filter(v => !v.paused);
  const pick = (playing.length ? playing : window === top ? videos : []).sort((a, b) => area(b) - area(a))[0];
  if (!pick) return;
  pick.disablePictureInPicture = false;
  return pick.requestPictureInPicture().catch(() => {});
}

const pictureInPicture = tabId =>
  chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: togglePictureInPicture });

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
    ...cmd(/^(https?|file):/.test(c.url || ''), 'Screenshot Page', '⎙', 'screenshot', { keys: 'capture image picture snapshot save png' }),
    ...cmd(/^(https?|file):/.test(c.url || ''), 'Video Miniplayer (Picture in Picture)', '▣', null, { keys: 'pip video float floating miniplayer pop out', local: () => pictureInPicture(c.tabId) }),
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

// ---------------------------------------------------------------------------
// Suggestions: sites from your history and from Google, for what's typed. They
// arrive after each keystroke and re-render; each is kept with the text it was
// for, and only shown while that's still what's typed.

const bare = u => u.replace(/^[a-z][\w+.-]*:\/\//i, '').replace(/^www\./i, '');
const sameUrl = (a, b) => bare(a).replace(/\/$/, '').toLowerCase() === bare(b).replace(/\/$/, '').toLowerCase();

let fromHistory = { q: null, autofill: null, rows: [] };
let fromGoogle = { q: null, sites: [], queries: [] };
let googleOn = true;
chrome.storage.local.get('layout').then(({ layout }) => { googleOn = layout?.settings?.googleSuggest !== false; });

async function fetchHistory(q) {
  const typed = bare(q.toLowerCase());
  const found = (await chrome.history.search({ text: q, startTime: 0, maxResults: 200 }).catch(() => []))
    .filter(h => /^https?:/.test(h.url));
  const weight = h => (h.typedCount || 0) * 10 + (h.visitCount || 0);
  // Like the address bar: the site you most likely mean, if its address starts
  // with what's typed. Just the site, unless a path is being typed.
  let autofill = null;
  if (typed && !/\s/.test(q)) {
    if (!typed.includes('/')) {
      const sites = new Map();
      for (const h of found) {
        const u = new URL(h.url);
        const host = u.hostname.replace(/^www\./, '');
        if (!host.startsWith(typed)) continue;
        const site = sites.get(host) || { title: host, url: `${u.origin}/`, w: 0 };
        site.w += weight(h);
        sites.set(host, site);
      }
      autofill = [...sites.values()].sort((a, b) => b.w - a.w)[0] || null;
    } else {
      const h = found.filter(x => bare(x.url.toLowerCase()).startsWith(typed)).sort((a, b) => weight(b) - weight(a))[0];
      if (h) autofill = { title: bare(h.url), url: h.url };
    }
  }
  const rows = found.sort((a, b) => weight(b) - weight(a)).slice(0, 6).map(h => ({ title: h.title || bare(h.url), url: h.url }));
  if (input.value.trim() !== q || asking) return;
  fromHistory = { q, autofill, rows };
  render(true);
}

let googleRequest = null;
async function fetchGoogle(q) {
  googleRequest?.abort();
  if (!googleOn) return;
  const req = googleRequest = new AbortController();
  try {
    const url = `https://suggestqueries.google.com/complete/search?client=chrome&ie=utf-8&oe=utf-8&q=${encodeURIComponent(q)}`;
    const res = await fetch(url, { signal: req.signal, credentials: 'omit' });
    const [, words = [], , , extra = {}] = await res.json();
    const types = extra['google:suggesttype'] || [];
    const sites = [];
    const queries = [];
    words.forEach((w, i) => {
      if (types[i] === 'NAVIGATION') sites.push({ title: bare(w).replace(/\/$/, ''), url: w });
      else if (w.toLowerCase() !== q.toLowerCase()) queries.push(w);
    });
    if (input.value.trim() !== q || asking) return;
    fromGoogle = { q, sites: sites.slice(0, 3), queries: queries.slice(0, 4) };
    render(true);
  } catch {
    // offline, or Google changed something: the rest still works
  }
}

let googleTimer = null;
function suggest() {
  const q = input.value.trim();
  clearTimeout(googleTimer);
  if (!q || asking) return;
  fetchHistory(q);
  googleTimer = setTimeout(() => fetchGoogle(q), 120);
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
  for (const a of data?.archived || []) {
    add(`${a.title} ${hostOf(a.url)}`, 3, { title: a.title, url: a.url, hint: `Archived  ${a.space}`, color: a.color, archived: true, cmd: { action: 'restore-archived', arg: a.key } });
  }
  // Archived tabs come after everything still around, however well they match.
  found.sort((a, b) => (a.rank === 3) - (b.rank === 3) || b.sc - a.sc || a.rank - b.rank);
  const matches = found.slice(0, MAX_RESULTS).map(f => f.item);

  // Sites to open, each only once.
  const opened = [];
  const site = (title, url, hint) => {
    if (opened.some(u => sameUrl(u, url))) return [];
    opened.push(url);
    return [{ title, url, hint, cmd: { action: 'open-url', arg: url } }];
  };
  const h = fromHistory.q === q ? fromHistory : null;
  const g = fromGoogle.q === q && googleOn ? fromGoogle : null;
  const url = asUrl(q);
  const go = [
    ...(h?.autofill ? site(h.autofill.title, h.autofill.url, 'Visited') : []),
    ...(url ? site(url, url, 'Open') : []),
  ];
  // A command or tab whose name starts with what's typed comes before a site,
  // unless what's typed is an address.
  const lower = q.toLowerCase();
  const leading = url ? [] : matches.filter(m => !m.archived && m.title.toLowerCase().startsWith(lower));
  return [
    ...leading,
    ...go,
    ...matches.filter(m => !leading.includes(m)),
    ...(h?.rows || []).flatMap(r => site(r.title, r.url, hostOf(r.url))),
    ...(g?.sites || []).flatMap(r => site(r.title, r.url, 'Google')),
    { title: `Search for “${q}”`, glyph: '⌕', hint: '', cmd: { action: 'search', arg: q } },
    ...(g?.queries || []).map(w => ({ title: w, glyph: '⌕', hint: 'Search', cmd: { action: 'search', arg: w } })),
  ];
}

const rowKey = it => it && `${it.cmd?.action}|${it.cmd?.arg ?? it.title}`;

// keep: if a row was picked with ↑/↓, stay on it as suggestions arrive.
function render(keep = false) {
  const was = keep && moved ? rowKey(items[sel]) : null;
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
  const i = was ? items.findIndex(it => rowKey(it) === was) : -1;
  select(Math.max(i, 0));
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

input.addEventListener('input', () => {
  if (asking) return;
  moved = false;
  render();
  suggest();
});

addEventListener('keydown', e => {
  if (e.isComposing) return;
  if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
    e.preventDefault();
    moved = true;
    select(sel + 1);
  } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
    e.preventDefault();
    moved = true;
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
if (!asking) render(true);
