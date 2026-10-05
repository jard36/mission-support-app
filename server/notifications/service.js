const crypto = require('crypto');
const { Resend } = require('resend');

const DEFAULT_NOTIFICATION_SETTINGS = {
  monthly: {
    enabled: true,
    daysBefore: 5,
    subject: 'Mission Support Reminder — {{month}}',
    emailMessage: 'Hello {{name}},\n\nThis is a reminder regarding your mission support for {{month}}. Please review your support record before the deadline on {{deadline}}.\n\nPastors with pending support: {{pastors}}\n\nThank you for your faithful support.\nLiving Hope Baptist Church',
    smsMessage: 'Hi {{name}}, reminder: please review your mission support for {{month}} before {{deadline}}. Pending: {{pastors}}. Thank you — Living Hope Baptist Church.'
  },
  quarterly: {
    enabled: true,
    daysBefore: 5,
    subject: 'Mission Support Reminder — {{quarter}}',
    emailMessage: 'Hello {{name}},\n\nThis is a reminder to review your mission support records for {{quarter}} before the quarter deadline on {{deadline}}.\n\nPastors with pending support: {{pastors}}\n\nThank you for your faithful support.\nLiving Hope Baptist Church',
    smsMessage: 'Hi {{name}}, reminder: please review your mission support for {{quarter}} before {{deadline}}. Pending: {{pastors}}. Thank you — Living Hope Baptist Church.'
  },
  channels: { email: true, sms: true }
};

function cloneDefaultNotificationSettings() {
  return JSON.parse(JSON.stringify(DEFAULT_NOTIFICATION_SETTINGS));
}

function ensureNotificationState(db) {
  const defaults = cloneDefaultNotificationSettings();
  const current = db.notificationSettings || {};
  db.notificationSettings = {
    ...defaults,
    ...current,
    monthly: { ...defaults.monthly, ...(current.monthly || {}) },
    quarterly: { ...defaults.quarterly, ...(current.quarterly || {}) },
    channels: { ...defaults.channels, ...(current.channels || {}) }
  };
  if (!Array.isArray(db.notificationLog)) db.notificationLog = [];
  return db;
}

