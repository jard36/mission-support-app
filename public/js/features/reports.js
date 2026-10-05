(function attachReportsFeature(global) {
async function downloadPptxFile(url) {
  const powerpointType = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  try {
    const response = await apiRequest(url, { credentials: 'same-origin' });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      let payload = {};
      try { payload = JSON.parse(body); } catch (_) { payload.error = body; }
      throw new Error(payload.error || `PowerPoint export failed (${response.status}).`);
    }
    const responseType = (response.headers.get('Content-Type') || '').split(';')[0].toLowerCase();
    let blob;
    let exportFilename = '';
    if (responseType === 'application/json') {
      const payload = await response.json();
      if (!payload.base64) throw new Error(payload.error || 'The export response did not contain a PowerPoint file.');
      const binary = atob(payload.base64);
      const bytes = new Uint8Array(binary.length);
      for (let offset = 0; offset < binary.length; offset += 1) bytes[offset] = binary.charCodeAt(offset);
      blob = new Blob([bytes], { type: payload.mimeType || powerpointType });
      exportFilename = payload.filename || '';
    } else {
      blob = await response.blob();
    }
    if (!blob.size) throw new Error('The PowerPoint export was empty. Please try again.');
    const signature = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
    if (signature[0] !== 0x50 || signature[1] !== 0x4b) {
      const responseText = await blob.text().catch(() => '');
      let errorMessage = responseText.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);
      try { errorMessage = JSON.parse(responseText).error || errorMessage; } catch (_) {}
      throw new Error(errorMessage || 'The server returned a response that is not a PowerPoint file.');
    }
    const disposition = response.headers.get('Content-Disposition') || '';
    const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
    const plainName = disposition.match(/filename="?([^";]+)"?/i)?.[1];
    let filename = exportFilename || plainName || 'Mission_Support_Report.pptx';
    if (encodedName) {
      try { filename = decodeURIComponent(encodedName); } catch (_) { filename = encodedName; }
    }
    const powerpointBlob = blob.type === powerpointType ? blob : new Blob([blob], { type: powerpointType });
    const objectUrl = URL.createObjectURL(powerpointBlob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    showToast('PowerPoint download started.', 'success');
  } catch (error) {
    showToast(`PowerPoint download failed: ${error.message}`, 'error');
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
    const res = await apiRequest(`/api/quarters/${id}`);
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
  downloadPptxFile(`/api/export/pptx-report?${params.toString()}`);
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



  global.MissionSupportFeatures = global.MissionSupportFeatures || {};
  global.MissionSupportFeatures.reports = Object.freeze({
    downloadPptxFile, openReportModal, closeReportModal, setAllReportQuarters,
    applyReportView, downloadReportPptx, updateReportModeUi, exitReportMode
  });
})(window);
