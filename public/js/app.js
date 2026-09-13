// ==========================================================================
// MISSION SUPPORT TRACKER - FRONTEND ENGINE
// ==========================================================================

let state = {
  quarters: [],
  currentQuarter: null,
  activeYear: null,
  allMode: false,
  allQuarters: [],
  searchQuery: '',
  filteredEntries: [],
  lastUpdated: null,
  auditTrail: [],
  pendingChanges: {},
  pastorTypeFilter: 'All',
  statusFilter: 'All',
  reportMode: false,
  reportQuarters: [],
  reportFilters: { pastorType: 'All', statusFilter: 'All' },
  presentation: {
    slides: [],
    currentSlideIndex: 0
  }
};

// DOM Elements
const quarterSelect = document.getElementById('quarter-select');
const yearPills = document.getElementById('year-pills');
const searchInput = document.getElementById('search-input');
const pastorTypeFilter = document.getElementById('pastor-type-filter');
const statusFilter = document.getElementById('status-filter');
const clearSearchBtn = document.getElementById('clear-search');
const pastorsTbody = document.getElementById('pastors-tbody');
const visibleCount = document.getElementById('visible-count');
const noResults = document.getElementById('no-results');

// Header Elements
const statTotal = document.getElementById('stat-total');
const statQuarterTitle = document.getElementById('stat-quarter-title');
const statM1Label = document.getElementById('stat-m1-label');
const statM1Val = document.getElementById('stat-m1-val');
const statM1Bar = document.getElementById('stat-m1-bar');
const statM2Label = document.getElementById('stat-m2-label');
const statM2Val = document.getElementById('stat-m2-val');
const statM2Bar = document.getElementById('stat-m2-bar');
const statM3Label = document.getElementById('stat-m3-label');
const statM3Val = document.getElementById('stat-m3-val');
const statM3Bar = document.getElementById('stat-m3-bar');

const thMonth1 = document.getElementById('th-month-1');
const thMonth2 = document.getElementById('th-month-2');
const thMonth3 = document.getElementById('th-month-3');
const bulkM1Name = document.getElementById('bulk-m1-name');
const bulkM2Name = document.getElementById('bulk-m2-name');
const bulkM3Name = document.getElementById('bulk-m3-name');
const tableHeaderTitle = document.getElementById('table-header-title');

// Modals
const pastorModal = document.getElementById('pastor-modal');
const quarterModal = document.getElementById('quarter-modal');
const presentationModal = document.getElementById('presentation-modal');
const reportModal = document.getElementById('report-modal');
const recycleBinModal = document.getElementById('recycle-bin-modal');

// --- Initialization ---
document.addEventListener('DOMContentLoaded', async () => {
  setupEventListeners();
  renderPendingChanges();
  await loadQuartersList();
});

function setupEventListeners() {
  // Quarter selector change
  quarterSelect.addEventListener('change', async (e) => {
    if (hasPendingChanges()) {
      const ok = confirm('You have pending changes. Discard them and switch quarters?');
      if (!ok) {
        if (state.currentQuarter) quarterSelect.value = state.currentQuarter.id;
        return;
      }
      discardPendingChanges();
    }
    state.allMode = false;
    state.reportMode = false;
    state.reportQuarters = [];
    toggleAllView(false);
    updateReportModeUi();
    await loadQuarterDetails(e.target.value);
  });

  // Search input
  searchInput.addEventListener('input', (e) => {
    state.searchQuery = e.target.value.trim().toLowerCase();
    clearSearchBtn.style.display = state.searchQuery ? 'block' : 'none';
    if (state.allMode) renderAllView(); else renderTable();
  });

  clearSearchBtn.addEventListener('click', () => {
    searchInput.value = '';
    state.searchQuery = '';
    clearSearchBtn.style.display = 'none';
    if (state.allMode) renderAllView(); else renderTable();
  });

  pastorTypeFilter.addEventListener('change', () => {
    state.pastorTypeFilter = pastorTypeFilter.value;
    if (state.reportMode) state.reportFilters.pastorType = state.pastorTypeFilter;
    if (state.allMode) renderAllView(); else renderTable();
  });

  statusFilter.addEventListener('change', () => {
    state.statusFilter = statusFilter.value;
    if (state.reportMode) state.reportFilters.statusFilter = state.statusFilter;
    if (state.allMode) renderAllView(); else renderTable();
  });

  // More options dropdown toggle
  const moreBtn = document.getElementById('btn-more-options');
  const dropdownMenu = document.getElementById('dropdown-menu');
  moreBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdownMenu.classList.toggle('show');
  });

  document.addEventListener('click', () => {
    dropdownMenu.classList.remove('show');
  });

  // Add Pastor Modal triggers
  document.getElementById('btn-add-pastor').addEventListener('click', () => {
    openPastorModal();
  });
  document.getElementById('modal-pastor-close').addEventListener('click', closePastorModal);
  document.getElementById('btn-pastor-cancel').addEventListener('click', closePastorModal);

  // Add Quarter Modal triggers
  document.getElementById('action-audit-trail').addEventListener('click', async (e) => {
    e.preventDefault();
    dropdownMenu.classList.remove('show');
    await openAuditModal();
  });

  document.getElementById('action-add-quarter').addEventListener('click', (e) => {
    e.preventDefault();
    openQuarterModal();
  });
  document.getElementById('modal-quarter-close').addEventListener('click', closeQuarterModal);
  document.getElementById('btn-quarter-cancel').addEventListener('click', closeQuarterModal);

  // Form Submissions
  document.getElementById('pastor-form').addEventListener('submit', handlePastorSubmit);
  document.getElementById('quarter-form').addEventListener('submit', handleQuarterSubmit);

  // Bulk Quick Action Buttons
  document.getElementById('btn-bulk-check-all').addEventListener('click', () => handleBulkUpdate('all', 'check'));
  document.getElementById('btn-bulk-clear-all').addEventListener('click', () => handleBulkUpdate('all', 'uncheck'));

  document.querySelectorAll('.month-bulk-bar .pill-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const monthKey = btn.dataset.month;
      handleMonthToggleAll(monthKey);
    });
  });

  // Pending change review actions
  document.getElementById('btn-save-changes')?.addEventListener('click', savePendingChanges);
  document.getElementById('btn-quick-save')?.addEventListener('click', savePendingChanges);
  document.getElementById('btn-discard-changes')?.addEventListener('click', discardPendingChanges);
  document.getElementById('btn-pending-update')?.addEventListener('click', savePendingChanges);
  document.getElementById('btn-pending-cancel')?.addEventListener('click', discardPendingChanges);
  document.getElementById('btn-pending-close')?.addEventListener('click', discardPendingChanges);

  // Download PPTX triggers
  document.getElementById('btn-download-pptx').addEventListener('click', () => {
    if (state.reportMode && state.reportQuarters.length) {
      downloadReportPptx();
    } else if (state.allMode) {
      showToast('Preparing complete all-quarters PowerPoint presentation...', 'info');
      window.location.href = `/api/export/pptx-all?pastorType=${encodeURIComponent(state.pastorTypeFilter)}&statusFilter=${encodeURIComponent(state.statusFilter)}`;
    } else if (state.currentQuarter) {
      showToast('Preparing PowerPoint presentation for download...', 'info');
      const qs = new URLSearchParams({ pastorType: state.pastorTypeFilter, statusFilter: state.statusFilter });
      window.location.href = `/api/export/pptx/${state.currentQuarter.id}?${qs.toString()}`;
    }
  });

  document.getElementById('action-download-all').addEventListener('click', (e) => {
    e.preventDefault();
    showToast('Preparing complete 14-quarter presentation...', 'info');
    window.location.href = `/api/export/pptx-all?pastorType=${encodeURIComponent(state.pastorTypeFilter)}&statusFilter=${encodeURIComponent(state.statusFilter)}`;
  });

  document.getElementById('action-backup-json').addEventListener('click', (e) => {
    e.preventDefault();
    window.location.href = '/api/backup';
  });

  // Reset Data trigger
  document.getElementById('action-reset-data').addEventListener('click', async (e) => {
    e.preventDefault();
    if (confirm('Are you sure you want to reset all data back to the original PowerPoint presentation? Any manual changes made since will be overwritten.')) {
      try {
        const res = await fetch('/api/reset', { method: 'POST' });
        const data = await res.json();
        showToast('Database reset to original PPT reference!', 'success');
        await loadQuartersList();
      } catch (err) {
        showToast('Reset failed: ' + err.message, 'error');
      }
    }
  });

  // Report + Recycle Bin
  document.getElementById('btn-report').addEventListener('click', openReportModal);
  document.getElementById('btn-exit-report').addEventListener('click', exitReportMode);
  document.getElementById('modal-report-close').addEventListener('click', closeReportModal);
  document.getElementById('btn-report-cancel').addEventListener('click', closeReportModal);
  document.getElementById('report-select-all').addEventListener('click', () => setAllReportQuarters(true));
  document.getElementById('report-clear-all').addEventListener('click', () => setAllReportQuarters(false));
  document.getElementById('btn-report-view').addEventListener('click', applyReportView);
  document.getElementById('btn-report-download').addEventListener('click', downloadReportPptx);
  document.getElementById('action-recycle-bin').addEventListener('click', async (e) => { e.preventDefault(); dropdownMenu.classList.remove('show'); await openRecycleBinModal(); });
  document.getElementById('modal-recycle-close').addEventListener('click', closeRecycleBinModal);

  // Presentation Mode triggers
  document.getElementById('btn-present').addEventListener('click', openPresentationMode);
  document.getElementById('pres-close').addEventListener('click', closePresentationMode);
  document.getElementById('pres-prev').addEventListener('click', prevSlide);
  document.getElementById('pres-next').addEventListener('click', nextSlide);
  document.getElementById('pres-download').addEventListener('click', () => {
    if (state.reportMode && state.reportQuarters.length) downloadReportPptx();
    else if (state.allMode) window.location.href = `/api/export/pptx-all?pastorType=${encodeURIComponent(state.pastorTypeFilter)}&statusFilter=${encodeURIComponent(state.statusFilter)}`;
    else if (state.currentQuarter) window.location.href = `/api/export/pptx/${state.currentQuarter.id}?pastorType=${encodeURIComponent(state.pastorTypeFilter)}&statusFilter=${encodeURIComponent(state.statusFilter)}`;
  });
  document.getElementById('pres-fullscreen').addEventListener('click', toggleFullscreen);
  document.getElementById('modal-audit-close').addEventListener('click', closeAuditModal);
  document.getElementById('audit-search').addEventListener('input', renderAuditTrail);
  document.getElementById('audit-action-filter').addEventListener('change', renderAuditTrail);
  document.addEventListener('fullscreenchange', updatePresentationFullscreenState);

  // Keyboard navigation for Presentation
  document.addEventListener('keydown', (e) => {
    if (!presentationModal.classList.contains('show')) return;
    if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') {
      nextSlide();
    } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
      prevSlide();
    } else if (e.key === 'Escape') {
      closePresentationMode();
    }
  });
}

