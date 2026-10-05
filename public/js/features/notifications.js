(function attachNotificationFeature(global) {
// --- Reminder / Notification Center ---
const notificationState = global.MissionSupportState.notifications;

let initialized = false;

async function openNotificationsModal() {
  if (!notificationsModal || !['admin','staff'].includes(global.MissionSupportState.currentUser?.role)) return;
  notificationsModal.classList.add('show');
  await loadNotificationState();
  await loadNotificationRecipients();
}

function closeNotificationsModal() { notificationsModal?.classList.remove('show'); }

async function loadNotificationState() {
  try {
    const res = await apiRequest('/api/notifications/state');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Unable to load notification settings');
    notificationState.settings = data.settings;
    populateNotificationSettings(data.settings);
    renderNotificationHistory(data.log || []);
  } catch (err) { showToast(err.message, 'error'); }
}

function populateNotificationSettings(settings) {
  if (!settings) return;
  const ids = {
    'monthly-enabled': settings.monthly.enabled,
    'monthly-days': settings.monthly.daysBefore,
    'monthly-subject': settings.monthly.subject,
    'monthly-email': settings.monthly.emailMessage,
    'monthly-sms': settings.monthly.smsMessage,
    'quarterly-enabled': settings.quarterly.enabled,
    'quarterly-days': settings.quarterly.daysBefore,
    'quarterly-subject': settings.quarterly.subject,
    'quarterly-email': settings.quarterly.emailMessage,
    'quarterly-sms': settings.quarterly.smsMessage,
    'channel-email': settings.channels.email,
    'channel-sms': settings.channels.sms,
    'notification-email': settings.channels.email,
    'notification-sms': settings.channels.sms
  };
  Object.entries(ids).forEach(([id,val]) => { const el=document.getElementById(id); if(!el)return; if(el.type==='checkbox')el.checked=Boolean(val); else el.value=val ?? ''; });
}

async function loadNotificationRecipients() {
  const kind = document.getElementById('notification-kind')?.value || 'monthly';
  const list = document.getElementById('notification-recipient-list');
  if (!list) return;
  list.innerHTML = '<div class="audit-empty">Loading recipients...</div>';
  try {
    const res = await apiRequest(`/api/notifications/recipients?kind=${encodeURIComponent(kind)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Unable to load recipients');
    notificationState.recipients = data.users || [];
    const dueCount = notificationState.recipients.filter(u => u.due).length;
    const badge = document.getElementById('notification-badge');
    if (badge) { badge.textContent = dueCount > 99 ? '99+' : String(dueCount); badge.style.display = dueCount ? 'inline-flex' : 'none'; }
    renderNotificationRecipients();
  } catch (err) { list.innerHTML = `<div class="audit-empty">${escapeHtml(err.message)}</div>`; }
}

function selectedRecipientIds() {
  return [...document.querySelectorAll('#notification-recipient-list input[type="checkbox"]:checked')].map(x => x.value);
}

function renderNotificationRecipients() {
  const list = document.getElementById('notification-recipient-list');
  if (!list) return;
  if (!notificationState.recipients.length) { list.innerHTML = '<div class="audit-empty">No active accounts found.</div>'; return; }
  list.innerHTML = notificationState.recipients.map(u => `
    <label class="notification-recipient">
      <input type="checkbox" value="${escapeHtml(u.id)}" ${u.due ? 'checked' : ''}>
      <span class="notification-recipient-main"><strong>${escapeHtml(u.name)}</strong><small>${escapeHtml(u.email || 'No email')} • ${escapeHtml(u.phone || 'No phone')}</small></span>
      <span class="notification-recipient-meta ${u.due ? 'due' : ''}">${u.due ? `Due: ${escapeHtml((u.pastors || []).join(', '))}` : 'No pending support'}</span>
    </label>`).join('');
  updateNotificationRecipientMode();
}

function updateNotificationRecipientMode() {
  const mode = document.querySelector('input[name="recipient-mode"]:checked')?.value || 'month';
  const list = document.getElementById('notification-recipient-list');
  if (list) list.style.opacity = mode === 'selected' ? '1' : '.65';
  const summary = document.getElementById('notification-send-summary');
  if (summary) summary.textContent = mode === 'month' ? 'Send to all supporters with pending support for the current month.' : mode === 'quarter' ? 'Send to all supporters with pending support for the current quarter.' : `${selectedRecipientIds().length} selected account(s).`;
}

async function sendNotificationsNow() {
  const kind = document.getElementById('notification-kind')?.value || 'monthly';
  const mode = document.querySelector('input[name="recipient-mode"]:checked')?.value || 'month';
  const channels = { email: document.getElementById('notification-email')?.checked !== false, sms: document.getElementById('notification-sms')?.checked !== false };
  const userIds = mode === 'selected' ? selectedRecipientIds() : [];
  if (mode === 'selected' && !userIds.length) return showToast('Select at least one recipient.', 'error');
  if (!channels.email && !channels.sms) return showToast('Select at least one channel.', 'error');
  const btn = document.getElementById('btn-send-notification');
  try {
    btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Sending...';
    const res = await apiRequest('/api/notifications/send', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ kind, recipientMode: mode, userIds, channels }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Notification sending failed');
    showToast(`Reminder complete: ${data.sent} sent, ${data.skipped} skipped, ${data.failed} failed.`, data.failed ? 'info' : 'success');
    await loadNotificationState(); await loadNotificationRecipients();
  } catch (err) { showToast(err.message, 'error'); }
  finally { btn.disabled=false; btn.innerHTML='<i class="fa-solid fa-paper-plane"></i> Send Now'; }
}

async function saveNotificationSettings() {
  if (global.MissionSupportState.currentUser?.role !== 'admin') return showToast('Only Admin can change reminder settings.', 'error');
  const payload = {
    monthly: { enabled: document.getElementById('monthly-enabled').checked, daysBefore: document.getElementById('monthly-days').value, subject: document.getElementById('monthly-subject').value, emailMessage: document.getElementById('monthly-email').value, smsMessage: document.getElementById('monthly-sms').value },
    quarterly: { enabled: document.getElementById('quarterly-enabled').checked, daysBefore: document.getElementById('quarterly-days').value, subject: document.getElementById('quarterly-subject').value, emailMessage: document.getElementById('quarterly-email').value, smsMessage: document.getElementById('quarterly-sms').value },
    channels: { email: document.getElementById('channel-email').checked, sms: document.getElementById('channel-sms').checked }
  };
  try {
    const res = await apiRequest('/api/notifications/settings', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Unable to save reminder settings');
    notificationState.settings=data.settings; populateNotificationSettings(data.settings); showToast('Reminder settings saved.', 'success');
  } catch(err) { showToast(err.message,'error'); }
}

function renderNotificationHistory(log) {
  const list=document.getElementById('notification-history-list'); if(!list)return;
  if(!log.length){list.innerHTML='<div class="audit-empty">No reminder messages have been sent yet.</div>';return;}
  list.innerHTML=log.map(item=>`<div class="notification-history-row"><strong>${escapeHtml(item.userName||'Account')}</strong><span>${escapeHtml(item.kind)} • ${escapeHtml(item.period)}</span><span>${escapeHtml(item.channel)}</span><span class="notification-status-${escapeHtml(item.status)}">${escapeHtml(item.status)}</span><small>${escapeHtml(item.sentAt ? new Date(item.sentAt).toLocaleString([], {dateStyle:'medium',timeStyle:'short'}) : '')}${item.error ? `<br>${escapeHtml(item.error)}` : ''}</small></div>`).join('');
}

function setupNotificationUi() {
  if (initialized) return;
  initialized = true;
  document.getElementById('modal-hidden-pastors-close')?.addEventListener('click', closeHiddenPastorsModal);
  document.getElementById('modal-notifications-close')?.addEventListener('click', closeNotificationsModal);
  document.querySelectorAll('.notification-tab').forEach(tab => tab.addEventListener('click', () => {
    document.querySelectorAll('.notification-tab').forEach(x=>x.classList.remove('active'));
    document.querySelectorAll('.notification-panel').forEach(x=>x.classList.remove('active'));
    tab.classList.add('active'); document.getElementById(`notification-panel-${tab.dataset.tab}`)?.classList.add('active');
  }));
  document.getElementById('notification-kind')?.addEventListener('change', loadNotificationRecipients);
  document.querySelectorAll('input[name="recipient-mode"]').forEach(r => r.addEventListener('change', updateNotificationRecipientMode));
  document.getElementById('notification-select-all')?.addEventListener('click', () => { document.querySelectorAll('#notification-recipient-list input[type="checkbox"]').forEach(x=>x.checked=true); updateNotificationRecipientMode(); });
  document.getElementById('notification-clear-all')?.addEventListener('click', () => { document.querySelectorAll('#notification-recipient-list input[type="checkbox"]').forEach(x=>x.checked=false); updateNotificationRecipientMode(); });
  document.getElementById('btn-send-notification')?.addEventListener('click', sendNotificationsNow);
  document.getElementById('btn-save-notification-settings')?.addEventListener('click', saveNotificationSettings);
  document.querySelector('#notifications-modal .modal-backdrop')?.addEventListener('click', closeNotificationsModal);
  document.querySelector('#hidden-pastors-modal .modal-backdrop')?.addEventListener('click', closeHiddenPastorsModal);
}




  global.MissionSupportFeatures = global.MissionSupportFeatures || {};
  global.MissionSupportFeatures.notifications = Object.freeze({ initialize: setupNotificationUi, open: openNotificationsModal });
})(window);
