(function attachMissionSupportState(global) {
  if (global.MissionSupportState) return;

  const state = {
    currentUser: null,
    tracker: {
      quarters: [],
      currentQuarter: null,
      activeYear: null,
      allMode: false,
      allQuarters: [],
      searchQuery: '',
      filteredEntries: [],
      lastUpdated: null,
      cacheSyncPending: false,
      auditTrail: [],
      pendingChanges: {},
      pastorTypeFilter: 'All',
      statusFilter: 'All',
      reportMode: false,
      reportQuarters: [],
      reportFilters: { pastorType: 'All', statusFilter: 'All' },
      presentation: { slides: [], currentSlideIndex: 0 }
    },
    notifications: { recipients: [], settings: null }
  };

  Object.defineProperty(global, 'MissionSupportState', {
    configurable: false,
    value: Object.seal(state)
  });
})(window);