// --- API Calls & Data Loading ---
async function loadQuartersList() {
  try {
    const res = await fetch('/api/quarters');
    const data = await res.json();
    state.quarters = data.quarters || [];
    state.reportMode = false;
    state.reportQuarters = [];
    updateReportModeUi();
    updateLastUpdated(data.lastUpdated);

    renderYearPills();
    populateQuarterDropdown();

    // Default select latest quarter (e.g. 2026-Q3)
    if (state.quarters.length > 0) {
      const defaultQ = state.quarters[state.quarters.length - 1];
      quarterSelect.value = defaultQ.id;
      await loadQuarterDetails(defaultQ.id);
    }
  } catch (err) {
    showToast('Error loading quarters: ' + err.message, 'error');
  }
}

async function loadQuarterDetails(quarterId) {
  try {
    const res = await fetch(`/api/quarters/${quarterId}`);
    const quarter = await res.json();
    state.currentQuarter = quarter;
    state.pendingChanges = {};
    renderPendingChanges();
    updateLastUpdated(quarter.lastUpdated || state.lastUpdated);

    // Update Year active pill
    if (quarter.year) {
      state.activeYear = quarter.year;
      updateYearPillsActive();
    }

    renderQuarterStats();
    renderTable();
  } catch (err) {
    showToast('Failed to load quarter: ' + err.message, 'error');
  }
}

// --- Render Methods ---
function renderYearPills() {
  const years = [...new Set(state.quarters.map(q => q.year))].sort();
  yearPills.innerHTML = `<button class="year-pill ${state.activeYear === null ? 'active' : ''}" data-year="all">All</button>`;
  
  years.forEach(y => {
    const pill = document.createElement('button');
    pill.className = `year-pill ${state.activeYear === y ? 'active' : ''}`;
    pill.dataset.year = y;
    pill.textContent = y;
    pill.addEventListener('click', async () => {
      if (hasPendingChanges()) {
        const ok = confirm('You have pending changes. Discard them and change the year filter?');
        if (!ok) return;
        discardPendingChanges();
      }
      state.activeYear = y === 'all' ? null : parseInt(y);
      updateYearPillsActive();
      populateQuarterDropdown();

      if (y === 'all') {
        state.reportMode = false;
        state.reportQuarters = [];
        updateReportModeUi();
        state.allMode = true;
        state.currentQuarter = null;
        quarterSelect.value = 'ALL';
        toggleAllView(true);
        await loadAllQuarterDetails();
      } else {
        state.reportMode = false;
        state.reportQuarters = [];
        updateReportModeUi();
        state.allMode = false;
        toggleAllView(false);
        // Select the latest quarter available in that year.
        const yearQs = state.quarters.filter(q => q.year === state.activeYear);
        const targetQ = yearQs[yearQs.length - 1];
        if (targetQ) {
          quarterSelect.value = targetQ.id;
          await loadQuarterDetails(targetQ.id);
        }
      }
    });
    yearPills.appendChild(pill);
  });
}

