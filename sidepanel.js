// Side panel UI. Renders state from the service worker and sends commands to it.

const DND_TYPE = 'application/x-tabgroups';
const DND_GROUP_TYPE = 'application/x-tabgroups-group';
const $ = (sel, root = document) => root.querySelector(sel);

let windowId = null;
let state = null;
let managedWindowId = null;
let toastTimer = null;
let pendingDelete = null;
let selectedGroupId = null; // keyboard selection, independent of the active group

const collapsed = new Set(JSON.parse(localStorage.getItem('collapsed') || '[]'));

// --------------------------------------------------------------- helpers

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'dataset') Object.assign(node.dataset, value);
    else node[key] = value;
  }
  node.append(...children);
  return node;
}

function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (node.hidden = true), 3000);
}

async function send(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...payload });
  if (!res) throw new Error('No response from the extension');
  if (!res.ok) throw new Error(res.error);
  return res.result;
}

async function act(type, payload) {
  try {
    return await send(type, payload);
  } catch (err) {
    toast(err.message);
    return undefined;
  }
}

function faviconFor(entry) {
  if (/^(https?:|data:)/.test(entry.favIconUrl || '')) return entry.favIconUrl;
  const url = new URL(chrome.runtime.getURL('/_favicon/'));
  url.searchParams.set('pageUrl', entry.url);
  url.searchParams.set('size', '16');
  return url.toString();
}

function saveCollapsed() {
  localStorage.setItem('collapsed', JSON.stringify([...collapsed]));
}

function groupNode(id) {
  return document.querySelector(`.group[data-id="${CSS.escape(id)}"]`);
}

function setCollapsed(id, value) {
  if (value) collapsed.add(id);
  else collapsed.delete(id);
  saveCollapsed();
  groupNode(id)?.classList.toggle('collapsed', value);
}

function selectGroup(id) {
  selectedGroupId = id;
  for (const li of document.querySelectorAll('.group')) {
    li.classList.toggle('selected', li.dataset.id === id);
  }
  groupNode(id)?.scrollIntoView({ block: 'nearest' });
}

/** Close this side panel. Newer Chrome has an API for it; older builds honour window.close(). */
async function closePanel() {
  if (chrome.sidePanel?.close) {
    try {
      await chrome.sidePanel.close({ windowId });
      return;
    } catch {
      /* fall through */
    }
  }
  window.close();
}

async function openGroupAndClose(groupId) {
  const ok = await act('switchGroup', { groupId, windowId });
  if (ok) await closePanel();
}

// ------------------------------------------------------------- keyboard
// j/k move the selection, h/l fold/unfold, Enter opens the selected group.

function onKeyDown(e) {
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || e.altKey || e.ctrlKey || e.metaKey || !state) return;
  const ids = state.groups.map((g) => g.id);
  if (!ids.length) return;
  const idx = ids.indexOf(selectedGroupId);
  switch (e.key) {
    case 'j':
    case 'ArrowDown':
      selectGroup(ids[Math.min(idx + 1, ids.length - 1)]);
      break;
    case 'k':
    case 'ArrowUp':
      selectGroup(ids[Math.max(idx - 1, 0)]);
      break;
    case 'h':
    case 'ArrowLeft':
      if (selectedGroupId) setCollapsed(selectedGroupId, true);
      break;
    case 'l':
    case 'ArrowRight':
      if (selectedGroupId) setCollapsed(selectedGroupId, false);
      break;
    case 'Enter':
      if (selectedGroupId) openGroupAndClose(selectedGroupId);
      break;
    default:
      return;
  }
  e.preventDefault();
}

// ------------------------------------------------------------ drag & drop

function dropTarget(node, groupId, beforeUid) {
  node.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes(DND_TYPE)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    node.classList.add('drop');
  });
  node.addEventListener('dragleave', () => node.classList.remove('drop'));
  node.addEventListener('drop', (e) => {
    if (!e.dataTransfer.types.includes(DND_TYPE)) return;
    e.preventDefault();
    e.stopPropagation();
    node.classList.remove('drop');
    let data;
    try {
      data = JSON.parse(e.dataTransfer.getData(DND_TYPE));
    } catch {
      return;
    }
    if (!data || data.uid === beforeUid) return;
    act('moveTab', { uid: data.uid, fromGroupId: data.groupId, toGroupId: groupId, beforeUid });
  });
}

