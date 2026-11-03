# Sidecar: Arc-style spaces for Chrome

A personal Chrome extension that brings Arc's sidebar to Chrome:

- **Vertical tabs** in Chrome's side panel, with compact names ("Inbox (3) - me@gmail.com - Gmail" shows as "Inbox (3)"). Double-click any name to rename it. Leave the name empty to go back to the page title.
- **Pinned tabs** sit above the line and are kept until you delete them.
  - Open: hover shows **−**, which closes the tab but keeps it pinned.
  - Not open: hover shows **×**, which deletes the pinned tab.
- **Unpinned tabs** sit below the line and are archived after **12 hours** without use. You can change the time in Settings. To get one back, open the archive (box icon, bottom left).
- **Folders** in the pinned section can be nested. Create one with the folder button in the header or from the right-click menu. Click a folder to open or close it. A closed folder still lists any of its tabs that are open, and its icon gets a colored dot.
- **Drag and drop** works for tabs and folders: reorder them, drop them into folders, drag across the line to pin or unpin, drag up to Favorites, or drop onto a space icon at the bottom to move them to that space.
- **Split view** shows two tabs side by side, using Chrome's own split view (Chrome 155 or newer). Drag a tab onto the **middle** of another tab. The half of the row you drop on is the side it goes on, and dropping near a row's top or bottom edge still just reorders. A split shows as one row with both tabs and drags as one piece.
  - In the pinned section, a split is kept with its left/right order, and it syncs. Closing one side keeps the pair, and clicking either side reopens both.
  - In the unpinned section, both tabs are archived together once neither has been used for the archive time.
  - Right-click either side for *Swap sides*, *Separate split view*, pin/unpin and move to space. Separating or swapping with Chrome's own controls updates the sidebar too.
- **Spaces** each have their own name, emoji icon and color, and the sidebar is tinted with the space's color. Switch spaces by clicking the icons at the bottom, swiping sideways with two fingers on the sidebar, or pressing `Alt+Shift+←/→`.
- **Favorites** appear in every space, as icons at the top.
- **Sync**: spaces, pinned tabs, folders, favorites and settings follow you to every computer signed into the same Chrome profile.

## Installing

