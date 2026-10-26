// Shared helpers used by both the background service worker and the side panel.

// Space colors are limited to Chrome's tab-group palette so that a space and
// its tab group in the tab strip always match.
export const GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];

export const COLOR_HEX = {
  grey: '#8b8f97',
  blue: '#3b82f6',
  red: '#ef4444',
  yellow: '#eab308',
  green: '#22c55e',
  pink: '#ec4899',
  purple: '#a855f7',
  cyan: '#06b6d4',
  orange: '#f97316',
};

export const ICON_PRESETS = [
  '🏠', '✈️', '💼', '🎮', '📚', '🛒', '💰', '🍳', '🎵', '🎨',
  '🏃', '❤️', '🧪', '🛠️', '📷', '🌱', '⭐', '🔥', '🧠', '📰',
];

export const DEFAULT_SETTINGS = {
  archiveHours: 12,        // unpinned tabs unused this long are archived; 0 = never
  compactTitles: true,     // strip " - Site Name" style suffixes from titles
  groupTabsBySpace: true,  // mirror each space as a (collapsed) tab group in the tab strip
};

export function uid() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

export function defaultLayout() {
  return {
    rev: 0,
    spaces: [{ id: uid(), name: 'Home', icon: '🏠', color: 'blue', pinned: [] }],
    favorites: [],
    settings: { ...DEFAULT_SETTINGS },
  };
}

function normalizeNodes(nodes) {
  if (!Array.isArray(nodes)) return [];
  return nodes.filter(n => n && n.id).map(n => n.type === 'folder'
    ? { id: n.id, type: 'folder', name: String(n.name || 'Folder'), collapsed: !!n.collapsed, children: normalizeNodes(n.children) }
    : { id: n.id, type: 'tab', url: String(n.url || ''), title: String(n.title || ''), customTitle: String(n.customTitle || '') });
}

// Coerces anything (old versions, imports, sync data) into a valid layout.
export function normalizeLayout(l) {
  if (!l || !Array.isArray(l.spaces) || !l.spaces.length) {
    const fresh = defaultLayout();
    if (l && l.settings) fresh.settings = { ...DEFAULT_SETTINGS, ...l.settings };
    return fresh;
  }
  return {
    rev: Number(l.rev) || 0,
    spaces: l.spaces.filter(s => s && s.id).map(s => ({
      id: s.id,
      name: String(s.name || 'Space'),
      icon: String(s.icon || ''),
      color: GROUP_COLORS.includes(s.color) ? s.color : 'grey',
      pinned: normalizeNodes(s.pinned),
    })),
    favorites: normalizeNodes(l.favorites).filter(n => n.type === 'tab'),
    settings: { ...DEFAULT_SETTINGS, ...(l.settings || {}) },
  };
}

export function findNode(nodes, id) {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.id === id) return { node: n, list: nodes, index: i };
    if (n.type === 'folder') {
      const f = findNode(n.children, id);
      if (f) return f;
    }
  }
  return null;
}

export function removeNode(nodes, id) {
  const f = findNode(nodes, id);
  if (!f) return null;
  f.list.splice(f.index, 1);
  return f.node;
}

export function walk(nodes, fn) {
  for (const n of nodes) {
    fn(n);
    if (n.type === 'folder') walk(n.children, fn);
  }
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url || '';
  }
}

export function sameUrl(a, b) {
  return !!a && !!b && a.split('#')[0] === b.split('#')[0];
}

const TITLE_SEP = /\s+[|–—·•-]\s+/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// "Inbox (3) - me@gmail.com - Gmail" -> "Inbox (3)"
// "GitHub - owner/repo: description" -> "owner/repo: description"
// "Untitled document - Google Docs"  -> "Untitled document"
export function compactTitle(title, url) {
  const t = (title || '').trim();
  if (!t || t === url) return hostOf(url) || 'New Tab';
  let parts = t.split(TITLE_SEP);
  if (parts.length < 2) return t;
  const host = hostOf(url).toLowerCase().replace(/[^a-z0-9]/g, '');
  const key = parts[0].toLowerCase().replace(/[^a-z0-9]/g, '');
  if (key.length >= 2 && host.includes(key)) parts = parts.slice(1);
  else if (parts[parts.length - 1].length <= 30) parts = parts.slice(0, -1);
  parts = parts.filter(p => !EMAIL.test(p));
  return parts.join(' – ') || t;
}