function updateYearPillsActive() {
  document.querySelectorAll('.year-pill').forEach(btn => {
    const yVal = btn.dataset.year;
    if (yVal === 'all' && state.activeYear === null) {
      btn.classList.add('active');
    } else if (parseInt(yVal) === state.activeYear) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });
}

function populateQuarterDropdown() {
  quarterSelect.innerHTML = '';
  if (state.allMode) {
    const allOpt = document.createElement('option');
    allOpt.value = 'ALL';
    allOpt.textContent = 'All Years / All Quarters';
    quarterSelect.appendChild(allOpt);
  }
  const list = state.activeYear 
    ? state.quarters.filter(q => q.year === state.activeYear)
    : state.quarters;

  list.forEach(q => {
    const opt = document.createElement('option');
    opt.value = q.id;
    opt.textContent = `${q.year} ${q.quarterName} (${q.months.join(', ')}) - ${q.totalPastors || q.entries?.length || 0} Pastors`;
    quarterSelect.appendChild(opt);
  });

  if (state.currentQuarter) {
    quarterSelect.value = state.currentQuarter.id;
  }
}

async function loadAllQuarterDetails() {
  try {
    const details = await Promise.all(state.quarters.map(async q => {
      const res = await fetch(`/api/quarters/${q.id}`);
      if (!res.ok) throw new Error(`Failed to load ${q.id}`);
      return await res.json();
    }));
    state.allQuarters = details;
    renderAllView();
    renderAllStats();
  } catch (err) {
    showToast('Failed to load all quarters: ' + err.message, 'error');
  }
}

function toggleAllView(show) {
  const table = document.getElementById('pastors-table');
  const allView = document.getElementById('all-quarters-view');
  const quick = document.getElementById('month-bulk-bar');
  const bulk = document.getElementById('btn-bulk-check-all')?.closest('.btn-group');
  const add = document.getElementById('btn-add-pastor');
  const stats = document.getElementById('stats-grid');
  if (table?.closest('.table-responsive')) table.closest('.table-responsive').style.display = show ? 'none' : '';
  if (allView) allView.style.display = show ? 'block' : 'none';
  if (stats) stats.style.display = show ? 'none' : '';
  if (quick) quick.style.display = show ? 'none' : '';
  if (bulk) bulk.style.display = show ? 'none' : '';
  if (add) add.style.display = show ? 'none' : '';
  if (show) {
    tableHeaderTitle.textContent = 'All Mission Support Records';
    visibleCount.textContent = 'All quarters';
  }
}

function renderAllView() {
  const container = document.getElementById('all-quarters-view');
  if (!container) return;
  if (!state.allQuarters.length) { container.innerHTML = '<div class="all-empty">No quarter records available.</div>'; return; }
  let html = '';
  state.allQuarters.forEach(q => {
    const entries = filterEntriesForDisplay(q, q.entries || []);
    if (!entries.length) return;
    html += `<div class="all-quarter-card">
      <div class="all-quarter-heading"><div><strong>${escapeHtml(q.title)}</strong><span>${escapeHtml((q.months||[]).join(' • '))}</span></div><span>${entries.length} of ${(q.entries||[]).length} pastors</span></div>
      <div class="table-responsive"><table class="data-table all-quarter-table"><thead><tr><th style="width:70px;">#</th><th>Pastor / Missionary</th><th>TYPE</th>${(q.months||[]).slice(0,3).map(m=>`<th style="text-align:center;">${escapeHtml(m).toUpperCase()}</th>`).join('')}<th style="text-align:center;">STATUS</th></tr></thead><tbody>`;
    entries.forEach((e,idx) => {
      const vals=[e.m1,e.m2,e.m3]; const badge=renderStatusBadge(e); const type=normalizePastorType(e.pastorType);
      html += `<tr><td>${e.number || idx+1}</td><td><strong>${escapeHtml(e.name)}</strong></td><td><span class="pastor-type-badge type-${type.toLowerCase()}">${escapeHtml(type)}</span></td>${vals.map(v=>`<td class="all-status-cell">${escapeHtml(compactStatus(v||''))}</td>`).join('')}<td style="text-align:center;"><span class="status-badge ${badge.badgeClass}">${badge.badgeText}</span></td></tr>`;
    });
    html += '</tbody></table></div></div>';
  });
  container.innerHTML = html || '<div class="all-empty">No records match your filters.</div>';
}

function renderAllStats() {
  const qs = state.allQuarters || [];
  statTotal.textContent = qs.reduce((sum, q) => sum + filterEntriesForDisplay(q, q.entries || []).length, 0);
  statQuarterTitle.textContent = state.reportMode ? 'MISSION REPORT VIEW' : 'ALL YEARS • ALL QUARTERS';
  const names = qs.map(q => q.months || []).flat();
  const labels = [names[0] || 'Month 1', names[1] || 'Month 2', names[2] || 'Month 3'];
  const bars = [statM1Bar, statM2Bar, statM3Bar]; const vals=[statM1Val,statM2Val,statM3Val]; const labs=[statM1Label,statM2Label,statM3Label];
  labels.forEach((label,i) => { labs[i].textContent=label; const entries=qs.flatMap(q=>filterEntriesForDisplay(q,q.entries||[])); const metrics=entries.reduce((a,e)=>{const m=statusMetrics(e[`m${i+1}`]);a.checked+=m.checked;a.total+=m.total;return a;},{checked:0,total:0}); const pct=metrics.total?Math.round(metrics.checked/metrics.total*100):0; vals[i].textContent=`${metrics.checked} / ${metrics.total} (${pct}%)`; bars[i].style.width=`${pct}%`; });
}

function renderQuarterStats() {
  if (!state.currentQuarter) return;
  const q = state.currentQuarter;
  const entries = q.entries || [];
  const total = entries.length;

  const monthMetrics = ['m1', 'm2', 'm3'].map(key => entries.reduce((acc, e) => {
    const m = statusMetrics(getEffectiveStatus(e, key));
    acc.checked += m.checked;
    acc.total += m.total;
    return acc;
  }, { checked: 0, total: 0 }));

  statTotal.textContent = total;
  statQuarterTitle.textContent = q.title;
  const mNames = q.months || ['Month 1', 'Month 2', 'Month 3'];
  [
    [statM1Label, statM1Val, statM1Bar, mNames[0], monthMetrics[0]],
    [statM2Label, statM2Val, statM2Bar, mNames[1], monthMetrics[1]],
    [statM3Label, statM3Val, statM3Bar, mNames[2], monthMetrics[2]]
  ].forEach(([label, val, bar, name, metric]) => {
    const pct = metric.total ? Math.round(metric.checked / metric.total * 100) : 0;
    label.textContent = name || 'Month';
    val.textContent = `${metric.checked} / ${metric.total} (${pct}%)`;
    bar.style.width = `${pct}%`;
  });

  thMonth1.textContent = (mNames[0] || 'M1').toUpperCase();
  thMonth2.textContent = (mNames[1] || 'M2').toUpperCase();
  thMonth3.textContent = (mNames[2] || 'M3').toUpperCase();
  bulkM1Name.textContent = mNames[0] || 'M1';
  bulkM2Name.textContent = mNames[1] || 'M2';
  bulkM3Name.textContent = mNames[2] || 'M3';
  tableHeaderTitle.textContent = `${q.year} ${q.quarterName} Support Records`;
}