The code lives at [github.com/mandel01/sidecar](https://github.com/mandel01/sidecar) (private). Chrome runs it straight from a local copy of the repo.

### Before you install

Do these in Chrome first, in every profile you'll use Sidecar in:

1. **Sign into Chrome** with your Google account. Sidecar's sync only works if you're signed in before installing it.
2. **Check sync is on.** Open `chrome://settings/syncSetup` (on some Chrome versions, click your name/profile there first) and go to *Manage what you sync*:
   - **Extensions** must be on. This is where Sidecar's spaces, pinned tabs, favorites and settings sync.
   - **Bookmarks** needs to be on only if you use the [iPhone bookmarks mirror](#iphone-and-ipad).
   - **History and tabs** isn't needed.
3. **Reopen tabs on startup.** Settings → *On startup* → **Continue where you left off** (`chrome://settings/onStartup`). Without it, your open tabs don't come back after Chrome restarts.

### Install

1. Clone the repo. The usual location is `~/Code/sidecar`, but any folder works and it can be different on each computer:
   ```
   gh repo clone mandel01/sidecar ~/Code/sidecar
   ```
   (or `git clone git@github.com:mandel01/sidecar.git ~/Code/sidecar`)
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the cloned folder (the one that contains `manifest.json`).
4. Click the puzzle-piece icon in the toolbar and **pin** Sidecar, then click its icon to open the sidebar.
   `⌥⇧S` (Mac) or `Alt+Shift+S` (Windows/Linux) also opens it. On a Mac, `⌘S` is recommended because it's closer to Arc, but you have to set it yourself (see [Keyboard shortcuts](#keyboard-shortcuts)).
5. Optional: for Arc's look, put the side panel on the left. Go to Settings → *Appearance* → *Side panel* → **Show on left** (`chrome://settings/appearance`).

On first run, every tab you already have open goes into a "Home" space.

## Installing on more computers

1. **Back up first.** On the computer that already has Sidecar, open Settings → *Export…* in **each profile** and keep the files. If something goes wrong on the new computer, *Import…* puts the layout back.
2. On the new computer, follow [Before you install](#before-you-install) and [Install](#install), signed into the **same Google account** as on the first computer. Do this for each profile.

Your spaces, pinned tabs and favorites appear within a few seconds. They sync through Chrome, not through git; the repo only carries the code.

The extension ID stays `gkaleojfpcipaofanpfapmknhmfaeeko` on every computer because of the `key` in `manifest.json`. Chrome only shares sync data between copies of the same extension ID, so **do not remove that key**.

**Updating:** on each computer, run `git pull` in the repo folder, then click the ↻ reload button on the Sidecar card in `chrome://extensions`. The version number on that card goes up with every commit, so comparing it across computers shows whether one is out of date.

**Moving the folder:** Chrome remembers where it loaded Sidecar from, so after moving the folder you have to remove Sidecar and **Load unpacked** again. Synced data comes back, but that computer's unpinned and archived tabs are lost, so use Settings → *Export…* first if you want a backup.

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

## iPhone and iPad

Chrome on iOS can't run extensions, but it does sync bookmarks. Turn on Settings → *Mirror to bookmarks from this computer* and Sidecar keeps a copy of your layout in **Other Bookmarks → Sidecar**:

```
Sidecar/
  ★ Favorites/
  🏠 Home/        ← one folder per space, with its pinned tabs and folders
  💼 Work/
```

- It updates a few seconds after any change, and Chrome syncs the bookmarks to your phone. Unpinned and archived tabs aren't included.
- Sidecar owns that folder, so anything you change inside it, on the phone or in the bookmark manager, gets overwritten. Nothing outside it is touched.
- Turn it on for **one computer only**. The layout is the same everywhere, and two computers rewriting the same folder can make bookmark sync create duplicates.
- Turning it off stops the updates and leaves the folder where it is. Delete the folder yourself if you no longer want it.

## Keyboard shortcuts

| Action | Default |
|---|---|
| New tab in the current space | `⌘T` / `Ctrl+T` (built into Chrome) |
| Open the sidebar | `Alt+Shift+S` (`⌥⇧S` on Mac) |
| Next / previous space | `Alt+Shift+→` / `Alt+Shift+←` |
| Pin / unpin the current tab | `Alt+Shift+D` |
| Add / remove the current tab from Favorites | (not set) |

To change any of these, go to `chrome://extensions/shortcuts`, or Settings → *Edit shortcuts…*. On a Mac, `Alt` is `⌥ Option`.

**Recommended on a Mac:** set *Open the sidebar* to `⌘S`, which is closer to Arc's sidebar toggle. Chrome won't let an extension claim one of its own shortcuts by default (`⌘S` is Save Page), so you have to set it by hand in `chrome://extensions/shortcuts`. Do this on each computer, and again whenever you remove and reinstall Sidecar.

In the sidebar: **click** a tab to open it, **middle-click** to close it, **double-click** its name to rename (folders: right-click → *Rename*), and **right-click** for more options (copy link, move to space, "Set pinned URL to current page", and so on).

## How it maps onto Chrome

- **New tabs** (`⌘T`, links, anything) join the space of the window they open in. Links open in the same space as the tab they came from.
- **New Tab page:** Sidecar replaces Chrome's New Tab page with a plain blank one, so the bookmarks bar doesn't pop in and out every time you press `⌘T`. The cursor still goes to the address bar. The first time, Chrome asks whether to keep the change; click **Keep it**. You lose Chrome's own New Tab page (Google search box and shortcut tiles).
- **Tab groups:** each space also appears as a tab group in Chrome's top tab strip. The current space's group is expanded and the others are collapsed, which keeps the strip tidy. If you click a tab from another space in the strip, the sidebar switches to that space. You can turn this off in Settings.
- **Pinned tabs** keep their "home" URL. If a pinned tab has navigated somewhere else and you want the new page to be its home, right-click → *Set pinned URL to current page*. To type a home URL yourself, right-click → *Edit pinned URL…* (*Edit URL…* on favorites). If the tab is open, it goes to the new URL.
- **Restarting Chrome:** with **Continue where you left off** set (see [Before you install](#before-you-install)), Sidecar matches restored tabs back to their spaces and pinned entries. Unpinned tabs that weren't restored stay listed, dimmed, and reopen when you click them.
- **Multiple windows:** each window can be on a different space.
- **Split views made in Chrome** (for example right-click a tab → split view) show up as a split in the sidebar when both tabs are in the same section of the same space. A pinned tab split with a tab it opened (say, *Open link in split view*) becomes a pinned split; drag it below the line if you don't want to keep it. A pinned tab split with any other unpinned tab stays as two separate rows.

## Profiles (Arc's separate logins)

Chrome extensions can't keep separate cookies or logins per space, so the closest match to Arc profiles is **Chrome profiles**, which is what you planned:

- Create a profile per identity, for example *Personal* and *Work*, from the profile icon → **Add**.
- Install Sidecar in each profile with **Load unpacked**, pointing at the same folder.
- Each profile has its own spaces, pinned tabs and favorites, and syncs through whatever Google account that profile is signed into.

So instead of "assign this space to the Work profile", you put your work spaces in the Work profile's window.

## Limitations

- Chrome's horizontal tab strip can't be hidden by an extension. Collapsing spaces into tab groups is the closest available option.
- The sidebar is Chrome's side panel, so it opens per window. Use the keyboard shortcut or the toolbar icon to open it.
- Favicons for tabs that aren't open come from Chrome's favicon cache. A site you've never visited on this computer shows a globe until you open it once.
- Chrome-pinned tabs (Chrome's own pin) can't be put in tab groups, so they never move into a space's group.
- Chrome doesn't let extensions read or set where a split view's divider sits, so a pinned split keeps which tab is on which side but always reopens at Chrome's default width.

## Files

| File | Purpose |
|---|---|
| `manifest.json` | Extension definition, permissions, shortcuts, fixed ID key |
| `background.js` | Service worker: owns all state, tab events, space switching, tab groups, auto-archive, sync |
| `sidepanel.html` / `.css` / `.js` | The sidebar UI |
| `shared.js` | Helpers shared by both: colors, layout normalization, tree helpers, title compaction |
| `newtab.html` | Blank New Tab page |
| `icons/` | Toolbar and extension icons |
