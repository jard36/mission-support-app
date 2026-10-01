const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pptxgen = require('pptxgenjs');
const { Resend } = require('resend');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// API responses are user/session-specific. Prevent Vercel/CDN caching from
// replaying an unauthenticated response across requests.
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, private, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Vary', 'Cookie, Authorization');
  next();
});

// Explicitly serve the main app page. Vercel's current Express support
// routes the project to this Express server automatically, so no
// vercel.json routing rules are required.
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const { readDB, writeDB, resetDB, getDatabaseMode } = require('./db');


// --------------------------------------------------------------------------
// Authentication
// --------------------------------------------------------------------------
const SESSION_COOKIE = 'mission_support_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
const DEFAULT_ADMIN_USERNAME = 'jarred';
// The initial admin password is only used once to create a secure hash.
// The plaintext password is never stored in the database.
const DEFAULT_ADMIN_SALT = 'cbc870a4360a4dd4be1db150150baf16';
const DEFAULT_ADMIN_HASH = 'b0ae490cfc530472c95ed07ea2cc8f7ca97b864eb5e9fab3135637ff03e6321cc653ce36a3e42da04254e1ec62c584b01e8b82a2f8ffd413477233f73be8e6e4';

function ensureAuthState(db) {
  if (!Array.isArray(db.users)) db.users = [];
  if (!Array.isArray(db.sessions)) db.sessions = [];
  return db;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, record) {
  if (!record?.passwordHash || !record?.passwordSalt) return false;
  const candidate = crypto.scryptSync(String(password), record.passwordSalt, 64);
  const stored = Buffer.from(record.passwordHash, 'hex');
  return candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored);
}

function sanitizeUser(user) {
  if (!user) return null;
  const assignedPastors = Array.isArray(user.assignedPastors)
    ? user.assignedPastors.map(p => ({
        name: String(p?.name || '').trim(),
        number: String(p?.number ?? '').trim(),
        slot: String(p?.slot || '').trim().toUpperCase() || null
      })).filter(p => p.name)
    : (user.assignedPastor ? [{
        name: String(user.assignedPastor.name || '').trim(),
        number: String(user.assignedPastor.number ?? '').trim(),
        slot: String(user.assignedPastor.slot || '').trim().toUpperCase() || null
      }] : []);
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
    status: user.status,
    email: user.email || '',
    phone: user.phone || '',
    assignedPastors,
    assignedPastor: assignedPastors[0] || null,
    createdAt: user.createdAt
  };
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  return header.split(';').reduce((out, part) => {
    const i = part.indexOf('=');
    if (i < 0) return out;
    const key = part.slice(0, i).trim();
    const value = decodeURIComponent(part.slice(i + 1).trim());
    if (key) out[key] = value;
    return out;
  }, {});
}

function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production';
  const sameSite = secure ? 'None' : 'Lax';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure ? '; Secure' : ''}`);
}

function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === 'production';
  const sameSite = secure ? 'None' : 'Lax';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=0${secure ? '; Secure' : ''}`);
}

async function ensureDefaultAdmin() {
  const db = ensureAuthState(await readDB());
  const existing = db.users.find(u => String(u.username || '').toLowerCase() === DEFAULT_ADMIN_USERNAME);
  if (existing) return db;

  const credentials = { salt: DEFAULT_ADMIN_SALT, hash: DEFAULT_ADMIN_HASH };
  db.users.push({
    id: `user-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
    username: DEFAULT_ADMIN_USERNAME,
    name: 'Jarred',
    role: 'admin',
    status: 'active',
    email: '',
    phone: '',
    passwordSalt: credentials.salt,
    passwordHash: credentials.hash,
    createdAt: new Date().toISOString()
  });
  await writeDB(db);
  return db;
}

async function getAuthenticatedUser(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const db = ensureAuthState(await readDB());
  const now = Date.now();
  db.sessions = db.sessions.filter(s => new Date(s.expiresAt).getTime() > now);
  const session = db.sessions.find(s => s.tokenHash === crypto.createHash('sha256').update(token).digest('hex'));
  if (!session) return null;
  const user = db.users.find(u => u.id === session.userId && u.status === 'active');
  if (!user) return null;
  return user;
}

async function requireAuth(req, res, next) {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) return res.status(401).json({ error: 'Authentication required.' });
    req.user = user;
    next();
  } catch (err) {
    console.error('Auth middleware error:', err);
    res.status(500).json({ error: 'Authentication service error.' });
  }
}

async function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required.' });
  next();
}

function requireStaff(req, res, next) {
  if (!['admin', 'staff'].includes(req.user?.role)) return res.status(403).json({ error: 'Staff access required.' });
  next();
}

function normalizePastorKey(name, number) {
  return `${String(number ?? '').trim()}::${String(name || '').trim().toLowerCase()}`;
}

function getSupporterAssignments(user) {
  if (user?.role !== 'supporter') return [];
  const assignedList = Array.isArray(user.assignedPastors) ? user.assignedPastors : (user.assignedPastor ? [user.assignedPastor] : []);
  return assignedList.filter(assigned => assigned?.name);
}

function assignmentMatchesEntry(assigned, entry) {
  const assignedName = String(assigned?.name || '').trim().toLowerCase();
  return normalizePastorKey(entry.name, entry.number) === normalizePastorKey(assigned.name, assigned.number) ||
    (String(entry.name || '').trim().toLowerCase() === assignedName && (!assigned.number || String(entry.number || '') === String(assigned.number || '')));
}

function getSupporterEntryFilter(user) {
  if (user?.role !== 'supporter') return () => true;
  const assignments = getSupporterAssignments(user);
  return entry => assignments.some(assigned => assignmentMatchesEntry(assigned, entry));
}

function getEntrySupportSlots(entry) {
  const slots = new Set();
  ['m1','m2','m3'].forEach(key => {
    const text = String(entry?.[key] || '');
    for (const match of text.matchAll(/([A-E])\s*\./gi)) slots.add(match[1].toUpperCase());
  });
  return [...slots].sort();
}

function clearSupportSlotChecks(value, fallbackSlots = []) {
  const slots = [...new Set([
    ...[...String(value || '').matchAll(/([A-E])\s*\./gi)].map(match => match[1].toUpperCase()),
    ...fallbackSlots
  ])];
  return slots.length ? slots.map(slot => `${slot}.`).join(' ') : '';
}

// A quarter created from another quarter should retain the lettered supporter
// slots, but its support checks always start empty. Older newly-created
// quarters may already exist without those labels, so repair the latest one
// lazily when an admin/staff user opens the quarter list.
function restoreLatestQuarterSupportSlots(db) {
  const quarters = Array.isArray(db?.quarters) ? db.quarters : [];
  if (quarters.length < 2) return 0;
  const latest = quarters[quarters.length - 1];
  const previous = quarters[quarters.length - 2];
  if (!latest || !previous) return 0;

  let repaired = 0;
  for (const entry of latest.entries || []) {
    if (entry.hidden || ['m1', 'm2', 'm3'].some(key => String(entry[key] || '').trim())) continue;
    const candidates = (previous.entries || []).filter(source => !source.hidden && String(source.name || '').trim().toLowerCase() === String(entry.name || '').trim().toLowerCase());
    const source = candidates.find(candidate => String(candidate.number || '') === String(entry.number || '')) || (candidates.length === 1 ? candidates[0] : null);
    if (!source) continue;
    const slots = getEntrySupportSlots(source);
    if (slots.length < 2) continue;
    for (const key of ['m1', 'm2', 'm3']) entry[key] = clearSupportSlotChecks(source[key], slots);
    repaired++;
  }
  return repaired;
}

function filterQuarterForUser(q, user) {
  if (!q) return q;
  const activeEntries = (q.entries || []).filter(e => !e.hidden);
  if (user?.role !== 'supporter') return { ...q, entries: activeEntries };
  const assignments = getSupporterAssignments(user);
  return {
    ...q,
    entries: activeEntries.filter(getSupporterEntryFilter(user)).map(entry => ({
      ...entry,
      supporterAssignedSlots: [...new Set(assignments.filter(assigned => assignmentMatchesEntry(assigned, entry))
        .map(assigned => String(assigned.slot || '').trim().toUpperCase()).filter(Boolean))]
    }))
  };
}

// Login/session endpoints remain public. All mission data APIs below are protected.
app.post('/api/auth/login', async (req, res) => {
  try {
    let db = await ensureDefaultAdmin();
    db = ensureAuthState(db);
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    const user = db.users.find(u => String(u.username || '').toLowerCase() === username.toLowerCase());

    if (!user || user.status !== 'active' || !verifyPassword(password, user)) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    const rawToken = crypto.randomBytes(32).toString('hex');
    db.sessions.push({
      id: `session-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
      userId: user.id,
      tokenHash: crypto.createHash('sha256').update(rawToken).digest('hex'),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString()
    });
    // Keep only the newest 100 sessions.
    db.sessions = db.sessions.slice(-100);
    await writeDB(db);
    setSessionCookie(res, rawToken);
    res.json({ user: sanitizeUser(user) });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Unable to sign in.' });
  }
});

