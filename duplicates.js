function comparisonUrl(url, includeQuery) {
  if (includeQuery) return url;
  const query = url.indexOf("?");
  const fragment = url.indexOf("#");
  if (query === -1 || (fragment !== -1 && query > fragment)) return url;
  return url.slice(0, query) + (fragment === -1 ? "" : url.slice(fragment));
}

export function tabKey(tab, includeQuery = false) {
  if (!Number.isInteger(tab.id) || !/^https?:\/\//.test(tab.url ?? "")) return null;
  if (tab.pendingUrl && tab.pendingUrl !== tab.url) return null;
  return (tab.incognito ? "private:" : "normal:") + comparisonUrl(tab.url, includeQuery);
}

export function isProtected(tab) {
  return Boolean(tab.pinned || tab.audible);
}

export function findDuplicates(tabs, includeQuery = false) {
  const byUrl = new Map();
  for (const tab of tabs) {
    const key = tabKey(tab, includeQuery);
    if (!key) continue;
    if (!byUrl.has(key)) byUrl.set(key, []);
    byUrl.get(key).push(tab);
  }

  const groups = [];
  for (const [key, members] of byUrl) {
    if (members.length < 2) continue;
    members.sort((a, b) =>
      Number(isProtected(b)) - Number(isProtected(a)) ||
      Number(Boolean(b.active)) - Number(Boolean(a.active)) ||
      (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0) ||
      a.id - b.id
    );
    groups.push({ key, url: comparisonUrl(members[0].url, includeQuery), members });
  }
  return groups.sort((a, b) => b.members.length - a.members.length ||
    a.url.localeCompare(b.url, "ru"));
}

export function planClosures(tabs, requests, includeQuery = false) {
  const byId = new Map(tabs.map(tab => [tab.id, tab]));
  const keepers = new Set(requests.map(request => request.keeperId));
  const targets = new Set();
  for (const { key, keeperId, ids } of requests) {
    if (keeperId === null) {
      const members = tabs.filter(tab => tabKey(tab, includeQuery) === key);
      const requested = new Set(ids);
      if (members.length >= 2 && members.length === requested.size &&
          members.every(tab => requested.has(tab.id) && !keepers.has(tab.id))) {
        for (const tab of members) targets.add(tab.id);
      }
      continue;
    }
    const keeper = byId.get(keeperId);
    if (!keeper || tabKey(keeper, includeQuery) !== key) continue;
    for (const id of ids) {
      const tab = byId.get(id);
      if (tab && !keepers.has(id) && !isProtected(tab) && tabKey(tab, includeQuery) === key) {
        targets.add(id);
      }
    }
  }
  return [...targets];
}
