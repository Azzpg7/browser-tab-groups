# Tab Groups Sidebar

A Chrome extension (Manifest V3, no build step) that keeps named groups of tabs and lets you switch between them from the side panel.

- Click a group: its tabs open in the current window and the tabs of the previously active group close (they stay saved in that group).
- Drag a tab between groups in the panel. Moving a tab out of the active group closes it; moving one into the active group opens it. Dropping on a tab inserts before it, dropping on a group header appends.
- Click a tab in the active group to focus it; click a tab in another group to switch to that group. The × on a tab removes it from the group (and closes it if the group is active).
- Type a name in the **+ New group…** field at the bottom and press Enter to create a group.
- Drag a group by its header and drop it above or below another group to reorder the list.
- Double-click a group name (or use ✎) to rename it. 🗑 deletes a group after a second confirming click.
- A **Default** group always exists and cannot be deleted.
- The tabs of the active group are tracked live: opening, closing, reordering or navigating tabs updates the group.

## Install

1. Open `chrome://extensions`, enable **Developer mode**.
2. Click **Load unpacked** and pick this folder.
3. Click the extension icon in the toolbar to open the panel.

### Vim-style keys inside the panel

The panel highlights a selected group (the active group when it opens). Click inside the panel once if keys do not respond, so it has keyboard focus.

| Key | Action |
| --- | --- |
| `j` / `↓` | select the next group |
| `k` / `↑` | select the previous group |
| `h` / `←` | fold the selected group's tab list |
| `l` / `→` | unfold it |
| `Enter` | open the selected group and close the panel |
| `Esc` | leave the "New group" field |

### Keyboard shortcut

`Ctrl+E` opens and closes the panel (on macOS Chrome maps this to `Cmd+E`). Chrome applies this key only on first install; after a reload set it manually. Change it at `chrome://extensions/shortcuts` if it clashes with something else.

### Showing the panel on the left

Chrome decides which side the side panel is on, not the extension. Go to `chrome://settings/appearance`, find **Side panel** and choose **Show on left**. (Chrome 116 or newer is required.)

## How it behaves

- One browser window is "managed" at a time: the one where you last clicked a group. Tabs in other windows are not touched.
- After a browser restart (or an extension reload) no window is managed. Opening the panel links its window to the active group: tabs already open are merged into the group and missing ones are opened. From then on every tab you open in that window is added to the active group.
- Blank tabs (new tab page, `about:blank`) are tracked like any other tab, but are not reopened when a window is linked.
- Tabs that Chrome refuses to open programmatically (for example `file://` without file access) are skipped with a warning in the service worker console.
- Deleting a group forgets its tabs. If it was active, the Default group is opened first.

## Files

- `manifest.json` – extension manifest.
- `background.js` – service worker: state, live tab tracking, group switching, tab moves.
- `sidepanel.html` / `sidepanel.css` / `sidepanel.js` – the panel UI.
- `icons/` – toolbar icons.
