// Importing Arc's exported data (Arc → Settings → Advanced → Export Data).
// The export is Markdown: "# Space", then "## Folder" / "### Subfolder" headings
// with "- url" lines under them. Each space's "## Favorites" holds Arc's
// favorites (shared by every space, so listed again in each) followed by that
// space's pinned tabs that aren't in a folder. Arc exports addresses only, no
// titles: imported tabs show their site name until first opened.
//
// Used by the import page (to preview and measure the result) and by the
// background (to apply it), so both build exactly the same layout.

import { uid, walk, GROUP_COLORS } from './shared.js';

// Text → [{ name, favorites: [url], nodes: [node] }], where a node is
// { type: 'tab', url } or { type: 'folder', name, children: [node] }.
export function parseArcExport(text) {
  const spaces = [];
  let space = null;
  let stack = []; // open folders: stack[0] is a "##" folder, stack[1] a "###" one, …
  let inFavorites = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      const name = h[2].trim();
      if (level === 1) {
        space = { name, favorites: [], nodes: [] };
        spaces.push(space);
        stack = [];
        inFavorites = false;
        continue;
      }
      if (!space) continue;
      const depth = level - 2;
      stack.length = Math.min(stack.length, depth);
      if (depth === 0 && name.toLowerCase() === 'favorites') {
        inFavorites = true;
        continue;
      }
      inFavorites = false;
      const folder = { type: 'folder', name, children: [] };
      (stack.length ? stack[stack.length - 1].children : space.nodes).push(folder);
      stack.push(folder);
      continue;
    }
    const item = line.match(/^[-*+]\s+(?:<(.+)>|\[[^\]]*\]\((.+)\)|(\S+))\s*$/);
    if (!item || !space) continue;
    const url = (item[1] || item[2] || item[3]).trim();
    if (!/^[a-z][\w+.-]*:/i.test(url)) continue;
    if (inFavorites) space.favorites.push(url);
    else (stack.length ? stack[stack.length - 1].children : space.nodes).push({ type: 'tab', url });
  }
  return spaces;
}

// Arc's own favorites: the addresses in more than half of the spaces'
// Favorites lists (a space from another Arc profile won't have them).
export function sharedFavorites(spaces) {
  const withFavs = spaces.filter(sp => sp.favorites.length);
  if (withFavs.length < 2) return [];
  const count = new Map();
  for (const sp of withFavs) for (const u of new Set(sp.favorites)) count.set(u, (count.get(u) || 0) + 1);
  const first = withFavs.find(sp => sp.favorites.some(u => count.get(u) * 2 > withFavs.length));
  return first ? [...new Set(first.favorites)].filter(u => count.get(u) * 2 > withFavs.length) : [];
}

// A leading emoji on a space name becomes the Sidecar space's icon.
export function splitIcon(name) {
  const m = name.match(/^(\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*)\s*(.*)$/u);
  return m && m[2] ? { icon: m[1], name: m[2] } : { icon: '', name };
}

const tabUrls = nodes => {
  const set = new Set();
  walk(nodes, n => { if (n.type === 'tab' && n.url) set.add(n.url); });
  return set;
};

// The addresses already pinned in each space, and in Favorites.
export function existingUrls(layout) {
  return {
    favorites: tabUrls(layout.favorites),
    spaces: Object.fromEntries(layout.spaces.map(sp => [sp.id, tabUrls(sp.pinned)])),
  };
}

// plan: { favorites: [url], spaces: [{ target: spaceId | 'new', name, nodes }] }
// with only the chosen links left in. Returns a new layout and how many tabs
// were added. Addresses a space (or Favorites) already has are skipped; a
// folder whose name matches one already at the same level is merged into it.
// New folders start collapsed. Folders left empty aren't made, unless they
// were empty in Arc too.
export function mergeArcImport(layout, plan) {
  const out = structuredClone(layout);
  let added = 0;
  const newTab = url => ({ id: uid(), type: 'tab', url, title: '', customTitle: '' });

  const favs = tabUrls(out.favorites);
  for (const url of plan.favorites || []) {
    if (favs.has(url)) continue;
    favs.add(url);
    out.favorites.push(newTab(url));
    added++;
  }

  const used = new Set(out.spaces.map(sp => sp.color));
  const nextColor = () => {
    const c = GROUP_COLORS.find(c => c !== 'grey' && !used.has(c)) || GROUP_COLORS[(out.spaces.length % (GROUP_COLORS.length - 1)) + 1];
    used.add(c);
    return c;
  };

  const addNodes = (list, nodes, have) => {
    for (const n of nodes) {
      if (n.type === 'tab') {
        if (have.has(n.url)) continue;
        have.add(n.url);
        list.push(newTab(n.url));
        added++;
        continue;
      }
      const name = n.name.toLowerCase();
      const existing = list.find(x => x.type === 'folder' && x.name.toLowerCase() === name);
      if (existing) {
        addNodes(existing.children, n.children, have);
        continue;
      }
      const folder = { id: uid(), type: 'folder', name: n.name, collapsed: true, children: [] };
      addNodes(folder.children, n.children, have);
      if (folder.children.length || !n.children.length) list.push(folder);
    }
  };

  for (const p of plan.spaces || []) {
    let sp = p.target === 'new' ? null : out.spaces.find(x => x.id === p.target);
    if (!sp) {
      const { icon, name } = splitIcon(p.name);
      sp = { id: uid(), name: name || 'Space', icon, color: nextColor(), pinned: [] };
      out.spaces.push(sp);
    }
    // Loose tabs first, then folders, after what the space already has.
    const nodes = [...p.nodes.filter(n => n.type === 'tab'), ...p.nodes.filter(n => n.type !== 'tab')];
    addNodes(sp.pinned, nodes, tabUrls(sp.pinned));
  }
  return { layout: out, added };
}

// Roughly what the layout takes in Chrome's sync storage: gzipped, base64'd,
// split into items, as the background stores it.
export const SYNC_LIMIT = 100_000;

// Imported tabs have no titles yet, but each saves its page title (which
// syncs) when first opened. This is the room to keep for one: what a title
// takes in this layout on average, if there are enough to go by, otherwise a
// cautious default. Clamped so a few odd titles can't skew it much.
export async function titleAllowance(layout) {
  const titled = [];
  walk(layout.favorites, n => { if (n.type === 'tab' && n.title) titled.push(n); });
  for (const sp of layout.spaces) walk(sp.pinned, n => { if (n.type === 'tab' && n.title) titled.push(n); });
  if (titled.length < 20) return 40;
  const bare = structuredClone(layout);
  walk(bare.favorites, n => { if (n.type === 'tab') n.title = ''; });
  for (const sp of bare.spaces) walk(sp.pinned, n => { if (n.type === 'tab') n.title = ''; });
  const per = ((await syncSize(layout)) - (await syncSize(bare))) / titled.length;
  return Math.min(80, Math.max(25, Math.round(per)));
}

export async function syncSize(layout) {
  const stream = new Blob([JSON.stringify(layout)]).stream().pipeThrough(new CompressionStream('gzip'));
  const gz = (await new Response(stream).arrayBuffer()).byteLength;
  const b64 = Math.ceil(gz / 3) * 4;
  return b64 + Math.ceil(b64 / 7000) * 12 + 40; // item keys and quotes, plus the meta item
}