/** Make a group element a drop target for other groups: top half = before, bottom half = after. */
function groupDropTarget(li, groupId) {
  const clear = () => li.classList.remove('drop-before', 'drop-after');
  const placement = (e) => {
    const rect = li.getBoundingClientRect();
    return e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
  };
  li.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes(DND_GROUP_TYPE)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    clear();
    li.classList.add(`drop-${placement(e)}`);
  });
  li.addEventListener('dragleave', (e) => {
    if (!li.contains(e.relatedTarget)) clear();
  });
  li.addEventListener('drop', (e) => {
    if (!e.dataTransfer.types.includes(DND_GROUP_TYPE)) return;
    e.preventDefault();
    e.stopPropagation();
    clear();
    const draggedId = e.dataTransfer.getData(DND_GROUP_TYPE);
    if (!draggedId || draggedId === groupId) return;
    let beforeGroupId;
    if (placement(e) === 'before') {
      beforeGroupId = groupId;
    } else {
      const next = li.nextElementSibling;
      beforeGroupId = next ? next.dataset.id : null;
    }
    if (beforeGroupId === draggedId) return;
    act('reorderGroup', { groupId: draggedId, beforeGroupId });
  });
}

// ---------------------------------------------------------------- render

function render() {
  const list = $('#groups');
  list.replaceChildren();
  $('#hint').hidden = managedWindowId === windowId;
  if (!state.groups.some((g) => g.id === selectedGroupId)) selectedGroupId = state.activeGroupId;
  for (const group of state.groups) {
    list.append(renderGroup(group, group.id === state.activeGroupId));
  }
  selectGroup(selectedGroupId);
}

function renderGroup(group, isActive) {
  const li = el('li', {
    className: ['group', isActive ? 'active' : '', collapsed.has(group.id) ? 'collapsed' : ''].join(' ').trim(),
    dataset: { id: group.id },
  });

  const toggle = el('button', { className: 'icon-btn toggle', textContent: '▾', title: 'Collapse / expand' });
  toggle.onclick = (e) => {
    e.stopPropagation();
    setCollapsed(group.id, !collapsed.has(group.id));
  };

  const name = el('span', { className: 'name', textContent: group.name, title: 'Double-click to rename' });
  name.ondblclick = (e) => {
    e.stopPropagation();
    startRename(group, name);
  };

  const count = el('span', { className: 'count', textContent: String(group.tabs.length) });

  const actions = el('span', { className: 'actions' });
  const renameBtn = el('button', { className: 'icon-btn', textContent: '✎', title: 'Rename group' });
  renameBtn.onclick = (e) => {
    e.stopPropagation();
    startRename(group, name);
  };
  actions.append(renameBtn);
  if (group.id !== 'default') {
    const deleteBtn = el('button', { className: 'icon-btn danger', textContent: '🗑', title: 'Delete group' });
    deleteBtn.onclick = (e) => {
      e.stopPropagation();
      if (pendingDelete === group.id) {
        pendingDelete = null;
        act('deleteGroup', { groupId: group.id, windowId });
      } else {
        pendingDelete = group.id;
        deleteBtn.textContent = '❓';
        deleteBtn.title = 'Click again to delete this group and forget its tabs';
        toast(`Click 🗑 again to delete "${group.name}"`);
        setTimeout(() => {
          if (pendingDelete === group.id) pendingDelete = null;
          deleteBtn.textContent = '🗑';
          deleteBtn.title = 'Delete group';
        }, 3000);
      }
    };
    actions.append(deleteBtn);
  }

  const header = el('div', {
    className: 'group-header',
    title: 'Click to open this group, drag to reorder',
    draggable: true,
  });
  header.append(toggle, name, count, actions);
  header.onclick = () => {
    selectGroup(group.id);
    act('switchGroup', { groupId: group.id, windowId });
  };
  header.ondragstart = (e) => {
    if (name.querySelector('input')) {
      e.preventDefault(); // renaming: let the input handle the mouse
      return;
    }
    e.dataTransfer.setData(DND_GROUP_TYPE, group.id);
    e.dataTransfer.effectAllowed = 'move';
    li.classList.add('dragging');
  };
  header.ondragend = () => {
    li.classList.remove('dragging');
    for (const node of document.querySelectorAll('.drop, .drop-before, .drop-after')) {
      node.classList.remove('drop', 'drop-before', 'drop-after');
    }
  };
  dropTarget(header, group.id, null);
  groupDropTarget(li, group.id);

  const tabs = el('ul', { className: 'tabs' });
  for (const entry of group.tabs) tabs.append(renderTab(group, entry, isActive));
  if (!group.tabs.length) tabs.append(el('li', { className: 'empty', textContent: 'No tabs' }));
  dropTarget(tabs, group.id, null);

  li.append(header, tabs);
  return li;
}

