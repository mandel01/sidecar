// Import from Arc: a full page (opened from Settings or the command bar). Reads
// Arc's exported Markdown, lets you map each Arc space onto a Sidecar space and
// tick the links to bring over, shows how much of sync storage the result
// would use, then hands the plan to the background to apply (one Undo step).

import { faviconFor, hostOf } from './shared.js';
import { parseArcExport, sharedFavorites, splitIcon, existingUrls, mergeArcImport, syncSize, titleAllowance, SYNC_LIMIT } from './arcimport.js';

const $ = id => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
};

let layout = null;  // Sidecar's current layout
let have = null;    // addresses already in each space and in Favorites
let perTitle = 40;  // sync bytes to allow for each imported tab's title, once it has one
let cards = [];     // { kind: 'favorites' | 'space', name, target, root, el, select, open }
let fileName = '';

// ---------------------------------------------------------------------------
// Reading the file

async function loadLayout() {
  layout = (await chrome.storage.local.get('layout')).layout;
  have = existingUrls(layout);
  perTitle = await titleAllowance(layout);
}

async function readFile(file) {
  const error = $('error');
  error.hidden = true;
  const spaces = parseArcExport(await file.text());
  if (!spaces.length) {
    error.textContent = 'That doesn’t look like an Arc export: no spaces found in it. In Arc, use Settings → Advanced → Export Data.';
    error.hidden = false;
    return;
  }
  fileName = file.name;
  await loadLayout();
  build(spaces);
  $('start').hidden = true;
  $('choose').hidden = false;
  $('bar').hidden = false;
  update();
}

$('file').addEventListener('change', () => { if ($('file').files[0]) readFile($('file').files[0]); });
const drop = $('drop');
drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', e => {
  e.preventDefault();
  drop.classList.remove('over');
  if (e.dataTransfer.files[0]) readFile(e.dataTransfer.files[0]);
});

// ---------------------------------------------------------------------------
// The model: each card has a tree of { type, url | name, children, checked, parent }.
// "checked" lives on tabs and on folders that were empty in Arc; other folders
// are checked when everything in them is.

function toModel(nodes, parent) {
  const seen = new Set();
  const out = [];
  for (const n of nodes) {
    if (n.type === 'tab') {
      if (seen.has(n.url)) continue; // listed twice in the same folder
      seen.add(n.url);
      out.push({ type: 'tab', url: n.url, checked: true, parent });
    } else {
      const f = { type: 'folder', name: n.name, children: [], checked: true, parent };
      f.children = toModel(n.children, f);
      out.push(f);
    }
  }
  return out;
}

const leaves = node => (node.type === 'tab' || !node.children.length ? [node] : node.children.flatMap(leaves));
const cardLeaves = card => card.root.children.flatMap(leaves);
const cardTabs = card => cardLeaves(card).filter(n => n.type === 'tab');

function build(spaces) {
  const shared = sharedFavorites(spaces);
  const sharedSet = new Set(shared);
  cards = [];
  if (shared.length) {
    const root = { children: [] };
    root.children = toModel(shared.map(url => ({ type: 'tab', url })), root);
    cards.push({ kind: 'favorites', name: 'Arc Favorites', target: 'favorites', root });
  }
  for (const sp of spaces) {
    const root = { children: [] };
    const loose = sp.favorites.filter(u => !sharedSet.has(u)).map(url => ({ type: 'tab', url }));
    root.children = toModel([...loose, ...sp.nodes], root);
    cards.push({ kind: 'space', name: sp.name, target: defaultTarget(sp.name), root });
  }
  for (const c of cards) markHave(c);
  render();
}

const plainName = name => splitIcon(name).name.trim().toLowerCase();

function defaultTarget(name) {
  const match = layout.spaces.find(sp => plainName(sp.name) === plainName(name));
  return match ? match.id : 'new';
}

// Links already where they'd go start unticked.
function markHave(card) {
  const set = card.target === 'favorites' ? have.favorites : card.target === 'new' || card.target === 'skip' ? new Set() : have.spaces[card.target] || new Set();
  for (const n of cardTabs(card)) {
    n.have = set.has(n.url);
    n.checked = !n.have;
  }
}

// ---------------------------------------------------------------------------
// Rendering

function render() {
  $('cards').replaceChildren(...cards.map(renderCard));
  refresh();
}

