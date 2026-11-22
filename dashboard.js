import { findDuplicates, isProtected } from "./duplicates.js";

const element = id => document.getElementById(id);
const summary = element("summary");
const search = element("search");
const includeQuery = element("include-query");
const refreshButton = element("refresh");
const closeAll = element("close-all");
const list = element("groups");
const notice = element("notice");
const dialog = element("confirm");
const previous = element("previous");
const next = element("next");
const pageSize = 30;
const memberPageSize = 40;
const format = new Intl.NumberFormat("ru");
const keepers = new Map();
const expanded = new Set();
let groups = [];
let currentTabs = [];
let visibleGroups = [];
let page = 0;
let busy = false;
let loaded = false;

function create(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) node.textContent = value;
  return node;
}

function button(label, action, className) {
  const node = create("button", className, label);
  node.type = "button";
  node.addEventListener("click", action);
  return node;
}

function showNotice(message) {
  notice.textContent = message;
  notice.hidden = !message;
}

function setBusy(value) {
  busy = value;
  refreshButton.disabled = value;
  search.disabled = value;
  includeQuery.disabled = value || !loaded;
  list.inert = value;
  element("pages").inert = value;
  updateBulkButton();
}

function keeperId(group) {
  return keepers.get(group.key) ?? group.members[0].id;
}

function requestFor(group, onlyId) {
  const keeper = keeperId(group);
  return {
    key: group.key,
    keeperId: keeper,
    ids: group.members
      .filter(tab => tab.id !== keeper && !isProtected(tab) &&
        (onlyId === undefined || tab.id === onlyId))
      .map(tab => tab.id)
  };
}

function updateBulkButton() {
  const count = visibleGroups.reduce((total, group) => total + requestFor(group).ids.length, 0);
  closeAll.disabled = busy || count === 0;
  closeAll.textContent = count ? `Закрыть дубли (${format.format(count)})` : "Закрыть дубли";
}

function applyTabs(tabs) {
  currentTabs = tabs;
  groups = findDuplicates(tabs, includeQuery.checked);
  const currentGroups = new Map(groups.map(group => [group.key, group]));
  for (const [key, id] of keepers) {
    if (!currentGroups.get(key)?.members.some(tab => tab.id === id)) keepers.delete(key);
  }
  for (const key of expanded) {
    if (!currentGroups.has(key)) expanded.delete(key);
  }
  const duplicates = groups.reduce((total, group) => total + group.members.length - 1, 0);
  const countWindows = new Set(tabs.map(tab => tab.windowId)).size;
  summary.textContent = `Вкладок: ${format.format(tabs.length)} · Окон: ${format.format(countWindows)} · Повторов: ${format.format(duplicates)}`;
  loaded = true;
  render();
}

async function refresh() {
  if (busy || dialog.open) return;
  setBusy(true);
  showNotice("");
  try {
    const [tabs, settings] = await Promise.all([
      chrome.tabs.query({}),
      chrome.storage.local.get({ includeQuery: false })
    ]);
    includeQuery.checked = settings.includeQuery;
    applyTabs(tabs);
  } catch {
    showNotice("Не удалось получить список вкладок. Нажмите «Обновить», чтобы повторить попытку.");
    if (!loaded) summary.textContent = "Список вкладок недоступен";
  } finally {
    setBusy(false);
  }
}

async function changeComparison() {
  const checked = includeQuery.checked;
  setBusy(true);
  showNotice("");
  try {
    await chrome.storage.local.set({ includeQuery: checked });
    page = 0;
    applyTabs(currentTabs);
  } catch {
    includeQuery.checked = !checked;
    showNotice("Не удалось сохранить настройку сравнения.");
  } finally {
    setBusy(false);
  }
}

