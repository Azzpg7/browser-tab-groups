// Service worker. Owns all state mutations and all browser tab operations.
// The side panel only renders state and sends commands here.
//
// State shape (chrome.storage.local, key "state"):
//   { activeGroupId, groups: [{ id, name, tabs: [{ uid, tabId, url, title, favIconUrl, pinned }] }] }
//
// Exactly one browser window is "managed" at a time (chrome.storage.session, key "managedWindowId").
// The tabs of the managed window are mirrored live into the active group.

const DEFAULT_GROUP_ID = 'default';
const BLANK_URL_PREFIXES = ['chrome://newtab', 'chrome://new-tab-page', 'about:blank', 'about:newtab'];
const SYNC_DELAY_MS = 250;

let busy = 0; // > 0 while this worker itself is creating/removing tabs; live sync is paused
let syncTimer = null;
let chain = Promise.resolve(); // serializes read-modify-write on state
const closingWindows = new Set();

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
  withState(() => {}).catch(console.error); // materialize the default state
});

// ---------------------------------------------------------------- state

function newId() {
  return crypto.randomUUID();
}

function defaultState() {
  return {
    activeGroupId: DEFAULT_GROUP_ID,
    groups: [{ id: DEFAULT_GROUP_ID, name: 'Default', tabs: [] }],
  };
}

async function loadState() {
  const { state } = await chrome.storage.local.get('state');
  if (!state || !Array.isArray(state.groups)) return defaultState();
  if (!state.groups.some((g) => g.id === DEFAULT_GROUP_ID)) {
    state.groups.unshift({ id: DEFAULT_GROUP_ID, name: 'Default', tabs: [] });
  }
  if (!state.groups.some((g) => g.id === state.activeGroupId)) {
    state.activeGroupId = DEFAULT_GROUP_ID;
  }
  for (const g of state.groups) g.tabs = Array.isArray(g.tabs) ? g.tabs : [];
  return state;
}

/** Run fn(state) with exclusive access, persist the state afterwards, return fn's result. */
function withState(fn) {
  const run = chain.then(async () => {
    const state = await loadState();
    const result = await fn(state);
    await chrome.storage.local.set({ state });
    return result;
  });
  chain = run.catch(() => {});
  return run;
}

function findGroup(state, id) {
  return state.groups.find((g) => g.id === id);
}

function isBlank(url) {
  return !url || BLANK_URL_PREFIXES.some((p) => url.startsWith(p));
}

function tabToEntry(tab, prev) {
  const url = tab.url || tab.pendingUrl || '';
  const same = prev && prev.url === url;
  return {
    uid: prev ? prev.uid : newId(),
    tabId: tab.id,
    url,
    title: tab.title || (same ? prev.title : '') || url,
    favIconUrl: tab.favIconUrl || (same ? prev.favIconUrl : '') || '',
    pinned: !!tab.pinned,
  };
}

function entriesFromTabs(tabs, prevEntries = []) {
  const prev = new Map(prevEntries.filter((e) => e.tabId != null).map((e) => [e.tabId, e]));
  return tabs.map((t) => tabToEntry(t, prev.get(t.id)));
}

function mergeByUrl(stored, open) {
  const seen = new Set(stored.map((e) => e.url));
  return [...stored, ...open.filter((e) => !seen.has(e.url))];
}

// ------------------------------------------------------- managed window

async function getManagedWindowId() {
  const { managedWindowId } = await chrome.storage.session.get('managedWindowId');
  if (managedWindowId == null || closingWindows.has(managedWindowId)) return null;
  try {
    await chrome.windows.get(managedWindowId);
    return managedWindowId;
  } catch {
    await chrome.storage.session.remove('managedWindowId');
    return null;
  }
}

async function forgetWindow(windowId) {
  closingWindows.add(windowId);
  const { managedWindowId } = await chrome.storage.session.get('managedWindowId');
  if (managedWindowId === windowId) await chrome.storage.session.remove('managedWindowId');
}

// ------------------------------------------------------------ live sync

function scheduleSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncActiveGroup().catch(console.error), SYNC_DELAY_MS);
}

async function syncActiveGroup() {
  if (busy) return;
  const windowId = await getManagedWindowId();
  if (windowId == null) return;
  const tabs = await chrome.tabs.query({ windowId });
  if (busy || closingWindows.has(windowId) || tabs.length === 0) return;
  await withState((state) => {
    const group = findGroup(state, state.activeGroupId);
    group.tabs = entriesFromTabs(tabs, group.tabs);
  });
}