function renderTable() {
  if (!state.currentQuarter) return;
  const entries = state.currentQuarter.entries || [];
  const filtered = filterEntriesForDisplay(state.currentQuarter, entries);
  state.filteredEntries = filtered;
  visibleCount.textContent = `${filtered.length} of ${entries.length} pastors`;

  if (filtered.length === 0) {
    pastorsTbody.innerHTML = '';
    noResults.style.display = 'flex';
    return;
  }

  noResults.style.display = 'none';
  let html = '';
  filtered.forEach((e, idx) => {
    const badge = renderStatusBadge(e);
    const type = normalizePastorType(e.pastorType);
    html += `
      <tr data-id="${escapeHtml(e.id)}">
        <td style="color: var(--text-subtle); font-weight: 700;">${e.number || (idx + 1)}</td>
        <td>
          <div class="pastor-name-cell">
            <span>${escapeHtml(e.name)}</span>
            <span class="pastor-type-badge type-${type.toLowerCase()}">${escapeHtml(type)}</span>
            ${e.notes ? `<span class="pastor-note-pill" title="${escapeHtml(e.notes)}"><i class="fa-regular fa-note-sticky"></i> ${escapeHtml(e.notes)}</span>` : ''}
          </div>
        </td>
        <td style="text-align: center;">${renderStatusBtn(e, 'm1')}</td>
        <td style="text-align: center;">${renderStatusBtn(e, 'm2')}</td>
        <td style="text-align: center;">${renderStatusBtn(e, 'm3')}</td>
        <td style="text-align: center;"><span class="status-badge ${badge.badgeClass}">${badge.badgeText}</span></td>
        <td style="text-align: center;">
          <div class="actions-cell">
            <button class="action-icon-btn btn-edit" title="Edit Pastor" onclick="editPastor('${e.id}')"><i class="fa-solid fa-pen-to-square"></i></button>
            <button class="action-icon-btn btn-delete" title="Move to Recycle Bin" onclick="deletePastor('${e.id}')"><i class="fa-regular fa-trash-can"></i></button>
          </div>
        </td>
      </tr>`;
  });
  pastorsTbody.innerHTML = html;
}

function statusMetrics(value) {
  const text = String(value || '').trim();
  if (!text) return { checked: 0, total: 1 };

  const matches = [...text.matchAll(/([A-E])\s*\./gi)];
  if (matches.length) {
    let checkedLetters = 0;
    matches.forEach((m, i) => {
      const start = m.index + m[0].length;
      const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
      if (/✓/.test(text.slice(start, end))) checkedLetters++;
    });
    return { checked: checkedLetters, total: matches.length };
  }

  return { checked: text.includes('✓') ? 1 : 0, total: 1 };
}

function getEffectiveStatus(entry, monthKey) {
  const key = `${entry.id}:${monthKey}`;
  if (Object.prototype.hasOwnProperty.call(state.pendingChanges, key)) {
    return state.pendingChanges[key].newValue;
  }
  return entry[monthKey] || '';
}

function hasCustomLetterStatus(value) {
  return /[A-E]\s*\./i.test(String(value || ''));
}

function parseLetterStatuses(value) {
  const text = String(value || '');
  const matches = [...text.matchAll(/([A-E])\s*\./gi)];
  if (!matches.length) return [];
  return matches.map((m, i) => {
    const start = m.index + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    return { letter: m[1].toUpperCase(), checked: /✓/.test(text.slice(start, end)) };
  });
}

function serializeLetterStatuses(items) {
  return items.map(x => `${x.letter}. ${x.checked ? '✓' : ''}`.trimEnd()).join(' ');
}

function renderStatusBtn(entry, monthKey) {
  const val = getEffectiveStatus(entry, monthKey);
  const pending = isPending(entry.id, monthKey);

  // Custom A/B/C/D/E statuses get individual compact checkboxes.
  if (hasCustomLetterStatus(val)) {
    const items = parseLetterStatuses(val);
    return `<div class="mini-status-list ${pending ? 'is-modified' : ''}">
      ${items.map(item => `
        <button type="button" class="mini-status-btn ${item.checked ? 'is-checked' : ''}"
          onclick="toggleLetterStatus('${entry.id}', '${monthKey}', '${item.letter}')"
          title="${item.letter}. ${item.checked ? 'Checked' : 'Unchecked'}">
          <span class="mini-status-letter">${item.letter}.</span><span class="mini-check-box">${item.checked ? '✓' : ''}</span>
        </button>`).join('')}
    </div>`;
  }

  if (val === '✓') {
    return `<button class="status-toggle-btn is-checked ${pending ? 'is-modified' : ''}" onclick="toggleStatus('${entry.id}', '${monthKey}')" title="Click to uncheck"><i class="fa-solid fa-check"></i></button>`;
  }
  return `<button class="status-toggle-btn ${pending ? 'is-modified' : ''}" onclick="toggleStatus('${entry.id}', '${monthKey}')" title="Click to mark as supported"></button>`;
}

function isPending(entryId, monthKey) {
  return Object.prototype.hasOwnProperty.call(state.pendingChanges, `${entryId}:${monthKey}`);
}

function stageStatusChange(entryId, monthKey, newValue) {
  if (!state.currentQuarter) return;
  const entry = state.currentQuarter.entries.find(e => e.id === entryId);
  if (!entry) return;
  const originalValue = entry[monthKey] || '';
  const key = `${entryId}:${monthKey}`;
  if (String(newValue) === String(originalValue)) {
    delete state.pendingChanges[key];
  } else {
    state.pendingChanges[key] = { entryId, monthKey, originalValue, newValue };
  }
  renderTable();
  renderQuarterStats();
  renderPendingChanges();
}

window.toggleStatus = function(entryId, monthKey) {
  if (!state.currentQuarter) return;
  const entry = state.currentQuarter.entries.find(e => e.id === entryId);
  if (!entry) return;
  const currentVal = getEffectiveStatus(entry, monthKey);
  stageStatusChange(entryId, monthKey, currentVal ? '' : '✓');
};

window.toggleLetterStatus = function(entryId, monthKey, letter) {
  if (!state.currentQuarter) return;
  const entry = state.currentQuarter.entries.find(e => e.id === entryId);
  if (!entry) return;
  const currentVal = getEffectiveStatus(entry, monthKey);
  const items = parseLetterStatuses(currentVal);
  const target = items.find(x => x.letter === letter.toUpperCase());
  if (!target) return;
  target.checked = !target.checked;
  stageStatusChange(entryId, monthKey, serializeLetterStatuses(items));
};

function compactStatus(value) {
  return String(value).replace(/\s+/g, ' ').replace(/\.\s+/g, '.').replace(/\s*✓\s*/g, '✓').trim();
}

function getPendingChangeEntries() {
  return Object.values(state.pendingChanges);
}