function renderCard(card) {
  const total = cardTabs(card).length;
  card.open = card.root.children.length <= 25;
  const caret = el('span', { className: 'caret', textContent: '▶' });
  const name = el('span', { className: 'name', textContent: card.name });
  const head = el('div', { className: 'card-head' });
  const toggle = el('button', { type: 'button', className: 'btn small', title: 'Show or hide links' }, caret, ' ', name);
  toggle.style.background = 'none';
  toggle.addEventListener('click', () => setCardOpen(card, !card.open));

  let dest;
  if (card.kind === 'favorites') {
    dest = el('span', { className: 'fixed', textContent: 'Sidecar Favorites (shown in every space)' });
  } else {
    dest = el('select');
    dest.append(el('option', { value: 'new', textContent: `New space “${card.name}”` }));
    for (const sp of layout.spaces) dest.append(el('option', { value: sp.id, textContent: `${sp.icon ? sp.icon + ' ' : ''}${sp.name}` }));
    dest.append(el('option', { value: 'skip', textContent: 'Don’t import' }));
    dest.value = card.target;
    dest.addEventListener('change', () => {
      card.target = dest.value;
      markHave(card);
      card.el.replaceWith(renderCard(card));
      refresh();
    });
  }
  const all = el('button', { type: 'button', className: 'btn small', textContent: 'All' });
  const none = el('button', { type: 'button', className: 'btn small', textContent: 'None' });
  all.addEventListener('click', () => { setAll(card, true); refresh(); });
  none.addEventListener('click', () => { setAll(card, false); refresh(); });
  card.countEl = el('span', { className: 'count' });
  head.append(toggle, el('span', { className: 'arrow', textContent: '→' }), dest,
    el('span', { className: 'card-tools' }, card.countEl, all, none));

  const tree = el('div', { className: 'tree' });
  if (!total && !card.root.children.length) tree.append(el('p', { className: 'empty-note', textContent: '  Nothing in this space.' }));
  for (const n of card.root.children) tree.append(renderNode(n, 0));
  card.el = el('div', { className: 'card' + (card.target === 'skip' ? ' skipped' : '') }, head, tree);
  card.tree = tree;
  card.caret = caret;
  setCardOpen(card, card.open);
  return card.el;
}

function setCardOpen(card, open) {
  card.open = open;
  card.tree.hidden = !open;
  card.caret.style.transform = open ? 'rotate(90deg)' : '';
}

function renderNode(n, depth) {
  const box = el('input', { type: 'checkbox' });
  box.addEventListener('change', () => {
    for (const l of leaves(n)) l.checked = box.checked;
    refresh();
  });
  n.box = box;
  const line = el('div', { className: 'line' });
  line.style.setProperty('--depth', depth);
  const wrap = el('div', { className: 'node ' + n.type });
  if (n.type === 'folder') {
    const caret = el('span', { className: 'caret', textContent: n.children.length ? '▶' : '' });
    const label = el('span', { className: 'label', textContent: `📁 ${n.name}` });
    const count = el('span', { className: 'count', textContent: n.children.length ? '' : 'empty' });
    n.countEl = count;
    const toggle = () => { if (n.children.length) wrap.classList.toggle('open'); };
    caret.addEventListener('click', toggle);
    label.addEventListener('click', toggle);
    line.append(box, caret, label, count);
    const kids = el('div', { className: 'children' }, ...n.children.map(c => renderNode(c, depth + 1)));
    wrap.append(line, kids);
    n.el = wrap;
  } else {
    let u;
    try { u = new URL(n.url); } catch { u = null; }
    const host = hostOf(n.url);
    const rest = u ? (u.pathname === '/' ? '' : u.pathname) + u.search + u.hash : '';
    const label = el('span', { className: 'label', title: n.url }, host, el('span', { className: 'rest', textContent: rest }));
    label.addEventListener('click', () => { box.checked = !box.checked; box.dispatchEvent(new Event('change')); });
    const icon = el('img', { alt: '', loading: 'lazy', src: faviconFor(n.url) });
    line.append(box, el('span', { className: 'leaf-pad' }), icon, label);
    if (n.have) line.append(el('span', { className: 'have', textContent: 'already in Sidecar' }));
    wrap.append(line);
  }
  return wrap;
}

function setAll(card, on) {
  for (const l of cardLeaves(card)) l.checked = on;
}

// Checkbox states, counts and the size meter, from the model.
function refresh() {
  const paint = n => {
    if (n.type === 'tab' || !n.children.length) {
      n.box.checked = n.checked;
      n.box.indeterminate = false;
      return;
    }
    n.children.forEach(paint);
    const ls = leaves(n);
    const on = ls.filter(l => l.checked).length;
    n.box.checked = on === ls.length;
    n.box.indeterminate = on > 0 && on < ls.length;
    const tabs = ls.filter(l => l.type === 'tab');
    n.countEl.textContent = `${tabs.filter(l => l.checked).length} of ${tabs.length}`;
  };
  for (const c of cards) {
    c.root.children.forEach(paint);
    const tabs = cardTabs(c);
    c.countEl.textContent = `${tabs.filter(t => t.checked).length} of ${tabs.length}`;
    c.el.classList.toggle('skipped', c.target === 'skip');
  }
  update();
}