function renderTab(group, entry, isActive) {
  const li = el('li', {
    className: entry.pinned ? 'tab pinned' : 'tab',
    draggable: true,
    dataset: { uid: entry.uid },
    title: entry.url,
  });

  const icon = el('img', { className: 'favicon', src: faviconFor(entry), alt: '' });
  icon.onerror = () => {
    icon.onerror = null;
    icon.src = faviconFor({ url: entry.url, favIconUrl: '' });
  };
  const title = el('span', { className: 'title', textContent: entry.title || entry.url });
  const close = el('button', { className: 'icon-btn close', textContent: '×', title: 'Remove from group' });
  close.onclick = (e) => {
    e.stopPropagation();
    act('removeTab', { groupId: group.id, uid: entry.uid });
  };

  li.append(icon, title, close);
  li.onclick = () => {
    if (isActive && managedWindowId === windowId && entry.tabId != null) {
      act('activateTab', { tabId: entry.tabId });
    } else {
      act('switchGroup', { groupId: group.id, windowId });
    }
  };
  li.ondragstart = (e) => {
    e.dataTransfer.setData(DND_TYPE, JSON.stringify({ uid: entry.uid, groupId: group.id }));
    e.dataTransfer.effectAllowed = 'move';
    li.classList.add('dragging');
  };
  li.ondragend = () => {
    li.classList.remove('dragging');
    for (const node of document.querySelectorAll('.drop')) node.classList.remove('drop');
  };
  dropTarget(li, group.id, entry.uid);
  return li;
}

function startRename(group, nameNode) {
  const input = el('input', { type: 'text', value: group.name, maxLength: 60 });
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    if (save && value && value !== group.name) await act('renameGroup', { groupId: group.id, name: value });
    else render();
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  };
  input.onblur = () => finish(true);
  input.onclick = (e) => e.stopPropagation();
  nameNode.replaceChildren(input);
  input.focus();
  input.select();
}

// ------------------------------------------------------------------ init

/** Give the panel document keyboard focus so j/k/h/l/Enter reach it. */
function focusPanel() {
  const list = $('#groups');
  list.tabIndex = -1;
  list.focus({ preventScroll: true });
}

async function refresh() {
  const res = await act('getState');
  if (!res) return;
  state = res.state;
  managedWindowId = res.managedWindowId;
  render();
}

(async () => {
  windowId = (await chrome.windows.getCurrent()).id;

  const form = $('#new-group-form');
  const nameInput = $('#new-group-name');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const name = nameInput.value.trim();
    if (!name) return;
    if ((await act('createGroup', { name })) !== undefined) nameInput.value = '';
  };
  nameInput.onkeydown = (e) => {
    if (e.key === 'Escape') {
      nameInput.blur();
      focusPanel();
    }
  };

  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') focusPanel();
  });
  focusPanel();

  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area === 'local' || area === 'session') refresh();
  });
  await refresh();

  // No window is linked yet (first run, browser restart, extension reload):
  // link this one so its tabs are tracked in the active group from now on.
  if (state && managedWindowId == null) {
    await act('switchGroup', { groupId: state.activeGroupId, windowId });
  }
})();