function renderPendingChanges() {
  const panel = document.getElementById('pending-changes-panel');
  const list = document.getElementById('pending-changes-list');
  const countEl = document.getElementById('pending-panel-count');
  const bar = document.getElementById('unsaved-changes-bar');
  const pill = document.getElementById('unsaved-pill');
  const quick = document.getElementById('btn-quick-save');
  const changes = getPendingChangeEntries();
  const count = changes.length;

  if (countEl) countEl.textContent = `${count} change${count === 1 ? '' : 's'}`;
  if (panel) panel.style.display = count ? 'block' : 'none';
  if (bar) bar.style.display = count ? 'none' : 'none';
  if (pill) pill.style.display = count ? 'inline-flex' : 'none';
  if (quick) quick.style.display = count ? 'inline-flex' : 'none';
  const countText = document.getElementById('unsaved-count-text');
  if (countText) countText.innerHTML = `<strong>${count} change${count === 1 ? '' : 's'} pending</strong>`;
  if (!list) return;

  if (!count) { list.innerHTML = ''; return; }
  list.innerHTML = changes.map(c => {
    const entry = state.currentQuarter?.entries?.find(e => e.id === c.entryId);
    const name = entry?.name || c.entryId;
    const monthIndex = Number(c.monthKey.slice(1)) - 1;
    const month = state.currentQuarter?.months?.[monthIndex] || c.monthKey.toUpperCase();
    const from = c.originalValue || 'Empty';
    const to = c.newValue || 'Empty';
    return `<div class="pending-change-item">
      <div class="pending-change-main"><strong>${escapeHtml(name)}</strong><span>${escapeHtml(month)}</span></div>
      <div class="pending-change-values"><span>${escapeHtml(compactStatus(from))}</span><i class="fa-solid fa-arrow-right"></i><span class="pending-new">${escapeHtml(compactStatus(to))}</span></div>
      <button type="button" class="pending-remove" onclick="removePendingChange('${c.entryId}', '${c.monthKey}')" title="Revert this pending change">&times;</button>
    </div>`;
  }).join('');
}

window.removePendingChange = function(entryId, monthKey) {
  delete state.pendingChanges[`${entryId}:${monthKey}`];
  renderTable();
  renderQuarterStats();
  renderPendingChanges();
};

function hasPendingChanges() { return getPendingChangeEntries().length > 0; }

function discardPendingChanges() {
  if (!hasPendingChanges()) return;
  state.pendingChanges = {};
  renderTable();
  renderQuarterStats();
  renderPendingChanges();
  showToast('Pending changes cancelled. Nothing was saved.', 'info');
}

async function savePendingChanges() {
  if (!state.currentQuarter || !hasPendingChanges()) return;
  const changes = getPendingChangeEntries();
  const summary = changes.map(c => {
    const entry = state.currentQuarter.entries.find(e => e.id === c.entryId);
    const month = state.currentQuarter.months?.[Number(c.monthKey.slice(1)) - 1] || c.monthKey;
    return `${entry?.name || c.entryId} — ${month}: ${compactStatus(c.originalValue || 'Empty')} → ${compactStatus(c.newValue || 'Empty')}`;
  }).join('\n');

  const confirmed = confirm(`Update ${changes.length} selected change${changes.length === 1 ? '' : 's'}?\n\n${summary}\n\nClick OK to save all selected changes, or Cancel to keep them pending.`);
  if (!confirmed) return;

  const grouped = {};
  changes.forEach(c => {
    if (!grouped[c.entryId]) grouped[c.entryId] = { id: c.entryId };
    grouped[c.entryId][c.monthKey] = c.newValue;
  });

  try {
    const res = await fetch(`/api/quarters/${state.currentQuarter.id}/batch-save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates: Object.values(grouped) })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to save changes');
    }
    const data = await res.json();
    state.currentQuarter = data.quarter;
    state.pendingChanges = {};
    updateLastUpdated(data.lastUpdated || new Date().toISOString());
    renderQuarterStats();
    renderTable();
    renderPendingChanges();
    showToast(`${changes.length} change${changes.length === 1 ? '' : 's'} saved successfully.`, 'success');
  } catch (err) {
    showToast('Update failed: ' + err.message, 'error');
  }
}

// --- CRUD Actions ---
async function toggleStatus(entryId, monthKey) {
  if (!state.currentQuarter) return;
  const entry = state.currentQuarter.entries.find(e => e.id === entryId);
  if (!entry) return;

  const currentVal = entry[monthKey] || '';
  const newVal = currentVal ? '' : '✓';
  const monthName = state.currentQuarter.months?.[Number(monthKey.slice(1)) - 1] || monthKey.toUpperCase();
  const action = newVal ? 'mark as supported' : 'remove support';

  const confirmed = confirm(`Confirm Update\n\n${entry.name} — ${monthName}\n\nAre you sure you want to ${action}?\n\nClick OK to save this change, or Cancel to keep the current status.`);
  if (!confirmed) return;

  try {
    const res = await fetch(`/api/quarters/${state.currentQuarter.id}/entries/${entryId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [monthKey]: newVal })
    });
    if (!res.ok) throw new Error('Failed to update status');
    const updated = await res.json();
    const idx = state.currentQuarter.entries.findIndex(e => e.id === entryId);
    if (idx !== -1) state.currentQuarter.entries[idx] = updated;
    updateLastUpdated(new Date().toISOString());
    renderTable();
    renderQuarterStats();
    showToast(`${entry.name} — ${monthName} updated successfully.`, 'success');
  } catch (err) {
    showToast('Update failed: ' + err.message, 'error');
  }
}

async function handleBulkUpdate(monthKey, action) {
  if (!state.currentQuarter) return;
  const q = state.currentQuarter;
  const val = action === 'check' ? '✓' : '';
  const targets = q.entries || [];
  targets.forEach(entry => stageStatusChange(entry.id, monthKey === 'all' ? 'm1' : monthKey, monthKey === 'all' ? val : val));
  if (monthKey === 'all') {
    targets.forEach(entry => {
      stageStatusChange(entry.id, 'm2', val);
      stageStatusChange(entry.id, 'm3', val);
    });
  }
  showToast(`${action === 'check' ? 'Check' : 'Clear'} changes staged. Review them before updating.`, 'info');
}

function handleMonthToggleAll(monthKey) {
  if (!state.currentQuarter) return;
  const entries = state.currentQuarter.entries || [];
  const checkedCount = entries.filter(e => getEffectiveStatus(e, monthKey) === '✓').length;
  const action = checkedCount > entries.length / 2 ? 'uncheck' : 'check';
  handleBulkUpdate(monthKey, action);
}

// --- Pastor Modal & CRUD ---
window.editPastor = function(entryId) {
  if (!state.currentQuarter) return;
  const entry = state.currentQuarter.entries.find(e => e.id === entryId);
  if (!entry) return;

  document.getElementById('modal-pastor-title').textContent = 'Edit Pastor / Missionary';
  document.getElementById('pastor-entry-id').value = entry.id;
  document.getElementById('pastor-number').value = entry.number || '';
  document.getElementById('pastor-name').value = entry.name || '';
  document.getElementById('pastor-type').value = normalizePastorType(entry.pastorType);
  document.getElementById('pastor-notes').value = entry.notes || '';
  document.getElementById('group-add-all').style.display = 'none';

  pastorModal.classList.add('show');
};