async function switchTo(tabId) {
  try {
    const tab = await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch {
    showNotice("Не удалось перейти к вкладке. Возможно, она уже закрыта. Обновите список.");
  }
}

async function closeRequests(requests, scope = "") {
  const count = requests.reduce((total, request) => total + request.ids.length, 0);
  if (busy || dialog.open || !count) return;

  const fullGroup = requests[0].keeperId === null;
  element("confirm-title").textContent = fullGroup ? "Закрыть всю группу?" : "Закрыть выбранные дубли?";
  const effect = fullGroup
    ? "Закроются все вкладки в группе, включая выбранную для сохранения, закреплённые и воспроизводящие звук."
    : "Отмеченные для сохранения вкладки останутся открытыми.";
  element("confirm-message").textContent =
    `Выбрано вкладок для закрытия — ${format.format(count)}. ${scope}${effect} Если закроется последняя вкладка окна, Chrome закроет и это окно.`;
  dialog.showModal();
  const confirmed = await new Promise(resolve => {
    const listeners = new AbortController();
    function finish(event, accepted) {
      event.preventDefault();
      listeners.abort();
      dialog.close();
      resolve(accepted);
    }
    dialog.addEventListener("submit", event => finish(event, event.submitter?.value === "close"),
      { signal: listeners.signal });
    dialog.addEventListener("cancel", event => finish(event, false), { signal: listeners.signal });
  });
  if (!confirmed) return;

  setBusy(true);
  showNotice("Закрываем выбранные вкладки…");
  try {
    const result = await chrome.runtime.sendMessage({
      type: "closeDuplicates", requests, includeQuery: includeQuery.checked
    });
    if (!result || result.error) throw new Error("Не удалось проверить результат");
    applyTabs(result.tabs);
    const parts = [`Закрыто: ${format.format(result.closed)}.`];
    if (result.skipped) parts.push(`Пропущено: ${format.format(result.skipped)}.`);
    if (fullGroup && result.skipped && !result.removeFailed) {
      parts.push("Список вкладок в группе изменился. Проверьте обновлённую группу.");
    }
    if (result.removeFailed) parts.push("Chrome не выполнил закрытие полностью. Можно повторить попытку.");
    showNotice(parts.join(" "));
  } catch {
    await chrome.tabs.query({}).then(applyTabs).catch(() => {});
    showNotice("Не удалось подтвердить результат закрытия. Проверьте обновлённый список.");
  } finally {
    setBusy(false);
  }
}

function renderMember(group, tab, redraw) {
  const row = create("div", "tab-row");
  const selected = tab.id === keeperId(group);
  const info = create("div", "tab-info");
  const title = create("strong", "", tab.title || tab.url);
  title.title = title.textContent;
  const labels = [`Окно ${tab.windowId} · вкладка ${tab.index + 1}`];
  if (tab.active) labels.push("активная");
  if (tab.pinned) labels.push("закреплена");
  if (tab.audible) labels.push("воспроизводит звук");
  info.append(title, create("small", "", labels.join(" · ")));
  if (tab.url !== group.url) info.append(create("span", "address", tab.url));
  const actions = create("div", "row-actions");
  const keep = button(selected ? "Останется" : "Оставить эту", () => {
    keepers.set(group.key, tab.id);
    redraw();
    updateBulkButton();
  }, selected ? "chosen" : "");
  keep.disabled = selected;
  actions.append(keep, button("Перейти", () => switchTo(tab.id)));
  if (!selected && !isProtected(tab)) {
    actions.append(button("Закрыть", () => closeRequests([requestFor(group, tab.id)]), "quiet-danger"));
  }
  row.append(info, actions);
  return row;
}

function renderGroup(group) {
  const card = create("details", "group");
  const heading = create("summary", "group-heading");
  const text = create("span", "group-text");
  const title = create("strong", "", group.members[0].title || group.url);
  const url = create("span", "address", group.url);
  url.title = group.url;
  text.append(title, url);
  heading.append(text, create("span", "count", `Вкладок: ${format.format(group.members.length)}`));
  const body = create("div", "group-body");
  card.append(heading, body);
  let memberPage = 0;

  function drawBody() {
    const start = memberPage * memberPageSize;
    const keeper = group.members.find(tab => tab.id === keeperId(group));
    const otherMembers = group.members.filter(tab => tab !== keeper);
    const rows = otherMembers.slice(start, start + memberPageSize)
      .map(tab => renderMember(group, tab, drawBody));
    body.replaceChildren(renderMember(group, keeper, drawBody), ...rows);

    const controls = create("div", "group-actions");
    const request = requestFor(group);
    const close = button(`Закрыть лишние (${format.format(request.ids.length)})`,
      () => closeRequests([requestFor(group)]), "quiet-danger");
    close.disabled = !request.ids.length;
    const fullGroup = { key: group.key, keeperId: null, ids: group.members.map(tab => tab.id) };
    const closeGroup = button(`Закрыть всю группу (${format.format(fullGroup.ids.length)})`,
      () => closeRequests([fullGroup]), "quiet-danger");
    controls.append(close, closeGroup);
    if (otherMembers.length > memberPageSize) {
      const back = button("Назад", () => { memberPage--; drawBody(); });
      const forward = button("Дальше", () => { memberPage++; drawBody(); });
      back.disabled = memberPage === 0;
      forward.disabled = start + memberPageSize >= otherMembers.length;
      controls.append(back, create("span", "", `${memberPage + 1} / ${Math.ceil(otherMembers.length / memberPageSize)}`), forward);
    }
    body.append(controls);
  }

  card.open = expanded.has(group.key);
  if (card.open) drawBody();
  card.addEventListener("toggle", () => {
    if (card.open) {
      expanded.add(group.key);
      if (!body.hasChildNodes()) drawBody();
    } else {
      expanded.delete(group.key);
      body.replaceChildren();
    }
  });
  return card;
}

function render() {
  if (!loaded) return;
  const filter = search.value.trim().toLowerCase();
  visibleGroups = groups.filter(group => !filter || group.url.toLowerCase().includes(filter) ||
    group.members.some(tab => tab.title?.toLowerCase().includes(filter) ||
      tab.url.toLowerCase().includes(filter)));
  const pages = Math.max(1, Math.ceil(visibleGroups.length / pageSize));
  page = Math.min(page, pages - 1);
  const start = page * pageSize;
  const cards = visibleGroups.slice(start, start + pageSize).map(renderGroup);
  const empty = groups.length ? "По этому запросу ничего не найдено." : "Одинаковых вкладок не найдено.";
  list.replaceChildren(...(cards.length ? cards : [create("p", "empty", empty)]));
  element("pages").hidden = pages <= 1;
  element("page-number").textContent = `${page + 1} / ${pages}`;
  previous.disabled = page === 0;
  next.disabled = page + 1 >= pages;
  updateBulkButton();
}

refreshButton.addEventListener("click", refresh);
includeQuery.addEventListener("change", changeComparison);
search.addEventListener("input", () => { page = 0; render(); });
closeAll.addEventListener("click", () => {
  const scope = search.value.trim() ? "Учитываются все группы по фильтру, включая другие страницы. " : "";
  closeRequests(visibleGroups.map(group => requestFor(group)), scope);
});
previous.addEventListener("click", () => { page--; render(); });
next.addEventListener("click", () => { page++; render(); });
chrome.runtime.onMessage.addListener(message => {
  if (message?.type === "refreshDuplicates") refresh();
});
refresh();
