import { planClosures } from "./duplicates.js";

const dashboardUrl = chrome.runtime.getURL("dashboard.html");

chrome.action.onClicked.addListener(async tab => {
  try {
    const tabs = await chrome.tabs.query({ url: dashboardUrl });
    const dashboard = tabs.find(candidate => candidate.incognito === tab.incognito);
    if (dashboard) {
      await chrome.tabs.update(dashboard.id, { active: true });
      await chrome.windows.update(dashboard.windowId, { focused: true });
      await chrome.runtime.sendMessage({ type: "refreshDuplicates" }).catch(() => {});
    } else {
      await chrome.tabs.create({ windowId: tab.windowId, url: dashboardUrl });
    }
  } catch (error) {
    console.error("Не удалось открыть список дублей", error);
  }
});

let closeQueue = Promise.resolve();

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.url !== dashboardUrl || message?.type !== "closeDuplicates") return;

  const operation = closeQueue.then(() => closeDuplicates(message.requests, message.includeQuery));
  closeQueue = operation.catch(() => {});
  operation.then(result => respond(result), () => respond({ error: true }));
  return true;
});

async function closeDuplicates(requests, includeQuery) {
  const requested = new Set(requests.flatMap(request => request.ids));
  const tabs = await chrome.tabs.query({});
  const ids = planClosures(tabs, requests, includeQuery);
  let removeFailed = false;

  if (ids.length) {
    try {
      await chrome.tabs.remove(ids);
    } catch {
      removeFailed = true;
    }
  }

  const remaining = ids.length ? await chrome.tabs.query({}) : tabs;
  const remainingIds = new Set(remaining.map(tab => tab.id));
  const closed = ids.filter(id => !remainingIds.has(id)).length;
  return { closed, skipped: requested.size - closed, removeFailed, tabs: remaining };
}