function openPastorModal() {
  document.getElementById('modal-pastor-title').textContent = 'Add Pastor / Missionary';
  document.getElementById('pastor-form').reset();
  document.getElementById('pastor-entry-id').value = '';
  document.getElementById('pastor-number').value = (state.currentQuarter?.entries?.length || 0) + 1;
  document.getElementById('pastor-type').value = 'Unassigned';
  document.getElementById('group-add-all').style.display = 'block';

  pastorModal.classList.add('show');
}

function closePastorModal() {
  pastorModal.classList.remove('show');
}

async function handlePastorSubmit(e) {
  e.preventDefault();
  if (!state.currentQuarter) return;

  const entryId = document.getElementById('pastor-entry-id').value;
  const name = document.getElementById('pastor-name').value.trim();
  const number = document.getElementById('pastor-number').value;
  const pastorType = document.getElementById('pastor-type').value;
  const notes = document.getElementById('pastor-notes').value.trim();
  const addToAll = document.getElementById('pastor-add-all').checked;

  if (!name) {
    alert('Please enter pastor name');
    return;
  }

  const payload = { name, number, pastorType, notes, addToAllQuarters: addToAll };

  try {
    if (entryId) {
      // PUT update
      const res = await fetch(`/api/quarters/${state.currentQuarter.id}/entries/${entryId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error('Failed to update pastor');
      const updated = await res.json();
      updateLastUpdated(new Date().toISOString());
      const idx = state.currentQuarter.entries.findIndex(x => x.id === entryId);
      if (idx !== -1) state.currentQuarter.entries[idx] = updated;
      showToast('Pastor updated successfully!', 'success');
    } else {
      // POST create
      const res = await fetch(`/api/quarters/${state.currentQuarter.id}/entries`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error('Failed to create pastor');
      const created = await res.json();
      updateLastUpdated(new Date().toISOString());
      state.currentQuarter.entries.push(created);
      showToast('Pastor added to list!', 'success');
    }

    closePastorModal();
    renderQuarterStats();
    renderTable();
  } catch (err) {
    showToast('Operation failed: ' + err.message, 'error');
  }
}

window.deletePastor = async function(entryId) {
  if (!state.currentQuarter) return;
  const entry = state.currentQuarter.entries.find(e => e.id === entryId);
  if (!entry) return;

  if (!confirm(`Are you sure you want to remove "${entry.name}" from ${state.currentQuarter.title}?`)) return;

  try {
    const res = await fetch(`/api/quarters/${state.currentQuarter.id}/entries/${entryId}`, {
      method: 'DELETE'
    });
    if (!res.ok) throw new Error('Failed to delete pastor');
    
    // Remove locally and renumber
    state.currentQuarter.entries = state.currentQuarter.entries.filter(e => e.id !== entryId);
    state.currentQuarter.entries.forEach((e, i) => { e.number = i + 1; });

    showToast('Pastor moved to Recycle Bin', 'success');
    renderQuarterStats();
    renderTable();
  } catch (err) {
    showToast('Delete failed: ' + err.message, 'error');
  }
};

// --- Quarter Modal & Creation ---
function openQuarterModal() {
  const copySelect = document.getElementById('new-quarter-copy');
  copySelect.innerHTML = '<option value="">-- Start with Empty List --</option>';
  state.quarters.forEach(q => {
    const opt = document.createElement('option');
    opt.value = q.id;
    opt.textContent = `Copy from ${q.year} ${q.quarterName} (${q.entries?.length || 0} pastors)`;
    if (state.currentQuarter && q.id === state.currentQuarter.id) opt.selected = true;
    copySelect.appendChild(opt);
  });

  document.getElementById('new-quarter-year').value = new Date().getFullYear();
  quarterModal.classList.add('show');
}

function closeQuarterModal() {
  quarterModal.classList.remove('show');
}

async function handleQuarterSubmit(e) {
  e.preventDefault();
  const year = document.getElementById('new-quarter-year').value;
  const quarterNum = document.getElementById('new-quarter-num').value;
  const copyFrom = document.getElementById('new-quarter-copy').value;

  try {
    const res = await fetch('/api/quarters', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ year, quarterNum, copyFromQuarterId: copyFrom })
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to create quarter');
    }

    const created = await res.json();
    showToast(`Quarter ${created.id} created successfully!`, 'success');
    closeQuarterModal();
    await loadQuartersList();
    quarterSelect.value = created.id;
    await loadQuarterDetails(created.id);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// --- Mission Report Builder ---
function openReportModal() {
  const list = document.getElementById('report-quarter-list');
  const latestId = state.quarters.length ? state.quarters[state.quarters.length - 1].id : null;
  const selected = new Set(state.reportQuarters.length ? state.reportQuarters : (state.currentQuarter ? [state.currentQuarter.id] : latestId ? [latestId] : []));
  document.getElementById('report-pastor-type').value = state.reportFilters.pastorType || state.pastorTypeFilter || 'All';
  document.getElementById('report-status-filter').value = state.reportFilters.statusFilter || state.statusFilter || 'All';
  list.innerHTML = state.quarters.map(q => `
    <label class="report-quarter-option">
      <input type="checkbox" value="${escapeHtml(q.id)}" ${selected.has(q.id) ? 'checked' : ''}>
      <span><strong>${escapeHtml(q.year + ' ' + q.quarterName)}</strong><small>${escapeHtml((q.months||[]).join(', '))} • ${q.totalPastors || 0} pastors</small></span>
    </label>`).join('');
  reportModal.classList.add('show');
}

function closeReportModal() { reportModal.classList.remove('show'); }
function setAllReportQuarters(checked) { document.querySelectorAll('#report-quarter-list input[type="checkbox"]').forEach(cb => cb.checked = checked); }
function getSelectedReportQuarters() { return [...document.querySelectorAll('#report-quarter-list input[type="checkbox"]:checked')].map(cb => cb.value); }

async function getReportQuarterDetails(ids) {
  const details = await Promise.all(ids.map(async id => {
    const res = await fetch(`/api/quarters/${id}`);
    if (!res.ok) throw new Error(`Failed to load ${id}`);
    return res.json();
  }));
  return details;
}

function getReportFilteredEntries(q, entries, pastorType, statusFilter) {
  let out = entries || [];
  if (pastorType !== 'All') out = out.filter(e => normalizePastorType(e.pastorType) === pastorType);
  if (statusFilter !== 'All' && !isLatestQuarter(q)) {
    out = out.filter(e => statusFilter === 'Incomplete Only' ? !isEntryComplete(e) : isEntryComplete(e));
  }
  return out;
}

async function applyReportView() {
  const ids = getSelectedReportQuarters();
  if (!ids.length) { showToast('Select at least one quarter for the report.', 'error'); return; }
  state.reportQuarters = ids;
  state.reportFilters = {
    pastorType: document.getElementById('report-pastor-type').value,
    statusFilter: document.getElementById('report-status-filter').value
  };
  state.pastorTypeFilter = state.reportFilters.pastorType;
  state.statusFilter = state.reportFilters.statusFilter;
  pastorTypeFilter.value = state.pastorTypeFilter;
  statusFilter.value = state.statusFilter;
  state.allMode = true;
  state.reportMode = true;
  state.currentQuarter = null;
  state.activeYear = null;
  quarterSelect.innerHTML = '<option value="ALL">Mission Report — Selected Quarters</option>';
  quarterSelect.value = 'ALL';
  updateYearPillsActive();
  state.allQuarters = await getReportQuarterDetails(ids);
  toggleAllView(true);
  renderAllView();
  renderAllStats();
  updateReportModeUi();
  closeReportModal();
  showToast(`Report view applied to ${ids.length} quarter${ids.length === 1 ? '' : 's'}.`, 'success');
}

function downloadReportPptx() {
  const ids = state.reportMode ? state.reportQuarters : getSelectedReportQuarters();
  if (!ids.length) { showToast('Select at least one quarter for the report.', 'error'); return; }
  const pastorType = state.reportMode ? state.reportFilters.pastorType : document.getElementById('report-pastor-type').value;
  const status = state.reportMode ? state.reportFilters.statusFilter : document.getElementById('report-status-filter').value;
  const params = new URLSearchParams({ quarterIds: ids.join(','), pastorType, statusFilter: status });
  showToast('Preparing mission report PowerPoint...', 'info');
  window.location.href = `/api/export/pptx-report?${params.toString()}`;
}

function updateReportModeUi() {
  const exit = document.getElementById('btn-exit-report');
  if (exit) exit.style.display = state.reportMode ? 'inline-flex' : 'none';
}

function exitReportMode() {
  state.reportMode = false;
  state.reportQuarters = [];
  state.reportFilters = { pastorType: state.pastorTypeFilter, statusFilter: state.statusFilter };
  state.allMode = false;
  toggleAllView(false);
  updateReportModeUi();
  const latest = state.quarters[state.quarters.length - 1];
  if (latest) { state.activeYear = latest.year; populateQuarterDropdown(); quarterSelect.value = latest.id; loadQuarterDetails(latest.id); }
}

// --- Recycle Bin ---
async function openRecycleBinModal() {
  recycleBinModal.classList.add('show');
  const list = document.getElementById('recycle-list');
  list.innerHTML = '<div class="audit-empty">Loading deleted records...</div>';
  try {
    const res = await fetch('/api/recycle-bin');
    if (!res.ok) throw new Error('Failed to load Recycle Bin');
    const data = await res.json();
    renderRecycleBin(data.recycleBin || []);
  } catch (err) {
    list.innerHTML = `<div class="audit-empty">${escapeHtml(err.message)}</div>`;
  }
}

function closeRecycleBinModal() { recycleBinModal.classList.remove('show'); }

function renderRecycleBin(items) {
  const list = document.getElementById('recycle-list');
  if (!items.length) { list.innerHTML = '<div class="audit-empty">Recycle Bin is empty.</div>'; return; }
  list.innerHTML = items.map(item => {
    const when = item.deletedAt ? new Date(item.deletedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'Unknown date';
    return `<div class="recycle-item">
      <div class="recycle-main"><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.deletedFromQuarterTitle || item.deletedFromQuarterId || 'Unknown quarter')} • ${escapeHtml(normalizePastorType(item.pastorType))}</span><small>Deleted ${escapeHtml(when)}</small></div>
      <div class="recycle-actions"><button class="btn btn-sm btn-secondary" onclick="restorePastor('${escapeHtml(item.id)}')"><i class="fa-solid fa-rotate-left"></i> Restore</button><button class="btn btn-sm btn-danger" onclick="permanentlyDeletePastor('${escapeHtml(item.id)}')"><i class="fa-solid fa-trash"></i></button></div>
    </div>`;
  }).join('');
}

window.restorePastor = async function(entryId) {
  if (!confirm('Restore this pastor to the original quarter with all previous support data?')) return;
  try {
    const res = await fetch(`/api/recycle-bin/${encodeURIComponent(entryId)}/restore`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to restore pastor');
    showToast(`${data.restored.name} restored successfully.`, 'success');
    await openRecycleBinModal();
    await loadQuartersList();
    const target = state.quarters.find(q => q.id === data.quarterId);
    if (target) { state.activeYear = target.year; state.allMode = false; state.reportMode = false; toggleAllView(false); updateReportModeUi(); quarterSelect.value = target.id; await loadQuarterDetails(target.id); }
  } catch (err) { showToast('Restore failed: ' + err.message, 'error'); }
};

window.permanentlyDeletePastor = async function(entryId) {
  if (!confirm('Permanently delete this pastor from the Recycle Bin? This cannot be undone.')) return;
  try {
    const res = await fetch(`/api/recycle-bin/${encodeURIComponent(entryId)}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to permanently delete pastor');
    showToast('Pastor permanently deleted.', 'success');
    await openRecycleBinModal();
  } catch (err) { showToast('Permanent delete failed: ' + err.message, 'error'); }
};

