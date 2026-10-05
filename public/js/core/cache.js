(function attachMissionSupportCache(global) {
  const CACHE_PREFIX = 'livingHope:quarterCache:v1:';
  const CACHE_VERSION = 1;
  const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  const MAX_CACHE_BYTES = 2 * 1024 * 1024;

  function accountIdentity(user) {
    const accountId = String(user?.id || user?.username || '').trim();
    if (!accountId || !user?.role) return null;

    const assignedPastors = Array.isArray(user.assignedPastors)
      ? user.assignedPastors
      : (user.assignedPastor ? [user.assignedPastor] : []);
    const assignments = user.role === 'supporter'
      ? assignedPastors.map(assignment => [
          String(assignment?.name || '').trim().toLowerCase(),
          String(assignment?.number || ''),
          String(assignment?.slot || '').trim().toUpperCase()
        ]).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
      : [];

    return {
      key: `${CACHE_PREFIX}${encodeURIComponent(accountId)}`,
      scope: JSON.stringify({ role: user.role, status: user.status || '', assignments })
    };
  }

  function projectQuarterSummary(quarter) {
    if (!quarter || typeof quarter.id !== 'string') return null;
    return {
      id: quarter.id,
      year: quarter.year,
      quarterNum: quarter.quarterNum,
      quarterName: quarter.quarterName,
      title: quarter.title,
      months: Array.isArray(quarter.months) ? quarter.months.map(String) : [],
      totalPastors: Number(quarter.totalPastors) || 0,
      stats: quarter.stats && typeof quarter.stats === 'object' ? quarter.stats : {}
    };
  }

  function removeExpiredEntries() {
    try {
      const storage = global.localStorage;
      for (let index = storage.length - 1; index >= 0; index -= 1) {
        const key = storage.key(index);
        if (!key?.startsWith(CACHE_PREFIX)) continue;
        try {
          const record = JSON.parse(storage.getItem(key) || 'null');
          if (!record || record.version !== CACHE_VERSION || Number(record.expiresAt) <= Date.now()) {
            storage.removeItem(key);
          }
        } catch (_) {
          storage.removeItem(key);
        }
      }
    } catch (_) {
      // Storage can be unavailable in private browsing or restricted contexts.
    }
  }

  function readDashboard(user) {
    const identity = accountIdentity(user);
    if (!identity) return null;

    try {
      const raw = global.localStorage.getItem(identity.key);
      if (!raw) return null;
      const record = JSON.parse(raw);
      if (record?.version !== CACHE_VERSION
        || record.scope !== identity.scope
        || !Number.isFinite(Number(record.expiresAt))
        || Number(record.expiresAt) <= Date.now()
        || !Array.isArray(record.quarters)) {
        global.localStorage.removeItem(identity.key);
        return null;
      }

      const latestQuarter = record.latestQuarter;
      return {
        quarters: record.quarters,
        lastUpdated: record.lastUpdated || null,
        latestQuarter: latestQuarter
          && typeof latestQuarter.id === 'string'
          && Array.isArray(latestQuarter.entries)
          ? latestQuarter
          : null
      };
    } catch (_) {
      try { global.localStorage.removeItem(identity.key); } catch (_) {}
      return null;
    }
  }

  function writeRecord(user, record) {
    const identity = accountIdentity(user);
    if (!identity) return false;

    const serialized = JSON.stringify({
      version: CACHE_VERSION,
      scope: identity.scope,
      savedAt: Date.now(),
      expiresAt: Date.now() + CACHE_TTL_MS,
      ...record
    });
    if (serialized.length > MAX_CACHE_BYTES) return false;

    try {
      global.localStorage.setItem(identity.key, serialized);
      return true;
    } catch (_) {
      return false;
    }
  }

  function saveDashboard(user, quarters, lastUpdated) {
    if (!Array.isArray(quarters)) return false;
    const projectedQuarters = quarters.map(projectQuarterSummary).filter(Boolean);
    const latestId = projectedQuarters.at(-1)?.id;
    const previous = readDashboard(user);
    const latestQuarter = previous?.latestQuarter?.id === latestId ? previous.latestQuarter : null;
    return writeRecord(user, {
      quarters: projectedQuarters,
      lastUpdated: lastUpdated || previous?.lastUpdated || null,
      latestQuarter
    });
  }

  function saveLatestQuarter(user, quarter, lastUpdated) {
    if (!quarter || !Array.isArray(quarter.entries)) return false;
    const previous = readDashboard(user);
    if (!previous || previous.quarters.at(-1)?.id !== quarter.id) return false;
    return writeRecord(user, {
      quarters: previous.quarters,
      lastUpdated: lastUpdated || quarter.lastUpdated || previous.lastUpdated,
      latestQuarter: quarter
    });
  }

  function invalidate(user) {
    const identity = accountIdentity(user);
    if (!identity) return;
    try { global.localStorage.removeItem(identity.key); } catch (_) {}
  }

  removeExpiredEntries();
  Object.defineProperty(global, 'MissionSupportCache', {
    configurable: false,
    value: Object.freeze({ readDashboard, saveDashboard, saveLatestQuarter, invalidate })
  });
})(window);