chrome.tabs.onCreated.addListener(() => scheduleSync());
chrome.tabs.onMoved.addListener(() => scheduleSync());
chrome.tabs.onAttached.addListener(() => scheduleSync());
chrome.tabs.onDetached.addListener(() => scheduleSync());
chrome.tabs.onUpdated.addListener((_tabId, info) => {
  if (info.url || info.title || info.favIconUrl || info.pinned !== undefined || info.status === 'complete') {
    scheduleSync();
  }
});
chrome.tabs.onRemoved.addListener((_tabId, info) => {
  if (info.isWindowClosing) forgetWindow(info.windowId).catch(console.error);
  else scheduleSync();
});
chrome.windows.onRemoved.addListener((windowId) => forgetWindow(windowId).catch(console.error));

// ------------------------------------------------------- tab helpers

async function createTab(windowId, entry, active, index) {
  const props = { windowId, url: entry.url, active, pinned: !!entry.pinned };
  if (index != null) props.index = index;
  try {
    return await chrome.tabs.create(props);
  } catch (err) {
    console.warn('Could not open tab', entry.url, err);
    return null;
  }
}

async function removeTabs(ids) {
  if (!ids.length) return;
  try {
    await chrome.tabs.remove(ids);
  } catch (err) {
    console.warn('Could not close tabs', ids, err);
  }
}

/** Chrome closes a window when its last tab is removed; open a blank tab first if needed. */
async function ensureNotLastTab(windowId) {
  const tabs = await chrome.tabs.query({ windowId });
  if (tabs.length <= 1) await chrome.tabs.create({ windowId, active: true });
}

/** Window index right after `prev` (an entry of the active group), or null when unknown. */
async function indexAfter(prev, movingTabId) {
  if (!prev) return 0;
  if (prev.tabId == null) return null;
  try {
    const prevTab = await chrome.tabs.get(prev.tabId);
    if (movingTabId != null) {
      const moving = await chrome.tabs.get(movingTabId);
      if (moving.index < prevTab.index) return prevTab.index;
    }
    return prevTab.index + 1;
  } catch {
    return null;
  }
}

// -------------------------------------------------------------- commands

async function switchGroup(targetGroupId, windowId) {
  if (busy) throw new Error('Another operation is in progress, try again');
  busy++;
  try {
    const managed = await getManagedWindowId();
    const openTabs = await chrome.tabs.query({ windowId });
    const openEntries = entriesFromTabs(openTabs);

    const plan = await withState((state) => {
      const target = findGroup(state, targetGroupId);
      if (!target) throw new Error('Group not found');
      const active = findGroup(state, state.activeGroupId);
      if (managed === windowId) {
        // This window is already mirrored: take an exact snapshot.
        active.tabs = entriesFromTabs(openTabs, active.tabs);
      } else {
        // Adopting a new window (e.g. after a browser restart): keep what we
        // stored and add whatever is open that we do not know about.
        active.tabs = mergeByUrl(active.tabs, openEntries.filter((e) => !isBlank(e.url)));
      }
      return {
        target: structuredClone(target),
        previousGroupId: active.id,
        sameGroup: target.id === active.id,
      };
    });

    if (plan.sameGroup && managed === windowId) return;

    if (plan.sameGroup) {
      // Adopt this window into the active group: open only what is missing.
      const openUrls = new Set(openEntries.map((e) => e.url));
      for (const entry of plan.target.tabs) {
        if (!openUrls.has(entry.url) && !isBlank(entry.url)) await createTab(windowId, entry, false);
      }
    } else {
      const opened = [];
      for (const [i, entry] of plan.target.tabs.entries()) {
        const tab = await createTab(windowId, entry, i === 0);
        if (tab) opened.push({ ...entry, tabId: tab.id });
      }
      if (!opened.length) await chrome.tabs.create({ windowId, active: true });
      await removeTabs(openTabs.map((t) => t.id));
      await withState((state) => {
        state.activeGroupId = targetGroupId;
        findGroup(state, targetGroupId).tabs = opened;
        const previous = findGroup(state, plan.previousGroupId);
        if (previous) for (const e of previous.tabs) e.tabId = null;
      });
    }
    await chrome.storage.session.set({ managedWindowId: windowId });
  } finally {
    busy--;
    scheduleSync();
  }
}