// --- Live Presentation Slides Mode ---
async function openPresentationMode() {
  if (state.allMode) {
    if (!state.allQuarters.length) await loadAllQuarterDetails();
    buildPresentationSlides();
  } else if (state.currentQuarter) {
    buildPresentationSlides();
  } else return;
  state.presentation.currentSlideIndex = 0;
  renderSlide();
  presentationModal.classList.add('show');
}

function closePresentationMode() {
  presentationModal.classList.remove('show');
}

function buildPresentationSlides() {
  const quarterList = state.allMode ? (state.allQuarters || []) : (state.currentQuarter ? [state.currentQuarter] : []);
  const chunkSize = 3;
  const slides = [];

  quarterList.forEach(q => {
    slides.push({
      isCover: true,
      title: q.title || `${q.year} MISSION SUPPORT ${q.quarterName.toUpperCase()}`,
      subtitle: q.quarterName,
      months: q.months
    });
    const entries = filterEntriesForDisplay(q, q.entries || []);
    for (let i = 0; i < entries.length; i += chunkSize) {
      slides.push({
        isCover: false,
        title: q.title,
        months: q.months,
        chunk: entries.slice(i, i + chunkSize),
        slideNum: Math.floor(i / chunkSize) + 1
      });
    }
  });
  state.presentation.slides = slides;
}

