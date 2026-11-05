// Tab switcher window, opened by the "switch-tab" shortcut (⌘E recommended).
// Works like ⌘Tab: it opens on the previous tab; keep holding the modifier and
// press the letter again to go further back (or hold the letter down), ⇧ to go
// forward, then let go to switch. Enter or a click also switches; Esc cancels.
// W closes the selected tab and keeps the list up on the rest (⌘W is handled in
// background.js, as Chrome keeps it for itself).
// Whatever shortcut is set on chrome://extensions/shortcuts works: any of ⌘, ⌥
// or Ctrl being let go switches.
//
// Chrome only reports the modifier being let go once this window has focus. A
// tap so quick it's over before then leaves the list open; tapping the
// modifier again (or Enter) switches.

import { COLOR_HEX, FALLBACK_ICON, faviconFor, hostOf } from './shared.js';

// Holding the letter down moves at most this often (6 rows a second), instead
// of at the keyboard's repeat rate.
const REPEAT_MS = 167;
// Presses passed on by the background don't say whether they're a held-down
// repeat. Key repeat sends them closer together than this; separate taps don't.
const REPEAT_GAP_MS = 125;

const MODIFIERS = new Set(['Meta', 'Alt', 'Control']);

// As SWITCHER_ROW / SWITCHER_ROWS in background.js, which opens the window at
// a guessed size; fit() corrects it for the real title bar.
const ROW = 36;
const MAX_ROWS = 12;

// The shortcut's letter, e.g. "⌘E" -> "KeyE". e.code, because ⌥ plus a letter
// types a symbol on a Mac.
let nextKey = 'KeyE';
chrome.commands.getAll().then(cmds => {
  const m = (cmds.find(c => c.name === 'switch-tab')?.shortcut || '').match(/([A-Z0-9])$/i);
  if (m) nextKey = /\d/.test(m[1]) ? `Digit${m[1]}` : `Key${m[1].toUpperCase()}`;
});

const list = document.getElementById('list');
let items = [];
let sel = 0;
let done = false;
let lastLocalStep = 0; // last press this page saw itself
let lastStep = 0;
let lastPassedOn = 0;

// Rows are built once; moving the selection only changes classes, so each
// press shows up straight away.
function render() {
  list.replaceChildren(...items.map(it => {
    const row = document.createElement('div');
    row.className = 'row';
    if (it.color) row.style.setProperty('--c', COLOR_HEX[it.color]);
    const img = document.createElement('img');
    img.alt = '';
    img.src = faviconFor(it.url, it);
    img.addEventListener('error', () => { img.src = FALLBACK_ICON; }, { once: true });
    const title = Object.assign(document.createElement('span'), { className: 'title', textContent: it.title });
    const host = Object.assign(document.createElement('span'), { className: 'host', textContent: hostOf(it.url) });
    const space = Object.assign(document.createElement('span'), { className: 'space', textContent: it.space });
    row.append(img, title, host, space);
    row.addEventListener('click', () => finish(it.tabId));
    return row;
  }));
  select(sel);
}

function select(i) {
  list.children[sel]?.classList.remove('selected');
  sel = i;
  const row = list.children[sel];
  if (!row) return;
  row.classList.add('selected');
  row.scrollIntoView({ block: 'nearest' });
  chrome.runtime.sendMessage({ type: 'switcherSelect', tabId: items[sel].tabId, index: sel }).catch(() => {});
}

// Size the window to the rows, plus however tall the title bar really is.
async function fit() {
  const rows = Math.min(Math.max(items.length, 2), MAX_ROWS);
  const height = rows * ROW + 16 + (outerHeight - innerHeight);
  if (height === outerHeight) return;
  const win = await chrome.windows.getCurrent();
  await chrome.windows.update(win.id, { height }).catch(() => {});
}

function closeSelected() {
  const it = items[sel];
  if (!it || done) return;
  chrome.runtime.sendMessage({ type: 'switcherCloseTab', tabId: it.tabId });
  items.splice(sel, 1);
  list.children[sel].remove();
  if (!items.length) return finish(null);
  select(Math.min(sel, items.length - 1));
  fit();
}

let earlySteps = 0; // presses that arrived before the list did
function step(dir, repeat) {
  const now = Date.now();
  if (repeat && now - lastStep < REPEAT_MS) return;
  lastStep = now;
  if (!loaded) earlySteps += dir;
  if (!items.length) return;
  select((sel + dir + items.length) % items.length);
}

// back: go back to the window it was opened from (Esc), rather than leaving
// focus wherever the window closing puts it.
function finish(tabId, back = false) {
  if (done) return;
  done = true;
  chrome.runtime.sendMessage(tabId == null ? { type: 'switcherClose', back } : { type: 'switcherCommit', tabId });
}

let loaded = false;
let commitOnLoad = false;
function commit() {
  if (loaded) finish(items[sel]?.tabId);
  else commitOnLoad = true;
}

addEventListener('keydown', e => {
  if (e.code === nextKey || e.key === 'Tab' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    lastLocalStep = Date.now();
    step(e.shiftKey || e.key === 'ArrowUp' ? -1 : 1, e.repeat);
  } else if (e.code === 'KeyW') {
    e.preventDefault();
    if (loaded && !e.repeat) closeSelected();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    commit();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    finish(null, true);
  }
});

addEventListener('keyup', e => { if (MODIFIERS.has(e.key)) commit(); });
// After a moment, so a ⌘W that closes this window isn't taken for a cancel.
addEventListener('blur', () => setTimeout(() => finish(null), 100));

// Pressing the shortcut again usually reaches Chrome's shortcut handling rather
// than this page, so the background passes it on. Ignore it if this page already
// saw the same key press.
chrome.runtime.onMessage.addListener(msg => {
  if (!msg || msg.type !== 'switcherNext') return;
  const now = Date.now();
  const repeat = now - lastPassedOn < REPEAT_GAP_MS;
  lastPassedOn = now;
  if (now - lastLocalStep > 150) step(1, repeat);
});

const res = await chrome.runtime.sendMessage({ type: 'switcherList' });
items = (res && res.ok && res.result) || [];
// Start on the previous tab: one below the current one, or the top row when
// the current tab isn't listed (it's a New Tab).
// Reopened after ⌘W, it picks up where it was.
const at = new URLSearchParams(location.search).get('at');
const start = at != null ? Math.min(+at, items.length - 1) : items[0]?.current && items.length > 1 ? 1 : 0;
sel = items.length ? ((start + earlySteps) % items.length + items.length) % items.length : 0;
loaded = true;
render();
fit();
if (commitOnLoad) commit();
