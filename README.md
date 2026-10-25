# vtabs: Arc-style spaces for Chrome

A personal Chrome extension that brings Arc's sidebar to Chrome:

- **Vertical tabs** in Chrome's side panel, with compact names ("Inbox (3) - me@gmail.com - Gmail" shows as "Inbox (3)"). Double-click any name to rename it. Leave the name empty to go back to the page title.
- **Pinned tabs** sit above the line and are kept until you delete them.
  - Open: hover shows **−**, which closes the tab but keeps it pinned.
  - Not open: hover shows **×**, which deletes the pinned tab.
- **Unpinned tabs** sit below the line and are archived after **18 hours** without use. You can change the time in Settings. To get one back, open the archive (box icon, bottom left).
- **Folders** in the pinned section can be nested. Create one with the folder button in the header or from the right-click menu.
- **Drag and drop** works for tabs and folders: reorder them, drop them into folders, drag across the line to pin or unpin, drag up to Favorites, or drop onto a space icon at the bottom to move them to that space.
- **Spaces** each have their own name, emoji icon and color, and the sidebar is tinted with the space's color. Switch spaces by clicking the icons at the bottom, swiping sideways with two fingers on the sidebar, or pressing `Alt+Shift+←/→`.
- **Favorites** appear in every space, as icons at the top.
- **Sync**: spaces, pinned tabs, folders, favorites and settings follow you to every computer signed into the same Chrome profile.

## Installing (first computer)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose this folder (`vtabs`, the one that contains `manifest.json`).
4. Click the puzzle-piece icon in the toolbar and **pin** vtabs, then click its icon to open the sidebar.
   `Alt+Shift+S` also opens it.
5. Optional: to get Arc's look, drag the side panel to the left side. Click the side panel's menu and choose **Position → Left**, or go to Settings → Appearance → *Side panel position*.

On first run, every tab you already have open goes into a "Home" space.

## Installing on more computers

The folder is already in Dropbox, so each computer has the same copy:

1. Wait for Dropbox to finish syncing the `vtabs` folder.
2. On that computer, repeat steps 1–4 above and point **Load unpacked** at the Dropbox copy. The folder path can be different on each computer.
3. Sign into Chrome with the **same Google account**, and check that sync is on for extensions: Settings → *You and Google* → *Sync and Google services* → *Manage what you sync*, with **Extensions** on.

Your spaces, pinned tabs and favorites appear within a few seconds.

The extension ID stays `gkaleojfpcipaofanpfapmknhmfaeeko` on every computer because of the `key` in `manifest.json`. Chrome only shares sync data between copies of the same extension ID, so **do not remove that key**.

**Updating:** when the code changes, Dropbox delivers the new files. Then click the ↻ reload button on the vtabs card in `chrome://extensions`, on each computer.

## Sync: what syncs and how secure it is

| Syncs to all computers | Stays on this computer |
|---|---|
| Spaces (name, icon, color, order) | Unpinned tabs |
| Pinned tabs and folders | Which tabs are currently open |
| Favorites | Archived tabs |
| Settings | |

- Sync goes through `chrome.storage.sync`, so it uses your Google account's Chrome Sync. Nothing is sent to any other server, and the extension makes no network requests of its own.
- Data is encrypted in transit and at rest by Google. For **end-to-end encryption**, where Google can't read it, set a sync passphrase: Settings → *You and Google* → *Sync and Google services* → *Encryption options* → **Encrypt synced data with your own sync passphrase**. That covers extension data as well as bookmarks and passwords.
- If two computers change the layout at nearly the same time, the most recent change wins.
- Chrome allows 100 KB of sync storage. The layout is compressed, so a few thousand pinned tabs fit. Settings → Sync shows how much is used.
- **Backups:** Settings → *Export…* saves a JSON file, and *Import…* restores it. *Replace with synced layout* forces this computer to take the synced version.

## Keyboard shortcuts

| Action | Default |
|---|---|
| New tab in the current space | `⌘T` / `Ctrl+T` (built into Chrome) |
| Open the sidebar | `Alt+Shift+S` |
| Next / previous space | `Alt+Shift+→` / `Alt+Shift+←` |
| Pin / unpin the current tab | `Alt+Shift+D` |
| Add / remove the current tab from Favorites | (not set) |

To change any of these, go to `chrome://extensions/shortcuts`, or Settings → *Edit shortcuts…*. On a Mac, `Alt` is `⌥ Option`.

In the sidebar: **click** a tab to open it, **middle-click** to close it, **double-click** its name to rename, and **right-click** for more options (copy link, move to space, "Set pinned URL to current page", and so on).

## How it maps onto Chrome

- **New tabs** (`⌘T`, links, anything) join the space of the window they open in. Links open in the same space as the tab they came from.
- **Tab groups:** each space also appears as a tab group in Chrome's top tab strip. The current space's group is expanded and the others are collapsed, which keeps the strip tidy. If you click a tab from another space in the strip, the sidebar switches to that space. You can turn this off in Settings.
- **Pinned tabs** keep their "home" URL. If a pinned tab has navigated somewhere else and you want the new page to be its home, right-click → *Set pinned URL to current page*.
- **Restarting Chrome:** for open tabs to come back, set Chrome to reopen them: Settings → *On startup* → **Continue where you left off**. vtabs matches restored tabs back to their spaces and pinned entries. Unpinned tabs that weren't restored stay listed, dimmed, and reopen when you click them.
- **Multiple windows:** each window can be on a different space.

## Profiles (Arc's separate logins)

Chrome extensions can't keep separate cookies or logins per space, so the closest match to Arc profiles is **Chrome profiles**, which is what you planned:

- Create a profile per identity, for example *Personal* and *Work*, from the profile icon → **Add**.
- Install vtabs in each profile with **Load unpacked**, pointing at the same folder.
- Each profile has its own spaces, pinned tabs and favorites, and syncs through whatever Google account that profile is signed into.

So instead of "assign this space to the Work profile", you put your work spaces in the Work profile's window.

## Limitations

- Chrome's horizontal tab strip can't be hidden by an extension. Collapsing spaces into tab groups is the closest available option.
- The sidebar is Chrome's side panel, so it opens per window. Use `Alt+Shift+S` or the toolbar icon to open it.
- Favicons for tabs that aren't open come from Chrome's favicon cache. A site you've never visited on this computer shows a globe until you open it once.
- Chrome-pinned tabs (Chrome's own pin) can't be put in tab groups, so they never move into a space's group.

## Files

| File | Purpose |
|---|---|
| `manifest.json` | Extension definition, permissions, shortcuts, fixed ID key |
| `background.js` | Service worker: owns all state, tab events, space switching, tab groups, auto-archive, sync |
| `sidepanel.html` / `.css` / `.js` | The sidebar UI |
| `shared.js` | Helpers shared by both: colors, layout normalization, tree helpers, title compaction |
| `icons/` | Toolbar and extension icons |