function renderSlide() {
  const { slides, currentSlideIndex } = state.presentation;
  const slideCanvas = document.getElementById('slide-canvas');
  const slideIndicator = document.getElementById('slide-indicator');

  if (slides.length === 0) return;
  const slide = slides[currentSlideIndex];
  slideIndicator.textContent = `Slide ${currentSlideIndex + 1} of ${slides.length}`;

  if (slide.isCover) {
    slideCanvas.innerHTML = `
      <div class="cover-slide-content">
        <img src="images/logo.png" alt="Church Logo" style="width: 130px; height: 130px; border-radius: 50%; background: white; padding: 5px; box-shadow: 0 0 35px rgba(139, 92, 246, 0.6); margin-bottom: 0.25rem; object-fit: contain;">
        <p style="font-size: 1.2rem; color: #DDD6FE; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; margin: 0;">LIVING HOPE BAPTIST CHURCH</p>
        <p style="font-size: 0.9rem; color: #A78BFA; margin: 0 0 0.5rem 0;">Managok, Malaybalay City</p>
        <h1 class="cover-title">${escapeHtml(slide.title)}</h1>
        <p style="font-size: 1.15rem; color: #C4B5FD;">${escapeHtml(slide.months.join(' • '))}</p>
      </div>
    `;
  } else {
    let rowsHtml = '';
    slide.chunk.forEach(p => {
      rowsHtml += `
        <tr>
          <td class="pastor-name-cell">${p.number ? p.number + '. ' : ''}${escapeHtml(p.name)}</td>
          <td class="check-mark">${p.m1 ? escapeHtml(compactStatus(p.m1)) : ''}</td>
          <td class="check-mark">${p.m2 ? escapeHtml(compactStatus(p.m2)) : ''}</td>
          <td class="check-mark">${p.m3 ? escapeHtml(compactStatus(p.m3)) : ''}</td>
        </tr>
      `;
    });

    // Pad to 3 rows
    for (let r = slide.chunk.length; r < 3; r++) {
      rowsHtml += `<tr><td>&nbsp;</td><td></td><td></td><td></td></tr>`;
    }

    slideCanvas.innerHTML = `
      <div class="slide-title-area">
        <h2>${escapeHtml(slide.title)}</h2>
      </div>
      <table class="slide-table">
        <thead>
          <tr>
            <th class="pastor-header">PASTOR/ MISSIONARY</th>
            <th>${escapeHtml(slide.months[0] || 'M1').toUpperCase()}</th>
            <th>${escapeHtml(slide.months[1] || 'M2').toUpperCase()}</th>
            <th>${escapeHtml(slide.months[2] || 'M3').toUpperCase()}</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>
      <div style="text-align: right; color: #A78BFA; font-size: 0.85rem; margin-top: 0.4rem;">
        Part ${slide.slideNum}
      </div>
    `;
  }
}

function nextSlide() {
  if (state.presentation.currentSlideIndex < state.presentation.slides.length - 1) {
    state.presentation.currentSlideIndex++;
    renderSlide();
  }
}

function prevSlide() {
  if (state.presentation.currentSlideIndex > 0) {
    state.presentation.currentSlideIndex--;
    renderSlide();
  }
}

function toggleFullscreen() {
  const elem = document.querySelector('.presentation-wrapper');
  if (!document.fullscreenElement) {
    elem.requestFullscreen().catch(err => alert(err.message));
  } else {
    document.exitFullscreen();
  }
}

function updatePresentationFullscreenState() {
  const wrapper = document.querySelector('.presentation-wrapper');
  const btn = document.getElementById('pres-fullscreen');
  const active = !!document.fullscreenElement;
  wrapper?.classList.toggle('is-fullscreen', active);
  if (btn) btn.innerHTML = active ? '<i class="fa-solid fa-compress"></i> Exit Fullscreen' : '<i class="fa-solid fa-expand"></i> Fullscreen';
}

function updateLastUpdated(timestamp) {
  if (!timestamp) return;
  state.lastUpdated = timestamp;
  const el = document.getElementById('last-updated');
  if (!el) return;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return;
  el.innerHTML = `<i class="fa-regular fa-clock"></i> Last updated: ${date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`;
}

async function pollForUpdates() {
  if (presentationModal.classList.contains('show')) return;
  try {
    const res = await fetch('/api/quarters');
    if (!res.ok) return;
    const data = await res.json();
    if (data.lastUpdated && data.lastUpdated !== state.lastUpdated && state.currentQuarter) {
      const currentId = state.currentQuarter.id;
      state.quarters = data.quarters || state.quarters;
      updateLastUpdated(data.lastUpdated);
      await loadQuarterDetails(currentId);
    } else {
      updateLastUpdated(data.lastUpdated);
    }
  } catch (_) {}
}

async function openAuditModal() {
  document.getElementById('audit-modal').classList.add('show');
  try {
    const res = await fetch('/api/audit-trail');
    if (!res.ok) throw new Error('Failed to load audit history');
    const data = await res.json();
    state.auditTrail = data.auditTrail || [];
    updateLastUpdated(data.lastUpdated);
    const filter = document.getElementById('audit-action-filter');
    const actions = [...new Set(state.auditTrail.map(x => x.action).filter(Boolean))].sort();
    filter.innerHTML = '<option value="">All actions</option>' + actions.map(a => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`).join('');
    renderAuditTrail();
  } catch (err) {
    document.getElementById('audit-list').innerHTML = `<div class="audit-empty">${escapeHtml(err.message)}</div>`;
  }
}

function closeAuditModal() { document.getElementById('audit-modal').classList.remove('show'); }

function renderAuditTrail() {
  const list = document.getElementById('audit-list');
  const query = document.getElementById('audit-search').value.trim().toLowerCase();
  const action = document.getElementById('audit-action-filter').value;
  const rows = state.auditTrail.filter(item => {
    const haystack = `${item.actor || ''} ${item.action || ''} ${item.pastorName || ''} ${item.quarterId || ''} ${item.description || ''} ${JSON.stringify(item.changes || [])}`.toLowerCase();
    return (!query || haystack.includes(query)) && (!action || item.action === action);
  });
  if (!rows.length) { list.innerHTML = '<div class="audit-empty">No audit records found.</div>'; return; }
  list.innerHTML = rows.map(item => {
    const when = new Date(item.timestamp);
    const changes = Array.isArray(item.changes) ? item.changes.map(c => `<span class="audit-change"><strong>${escapeHtml(c.field)}</strong>: ${escapeHtml(c.from || 'Empty')} → ${escapeHtml(c.to || 'Empty')}</span>`).join('') : '';
    return `<div class="audit-item"><div class="audit-icon"><i class="fa-solid fa-clock-rotate-left"></i></div><div class="audit-main"><div class="audit-top"><strong>${escapeHtml(item.action)}</strong><span>${when.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</span></div><div class="audit-description">${escapeHtml(item.description || '')}</div><div class="audit-meta">${escapeHtml(item.actor || 'Local User')}${item.quarterId ? ` • ${escapeHtml(item.quarterId)}` : ''}${item.pastorName ? ` • ${escapeHtml(item.pastorName)}` : ''}</div>${changes ? `<div class="audit-changes">${changes}</div>` : ''}</div></div>`;
  }).join('');
}

setInterval(pollForUpdates, 5000);

// --- Utilities ---
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  
  let icon = 'fa-info-circle';
  if (type === 'success') icon = 'fa-check-circle';
  if (type === 'error') icon = 'fa-exclamation-circle';

  toast.innerHTML = `<i class="fa-solid ${icon}"></i> <span>${escapeHtml(message)}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

function escapeHtml(str) {
  if (!str) return '';
  return str.toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
