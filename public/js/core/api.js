(function attachMissionSupportApi(global) {
  if (global.MissionSupportApi) return;

  function requestPath(input) {
    const rawUrl = typeof input === 'string' || input instanceof URL
      ? String(input)
      : input?.url;
    if (!rawUrl) return '';

    try {
      return new URL(rawUrl, global.location.href).pathname;
    } catch {
      return String(rawUrl).split('?')[0];
    }
  }

  async function request(input, init = {}) {
    const requestInit = { ...init, credentials: init.credentials || 'same-origin' };
    const response = await global.fetch(input, requestInit);
    const method = String(requestInit.method || input?.method || 'GET').toUpperCase();
    const path = requestPath(input);

    if (response.ok && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      const changesQuarterData = /^\/api\/(?:quarters(?:\/|$)|hidden-pastors\/include$|reset$)/.test(path);
      const supportMarksOnly = /^\/api\/quarters\/[^/]+\/(?:batch-save|bulk)$/.test(path);
      if (changesQuarterData && !supportMarksOnly) {
        global.MissionSupportCache?.invalidate(global.MissionSupportState?.currentUser);
      }
    }

    if (response.status === 401 && !requestPath(input).startsWith('/api/auth/')) {
      global.dispatchEvent(new global.CustomEvent('mission-support:session-expired'));
    }

    return response;
  }

  Object.defineProperty(global, 'MissionSupportApi', {
    configurable: false,
    value: Object.freeze({ request })
  });
})(window);
