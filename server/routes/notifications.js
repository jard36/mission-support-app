const express = require('express');

function createNotificationRouter({
  service,
  readDB,
  writeDB,
  normalizeDB,
  ensureAuthState,
  requireAuth,
  requireStaff,
  requireAdmin,
  sendInternalError
}) {
  const cron = express.Router();
  const api = express.Router();

  // Mount this router before the general API authentication middleware. The
  // route authenticates with its own server-side bearer secret.
  cron.get('/notifications/cron', async (req, res) => {
    const expected = process.env.CRON_SECRET;
    const authorization = req.headers.authorization || '';
    if (!expected) return res.status(503).json({ error: 'CRON_SECRET is not configured.' });
    if (authorization !== `Bearer ${expected}`) {
      return res.status(401).json({ error: 'Unauthorized cron request.' });
    }
    try {
      const result = await service.runScheduledNotifications();
      res.json({ ok: true, result });
    } catch (error) {
      sendInternalError(res, error, 'Scheduled notification error:');
    }
  });

  api.get('/notifications/state', requireStaff, async (req, res) => {
    try {
      const db = normalizeDB(await readDB());
      ensureAuthState(db);
      const safeLog = db.notificationLog.slice(0, 100).map(item => ({
        id: item.id,
        kind: item.kind,
        period: item.period,
        userId: item.userId,
        userName: item.userName,
        channel: item.channel,
        sentAt: item.sentAt,
        status: item.status,
        error: item.error || null
      }));
      res.json({ settings: db.notificationSettings, log: safeLog });
    } catch (error) {
      sendInternalError(res, error);
    }
  });

  api.put('/notifications/settings', requireAuth, requireAdmin, async (req, res) => {
    try {
      const db = normalizeDB(await readDB());
      const incoming = req.body || {};
      const current = db.notificationSettings;
      for (const kind of ['monthly', 'quarterly']) {
        if (!incoming[kind]) continue;
        current[kind].enabled = Boolean(incoming[kind].enabled);
        current[kind].daysBefore = Math.min(30, Math.max(0,
          Number(incoming[kind].daysBefore ?? current[kind].daysBefore)));
        current[kind].subject = String(incoming[kind].subject ?? current[kind].subject).slice(0, 200);
        current[kind].emailMessage = String(incoming[kind].emailMessage ?? current[kind].emailMessage).slice(0, 10000);
        current[kind].smsMessage = String(incoming[kind].smsMessage ?? current[kind].smsMessage).slice(0, 900);
      }
      if (incoming.channels) {
        current.channels.email = Boolean(incoming.channels.email);
        current.channels.sms = Boolean(incoming.channels.sms);
      }
      await writeDB(db);
      res.json({ settings: db.notificationSettings });
    } catch (error) {
      sendInternalError(res, error);
    }
  });

  api.get('/notifications/recipients', requireStaff, async (req, res) => {
    try {
      const db = normalizeDB(await readDB());
      ensureAuthState(db);
      const kind = req.query.kind === 'quarterly' ? 'quarterly' : 'monthly';
      const quarter = service.currentQuarterForManilaDate(db);
      const users = db.users.filter(user => user.status === 'active').map(user => {
        const summary = service.dueSummaryForUser(user, quarter, kind);
        return {
          id: user.id,
          name: user.name || user.username,
          username: user.username,
          role: user.role,
          email: user.email || '',
          phone: user.phone || '',
          hasEmail: Boolean(user.email),
          hasSms: Boolean(service.normalizePHPhone(user.phone)),
          due: Boolean(summary),
          pastors: summary?.pastors || []
        };
      });
      res.json({
        kind,
        quarter: quarter ? { id: quarter.id, title: quarter.title, months: quarter.months } : null,
        users
      });
    } catch (error) {
      sendInternalError(res, error);
    }
  });

  api.post('/notifications/send', requireStaff, async (req, res) => {
    try {
      const kind = req.body?.kind === 'quarterly' ? 'quarterly' : 'monthly';
      const recipientMode = ['month', 'quarter', 'selected'].includes(req.body?.recipientMode)
        ? req.body.recipientMode
        : 'selected';
      const userIds = Array.isArray(req.body?.userIds) ? req.body.userIds : [];
      const channels = {
        email: req.body?.channels?.email !== false,
        sms: req.body?.channels?.sms !== false
      };
      if (recipientMode === 'selected' && !userIds.length) {
        return res.status(400).json({ error: 'Select at least one recipient.' });
      }
      const db = normalizeDB(await readDB());
      const result = await service.sendNotificationBatch(db, {
        kind,
        recipientMode,
        userIds,
        channels,
        manual: true
      });
      res.json(result);
    } catch (error) {
      sendInternalError(res, error, 'Manual notification error:');
    }
  });

  return { cron, api };
}

module.exports = { createNotificationRouter };