function createNotificationService({
  normalizeDB,
  readDB,
  writeDB,
  ensureAuthState,
  normalizePastorKey,
  getEnabledEntrySupportSlots,
  statusMetrics,
  isEntryComplete
}) {
  function manilaDateParts(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(date).reduce((out, part) => {
      if (part.type !== 'literal') out[part.type] = part.value;
      return out;
    }, {});
    return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
  }

  function daysInMonth(year, month) {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
  }

  function formatManilaDate(year, month, day) {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Manila', year: 'numeric', month: 'long', day: 'numeric'
    }).format(new Date(Date.UTC(year, month - 1, day, 12)));
  }

  function currentQuarterForManilaDate(db, date = new Date()) {
    const parts = manilaDateParts(date);
    const quarterNum = Math.ceil(parts.month / 3);
    return db.quarters.find(quarter => Number(quarter.year) === parts.year
      && Number(quarter.quarterNum) === quarterNum) || null;
  }

  function assignedEntriesForUser(user, quarter) {
    const assigned = Array.isArray(user?.assignedPastors)
      ? user.assignedPastors
      : (user?.assignedPastor ? [user.assignedPastor] : []);
    if (!assigned.length || !quarter) return [];
    return (quarter.entries || []).filter(entry => !entry.hidden && assigned.some(pastor => {
      const matches = normalizePastorKey(pastor.name, pastor.number) === normalizePastorKey(entry.name, entry.number)
        || (String(pastor.name || '').trim().toLowerCase() === String(entry.name || '').trim().toLowerCase()
          && (!pastor.number || String(pastor.number) === String(entry.number)));
      if (!matches || !pastor.slot) return matches;
      return getEnabledEntrySupportSlots(entry).includes(String(pastor.slot).trim().toUpperCase());
    }));
  }

  function dueSummaryForUser(user, quarter, kind, date = new Date()) {
    const entries = assignedEntriesForUser(user, quarter);
    if (!entries.length) return null;
    const parts = manilaDateParts(date);
    const monthIndex = (parts.month - 1) % 3;
    const monthKey = `m${monthIndex + 1}`;
    const monthName = quarter.months?.[monthIndex] || parts.month;
    let due = entries;
    if (kind === 'monthly') {
      due = entries.filter(entry => {
        const metrics = statusMetrics(entry[monthKey], entry);
        return metrics.checked < metrics.total;
      });
    }
    if (kind === 'quarterly') due = entries.filter(entry => !isEntryComplete(entry));
    if (!due.length) return null;
    return {
      pastors: due.map(entry => entry.name),
      month: monthName,
      monthKey,
      quarter: quarter.quarterName ? `${quarter.year} ${quarter.quarterName}` : quarter.id
    };
  }

  function notificationPeriod(kind, date = new Date()) {
    const parts = manilaDateParts(date);
    const quarterNum = Math.ceil(parts.month / 3);
    if (kind === 'monthly') return `${parts.year}-${String(parts.month).padStart(2, '0')}`;
    return `${parts.year}-Q${quarterNum}`;
  }

  function renderNotificationTemplate(template, context) {
    return String(template || '')
      .replace(/{{\s*name\s*}}/gi, context.name || '')
      .replace(/{{\s*month\s*}}/gi, context.month || '')
      .replace(/{{\s*quarter\s*}}/gi, context.quarter || '')
      .replace(/{{\s*deadline\s*}}/gi, context.deadline || '')
      .replace(/{{\s*pastors\s*}}/gi, context.pastors || '')
      .replace(/{{\s*year\s*}}/gi, context.year || '');
  }

  function normalizePHPhone(value) {
    let phone = String(value || '').replace(/[^0-9+]/g, '');
    if (phone.startsWith('+63')) phone = phone.slice(1);
    if (phone.startsWith('09') && phone.length === 11) phone = `63${phone.slice(1)}`;
    if (phone.startsWith('63') && phone.length === 12) return phone;
    return '';
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[character]));
  }

  async function sendReminderEmail({ to, subject, text }) {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) throw new Error('RESEND_API_KEY is not configured.');
    const from = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
    const resend = new Resend(apiKey);
    const html = String(text || '').split(/\n{2,}/)
      .map(block => `<p>${escapeHtml(block).replace(/\n/g, '<br>')}</p>`).join('');
    const result = await resend.emails.send({ from, to: [to], subject, text, html });
    if (result?.error) throw new Error(result.error.message || 'Resend email failed.');
    return result?.data?.id || null;
  }

  async function sendReminderSMS({ to, message }) {
    const apiToken = process.env.IPROG_SMS_API_TOKEN;
    if (!apiToken) throw new Error('IPROG_SMS_API_TOKEN is not configured.');
    const response = await fetch('https://www.iprogsms.com/api/v1/sms_messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_token: apiToken, phone_number: to, message })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || Number(data?.status) !== 200) {
      throw new Error(data?.message || `IPROG SMS request failed (${response.status}).`);
    }
    return data?.message_id || null;
  }

  async function sendNotificationBatch(db, {
    kind,
    recipientMode,
    userIds = [],
    channels = {},
    manual = true,
    now = new Date()
  }) {
    ensureAuthState(db);
    ensureNotificationState(db);
    const settings = db.notificationSettings;
    const typeSettings = settings[kind];
    if (!typeSettings?.enabled && !manual) {
      return { sent: 0, skipped: 0, failed: 0, reason: `${kind} reminders are disabled.` };
    }
    const quarter = currentQuarterForManilaDate(db, now);
    if (!quarter) return { sent: 0, skipped: 0, failed: 0, reason: 'No quarter exists for the current Manila date.' };

    const parts = manilaDateParts(now);
    const deadlineMonth = kind === 'quarterly' ? Math.ceil(parts.month / 3) * 3 : parts.month;
    const deadline = formatManilaDate(parts.year, deadlineMonth, daysInMonth(parts.year, deadlineMonth));
    const period = notificationPeriod(kind, now);
    const allUsers = db.users.filter(user => user.status === 'active');
    let recipients = allUsers;
    if (recipientMode === 'month' || recipientMode === 'quarter') {
      recipients = allUsers.filter(user => user.role === 'supporter'
        && dueSummaryForUser(user, quarter, kind, now));
    } else if (recipientMode === 'selected') {
      const wanted = new Set((userIds || []).map(String));
      recipients = allUsers.filter(user => wanted.has(String(user.id)));
    }

    const emailEnabled = channels.email !== false && settings.channels.email !== false;
    const smsEnabled = channels.sms !== false && settings.channels.sms !== false;
    const results = { sent: 0, skipped: 0, failed: 0, recipients: recipients.length, details: [] };

    for (const user of recipients) {
      const summary = dueSummaryForUser(user, quarter, kind, now) || {
        pastors: [],
        month: quarter.months?.[((parts.month - 1) % 3)] || '',
        monthKey: `m${((parts.month - 1) % 3) + 1}`,
        quarter: `${quarter.year} ${quarter.quarterName}`
      };
      const context = {
        name: user.name || user.username,
        month: summary.month,
        quarter: summary.quarter,
        deadline,
        pastors: summary.pastors.join(', '),
        year: String(parts.year)
      };
      const channelsToSend = [];
      if (emailEnabled && user.email) channelsToSend.push('email');
      if (smsEnabled && normalizePHPhone(user.phone)) channelsToSend.push('sms');
      if (!channelsToSend.length) {
        results.skipped++;
        results.details.push({ userId: user.id, name: user.name, status: 'skipped', reason: 'No usable email or SMS contact.' });
        continue;
      }

      for (const channel of channelsToSend) {
        const dedupeKey = `${kind}:${period}:${user.id}:${channel}`;
        if (db.notificationLog.some(item => item.dedupeKey === dedupeKey && item.status === 'sent')) {
          results.skipped++;
          continue;
        }
        const log = {
          id: `notification-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
          dedupeKey, kind, period, userId: user.id, userName: user.name || user.username,
          channel, sentAt: new Date().toISOString(), status: 'failed'
        };
        try {
          if (channel === 'email') {
            log.providerMessageId = await sendReminderEmail({
              to: user.email,
              subject: renderNotificationTemplate(typeSettings.subject, context),
              text: renderNotificationTemplate(typeSettings.emailMessage, context)
            });
          } else {
            log.providerMessageId = await sendReminderSMS({
              to: normalizePHPhone(user.phone),
              message: renderNotificationTemplate(typeSettings.smsMessage, context)
            });
          }
          log.status = 'sent';
          results.sent++;
        } catch (error) {
          log.error = error.message;
          results.failed++;
        }
        db.notificationLog.unshift(log);
        if (db.notificationLog.length > 5000) db.notificationLog.length = 5000;
        results.details.push({ userId: user.id, name: user.name, channel, status: log.status, error: log.error || null });
      }
    }
    await writeDB(db);
    return results;
  }

  function isScheduledReminderDay(kind, settings, date = new Date()) {
    const parts = manilaDateParts(date);
    const days = daysInMonth(parts.year, parts.month);
    const daysBefore = Math.max(0, Number(settings?.daysBefore ?? 5));
    const monthlyDue = parts.day === Math.max(1, days - daysBefore);
    const quarterMonth = [3, 6, 9, 12].includes(parts.month);
    const quarterlyDue = quarterMonth && monthlyDue;
    return kind === 'monthly' ? monthlyDue : quarterlyDue;
  }

  async function runScheduledNotifications() {
    const db = normalizeDB(await readDB());
    ensureNotificationState(db);
    const now = new Date();
    const outcomes = [];
    for (const kind of ['monthly', 'quarterly']) {
      const settings = db.notificationSettings[kind];
      if (!settings.enabled || !isScheduledReminderDay(kind, settings, now)) continue;
      const mode = kind === 'monthly' ? 'month' : 'quarter';
      outcomes.push({
        kind,
        result: await sendNotificationBatch(db, {
          kind,
          recipientMode: mode,
          channels: db.notificationSettings.channels,
          manual: false,
          now
        })
      });
    }
    return outcomes;
  }

  return {
    currentQuarterForManilaDate,
    dueSummaryForUser,
    normalizePHPhone,
    sendNotificationBatch,
    runScheduledNotifications
  };
}

module.exports = { createNotificationService, ensureNotificationState };