// ---------------------------------------------------------------------------
// The plan, and what it would cost in sync storage

function pick(nodes) {
  const out = [];
  for (const n of nodes) {
    if (n.type === 'tab') {
      if (n.checked) out.push({ type: 'tab', url: n.url });
    } else if (!n.children.length) {
      if (n.checked) out.push({ type: 'folder', name: n.name, children: [] });
    } else {
      const children = pick(n.children);
      if (children.length) out.push({ type: 'folder', name: n.name, children });
    }
  }
  return out;
}

function plan() {
  const p = { favorites: [], spaces: [] };
  for (const c of cards) {
    if (c.target === 'skip') continue;
    if (c.kind === 'favorites') p.favorites = cardTabs(c).filter(t => t.checked).map(t => t.url);
    else {
      const nodes = pick(c.root.children);
      if (nodes.length) p.spaces.push({ target: c.target, name: c.name, nodes });
    }
  }
  return p;
}

let updateTimer = null;
let importable = false;
function update() {
  clearTimeout(updateTimer);
  updateTimer = setTimeout(async () => {
    const p = plan();
    const { layout: after, added } = mergeArcImport(layout, p);
    const now = await syncSize(after);
    const bytes = now + added * perTitle; // once the imported tabs have their titles
    const kb = n => `${Math.round(n / 1000)} KB`;
    const pct = bytes / SYNC_LIMIT;
    const bar = $('bar');
    bar.querySelector('.fill').style.width = `${Math.min(100, pct * 100)}%`;
    bar.classList.toggle('over', pct > 1);
    bar.classList.toggle('near', pct > 0.85 && pct <= 1);
    const what = added === 1 ? '1 link' : `${added.toLocaleString()} links`;
    bar.querySelector('.summary').textContent = pct > 1
      ? `Too much to sync: once their page titles fill in, ${what} would bring Sidecar to about ${kb(bytes)} of its ${kb(SYNC_LIMIT)} limit. Untick some links (long addresses take the most room).`
      : added
        ? `Imports ${what}. Sidecar’s synced data would use ${kb(now)} now, and about ${kb(bytes)} once their page titles fill in, of ${kb(SYNC_LIMIT)} (about 1,000 pinned tabs and favorites in all).`
        : `Nothing new ticked. Sidecar’s synced data uses ${kb(now)} of ${kb(SYNC_LIMIT)}.`;
    importable = added > 0 && pct <= 1;
    $('import-btn').disabled = !importable;
  }, 150);
}

// ---------------------------------------------------------------------------
// Buttons

document.addEventListener('click', async e => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'all' || act === 'none') {
    for (const c of cards) if (c.target !== 'skip') setAll(c, act === 'all');
    refresh();
  } else if (act === 'expand' || act === 'collapse') {
    const open = act === 'expand';
    for (const c of cards) setCardOpen(c, open);
    document.querySelectorAll('.node.folder').forEach(f => f.classList.toggle('open', open));
  } else if (act === 'other-file') {
    $('file').value = '';
    $('choose').hidden = true;
    $('bar').hidden = true;
    $('start').hidden = false;
  } else if (act === 'close') {
    const tab = await chrome.tabs.getCurrent();
    chrome.tabs.remove(tab.id);
  }
});

$('import-btn').addEventListener('click', async () => {
  if (!importable) return;
  const btn = $('import-btn');
  btn.disabled = true;
  btn.textContent = 'Importing…';
  const p = plan();
  const res = await chrome.runtime.sendMessage({ type: 'importArc', plan: p }).catch(err => ({ ok: false, error: String(err.message || err) }));
  if (!res || !res.ok) {
    btn.disabled = false;
    btn.textContent = 'Import';
    // No answer at all means Sidecar's background is older than this page: the
    // folder was updated but Sidecar wasn't reloaded in this Chrome profile.
    alert(res
      ? `Import failed: ${res.error}`
      : 'Import failed: Sidecar needs reloading. Open chrome://extensions in this Chrome profile, click the reload button on the Sidecar card, then try the import again.');
    return;
  }
  const added = res.result;
  const spaces = p.spaces.length;
  $('choose').hidden = true;
  $('bar').hidden = true;
  $('done').hidden = false;
  $('done').querySelector('.done-text').textContent =
    `Imported ${added === 1 ? '1 link' : `${added.toLocaleString()} links`} from ${fileName} into ${spaces === 1 ? '1 space' : `${spaces} spaces`}${p.favorites.length ? ' and Favorites' : ''}.`;
});

// Sidecar changing meanwhile (another computer syncing, say) changes what's already there.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.layout || !cards.length || !$('done').hidden) return;
  layout = changes.layout.newValue;
  have = existingUrls(layout);
  titleAllowance(layout).then(n => { perTitle = n; update(); });
});