async function moveTab({ uid, fromGroupId, toGroupId, beforeUid }) {
  if (busy) throw new Error('Another operation is in progress, try again');
  busy++;
  try {
    const managed = await getManagedWindowId();
    const res = await withState((state) => {
      const from = findGroup(state, fromGroupId);
      const to = findGroup(state, toGroupId);
      if (!from || !to) throw new Error('Group not found');
      const idx = from.tabs.findIndex((e) => e.uid === uid);
      if (idx < 0) throw new Error('Tab not found');
      const [entry] = from.tabs.splice(idx, 1);
      let insertAt = beforeUid ? to.tabs.findIndex((e) => e.uid === beforeUid) : -1;
      if (insertAt < 0) insertAt = to.tabs.length;
      const toActive = to.id === state.activeGroupId;
      const liveTabId = entry.tabId;
      if (!toActive) entry.tabId = null;
      to.tabs.splice(insertAt, 0, entry);
      return {
        entry: structuredClone(entry),
        fromActive: from.id === state.activeGroupId,
        toActive,
        prev: structuredClone(to.tabs[insertAt - 1] ?? null),
        liveTabId,
      };
    });
    if (managed == null) return;

    const { entry, fromActive, toActive, prev, liveTabId } = res;
    if (fromActive && !toActive) {
      if (liveTabId != null) {
        await ensureNotLastTab(managed);
        await removeTabs([liveTabId]);
      }
    } else if (!fromActive && toActive) {
      const index = await indexAfter(prev);
      const tab = await createTab(managed, entry, false, index);
      if (tab) {
        await withState((state) => {
          const e = findGroup(state, toGroupId)?.tabs.find((x) => x.uid === uid);
          if (e) e.tabId = tab.id;
        });
      }
    } else if (fromActive && toActive && liveTabId != null) {
      const index = await indexAfter(prev, liveTabId);
      try {
        await chrome.tabs.move(liveTabId, { index: index ?? -1 });
      } catch (err) {
        console.warn('Could not reorder tab', err);
      }
    }
  } finally {
    busy--;
    scheduleSync();
  }
}

async function removeTab({ groupId, uid }) {
  busy++;
  try {
    const managed = await getManagedWindowId();
    const res = await withState((state) => {
      const group = findGroup(state, groupId);
      if (!group) throw new Error('Group not found');
      const idx = group.tabs.findIndex((e) => e.uid === uid);
      if (idx < 0) return null;
      const [entry] = group.tabs.splice(idx, 1);
      return { tabId: entry.tabId, active: group.id === state.activeGroupId };
    });
    if (res && res.active && managed != null && res.tabId != null) {
      await ensureNotLastTab(managed);
      await removeTabs([res.tabId]);
    }
  } finally {
    busy--;
    scheduleSync();
  }
}

async function activateTab({ tabId }) {
  const tab = await chrome.tabs.get(tabId);
  await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
}

async function createGroup({ name }) {
  const trimmed = (name || '').trim();
  if (!trimmed) throw new Error('Group name is empty');
  return withState((state) => {
    const id = newId();
    state.groups.push({ id, name: trimmed, tabs: [] });
    return id;
  });
}

async function renameGroup({ groupId, name }) {
  const trimmed = (name || '').trim();
  if (!trimmed) throw new Error('Group name is empty');
  await withState((state) => {
    const group = findGroup(state, groupId);
    if (!group) throw new Error('Group not found');
    group.name = trimmed;
  });
}

async function reorderGroup({ groupId, beforeGroupId }) {
  await withState((state) => {
    const idx = state.groups.findIndex((g) => g.id === groupId);
    if (idx < 0) throw new Error('Group not found');
    const [group] = state.groups.splice(idx, 1);
    let insertAt = beforeGroupId ? state.groups.findIndex((g) => g.id === beforeGroupId) : -1;
    if (insertAt < 0) insertAt = state.groups.length;
    state.groups.splice(insertAt, 0, group);
  });
}

async function deleteGroup({ groupId, windowId }) {
  if (groupId === DEFAULT_GROUP_ID) throw new Error('The default group cannot be deleted');
  const state = await loadState();
  if (state.activeGroupId === groupId) await switchGroup(DEFAULT_GROUP_ID, windowId);
  await withState((s) => {
    s.groups = s.groups.filter((g) => g.id !== groupId);
  });
}

async function getState() {
  return { state: await loadState(), managedWindowId: await getManagedWindowId() };
}

const handlers = {
  getState,
  switchGroup: async ({ groupId, windowId }) => {
    await switchGroup(groupId, windowId);
    return true;
  },
  moveTab,
  removeTab,
  activateTab,
  createGroup,
  renameGroup,
  reorderGroup,
  deleteGroup,
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) {
    sendResponse({ ok: false, error: `Unknown command: ${msg?.type}` });
    return false;
  }
  Promise.resolve()
    .then(() => handler(msg))
    .then(
      (result) => sendResponse({ ok: true, result }),
      (err) => sendResponse({ ok: false, error: String(err?.message || err) }),
    );
  return true;
});