app.get('/api/auth/me', async (req, res) => {
  try {
    await ensureDefaultAdmin();
    const user = await getAuthenticatedUser(req);
    if (!user) return res.status(401).json({ authenticated: false });
    res.json({ authenticated: true, user: sanitizeUser(user) });
  } catch (err) {
    console.error('Auth session check error:', err);
    res.status(500).json({ error: 'Unable to check session.' });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  try {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (token) {
      const db = ensureAuthState(await readDB());
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      db.sessions = db.sessions.filter(s => s.tokenHash !== tokenHash);
      await writeDB(db);
    }
    clearSessionCookie(res);
    res.json({ ok: true });
  } catch (err) {
    clearSessionCookie(res);
    res.json({ ok: true });
  }
});

// --------------------------------------------------------------------------
// Account creation and user management
// --------------------------------------------------------------------------
app.post('/api/auth/signup', async (req, res) => {
  try {
    let db = ensureAuthState(await readDB());
    const name = String(req.body?.name || '').trim();
    const username = String(req.body?.username || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const phone = String(req.body?.phone || '').trim();
    const password = String(req.body?.password || '');
    if (!name || !username || !password || (!email && !phone)) {
      return res.status(400).json({ error: 'Name, username, password, and at least an email or phone number are required.' });
    }
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    const usernameTaken = db.users.some(u => String(u.username || '').toLowerCase() === username.toLowerCase());
    const emailTaken = email && db.users.some(u => String(u.email || '').toLowerCase() === email);
    if (usernameTaken || emailTaken) return res.status(409).json({ error: 'Username or email is already registered.' });
    const credentials = hashPassword(password);
    const user = {
      id: `user-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
      username, name, role: 'supporter', status: 'pending_assignment', email, phone,
      assignedPastor: null, passwordSalt: credentials.salt, passwordHash: credentials.hash,
      createdAt: new Date().toISOString()
    };
    db.users.push(user);
    await writeDB(db);
    res.status(201).json({ user: sanitizeUser(user), message: 'Account created. Please wait for Admin/Staff assignment confirmation.' });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Unable to create account.' });
  }
});

app.get('/api/auth/users', requireAuth, requireStaff, async (req, res) => {
  try {
    const db = ensureAuthState(await readDB());
    res.json({ users: db.users.map(sanitizeUser) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const db = ensureAuthState(await readDB());
    const name = String(req.body?.name || '').trim();
    const username = String(req.body?.username || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const phone = String(req.body?.phone || '').trim();
    const role = ['staff','supporter'].includes(req.body?.role) ? req.body.role : 'supporter';
    if (role === 'staff' && req.user.role !== 'admin') return res.status(403).json({ error: 'Only Admin can create Staff accounts.' });
    const password = String(req.body?.password || '');
    if (!name || !username || !password || (!email && !phone)) return res.status(400).json({ error: 'Name, username, password, and email or phone are required.' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    if (db.users.some(u => String(u.username || '').toLowerCase() === username.toLowerCase())) return res.status(409).json({ error: 'Username is already registered.' });
    if (email && db.users.some(u => String(u.email || '').toLowerCase() === email)) return res.status(409).json({ error: 'Email is already registered.' });
    const credentials = hashPassword(password);
    const user = { id:`user-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`, username, name, role, status: role === 'staff' ? 'active' : 'pending_assignment', email, phone, assignedPastor: null, passwordSalt: credentials.salt, passwordHash: credentials.hash, createdAt:new Date().toISOString() };
    db.users.push(user);
    addAudit(db, req, 'USER_CREATED', { userId:user.id, username:user.username, role:user.role });
    await writeDB(db);
    res.status(201).json({ user:sanitizeUser(user) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/auth/users/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const db = ensureAuthState(await readDB());
    const user = db.users.find(u => u.id === req.params.id);
    if (!user) return res.status(404).json({ error:'User not found.' });
    if (user.role === 'admin' && req.user.id !== user.id) return res.status(403).json({ error:'Admin account cannot be edited by another user here.' });
    if (req.body?.name !== undefined) user.name = String(req.body.name).trim();
    if (req.body?.email !== undefined) user.email = String(req.body.email).trim().toLowerCase();
    if (req.body?.phone !== undefined) user.phone = String(req.body.phone).trim();
    if (req.body?.status && ['active','disabled','pending_assignment'].includes(req.body.status)) {
      if (req.body.status === 'disabled' && user.id === req.user.id) {
        return res.status(400).json({ error:'You cannot disable your own account while signed in.' });
      }
      user.status = req.body.status;
    }
    if (req.body?.role && req.user.role === 'admin' && ['staff','supporter'].includes(req.body.role)) user.role = req.body.role;
    if (req.body?.password) {
      if (String(req.body.password).length < 8) return res.status(400).json({ error:'Password must be at least 8 characters.' });
      const credentials = hashPassword(req.body.password); user.passwordSalt=credentials.salt; user.passwordHash=credentials.hash;
    }
    addAudit(db, req, req.body?.status ? 'USER_STATUS_CHANGED' : 'USER_UPDATED', { userId:user.id, username:user.username, status:user.status });
    await writeDB(db);
    res.json({ user:sanitizeUser(user) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/users/:id/assign', requireAuth, requireStaff, async (req, res) => {
  try {
    const db = ensureAuthState(await readDB());
    const user = db.users.find(u => u.id === req.params.id && u.role === 'supporter');
    if (!user) return res.status(404).json({ error:'Supporter not found.' });

    let pastors = Array.isArray(req.body?.pastors) ? req.body.pastors : [];
    if (!pastors.length && req.body?.name) pastors = [{ name:req.body.name, number:req.body.number, slot:req.body.slot }];
    pastors = pastors.map(p => ({
      name:String(p?.name || '').trim(),
      number:String(p?.number ?? '').trim(),
      slot:String(p?.slot || '').trim().toUpperCase()
    }))
      .filter(p => p.name)
      .filter((p, i, arr) => arr.findIndex(x => `${normalizePastorKey(x.name, x.number)}::${x.slot}` === `${normalizePastorKey(p.name, p.number)}::${p.slot}`) === i);
    if (!pastors.length) return res.status(400).json({ error:'Select at least one pastor assignment.' });

    // A/B/C/etc. represent distinct supporter slots for a pastor. Prevent two
    // supporter accounts from taking the same slot while still allowing the
    // same pastor to have multiple supporters. Legacy assignments without a
    // slot remain valid and are treated as a general assignment.
    const otherSupporters = db.users.filter(u => u.role === 'supporter' && u.id !== user.id);
    for (const pastor of pastors) {
      if (!pastor.slot) continue;
      const taken = otherSupporters.some(other => {
        const list = Array.isArray(other.assignedPastors) ? other.assignedPastors : (other.assignedPastor ? [other.assignedPastor] : []);
        return list.some(a => normalizePastorKey(a.name, a.number) === normalizePastorKey(pastor.name, pastor.number) && String(a.slot || '').toUpperCase() === pastor.slot);
      });
      if (taken) return res.status(409).json({ error:`Supporter slot ${pastor.slot}. for ${pastor.name} is already assigned to another supporter.` });
    }

    user.assignedPastors = pastors;
    user.assignedPastor = pastors[0];
    user.status = 'active';
    addAudit(db, req, 'SUPPORTER_ASSIGNED', { userId:user.id, username:user.username, pastors });
    await writeDB(db);
    res.json({ user:sanitizeUser(user) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/users/:id/unassign', requireAuth, requireStaff, async (req, res) => {
  try {
    const db = ensureAuthState(await readDB());
    const user = db.users.find(u => u.id === req.params.id && u.role === 'supporter');
    if (!user) return res.status(404).json({ error:'Supporter not found.' });
    user.assignedPastors = []; user.assignedPastor = null; user.status = 'pending_assignment';
    addAudit(db, req, 'SUPPORTER_UNASSIGNED', { userId:user.id, username:user.username });
    await writeDB(db);
    res.json({ user:sanitizeUser(user) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/auth/users/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const db = ensureAuthState(await readDB());
    const idx = db.users.findIndex(u => u.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error:'User not found.' });
    if (db.users[idx].role === 'admin') return res.status(400).json({ error:'Admin accounts cannot be deleted.' });
    const [user] = db.users.splice(idx,1);
    db.sessions = db.sessions.filter(s => s.userId !== user.id);
    addAudit(db, req, 'USER_DELETED', { userId:user.id, username:user.username });
    await writeDB(db);
    res.json({ ok:true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/health', async (req, res) => {
  try {
    const db = normalizeDB(await readDB());
    res.json({ ok: true, mode: getDatabaseMode(), quarters: db.quarters.length, latestQuarter: db.quarters.at(-1)?.id || null });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

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

function manilaDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date).reduce((out, p) => { if (p.type !== 'literal') out[p.type] = p.value; return out; }, {});
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function formatManilaDate(year, month, day) {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Manila', year: 'numeric', month: 'long', day: 'numeric' })
    .format(new Date(Date.UTC(year, month - 1, day, 12)));
}

function currentQuarterForManilaDate(db, date = new Date()) {
  const d = manilaDateParts(date);
  const qNum = Math.ceil(d.month / 3);
  return db.quarters.find(q => Number(q.year) === d.year && Number(q.quarterNum) === qNum) || null;
}

function assignedEntriesForUser(user, quarter) {
  const assigned = Array.isArray(user?.assignedPastors) ? user.assignedPastors : (user?.assignedPastor ? [user.assignedPastor] : []);
  if (!assigned.length || !quarter) return [];
  return (quarter.entries || []).filter(entry => !entry.hidden && assigned.some(p =>
    normalizePastorKey(p.name, p.number) === normalizePastorKey(entry.name, entry.number) ||
    (String(p.name || '').trim().toLowerCase() === String(entry.name || '').trim().toLowerCase() && (!p.number || String(p.number) === String(entry.number)))
  ));
}

function dueSummaryForUser(user, quarter, kind, date = new Date()) {
  const entries = assignedEntriesForUser(user, quarter);
  if (!entries.length) return null;
  const d = manilaDateParts(date);
  const monthIndex = ((d.month - 1) % 3);
  const monthKey = `m${monthIndex + 1}`;
  const monthName = quarter.months?.[monthIndex] || d.month;
  let due = entries;
  if (kind === 'monthly') due = entries.filter(e => { const m = statusMetrics(e[monthKey]); return m.checked < m.total; });
  if (kind === 'quarterly') due = entries.filter(e => !isEntryComplete(e));
  if (!due.length) return null;
  return {
    pastors: due.map(e => e.name),
    month: monthName,
    monthKey,
    quarter: quarter.quarterName ? `${quarter.year} ${quarter.quarterName}` : quarter.id
  };
}

function notificationPeriod(kind, date = new Date()) {
  const d = manilaDateParts(date);
  const qNum = Math.ceil(d.month / 3);
  if (kind === 'monthly') return `${d.year}-${String(d.month).padStart(2, '0')}`;
  return `${d.year}-Q${qNum}`;
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
  if (phone.startsWith('09') && phone.length === 11) phone = '63' + phone.slice(1);
  if (phone.startsWith('63') && phone.length === 12) return phone;
  return '';
}

async function sendReminderEmail({ to, subject, text }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY is not configured.');
  const from = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
  const resend = new Resend(apiKey);
  const html = String(text || '').split(/\n{2,}/).map(block => `<p>${escapeHtmlServer(block).replace(/\n/g, '<br>')}</p>`).join('');
  const result = await resend.emails.send({ from, to: [to], subject, text, html });
  if (result?.error) throw new Error(result.error.message || 'Resend email failed.');
  return result?.data?.id || null;
}

function escapeHtmlServer(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
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
  if (!response.ok || Number(data?.status) !== 200) throw new Error(data?.message || `IPROG SMS request failed (${response.status}).`);
  return data?.message_id || null;
}

async function sendNotificationBatch(db, { kind, recipientMode, userIds = [], channels = {}, manual = true, now = new Date() }) {
  ensureAuthState(db);
  ensureNotificationState(db);
  const settings = db.notificationSettings;
  const typeSettings = settings[kind];
  if (!typeSettings?.enabled && !manual) return { sent: 0, skipped: 0, failed: 0, reason: `${kind} reminders are disabled.` };
  const quarter = currentQuarterForManilaDate(db, now);
  if (!quarter) return { sent: 0, skipped: 0, failed: 0, reason: 'No quarter exists for the current Manila date.' };

  const d = manilaDateParts(now);
  const deadlineMonth = kind === 'quarterly' ? Math.ceil(d.month / 3) * 3 : d.month;
  const deadlineDay = daysInMonth(d.year, deadlineMonth);
  const deadline = formatManilaDate(d.year, deadlineMonth, deadlineDay);
  const period = notificationPeriod(kind, now);
  const allUsers = db.users.filter(u => u.status === 'active');
  let recipients = allUsers;
  if (recipientMode === 'month' || recipientMode === 'quarter') {
    recipients = allUsers.filter(u => u.role === 'supporter' && dueSummaryForUser(u, quarter, kind, now));
  } else if (recipientMode === 'selected') {
    const wanted = new Set((userIds || []).map(String));
    recipients = allUsers.filter(u => wanted.has(String(u.id)));
  }

  const emailEnabled = channels.email !== false && settings.channels.email !== false;
  const smsEnabled = channels.sms !== false && settings.channels.sms !== false;
  const results = { sent: 0, skipped: 0, failed: 0, recipients: recipients.length, details: [] };

  for (const user of recipients) {
    const summary = dueSummaryForUser(user, quarter, kind, now) || {
      pastors: [],
      month: quarter.months?.[((d.month - 1) % 3)] || '',
      monthKey: `m${((d.month - 1) % 3) + 1}`,
      quarter: `${quarter.year} ${quarter.quarterName}`
    };
    const context = {
      name: user.name || user.username,
      month: summary.month,
      quarter: summary.quarter,
      deadline,
      pastors: summary.pastors.join(', '),
      year: String(d.year)
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
      } catch (err) {
        log.error = err.message;
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
  const d = manilaDateParts(date);
  const days = daysInMonth(d.year, d.month);
  const daysBefore = Math.max(0, Number(settings?.daysBefore ?? 5));
  const monthlyDue = d.day === Math.max(1, days - daysBefore);
  const quarterMonth = [3, 6, 9, 12].includes(d.month);
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
    outcomes.push({ kind, result: await sendNotificationBatch(db, { kind, recipientMode: mode, channels: db.notificationSettings.channels, manual: false, now }) });
  }
  return outcomes;
}

// Vercel Cron / external scheduler entry point. Keep the secret server-side.
app.get('/api/notifications/cron', async (req, res) => {
  const expected = process.env.CRON_SECRET;
  const auth = req.headers.authorization || '';
  if (!expected && process.env.NODE_ENV === 'production') return res.status(503).json({ error: 'CRON_SECRET is not configured.' });
  if (expected && auth !== `Bearer ${expected}`) return res.status(401).json({ error: 'Unauthorized cron request.' });
  try {
    const result = await runScheduledNotifications();
    res.json({ ok: true, result });
  } catch (err) {
    console.error('Scheduled notification error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.use('/api', requireAuth);

function ensureAuditTrail(db) {
  if (!Array.isArray(db.auditTrail)) db.auditTrail = [];
  return db.auditTrail;
}

function addAudit(db, req, action, details = {}) {
  const auditTrail = ensureAuditTrail(db);
  auditTrail.unshift({
    id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    actor: req.user?.name || req.user?.username || 'Local User',
    action,
    ...details
  });
  // Keep the log practical while preventing unbounded growth.
  if (auditTrail.length > 2000) auditTrail.length = 2000;
}

function normalizePastorType(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'local') return 'Local';
  if (v === 'foreign') return 'Foreign';
  return 'Unassigned';
}

function pastorIdentityKey(name) {
  return String(name || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function syncPastorTypeAcrossQuarters(db, names, pastorType) {
  const identities = new Set(names.map(pastorIdentityKey).filter(Boolean));
  const updatedQuarters = new Set();
  const now = new Date().toISOString();
  db.quarters.forEach(q => q.entries.forEach(entry => {
    if (identities.has(pastorIdentityKey(entry.name)) && normalizePastorType(entry.pastorType) !== pastorType) {
      entry.pastorType = pastorType;
      entry.updatedAt = now;
      updatedQuarters.add(q.id);
    }
  }));
  return [...updatedQuarters];
}

async function sendPptxDownload(res, pptx, filename) {
  const buffer = await pptx.write({ outputType: 'nodebuffer' });
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) throw new Error('PowerPoint generation returned an invalid file.');
  res.status(200);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', String(buffer.length));
  res.setHeader('Cache-Control', 'private, no-store');
  return res.end(buffer);
}

function normalizeEntry(entry) {
  entry.pastorType = normalizePastorType(entry.pastorType);
  entry.hidden = entry.hidden === true;
  return entry;
}

function normalizeDB(db) {
  if (!Array.isArray(db.quarters)) db.quarters = [];
  db.quarters.forEach(q => {
    if (!Array.isArray(q.entries)) q.entries = [];
    q.entries.forEach(normalizeEntry);
  });
  ensureAuditTrail(db);
  ensureNotificationState(db);
  return db;
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

function entryMetrics(entry) {
  const months = [entry.m1, entry.m2, entry.m3].map(statusMetrics);
  return {
    checked: months.reduce((sum, m) => sum + m.checked, 0),
    total: months.reduce((sum, m) => sum + m.total, 0)
  };
}

function isEntryComplete(entry) {
  const m = entryMetrics(entry);
  return m.total > 0 && m.checked === m.total;
}

function filterQuarterEntries(q, { pastorType = 'All', statusFilter = 'All', currentLatest = false } = {}) {
  let entries = (q.entries || []).map(normalizeEntry).filter(e => !e.hidden);
  if (pastorType && pastorType !== 'All') entries = entries.filter(e => e.pastorType === pastorType);
  if (statusFilter && statusFilter !== 'All' && !currentLatest) {
    entries = entries.filter(e => statusFilter === 'Incomplete Only' ? !isEntryComplete(e) : isEntryComplete(e));
  }
  return entries;
}

// 1. GET all quarters summary
app.get('/api/quarters', async (req, res) => {
  try {
    const db = normalizeDB(await readDB());
    if (['admin', 'staff'].includes(req.user?.role)) {
      const repaired = restoreLatestQuarterSupportSlots(db);
      if (repaired) {
        addAudit(db, req, 'Quarter Support Slots Restored', {
          quarterId: db.quarters.at(-1)?.id,
          description: `Restored blank supporter slot labels for ${repaired} pastor record${repaired === 1 ? '' : 's'}`
        });
        await writeDB(db, { touchLastUpdated: true });
      }
    }
    const summary = db.quarters.map(q => {
      const visibleEntries = q.entries.filter(e => !e.hidden).filter(getSupporterEntryFilter(req.user));
      const total = visibleEntries.length;
      const countM1 = visibleEntries.filter(e => e.m1 && e.m1.includes('✓')).length;
      const countM2 = visibleEntries.filter(e => e.m2 && e.m2.includes('✓')).length;
      const countM3 = visibleEntries.filter(e => e.m3 && e.m3.includes('✓')).length;
      return {
        id: q.id,
        year: q.year,
        quarterNum: q.quarterNum,
        quarterName: q.quarterName,
        title: q.title,
        months: q.months,
        totalPastors: total,
        stats: {
          m1: { count: countM1, percent: total ? Math.round((countM1 / total) * 100) : 0 },
          m2: { count: countM2, percent: total ? Math.round((countM2 / total) * 100) : 0 },
          m3: { count: countM3, percent: total ? Math.round((countM3 / total) * 100) : 0 },
        }
      };
    });
    res.json({
      quarters: summary,
      summaryNotes: db.summaryNotes || [],
      lastUpdated: db.lastUpdated
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. GET specific quarter details
app.get('/api/quarters/:id', async (req, res) => {
  try {
    const db = normalizeDB(await readDB());
    if (['admin', 'staff'].includes(req.user?.role)) {
      const repaired = restoreLatestQuarterSupportSlots(db);
      if (repaired) {
        addAudit(db, req, 'Quarter Support Slots Restored', {
          quarterId: db.quarters.at(-1)?.id,
          description: `Restored blank supporter slot labels for ${repaired} pastor record${repaired === 1 ? '' : 's'}`
        });
        await writeDB(db, { touchLastUpdated: true });
      }
    }
    const q = db.quarters.find(x => x.id === req.params.id);
    if (!q) return res.status(404).json({ error: 'Quarter not found' });
    res.json(filterQuarterForUser(q, req.user));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. POST new quarter
app.post('/api/quarters', requireStaff, async (req, res) => {
  try {
    const { year, quarterNum, copyFromQuarterId } = req.body;
    if (!year || !quarterNum) return res.status(400).json({ error: 'Year and Quarter Number are required' });

    const qNum = parseInt(quarterNum);
    const yr = parseInt(year);
    const qKey = `${yr}-Q${qNum}`;

    const db = normalizeDB(await readDB());
    if (db.quarters.some(q => q.id === qKey)) {
      return res.status(400).json({ error: 'Quarter already exists: ' + qKey });
    }

    const quarterMonthMap = {
      1: ["January", "February", "March"],
      2: ["April", "May", "June"],
      3: ["July", "August", "September"],
      4: ["October", "November", "December"]
    };

    const quarterName = `${qNum === 1 ? '1st' : qNum === 2 ? '2nd' : qNum === 3 ? '3rd' : '4th'} Quarter`;
    const title = `${yr} MISSION SUPPORT ${qNum === 1 ? '1ST' : qNum === 2 ? '2ND' : qNum === 3 ? '3RD' : '4TH'} QUARTER`;

    let entries = [];
    const latestQuarterId = db.quarters.slice().sort((a, b) => String(a.id).localeCompare(String(b.id))).at(-1)?.id;
    const sourceQuarterId = copyFromQuarterId || latestQuarterId;
    if (sourceQuarterId) {
      const sourceQ = db.quarters.find(q => q.id === sourceQuarterId);
      if (sourceQ) {
        entries = sourceQ.entries.filter(e => !e.hidden).map((e, idx) => {
          const slots = getEntrySupportSlots(e);
          return {
            id: `${qKey}-${idx + 1}`,
            number: e.number || (idx + 1),
            name: e.name,
            rawName: e.rawName || `${e.number || (idx + 1)}. ${e.name}`,
            m1: clearSupportSlotChecks(e.m1, slots),
            m2: clearSupportSlotChecks(e.m2, slots),
            m3: clearSupportSlotChecks(e.m3, slots),
            notes: '',
            pastorType: normalizePastorType(e.pastorType),
            hidden: false
          };
        });
      }
    }

    const newQuarter = {
      id: qKey,
      year: yr,
      quarterNum: qNum,
      quarterName,
      months: quarterMonthMap[qNum] || ["Month 1", "Month 2", "Month 3"],
      title,
      entries
    };

    db.quarters.push(newQuarter);
    db.quarters.sort((a, b) => a.id.localeCompare(b.id));
    addAudit(db, req, 'Quarter Created', { quarterId: qKey, description: `${qKey} was created` });
    await writeDB(db, { touchLastUpdated: true });

    res.status(201).json({ ...newQuarter, lastUpdated: db.lastUpdated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. DELETE quarter
app.delete('/api/quarters/:id', requireStaff, async (req, res) => {
  try {
    const db = normalizeDB(await readDB());
    const idx = db.quarters.findIndex(q => q.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Quarter not found' });
    const deleted = db.quarters.splice(idx, 1);
    addAudit(db, req, 'Quarter Deleted', { quarterId: deleted[0].id, description: `${deleted[0].id} was deleted` });
    await writeDB(db, { touchLastUpdated: true });
    res.json({ message: 'Quarter deleted', deleted: deleted[0].id, lastUpdated: db.lastUpdated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. POST new Pastor to quarter
app.post('/api/quarters/:quarterId/entries', requireStaff, async (req, res) => {
  try {
    const { name, number, m1, m2, m3, notes, pastorType, addToAllQuarters } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Pastor name is required' });

    const db = normalizeDB(await readDB());
    const quarter = db.quarters.find(q => q.id === req.params.quarterId);
    if (!quarter) return res.status(404).json({ error: 'Quarter not found' });

    const pastorName = name.trim();
    const maxNumber = quarter.entries.reduce((max, e) => Math.max(max, Number(e.number) || 0), 0);
    const num = number ? parseInt(number) : (maxNumber + 1);

    const now = new Date().toISOString();
    const newEntry = {
      id: `${quarter.id}-${Date.now()}`,
      number: num,
      name: pastorName,
      rawName: `${num}. ${pastorName}`,
      m1: m1 || '',
      m2: m2 || '',
      m3: m3 || '',
      notes: notes || '',
      pastorType: normalizePastorType(pastorType),
      hidden: false,
      updatedAt: now
    };

    quarter.entries.push(newEntry);
    syncPastorTypeAcrossQuarters(db, [pastorName], newEntry.pastorType);
    addAudit(db, req, 'Pastor Added', { quarterId: quarter.id, entryId: newEntry.id, pastorName, description: `${pastorName} was added to ${quarter.id}` });

    // Optional: add to all active quarters
    if (addToAllQuarters) {
      db.quarters.forEach(q => {
        if (q.id !== quarter.id && !q.entries.some(e => !e.hidden && e.name.toLowerCase() === pastorName.toLowerCase())) {
          const nextNum = q.entries.reduce((max, e) => Math.max(max, Number(e.number) || 0), 0) + 1;
          q.entries.push({
            id: `${q.id}-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
            number: nextNum,
            name: pastorName,
            rawName: `${nextNum}. ${pastorName}`,
            m1: '',
            m2: '',
            m3: '',
            notes: '',
            pastorType: normalizePastorType(pastorType),
            hidden: false,
            updatedAt: now
          });
        }
      });
    }

    await writeDB(db, { touchLastUpdated: true });
    res.status(201).json({ entry: newEntry, lastUpdated: db.lastUpdated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. PUT update Pastor entry
app.put('/api/quarters/:quarterId/entries/:entryId', requireStaff, async (req, res) => {
  try {
    const { name, number, m1, m2, m3, notes, pastorType, hidden, included } = req.body;
    const db = normalizeDB(await readDB());
    const quarter = db.quarters.find(q => q.id === req.params.quarterId);
    if (!quarter) return res.status(404).json({ error: 'Quarter not found' });

    const entry = quarter.entries.find(e => e.id === req.params.entryId);
    if (!entry) return res.status(404).json({ error: 'Pastor entry not found' });

    const before = {
      name: entry.name,
      number: entry.number,
      m1: entry.m1 || '', m2: entry.m2 || '', m3: entry.m3 || '',
      notes: entry.notes || '',
      pastorType: normalizePastorType(entry.pastorType),
      hidden: entry.hidden === true
    };

    const candidate = {
      name: name !== undefined ? String(name).trim() : entry.name,
      number: number !== undefined ? parseInt(number) : entry.number,
      m1: m1 !== undefined ? m1 : (entry.m1 || ''),
      m2: m2 !== undefined ? m2 : (entry.m2 || ''),
      m3: m3 !== undefined ? m3 : (entry.m3 || ''),
      notes: notes !== undefined ? String(notes) : (entry.notes || ''),
      pastorType: pastorType !== undefined ? normalizePastorType(pastorType) : normalizePastorType(entry.pastorType),
      hidden: hidden !== undefined ? Boolean(hidden) : (included !== undefined ? !Boolean(included) : entry.hidden === true)
    };
    if (!candidate.name) return res.status(400).json({ error: 'Pastor name is required' });
    if (!Number.isFinite(candidate.number) || candidate.number < 1) return res.status(400).json({ error: 'Pastor number must be a positive number' });

    const changes = [];
    ['name','number','m1','m2','m3','notes','pastorType','hidden'].forEach(key => {
      const after = candidate[key] ?? '';
      if (String(before[key] ?? '') !== String(after)) {
        const monthName = key === 'm1' ? quarter.months?.[0] : key === 'm2' ? quarter.months?.[1] : key === 'm3' ? quarter.months?.[2] : null;
        changes.push({ field: key === 'hidden' ? (after ? 'included' : 'hidden') : (monthName || key), from: before[key] ?? '', to: after });
      }
    });

    if (!changes.length) {
      return res.json({ entry, lastUpdated: db.lastUpdated });
    }

    Object.assign(entry, candidate);
    entry.rawName = `${entry.number}. ${entry.name}`;
    entry.updatedAt = new Date().toISOString();

    let typeUpdatedQuarters = [];
    if (before.pastorType !== candidate.pastorType) {
      typeUpdatedQuarters = [...new Set([quarter.id, ...syncPastorTypeAcrossQuarters(db, [before.name, candidate.name], candidate.pastorType)])];
    }

    const supportChanged = changes.some(c => quarter.months?.includes(c.field));
    addAudit(db, req, supportChanged ? 'Support Updated' : (changes.some(c => ['hidden','included'].includes(c.field)) ? (entry.hidden ? 'Pastor Hidden' : 'Pastor Restored') : 'Pastor Edited'), {
      quarterId: quarter.id,
      entryId: entry.id,
      pastorName: entry.name,
      changes,
      description: changes.some(change => change.field === 'pastorType')
        ? `${entry.name}'s pastor type was updated across ${Math.max(1, typeUpdatedQuarters.length)} quarter${typeUpdatedQuarters.length === 1 ? '' : 's'}`
        : `${entry.name} was updated in ${quarter.id}`
    });

    await writeDB(db, { touchLastUpdated: true });
    res.json({ entry, lastUpdated: db.lastUpdated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Legacy delete route intentionally disabled. Pastors are now hidden/restored and never permanently deleted.
app.delete('/api/quarters/:quarterId/entries/:entryId', requireStaff, async (req, res) => {
  return res.status(410).json({ error: 'Pastor deletion has been replaced by Include/Exclude (Hide/Restore).' });
});

// 7. DELETE Pastor entry
// 8. POST bulk update support status
app.post('/api/quarters/:quarterId/bulk', requireStaff, async (req, res) => {
  try {
    const { monthKey, action } = req.body;
    const db = normalizeDB(await readDB());
    const quarter = db.quarters.find(q => q.id === req.params.quarterId);
    if (!quarter) return res.status(404).json({ error: 'Quarter not found' });
    const val = action === 'check' ? '✓' : '';
    const now = new Date().toISOString();
    let changedCount = 0;
    quarter.entries.filter(e => !e.hidden).forEach(e => {
      const keys = monthKey === 'all' ? ['m1','m2','m3'] : (['m1','m2','m3'].includes(monthKey) ? [monthKey] : []);
      let changed = false;
      keys.forEach(key => { if (String(e[key] || '') !== val) { e[key] = val; changed = true; } });
      if (changed) { e.updatedAt = now; changedCount++; }
    });
    if (changedCount) {
      addAudit(db, req, 'Bulk Support Updated', { quarterId: quarter.id, monthKey, action, changedCount, description: `${action === 'check' ? 'Marked' : 'Cleared'} ${monthKey} for ${changedCount} pastor record(s) in ${quarter.id}` });
      await writeDB(db, { touchLastUpdated: true });
    }
    res.json({ message: 'Bulk update applied', quarter, changedCount, lastUpdated: db.lastUpdated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 8b. POST batch save entries updates
app.post('/api/quarters/:quarterId/batch-save', requireStaff, async (req, res) => {
  try {
    const { updates } = req.body; // updates: [{ id, m1, m2, m3, notes }]
    if (!Array.isArray(updates)) return res.status(400).json({ error: 'Updates array is required' });

    const db = normalizeDB(await readDB());
    const quarter = db.quarters.find(q => q.id === req.params.quarterId);
    if (!quarter) return res.status(404).json({ error: 'Quarter not found' });

    const now = new Date().toISOString();
    const auditChanges = [];
    let updatedCount = 0;
    updates.forEach(u => {
      const entry = quarter.entries.find(e => e.id === u.id && !e.hidden);
      if (!entry) return;
      const before = { m1: entry.m1 || '', m2: entry.m2 || '', m3: entry.m3 || '', notes: entry.notes || '' };
      if (u.m1 !== undefined) entry.m1 = u.m1;
      if (u.m2 !== undefined) entry.m2 = u.m2;
      if (u.m3 !== undefined) entry.m3 = u.m3;
      if (u.notes !== undefined) entry.notes = u.notes;

      let changed = false;
      ['m1','m2','m3','notes'].forEach(key => {
        const after = entry[key] ?? '';
        if (String(before[key]) !== String(after)) {
          changed = true;
          const monthName = key === 'm1' ? quarter.months?.[0] : key === 'm2' ? quarter.months?.[1] : key === 'm3' ? quarter.months?.[2] : 'Notes';
          auditChanges.push({ pastorName: entry.name, field: monthName, from: before[key], to: after });
        }
      });
      if (changed) { entry.updatedAt = now; updatedCount++; }
    });

    if (auditChanges.length) {
      addAudit(db, req, 'Batch Support Updated', {
        quarterId: quarter.id,
        updatedCount,
        changes: auditChanges.map(c => ({ field: `${c.pastorName} — ${c.field}`, from: c.from, to: c.to })),
        description: `${auditChanges.length} status change(s) saved across ${updatedCount} pastor record(s) in ${quarter.id}`
      });
    }
    if (auditChanges.length) await writeDB(db, { touchLastUpdated: true });
    res.json({ message: 'Batch updates saved successfully', updatedCount, quarter, lastUpdated: db.lastUpdated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Hidden pastors: excluded records remain in the database and can be restored.
app.get('/api/hidden-pastors', requireStaff, async (req, res) => {
  try {
    const db = normalizeDB(await readDB());
    const hidden = [];
    db.quarters.forEach(q => (q.entries || []).filter(e => e.hidden).forEach(entry => {
      hidden.push({
        ...entry,
        quarterId: q.id,
        quarterTitle: q.title,
        year: q.year,
        quarterName: q.quarterName
      });
    }));
    hidden.sort((a, b) => `${b.year}-${b.quarterId}`.localeCompare(`${a.year}-${a.quarterId}`) || (Number(a.number) - Number(b.number)));
    res.json({ hidden });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/quarters/:id/hidden', requireStaff, async (req, res) => {
  try {
    const db = normalizeDB(await readDB());
    const q = db.quarters.find(x => x.id === req.params.id);
    if (!q) return res.status(404).json({ error: 'Quarter not found' });
    res.json({ quarter: { ...q, entries: (q.entries || []).filter(e => e.hidden) } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Reminder / notification center
app.get('/api/notifications/state', requireStaff, async (req, res) => {
  try {
    const db = normalizeDB(await readDB());
    ensureAuthState(db); ensureNotificationState(db);
    const safeLog = db.notificationLog.slice(0, 100).map(item => ({
      id: item.id, kind: item.kind, period: item.period, userId: item.userId,
      userName: item.userName, channel: item.channel, sentAt: item.sentAt,
      status: item.status, error: item.error || null
    }));
    res.json({ settings: db.notificationSettings, log: safeLog });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/notifications/settings', requireAuth, requireAdmin, async (req, res) => {
  try {
    const db = normalizeDB(await readDB());
    ensureNotificationState(db);
    const incoming = req.body || {};
    const current = db.notificationSettings;
    for (const kind of ['monthly', 'quarterly']) {
      if (incoming[kind]) {
        current[kind].enabled = Boolean(incoming[kind].enabled);
        current[kind].daysBefore = Math.min(30, Math.max(0, Number(incoming[kind].daysBefore ?? current[kind].daysBefore)));
        current[kind].subject = String(incoming[kind].subject ?? current[kind].subject).slice(0, 200);
        current[kind].emailMessage = String(incoming[kind].emailMessage ?? current[kind].emailMessage).slice(0, 10000);
        current[kind].smsMessage = String(incoming[kind].smsMessage ?? current[kind].smsMessage).slice(0, 900);
      }
    }
    if (incoming.channels) {
      current.channels.email = Boolean(incoming.channels.email);
      current.channels.sms = Boolean(incoming.channels.sms);
    }
    await writeDB(db);
    res.json({ settings: db.notificationSettings });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/notifications/recipients', requireStaff, async (req, res) => {
  try {
    const db = normalizeDB(await readDB());
    ensureAuthState(db); ensureNotificationState(db);
    const kind = req.query.kind === 'quarterly' ? 'quarterly' : 'monthly';
    const quarter = currentQuarterForManilaDate(db);
    const users = db.users.filter(u => u.status === 'active').map(u => {
      const summary = dueSummaryForUser(u, quarter, kind);
      return {
        id: u.id, name: u.name || u.username, username: u.username,
        role: u.role, email: u.email || '', phone: u.phone || '',
        hasEmail: Boolean(u.email), hasSms: Boolean(normalizePHPhone(u.phone)),
        due: Boolean(summary), pastors: summary?.pastors || []
      };
    });
    res.json({ kind, quarter: quarter ? { id: quarter.id, title: quarter.title, months: quarter.months } : null, users });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/notifications/send', requireStaff, async (req, res) => {
  try {
    const kind = req.body?.kind === 'quarterly' ? 'quarterly' : 'monthly';
    const recipientMode = ['month','quarter','selected'].includes(req.body?.recipientMode) ? req.body.recipientMode : 'selected';
    const userIds = Array.isArray(req.body?.userIds) ? req.body.userIds : [];
    const channels = {
      email: req.body?.channels?.email !== false,
      sms: req.body?.channels?.sms !== false
    };
    if (recipientMode === 'selected' && !userIds.length) return res.status(400).json({ error: 'Select at least one recipient.' });
    const db = normalizeDB(await readDB());
    const result = await sendNotificationBatch(db, { kind, recipientMode, userIds, channels, manual: true });
    res.json(result);
  } catch (err) {
    console.error('Manual notification error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 10. GET audit trail
app.get('/api/audit-trail', requireStaff, async (req, res) => {
  try {
    const db = normalizeDB(await readDB());
    res.json({ auditTrail: db.auditTrail || [], lastUpdated: db.lastUpdated || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 9. Reset DB to original backup
app.post('/api/reset', requireAdmin, async (req, res) => {
  try {
    const db = normalizeDB(await resetDB());
    addAudit(db, req, 'Database Reset', { description: 'Database was reset to the original PowerPoint reference data' });
    await writeDB(db, { touchLastUpdated: true });
    res.json({ message: 'Database reset to original PowerPoint reference successfully', quartersCount: db.quarters.length, lastUpdated: db.lastUpdated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 10. Health/status endpoint


// 11. PPTX Generator Function
function compactPptStatus(value) {
  if (!value) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

function pptStatusDisplay(value) {
  const text = compactPptStatus(value);
  if (!text) return '';
  const matches = [...text.matchAll(/([A-E])\.\s*(✓)?/gi)];
  if (matches.length >= 2) {
    return matches.map(m => `${m[1].toUpperCase()}. ${m[2] ? '✓' : ''}`.trimEnd()).join('    ');
  }
  return text;
}

function pptStatusFontSize(value) {
  const text = pptStatusDisplay(value);
  if (!text) return 20;
  if (text === '✓') return 32;
  const letters = (text.match(/[A-E]\./g) || []).length;
  if (letters >= 5) return 10;
  if (letters === 4) return 11;
  if (letters === 3) return 13;
  if (letters === 2) return 15;
  if (text.length <= 10) return 18;
  if (text.length <= 18) return 15;
  return 11;
}

function filtersForQuarter(q, filters = {}) {
  const latestId = filters.latestQuarterId || null;
  return {
    pastorType: filters.pastorType || 'All',
    statusFilter: filters.statusFilter || 'All',
    currentLatest: Boolean(latestId && q.id === latestId)
  };
}

async function buildPptx(quarterList, filters = {}) {
  const pptx = new pptxgen();
  // Explicit 16:9 PowerPoint canvas: 13.333 x 7.5 inches.
  pptx.defineLayout({ name: 'MISSION_16X9', width: 13.333, height: 7.5 });
  pptx.layout = 'MISSION_16X9';
  const SW = 13.333;
  const SH = 7.5;
  const centerX = (w) => (SW - w) / 2;
  pptx.author = 'Mission Support Tracker';
  pptx.subject = 'Mission Support Records';
  pptx.title = 'Mission Support';
  pptx.company = 'Living Hope Baptist Church';
  pptx.lang = 'en-US';

  const logoPath = path.join(__dirname, 'public', 'images', 'logo.png');
  const MARGIN = 0.85;
  const CONTENT_W = SW - (MARGIN * 2);

  quarterList.forEach(q => {
    const coverSlide = pptx.addSlide();
    coverSlide.background = { color: '2D1B4E' };

    if (fs.existsSync(logoPath)) {
      coverSlide.addImage({ path: logoPath, x: centerX(1.98), y: 0.58, w: 1.98, h: 1.98 });
    }
    coverSlide.addText('LIVING HOPE BAPTIST CHURCH', {
      x: 0, y: 2.72, w: SW, h: 0.42,
      fontSize: 18, bold: true, color: 'DDD6FE', align: 'center', valign: 'mid',
      fit: 'shrink'
    });
    coverSlide.addText('Managok, Malaybalay City', {
      x: 0, y: 3.12, w: SW, h: 0.32,
      fontSize: 13, color: 'A78BFA', align: 'center', valign: 'mid'
    });
    coverSlide.addText(q.title || `${q.year} MISSION SUPPORT ${q.quarterName.toUpperCase()}`, {
      x: 0, y: 4.05, w: SW, h: 0.85,
      fontSize: 31, bold: true, color: 'FFFFFF', align: 'center', valign: 'mid',
      breakLine: false, fit: 'shrink', margin: 0.02
    });

    const entries = filterQuarterEntries(q, filtersForQuarter(q, filters));
    const months = q.months || ['Month 1', 'Month 2', 'Month 3'];
    const chunkSize = 3;

    for (let i = 0; i < entries.length; i += chunkSize) {
      const chunk = entries.slice(i, i + chunkSize);
      const slide = pptx.addSlide();
      slide.background = { color: '26143F' };

      slide.addText(q.title || `${q.year} MISSION SUPPORT ${q.quarterName.toUpperCase()}`, {
        x: 0.60, y: 0.35, w: 12.133, h: 0.72,
        fontSize: 29, bold: true, color: 'FFFFFF', align: 'center', valign: 'mid',
        fit: 'shrink', margin: 0.02
      });

      const tableData = [[
        { text: 'PASTOR/ MISSIONARY', options: { bold: true, fill: { color: '4C1D95' }, color: 'FFFFFF', align: 'center', valign: 'middle', fontSize: 17, fit: 'shrink' } },
        ...months.slice(0, 3).map((m, idx) => ({ text: (m || `MONTH ${idx + 1}`).toUpperCase(), options: { bold: true, fill: { color: '4C1D95' }, color: 'FFFFFF', align: 'center', valign: 'middle', fontSize: 17, fit: 'shrink' } }))
      ]];
      while (tableData[0].length < 4) tableData[0].push({ text: `MONTH ${tableData[0].length}`, options: { bold: true, fill: { color: '4C1D95' }, color: 'FFFFFF', align: 'center', valign: 'middle', fontSize: 17 } });

      chunk.forEach(p => {
        const rowBg = '26143F';
        const nameLabel = `${p.number ? p.number + '. ' : ''}${p.name}`;
        const vals = [p.m1, p.m2, p.m3];
        tableData.push([
          { text: nameLabel, options: { fontSize: 36, color: 'FFFFFF', fill: { color: rowBg }, bold: true, align: 'left', valign: 'middle', fit: 'shrink', margin: 0.08 } },
          ...vals.map(v => {
            const text = pptStatusDisplay(v);
            return { text, options: { fontSize: pptStatusFontSize(v), color: text ? '34D399' : 'FFFFFF', align: 'center', valign: 'middle', fill: { color: rowBg }, bold: true, fit: 'shrink', margin: 0.03 } };
          })
        ]);
      });
      while (tableData.length < 4) {
        tableData.push([
          { text: '', options: { fill: { color: '26143F' } } },
          { text: '', options: { fill: { color: '26143F' } } },
          { text: '', options: { fill: { color: '26143F' } } },
          { text: '', options: { fill: { color: '26143F' } } }
        ]);
      }

      slide.addTable(tableData, {
        x: centerX(12.133), y: 1.72, w: 12.133,
        colW: [5.02, 2.371, 2.371, 2.371],
        rowH: [0.78, 1.42, 1.42, 1.42],
        border: { pt: 1.5, color: '7C3AED' },
        margin: 0.04,
        autoFit: false
      });
    }
  });
  return pptx;
}

// 11. Download PPTX endpoint for single quarter
app.get('/api/export/pptx/:quarterId', async (req, res) => {
  try {
    const db = normalizeDB(await readDB());
    const q = filterQuarterForUser(db.quarters.find(x => x.id === req.params.quarterId), req.user);
    if (!q) return res.status(404).json({ error: 'Quarter not found' });

    const latestId = db.quarters.length ? db.quarters[db.quarters.length - 1].id : null;
    const pptx = await buildPptx([q], { pastorType: req.query.pastorType || 'All', statusFilter: req.query.statusFilter || 'All', latestQuarterId: latestId });
    const filename = `Mission_Support_${q.id}.pptx`;
    await sendPptxDownload(res, pptx, filename);
  } catch (err) {
    console.error('Export error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 12. Download a filtered multi-quarter mission report
app.get('/api/export/pptx-report', async (req, res) => {
  try {
    const db = normalizeDB(await readDB());
    const ids = String(req.query.quarterIds || '').split(',').map(s => s.trim()).filter(Boolean);
    const quarterList = ids.length ? db.quarters.filter(q => ids.includes(q.id)) : db.quarters;
    if (!quarterList.length) return res.status(400).json({ error: 'No quarters selected for the report' });
    const pastorType = req.query.pastorType || 'All';
    const statusFilter = req.query.statusFilter || 'All';
    const latestId = db.quarters.length ? db.quarters[db.quarters.length - 1].id : null;
    const pptx = await buildPptx(quarterList, { pastorType, statusFilter, latestQuarterId: latestId });
    const label = ids.length === 1 ? ids[0] : `${quarterList[0].year}-${quarterList[quarterList.length - 1].year}`;
    const filename = `Mission_Support_Report_${label}.pptx`;
    await sendPptxDownload(res, pptx, filename);
  } catch (err) {
    console.error('Report export error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 13. Download PPTX endpoint for all quarters
app.get('/api/export/pptx-all', async (req, res) => {
  try {
    const db = normalizeDB(await readDB());
    const latestId = db.quarters.length ? db.quarters[db.quarters.length - 1].id : null;
    const visibleQuarters = req.user?.role === 'supporter' ? db.quarters.map(q => filterQuarterForUser(q, req.user)) : db.quarters;
    const pptx = await buildPptx(visibleQuarters, { pastorType: req.query.pastorType || 'All', statusFilter: req.query.statusFilter || 'All', latestQuarterId: latestId });
    const filename = 'Mission_Support_All_Quarters.pptx';
    await sendPptxDownload(res, pptx, filename);
  } catch (err) {
    console.error('Export error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 13. Download JSON backup
app.get('/api/backup', requireAdmin, async (req, res) => {
  try {
    const db = normalizeDB(await readDB());
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="mission_support_backup.json"');
    res.send(JSON.stringify(db, null, 2));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Mission Support Web App running at http://localhost:${PORT}`);
  });
}

module.exports = app;
