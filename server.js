const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { createPptxService } = require('./server/reports/pptx');
const { createReportRouter } = require('./server/routes/reports');
const { createNotificationService, ensureNotificationState } = require('./server/notifications/service');
const { createNotificationRouter } = require('./server/routes/notifications');

const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// API responses are user/session-specific. Prevent Vercel/CDN caching from
// replaying an unauthenticated response across requests.
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, private, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Vary', 'Cookie, Authorization');
  next();
});

function sendInternalError(res, error, context = 'Internal API error') {
  console.error(context, error);
  return res.status(500).json({ error: 'An internal error occurred.' });
}

// Explicitly serve the main app page. Vercel's current Express support
// routes the project to this Express server automatically, so no
// vercel.json routing rules are required.
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const { readDB, writeDB, resetDB } = require('./db');

const notificationService = createNotificationService({
  normalizeDB,
  readDB,
  writeDB,
  ensureAuthState,
  normalizePastorKey,
  getEnabledEntrySupportSlots,
  statusMetrics,
  isEntryComplete
});
const notificationRouters = createNotificationRouter({
  service: notificationService,
  readDB,
  writeDB,
  normalizeDB,
  ensureAuthState,
  requireAuth,
  requireStaff,
  requireAdmin,
  sendInternalError
});


// --------------------------------------------------------------------------
// Authentication
// --------------------------------------------------------------------------
const SESSION_COOKIE = 'mission_support_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
const DEFAULT_ADMIN_USERNAME = 'jarred';
// Detect the original fixed bootstrap hash so deployments can rotate it using
// INITIAL_ADMIN_PASSWORD without forcing an unconfigured database offline.
const LEGACY_BOOTSTRAP_SALT = 'cbc870a4360a4dd4be1db150150baf16';
const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_FAILURE_LIMIT = 8;
const loginFailures = new Map();

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
    let value = part.slice(i + 1).trim();
    try { value = decodeURIComponent(value); } catch { /* Ignore malformed cookie encoding. */ }
    if (key) out[key] = value;
    return out;
  }, {});
}

function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure ? '; Secure' : ''}`);
}

function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === 'production';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`);
}

async function ensureDefaultAdmin() {
  const db = ensureAuthState(await readDB());
  const existing = db.users.find(u => String(u.username || '').toLowerCase() === DEFAULT_ADMIN_USERNAME);
  // Never create an account with a password baked into source control. On an
  // empty database, provision the owner account only when an operator has set
  // an out-of-band bootstrap password in the deployment environment.
  const initialPassword = process.env.INITIAL_ADMIN_PASSWORD;
  if (existing) {
    if (existing.passwordSalt === LEGACY_BOOTSTRAP_SALT && initialPassword) {
      if (initialPassword.length < 12) throw new Error('INITIAL_ADMIN_PASSWORD must be at least 12 characters.');
      const credentials = hashPassword(initialPassword);
      existing.passwordSalt = credentials.salt;
      existing.passwordHash = credentials.hash;
      db.sessions = db.sessions.filter(session => session.userId !== existing.id);
      await writeDB(db);
    }
    return db;
  }
  if (!initialPassword) return db;
  if (initialPassword.length < 12) throw new Error('INITIAL_ADMIN_PASSWORD must be at least 12 characters.');
  const credentials = hashPassword(initialPassword);
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

function originIsAllowed(req) {
  const origin = req.get('origin');
  if (origin) {
    try {
      if (new URL(origin).host.toLowerCase() !== String(req.get('host') || '').toLowerCase()) return false;
    } catch {
      return false;
    }
  }
  return req.get('sec-fetch-site') !== 'cross-site';
}

function loginKey(username) {
  return crypto.createHash('sha256').update(String(username || '').trim().toLowerCase()).digest('hex');
}

function loginIsBlocked(key, now = Date.now()) {
  const state = loginFailures.get(key);
  if (!state) return false;
  if (now - state.startedAt >= LOGIN_FAILURE_WINDOW_MS) {
    loginFailures.delete(key);
    return false;
  }
  return state.count >= LOGIN_FAILURE_LIMIT;
}

function recordLoginFailure(key, now = Date.now()) {
  let state = loginFailures.get(key);
  if (!state || now - state.startedAt >= LOGIN_FAILURE_WINDOW_MS) state = { startedAt: now, count: 0 };
  state.count++;
  loginFailures.set(key, state);
  if (loginFailures.size > 5000) {
    const oldestKey = loginFailures.keys().next().value;
    if (oldestKey) loginFailures.delete(oldestKey);
  }
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
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !originIsAllowed(req)) {
      return res.status(403).json({ error: 'Cross-site request blocked.' });
    }
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
  return entry => assignments.some(assigned => {
    if (!assignmentMatchesEntry(assigned, entry)) return false;
    if (!assigned.slot) return true;
    return getEnabledEntrySupportSlots(entry).includes(String(assigned.slot).trim().toUpperCase());
  });
}

function supportSlotLabel(position) {
  let value = Math.max(1, Number(position) || 1);
  let label = '';
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
}

function supportSlotPosition(label) {
  let value = 0;
  for (const char of String(label || '').toUpperCase()) value = value * 26 + char.charCodeAt(0) - 64;
  return value;
}

function parseSupportSlotStatuses(value) {
  const text = String(value || '');
  const matches = [...text.matchAll(/\b([A-Z]+)\s*\./gi)];
  return matches.map((match, index) => {
    const start = match.index + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index : text.length;
    return { label: match[1].toUpperCase(), checked: /✓/.test(text.slice(start, end)) };
  });
}

function normalizeSlotLabels(labels) {
  return [...new Set((Array.isArray(labels) ? labels : [])
    .map(label => String(label || '').trim().toUpperCase())
    .filter(label => /^[A-Z]{1,6}$/.test(label)))].sort((a, b) => supportSlotPosition(a) - supportSlotPosition(b));
}

function getEntrySupportSlots(entry) {
  const slots = new Set();
  ['m1','m2','m3'].forEach(key => {
    parseSupportSlotStatuses(entry?.[key]).forEach(item => slots.add(item.label));
  });
  normalizeSlotLabels(entry?.disabledSupportSlots).forEach(label => slots.add(label));
  return [...slots].sort((a, b) => supportSlotPosition(a) - supportSlotPosition(b));
}

function getEnabledEntrySupportSlots(entry) {
  const disabled = new Set(normalizeSlotLabels(entry?.disabledSupportSlots));
  return getEntrySupportSlots(entry).filter(label => !disabled.has(label));
}

function statusWithSupportSlots(value, slots) {
  const labels = normalizeSlotLabels(slots);
  if (!labels.length) return String(value || '');
  const parsed = parseSupportSlotStatuses(value);
  const known = new Map(parsed.map(item => [item.label, item.checked]));
  const legacyChecked = parsed.length === 0 && String(value || '').includes('✓');
  return labels.map((label, index) => `${label}. ${known.get(label) === true || (parsed.length === 0 && index === 0 && legacyChecked) ? '✓' : ''}`.trimEnd()).join(' ');
}

function setEnabledSupportStatuses(value, entry, checked) {
  const parsed = parseSupportSlotStatuses(value);
  if (!parsed.length) return checked ? '✓' : '';
  const disabled = new Set(normalizeSlotLabels(entry?.disabledSupportSlots));
  return parsed.map(slot => `${slot.label}. ${disabled.has(slot.label) ? (slot.checked ? '✓' : '') : (checked ? '✓' : '')}`.trimEnd()).join(' ');
}

function preserveDisabledSupportMarks(value, currentValue, entry) {
  const current = parseSupportSlotStatuses(currentValue);
  const incoming = parseSupportSlotStatuses(value);
  const disabled = new Set(normalizeSlotLabels(entry?.disabledSupportSlots));
  if (!current.length || !disabled.size) return value;
  const nextByLabel = new Map(incoming.map(item => [item.label, item.checked]));
  return current.map(item => {
    const checked = disabled.has(item.label) ? item.checked : (nextByLabel.has(item.label) ? nextByLabel.get(item.label) : item.checked);
    return `${item.label}. ${checked ? '✓' : ''}`.trimEnd();
  }).join(' ');
}

function globalPastorSlots(db, names) {
  const identities = new Set(names.map(pastorIdentityKey).filter(Boolean));
  const slots = new Set();
  (db.quarters || []).forEach(quarter => (quarter.entries || []).forEach(entry => {
    if (!identities.has(pastorIdentityKey(entry.name))) return;
    getEntrySupportSlots(entry).forEach(label => slots.add(label));
  }));
  return [...slots].sort((a, b) => supportSlotPosition(a) - supportSlotPosition(b));
}

function globalDisabledPastorSlots(db, names) {
  const identities = new Set(names.map(pastorIdentityKey).filter(Boolean));
  const slots = new Set();
  (db.quarters || []).forEach(quarter => (quarter.entries || []).forEach(entry => {
    if (!identities.has(pastorIdentityKey(entry.name))) return;
    normalizeSlotLabels(entry.disabledSupportSlots).forEach(label => slots.add(label));
  }));
  return [...slots].sort((a, b) => supportSlotPosition(a) - supportSlotPosition(b));
}

function decorateEntrySupportSlots(db, entry) {
  const names = [entry.name];
  const labels = globalPastorSlots(db, names);
  const disabledSupportSlots = globalDisabledPastorSlots(db, names);
  return {
    ...entry,
    supportSlots: labels,
    disabledSupportSlots
  };
}

function validateSupportSlotConfig(input, knownSlots) {
  if (!Array.isArray(input) || input.length > 5000) return { error: 'Supporter slot configuration is invalid.' };
  const slots = [];
  const seen = new Set();
  for (const item of input) {
    const label = String(item?.label || '').trim().toUpperCase();
    if (!/^[A-Z]{1,6}$/.test(label) || seen.has(label) || typeof item?.enabled !== 'boolean') {
      return { error: 'Each supporter slot needs a unique letter label and enabled state.' };
    }
    seen.add(label);
    slots.push({ label, enabled: item.enabled });
  }
  slots.sort((a, b) => supportSlotPosition(a.label) - supportSlotPosition(b.label));
  const requestedLabels = slots.map(slot => slot.label);
  if (knownSlots.some(label => !seen.has(label))) return { error: 'Existing supporter slots cannot be removed; disable them to preserve their history.' };
  const knownPositions = knownSlots.map(supportSlotPosition);
  const maxPosition = Math.max(0, ...knownPositions);
  const additions = requestedLabels.filter(label => !knownSlots.includes(label));
  for (let index = 0; index < additions.length; index += 1) {
    if (supportSlotPosition(additions[index]) !== maxPosition + index + 1) {
      return { error: 'New supporter slots must continue the existing sequence.' };
    }
  }
  return { slots };
}

function clearSupportSlotChecks(value, fallbackSlots = []) {
  const slots = normalizeSlotLabels([...parseSupportSlotStatuses(value).map(item => item.label), ...fallbackSlots]);
  return slots.length ? slots.map(slot => `${slot}.`).join(' ') : '';
}

// Keep supporter-slot structure consistent across every existing year and
// quarter. Each quarter retains its own checked marks; newly restored labels
// begin unchecked where that quarter had no corresponding slot history.
function reconcilePastorSupportSlotsAcrossQuarters(db) {
  const namesByIdentity = new Map();
  (db.quarters || []).forEach(quarter => (quarter.entries || []).forEach(entry => {
    const identity = pastorIdentityKey(entry.name);
    if (identity && !namesByIdentity.has(identity)) namesByIdentity.set(identity, entry.name);
  }));

  const quarterIds = new Set();
  let updatedEntries = 0;
  for (const name of namesByIdentity.values()) {
    const labels = globalPastorSlots(db, [name]);
    if (!labels.length) continue;
    const disabled = new Set(globalDisabledPastorSlots(db, [name]));
    const config = labels.map(label => ({ label, enabled: !disabled.has(label) }));
    const result = syncPastorSupportSlotsAcrossQuarters(db, [name], config);
    updatedEntries += result.updatedEntries;
    result.quarterIds.forEach(id => quarterIds.add(id));
  }
  return { quarterIds: [...quarterIds], updatedEntries };
}

function filterQuarterForUser(q, user, db = null) {
  if (!q) return q;
  const activeEntries = (q.entries || []).filter(e => !e.hidden).map(entry => db ? decorateEntrySupportSlots(db, entry) : entry);
  if (user?.role !== 'supporter') return { ...q, entries: activeEntries };
  const assignments = getSupporterAssignments(user);
  return {
    ...q,
    entries: activeEntries.filter(getSupporterEntryFilter(user)).map(entry => ({
      ...entry,
      supporterAssignedSlots: [...new Set(assignments.filter(assigned => assignmentMatchesEntry(assigned, entry))
        .map(assigned => String(assigned.slot || '').trim().toUpperCase()).filter(slot => slot && getEnabledEntrySupportSlots(entry).includes(slot)))]
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
    if (username.length > 128 || password.length > 1024) {
      return res.status(400).json({ error: 'Username or password is too long.' });
    }
    const key = loginKey(username);
    if (loginIsBlocked(key)) {
      res.setHeader('Retry-After', String(Math.ceil(LOGIN_FAILURE_WINDOW_MS / 1000)));
      return res.status(429).json({ error: 'Too many unsuccessful sign-in attempts. Please try again in 15 minutes.' });
    }
    const user = db.users.find(u => String(u.username || '').toLowerCase() === username.toLowerCase());

    if (!user || user.status !== 'active' || !verifyPassword(password, user)) {
      recordLoginFailure(key);
      return res.status(401).json({ error: 'Invalid username or password.' });
    }
    loginFailures.delete(key);

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
    if (!originIsAllowed(req)) return res.status(403).json({ error: 'Cross-site request blocked.' });
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
    if (name.length > 120 || username.length > 64 || email.length > 254 || phone.length > 32 || password.length > 1024) {
      return res.status(400).json({ error: 'One or more account fields are too long.' });
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
  } catch (err) { sendInternalError(res, err); }
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
    if (name.length > 120 || username.length > 64 || email.length > 254 || phone.length > 32 || password.length > 1024) return res.status(400).json({ error:'One or more account fields are too long.' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    if (db.users.some(u => String(u.username || '').toLowerCase() === username.toLowerCase())) return res.status(409).json({ error: 'Username is already registered.' });
    if (email && db.users.some(u => String(u.email || '').toLowerCase() === email)) return res.status(409).json({ error: 'Email is already registered.' });
    const credentials = hashPassword(password);
    const user = { id:`user-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`, username, name, role, status: role === 'staff' ? 'active' : 'pending_assignment', email, phone, assignedPastor: null, passwordSalt: credentials.salt, passwordHash: credentials.hash, createdAt:new Date().toISOString() };
    db.users.push(user);
    addAudit(db, req, 'USER_CREATED', { userId:user.id, username:user.username, role:user.role });
    await writeDB(db);
    res.status(201).json({ user:sanitizeUser(user) });
  } catch (err) { sendInternalError(res, err); }
});

app.put('/api/auth/users/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const db = ensureAuthState(await readDB());
    const user = db.users.find(u => u.id === req.params.id);
    if (!user) return res.status(404).json({ error:'User not found.' });
    if (user.role === 'admin' && req.user.id !== user.id) return res.status(403).json({ error:'Admin account cannot be edited by another user here.' });
    if (req.body?.name !== undefined && String(req.body.name).length > 120) return res.status(400).json({ error:'Name is too long.' });
    if (req.body?.email !== undefined && String(req.body.email).length > 254) return res.status(400).json({ error:'Email is too long.' });
    if (req.body?.phone !== undefined && String(req.body.phone).length > 32) return res.status(400).json({ error:'Phone is too long.' });
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
    let passwordChanged = false;
    if (req.body?.password) {
      if (String(req.body.password).length > 1024) return res.status(400).json({ error:'Password is too long.' });
      if (String(req.body.password).length < 8) return res.status(400).json({ error:'Password must be at least 8 characters.' });
      const credentials = hashPassword(req.body.password); user.passwordSalt=credentials.salt; user.passwordHash=credentials.hash;
      passwordChanged = true;
    }
    if (passwordChanged) db.sessions = db.sessions.filter(session => session.userId !== user.id);
    addAudit(db, req, req.body?.status ? 'USER_STATUS_CHANGED' : 'USER_UPDATED', { userId:user.id, username:user.username, status:user.status });
    await writeDB(db);
    res.json({ user:sanitizeUser(user) });
  } catch (err) { sendInternalError(res, err); }
});

app.post('/api/auth/users/:id/assign', requireAuth, requireStaff, async (req, res) => {
  try {
    const db = normalizeDB(ensureAuthState(await readDB()));
    const user = db.users.find(u => u.id === req.params.id && u.role === 'supporter');
    if (!user) return res.status(404).json({ error:'Supporter not found.' });
    const existingAssignments = Array.isArray(user.assignedPastors) ? user.assignedPastors : (user.assignedPastor ? [user.assignedPastor] : []);

    let pastors = Array.isArray(req.body?.pastors) ? req.body.pastors : [];
    if (!pastors.length && req.body?.name) pastors = [{ name:req.body.name, number:req.body.number, slot:req.body.slot }];
    pastors = pastors.map(p => ({
      name:String(p?.name || '').trim(),
      number:String(p?.number ?? '').trim(),
      slot:String(p?.slot || '').trim().toUpperCase()
    }))
      .filter(p => p.name)
      .filter((p, i, arr) => arr.findIndex(x => `${normalizePastorKey(x.name, x.number)}::${x.slot}` === `${normalizePastorKey(p.name, p.number)}::${p.slot}`) === i);

    const retainedDisabledAssignments = existingAssignments
      .filter(assigned => assigned?.slot && !isSupportSlotEnabledForPastor(db, assigned.name, assigned.number, assigned.slot))
      .map(assigned => ({ name: String(assigned.name || '').trim(), number: String(assigned.number ?? '').trim(), slot: String(assigned.slot || '').trim().toUpperCase() }));
    pastors = [...pastors, ...retainedDisabledAssignments]
      .filter((pastor, index, all) => all.findIndex(item => `${normalizePastorKey(item.name, item.number)}::${item.slot}` === `${normalizePastorKey(pastor.name, pastor.number)}::${pastor.slot}`) === index);
    if (!pastors.length) return res.status(400).json({ error:'Select at least one pastor assignment.' });

    for (const pastor of pastors) {
      if (!pastor.slot && getEntrySupportSlots(latestPastorRecord(db, pastor.name, pastor.number) || {}).length) {
        return res.status(400).json({ error:`Choose a specific supporter slot for ${pastor.name}.` });
      }
      const alreadyAssigned = existingAssignments.some(item => normalizePastorKey(item.name, item.number) === normalizePastorKey(pastor.name, pastor.number)
        && String(item.slot || '').toUpperCase() === pastor.slot);
      if (pastor.slot && !isSupportSlotEnabledForPastor(db, pastor.name, pastor.number, pastor.slot) && !alreadyAssigned) {
        return res.status(400).json({ error:`Support slot ${pastor.slot}. for ${pastor.name} is disabled or unavailable.` });
      }
    }

    // A/B/C/etc. represent distinct supporter slots for a pastor. Prevent two
    // supporter accounts from taking the same slot while still allowing the
    // same pastor to have multiple supporters. Legacy assignments without a
    // slot remain valid and are treated as a general assignment.
    const otherSupporters = db.users.filter(u => u.role === 'supporter' && u.id !== user.id);
    for (const pastor of pastors) {
      if (!pastor.slot) continue;
      if (!isSupportSlotEnabledForPastor(db, pastor.name, pastor.number, pastor.slot)) continue;
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
  } catch (err) { sendInternalError(res, err); }
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
  } catch (err) { sendInternalError(res, err); }
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
  } catch (err) { sendInternalError(res, err); }
});

app.get('/api/health', async (req, res) => {
  try {
    await readDB();
    res.json({ ok: true });
  } catch {
    res.status(500).json({ ok: false });
  }
});

app.use('/api', notificationRouters.cron);

app.use('/api', requireAuth);
app.use('/api', notificationRouters.api);

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

function quarterOrderValue(q) {
  const quarterNumber = Number(String(q.id || '').match(/Q(\d+)/i)?.[1]
    || String(q.quarterName || '').match(/(\d+)/)?.[1]
    || 0);
  return (Number(q.year) || 0) * 10 + quarterNumber;
}

function syncPastorTypeAcrossQuarters(db, names, pastorType, updatedAt = new Date().toISOString()) {
  const identities = new Set(names.map(pastorIdentityKey).filter(Boolean));
  const updatedQuarters = new Set();
  db.quarters.forEach(q => q.entries.forEach(entry => {
    if (!identities.has(pastorIdentityKey(entry.name))) return;
    if (normalizePastorType(entry.pastorType) !== pastorType) {
      entry.pastorType = pastorType;
      entry.updatedAt = updatedAt;
      updatedQuarters.add(q.id);
    }
    entry.pastorTypeUpdatedAt = updatedAt;
  }));
  return [...updatedQuarters];
}

function syncPastorSupportSlotsAcrossQuarters(db, names, slotConfig, updatedAt = new Date().toISOString()) {
  const identities = new Set(names.map(pastorIdentityKey).filter(Boolean));
  const labels = normalizeSlotLabels(slotConfig.map(slot => slot.label));
  const disabled = slotConfig.filter(slot => !slot.enabled).map(slot => slot.label);
  const updatedQuarters = new Set();
  let updatedEntries = 0;

  (db.quarters || []).forEach(quarter => (quarter.entries || []).forEach(entry => {
    if (!identities.has(pastorIdentityKey(entry.name))) return;
    let changed = false;
    for (const key of ['m1', 'm2', 'm3']) {
      const next = statusWithSupportSlots(entry[key], labels);
      if (next !== String(entry[key] || '')) {
        entry[key] = next;
        changed = true;
      }
    }
    const currentDisabled = normalizeSlotLabels(entry.disabledSupportSlots);
    if (JSON.stringify(currentDisabled) !== JSON.stringify(disabled)) {
      if (disabled.length) entry.disabledSupportSlots = disabled;
      else delete entry.disabledSupportSlots;
      changed = true;
    }
    if (changed) {
      entry.updatedAt = updatedAt;
      updatedEntries += 1;
      updatedQuarters.add(quarter.id);
    }
  }));

  return { quarterIds: [...updatedQuarters], updatedEntries, labels, disabled };
}

function pastorSupportSlotsNeedSync(db, names, slotConfig) {
  const identities = new Set(names.map(pastorIdentityKey).filter(Boolean));
  const labels = normalizeSlotLabels(slotConfig.map(slot => slot.label));
  const disabled = normalizeSlotLabels(slotConfig.filter(slot => !slot.enabled).map(slot => slot.label));
  return (db.quarters || []).some(quarter => (quarter.entries || []).some(entry => {
    if (!identities.has(pastorIdentityKey(entry.name))) return false;
    const monthValuesOutOfSync = ['m1', 'm2', 'm3'].some(key =>
      statusWithSupportSlots(entry[key], labels) !== String(entry[key] || '')
    );
    const disabledStateOutOfSync = JSON.stringify(normalizeSlotLabels(entry.disabledSupportSlots)) !== JSON.stringify(disabled);
    return monthValuesOutOfSync || disabledStateOutOfSync;
  }));
}

function isSupportSlotEnabledForPastor(db, name, number, slot) {
  const latest = latestPastorRecord(db, name, number);
  return Boolean(latest && !latest.hidden && getEnabledEntrySupportSlots(latest).includes(String(slot || '').trim().toUpperCase()));
}

function latestPastorRecord(db, name, number) {
  const identity = pastorIdentityKey(name);
  const records = (db.quarters || []).flatMap(quarter => (quarter.entries || []).map(entry => ({ quarter, entry })))
    .filter(({ entry }) => pastorIdentityKey(entry.name) === identity);
  if (!records.length) return null;
  return records.sort((a, b) => quarterOrderValue(b.quarter) - quarterOrderValue(a.quarter))[0].entry;
}

function reconcilePastorTypesAcrossQuarters(db) {
  const entriesByPastor = new Map();
  db.quarters.forEach(q => (q.entries || []).forEach(entry => {
    const key = pastorIdentityKey(entry.name);
    if (!key) return;
    if (!entriesByPastor.has(key)) entriesByPastor.set(key, []);
    entriesByPastor.get(key).push({ quarter: q, entry, type: normalizePastorType(entry.pastorType) });
  }));

  const changedQuarters = new Set();
  let changedEntries = 0;
  const now = new Date().toISOString();
  entriesByPastor.forEach(records => {
    const classified = records.filter(record => ['Local', 'Foreign'].includes(record.type));
    if (!classified.length) return;
    const hasExplicitTypeTimestamp = classified.some(record => Number.isFinite(Date.parse(record.entry.pastorTypeUpdatedAt || '')));
    classified.sort((a, b) => {
      if (hasExplicitTypeTimestamp) {
        const timestampDifference = (Date.parse(b.entry.pastorTypeUpdatedAt || '') || 0)
          - (Date.parse(a.entry.pastorTypeUpdatedAt || '') || 0);
        if (timestampDifference) return timestampDifference;
      }
      return quarterOrderValue(b.quarter) - quarterOrderValue(a.quarter);
    });
    const canonicalType = classified[0].type;
    records.forEach(({ quarter, entry }) => {
      if (normalizePastorType(entry.pastorType) === canonicalType) return;
      entry.pastorType = canonicalType;
      entry.pastorTypeUpdatedAt = now;
      entry.updatedAt = now;
      changedQuarters.add(quarter.id);
      changedEntries++;
    });
  });
  return { changedEntries, changedQuarters: [...changedQuarters] };
}

async function reconcileAndPersistQuarterTypes(db, req) {
  const result = reconcilePastorTypesAcrossQuarters(db);
  if (!result.changedEntries) return false;
  addAudit(db, req, 'Pastor Types Synchronized', {
    quarterIds: result.changedQuarters,
    description: `Synchronized Local/Foreign pastor types across ${result.changedQuarters.length} quarter${result.changedQuarters.length === 1 ? '' : 's'} (${result.changedEntries} records)`
  });
  await writeDB(db, { touchLastUpdated: true });
  return true;
}

function pastorTypeForNewOccurrence(db, pastorName, requestedType) {
  const normalizedRequested = normalizePastorType(requestedType);
  if (normalizedRequested !== 'Unassigned') return normalizedRequested;
  const identity = pastorIdentityKey(pastorName);
  const mostRecentKnownType = db.quarters
    .slice()
    .sort((a, b) => quarterOrderValue(b) - quarterOrderValue(a))
    .flatMap(q => q.entries || [])
    .find(entry => pastorIdentityKey(entry.name) === identity
      && ['Local', 'Foreign'].includes(normalizePastorType(entry.pastorType)));
  return mostRecentKnownType ? normalizePastorType(mostRecentKnownType.pastorType) : normalizedRequested;
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

// One-time roster migration requested by the church: preserve each quarter's
// original order and support marks, while excluding Arellano, Jack from every
// quarter that already exists. The marker keeps later per-quarter restores
// from being hidden again on subsequent requests.
function hideArellanoJackAcrossExistingQuarters(db) {
  const migrationKey = 'hide-arellano-jack-across-existing-quarters-v1';
  if (!db.migrations || typeof db.migrations !== 'object' || Array.isArray(db.migrations)) db.migrations = {};
  if (db.migrations[migrationKey]) return null;

  let hiddenCount = 0;
  let affectedQuarters = 0;
  for (const quarter of db.quarters) {
    let quarterChanged = false;
    for (const entry of quarter.entries) {
      const name = String(entry.name || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
      if (name !== 'arellano, jack' || entry.hidden === true) continue;
      entry.hidden = true;
      hiddenCount += 1;
      quarterChanged = true;
    }
    if (quarterChanged) affectedQuarters += 1;
  }

  db.migrations[migrationKey] = {
    completedAt: new Date().toISOString(),
    hiddenCount,
    affectedQuarters
  };
  return { hiddenCount, affectedQuarters };
}

// Bring older per-quarter visibility edits into line with the current global
// hide/restore behavior. If a pastor is already hidden anywhere, hide their
// matching records in all existing quarters without changing support marks.
function synchronizeHiddenPastorsAcrossExistingQuarters(db) {
  const migrationKey = 'sync-hidden-pastors-across-existing-quarters-v1';
  if (!db.migrations || typeof db.migrations !== 'object' || Array.isArray(db.migrations)) db.migrations = {};
  if (db.migrations[migrationKey]) return null;

  const hiddenIdentities = new Set();
  db.quarters.forEach(quarter => (quarter.entries || []).forEach(entry => {
    if (!entry.hidden) return;
    const identity = pastorIdentityKey(entry.name);
    if (identity) hiddenIdentities.add(identity);
  }));

  let hiddenCount = 0;
  let affectedQuarters = 0;
  db.quarters.forEach(quarter => {
    let quarterChanged = false;
    (quarter.entries || []).forEach(entry => {
      if (entry.hidden || !hiddenIdentities.has(pastorIdentityKey(entry.name))) return;
      entry.hidden = true;
      hiddenCount += 1;
      quarterChanged = true;
    });
    if (quarterChanged) affectedQuarters += 1;
  });

  db.migrations[migrationKey] = {
    completedAt: new Date().toISOString(),
    pastorCount: hiddenIdentities.size,
    hiddenCount,
    affectedQuarters
  };
  return { pastorCount: hiddenIdentities.size, hiddenCount, affectedQuarters };
}

function statusMetrics(value, entry = null) {
  const text = String(value || '').trim();
  const parsed = parseSupportSlotStatuses(text);
  if (parsed.length) {
    const disabled = new Set(normalizeSlotLabels(entry?.disabledSupportSlots));
    const active = parsed.filter(item => !disabled.has(item.label));
    return { checked: active.filter(item => item.checked).length, total: active.length };
  }
  if (!text) return { checked: 0, total: 1 };
  return { checked: text.includes('✓') ? 1 : 0, total: 1 };
}

function entryMetrics(entry) {
  const months = [entry.m1, entry.m2, entry.m3].map(value => statusMetrics(value, entry));
  return {
    checked: months.reduce((sum, m) => sum + m.checked, 0),
    total: months.reduce((sum, m) => sum + m.total, 0)
  };
}

function isEntryComplete(entry) {
  const m = entryMetrics(entry);
  return m.total === 0 || m.checked === m.total;
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
    const jackMigration = hideArellanoJackAcrossExistingQuarters(db);
    const hiddenPastorMigration = synchronizeHiddenPastorsAcrossExistingQuarters(db);
    if (jackMigration || hiddenPastorMigration) {
      if (jackMigration) {
        addAudit(db, req, 'Pastor Hidden Across Quarters', {
          pastorName: 'Arellano, Jack',
          affectedQuarters: jackMigration.affectedQuarters,
          recordsHidden: jackMigration.hiddenCount
        });
      }
      if (hiddenPastorMigration) {
        addAudit(db, req, 'Hidden Pastors Synchronized Across Quarters', {
          pastorCount: hiddenPastorMigration.pastorCount,
          affectedQuarters: hiddenPastorMigration.affectedQuarters,
          recordsHidden: hiddenPastorMigration.hiddenCount,
          description: `Synchronized hidden status for ${hiddenPastorMigration.pastorCount} pastor${hiddenPastorMigration.pastorCount === 1 ? '' : 's'} across existing quarters.`
        });
      }
      await writeDB(db, { touchLastUpdated: true });
    }
    if (['admin', 'staff'].includes(req.user?.role)) await reconcileAndPersistQuarterTypes(db, req);
    if (['admin', 'staff'].includes(req.user?.role)) {
      const reconciled = reconcilePastorSupportSlotsAcrossQuarters(db);
      if (reconciled.updatedEntries) {
        addAudit(db, req, 'Pastor Supporter Slots Reconciled', {
          affectedQuarters: reconciled.quarterIds.length,
          updatedEntries: reconciled.updatedEntries,
          description: `Synchronized supporter slots and preserved quarter-specific checks across ${reconciled.quarterIds.length} quarter${reconciled.quarterIds.length === 1 ? '' : 's'}`
        });
        await writeDB(db, { touchLastUpdated: true });
      }
    }
    const summary = db.quarters.map(q => {
      const visibleEntries = q.entries.filter(e => !e.hidden).filter(getSupporterEntryFilter(req.user));
      const total = visibleEntries.length;
      const monthlyMetrics = ['m1', 'm2', 'm3'].map(key => visibleEntries.reduce((metrics, entry) => {
        const month = statusMetrics(entry[key], entry);
        metrics.checked += month.checked;
        metrics.total += month.total;
        return metrics;
      }, { checked: 0, total: 0 }));
      return {
        id: q.id,
        year: q.year,
        quarterNum: q.quarterNum,
        quarterName: q.quarterName,
        title: q.title,
        months: q.months,
        totalPastors: total,
        stats: {
          m1: { count: monthlyMetrics[0].checked, total: monthlyMetrics[0].total, percent: monthlyMetrics[0].total ? Math.round((monthlyMetrics[0].checked / monthlyMetrics[0].total) * 100) : 0 },
          m2: { count: monthlyMetrics[1].checked, total: monthlyMetrics[1].total, percent: monthlyMetrics[1].total ? Math.round((monthlyMetrics[1].checked / monthlyMetrics[1].total) * 100) : 0 },
          m3: { count: monthlyMetrics[2].checked, total: monthlyMetrics[2].total, percent: monthlyMetrics[2].total ? Math.round((monthlyMetrics[2].checked / monthlyMetrics[2].total) * 100) : 0 },
        }
      };
    });
    res.json({
      quarters: summary,
      summaryNotes: db.summaryNotes || [],
      lastUpdated: db.lastUpdated
    });
  } catch (err) {
    sendInternalError(res, err);
  }
});

// 2. GET specific quarter details
app.get('/api/quarters/:id', async (req, res) => {
  try {
    const db = normalizeDB(await readDB());
    if (['admin', 'staff'].includes(req.user?.role)) await reconcileAndPersistQuarterTypes(db, req);
    if (['admin', 'staff'].includes(req.user?.role)) {
      const reconciled = reconcilePastorSupportSlotsAcrossQuarters(db);
      if (reconciled.updatedEntries) {
        addAudit(db, req, 'Pastor Supporter Slots Reconciled', {
          affectedQuarters: reconciled.quarterIds.length,
          updatedEntries: reconciled.updatedEntries,
          description: `Synchronized supporter slots and preserved quarter-specific checks across ${reconciled.quarterIds.length} quarter${reconciled.quarterIds.length === 1 ? '' : 's'}`
        });
        await writeDB(db, { touchLastUpdated: true });
      }
    }
    const q = db.quarters.find(x => x.id === req.params.id);
    if (!q) return res.status(404).json({ error: 'Quarter not found' });
    res.json(filterQuarterForUser(q, req.user, db));
  } catch (err) {
    sendInternalError(res, err);
  }
});

// 3. POST new quarter
app.post('/api/quarters', requireStaff, async (req, res) => {
  try {
    const { year, quarterNum, copyFromQuarterId } = req.body;
    if (!year || !quarterNum) return res.status(400).json({ error: 'Year and Quarter Number are required' });

    const qNum = Number(quarterNum);
    const yr = Number(year);
    if (!Number.isInteger(qNum) || qNum < 1 || qNum > 4 || !Number.isInteger(yr) || yr < 1900 || yr > 2200) {
      return res.status(400).json({ error: 'Enter a valid year and quarter number (1–4).' });
    }
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
          const slots = globalPastorSlots(db, [e.name]);
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
            ...(globalDisabledPastorSlots(db, [e.name]).length ? { disabledSupportSlots: globalDisabledPastorSlots(db, [e.name]) } : {}),
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
    sendInternalError(res, err);
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
    sendInternalError(res, err);
  }
});

// 5. POST new Pastor to quarter
app.post('/api/quarters/:quarterId/entries', requireStaff, async (req, res) => {
  try {
    const { name, number, m1, m2, m3, notes, pastorType, addToAllQuarters } = req.body;
    const requestedName = String(name || '').trim();
    if (!requestedName) return res.status(400).json({ error: 'Pastor name is required' });
    if (requestedName.length > 120 || String(notes || '').length > 2000) return res.status(400).json({ error: 'Pastor name or notes are too long.' });

    const db = normalizeDB(await readDB());
    const quarter = db.quarters.find(q => q.id === req.params.quarterId);
    if (!quarter) return res.status(404).json({ error: 'Quarter not found' });

    const pastorName = requestedName;
    const effectivePastorType = pastorTypeForNewOccurrence(db, pastorName, pastorType);
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
      pastorType: effectivePastorType,
      pastorTypeUpdatedAt: now,
      hidden: false,
      updatedAt: now
    };

    quarter.entries.push(newEntry);
    syncPastorTypeAcrossQuarters(db, [pastorName], effectivePastorType);
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
            pastorType: effectivePastorType,
            pastorTypeUpdatedAt: now,
            hidden: false,
            updatedAt: now
          });
        }
      });
    }

    await writeDB(db, { touchLastUpdated: true });
    res.status(201).json({ entry: newEntry, lastUpdated: db.lastUpdated });
  } catch (err) {
    sendInternalError(res, err);
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
    const supportSlotsProvided = Object.prototype.hasOwnProperty.call(req.body || {}, 'supportSlots');
    const slotNames = [entry.name, name !== undefined ? String(name).trim() : entry.name];
    const knownSupportSlots = globalPastorSlots(db, slotNames);
    let slotConfig = null;
    if (supportSlotsProvided) {
      const validation = validateSupportSlotConfig(req.body.supportSlots, knownSupportSlots);
      if (validation.error) return res.status(400).json({ error: validation.error });
      slotConfig = validation.slots;
    }

    const candidate = {
      name: name !== undefined ? String(name).trim() : entry.name,
      number: number !== undefined ? parseInt(number) : entry.number,
      m1: m1 !== undefined ? preserveDisabledSupportMarks(m1, entry.m1, entry) : (entry.m1 || ''),
      m2: m2 !== undefined ? preserveDisabledSupportMarks(m2, entry.m2, entry) : (entry.m2 || ''),
      m3: m3 !== undefined ? preserveDisabledSupportMarks(m3, entry.m3, entry) : (entry.m3 || ''),
      notes: notes !== undefined ? String(notes) : (entry.notes || ''),
      pastorType: pastorType !== undefined ? normalizePastorType(pastorType) : normalizePastorType(entry.pastorType),
      hidden: hidden !== undefined ? Boolean(hidden) : (included !== undefined ? !Boolean(included) : entry.hidden === true)
    };
    if (!candidate.name) return res.status(400).json({ error: 'Pastor name is required' });
    if (candidate.name.length > 120 || candidate.notes.length > 2000) return res.status(400).json({ error: 'Pastor name or notes are too long.' });
    if (!Number.isFinite(candidate.number) || candidate.number < 1) return res.status(400).json({ error: 'Pastor number must be a positive number' });

    const changes = [];
    ['name','number','m1','m2','m3','notes','pastorType','hidden'].forEach(key => {
      const after = candidate[key] ?? '';
      if (String(before[key] ?? '') !== String(after)) {
        const monthName = key === 'm1' ? quarter.months?.[0] : key === 'm2' ? quarter.months?.[1] : key === 'm3' ? quarter.months?.[2] : null;
        changes.push({ field: key === 'hidden' ? (after ? 'hidden' : 'included') : (monthName || key), from: before[key] ?? '', to: after });
      }
    });

    const currentDisabledSlots = new Set(globalDisabledPastorSlots(db, slotNames));
    const supportSlotsChanged = Boolean(slotConfig && (
      JSON.stringify(slotConfig.map(slot => slot.label)) !== JSON.stringify(knownSupportSlots) ||
      JSON.stringify(slotConfig.filter(slot => !slot.enabled).map(slot => slot.label)) !== JSON.stringify([...currentDisabledSlots].sort((a, b) => supportSlotPosition(a) - supportSlotPosition(b))) ||
      pastorSupportSlotsNeedSync(db, slotNames, slotConfig)
    ));
    if (supportSlotsChanged) {
      changes.push({
        field: 'supportSlots',
        from: knownSupportSlots.map(label => `${label}${currentDisabledSlots.has(label) ? ' (disabled)' : ''}`),
        to: slotConfig.map(slot => `${slot.label}${slot.enabled ? '' : ' (disabled)'}`)
      });
    }

    if (!changes.length) {
      return res.json({ entry, lastUpdated: db.lastUpdated });
    }

    Object.assign(entry, candidate);
    entry.rawName = `${entry.number}. ${entry.name}`;
    entry.updatedAt = new Date().toISOString();

    // Include/exclude is a pastor-wide choice. Apply it to every matching
    // quarter record while leaving each quarter's month marks and original
    // order untouched. Match by name because the historical number can vary.
    const visibilityUpdatedQuarters = [];
    const visibilityChanged = before.hidden !== candidate.hidden;
    if (visibilityChanged) {
      const identity = pastorIdentityKey(before.name);
      db.quarters.forEach(otherQuarter => {
        let quarterChanged = otherQuarter.id === quarter.id;
        (otherQuarter.entries || []).forEach(otherEntry => {
          if (otherEntry.id === entry.id && otherQuarter.id === quarter.id) return;
          if (pastorIdentityKey(otherEntry.name) !== identity || otherEntry.hidden === candidate.hidden) return;
          otherEntry.hidden = candidate.hidden;
          otherEntry.updatedAt = entry.updatedAt;
          quarterChanged = true;
        });
        if (quarterChanged) visibilityUpdatedQuarters.push(otherQuarter.id);
      });
    }

    let typeUpdatedQuarters = [];
    if (before.pastorType !== candidate.pastorType) {
      const typeTimestamp = new Date().toISOString();
      entry.pastorTypeUpdatedAt = typeTimestamp;
      typeUpdatedQuarters = [...new Set([quarter.id, ...syncPastorTypeAcrossQuarters(db, [before.name, candidate.name], candidate.pastorType, typeTimestamp)])];
    }

    let supportSlotSync = { quarterIds: [], updatedEntries: 0, labels: [], disabled: [] };
    if (supportSlotsChanged) {
      supportSlotSync = syncPastorSupportSlotsAcrossQuarters(db, [before.name, candidate.name], slotConfig, entry.updatedAt);
    }

    const supportChanged = changes.some(c => quarter.months?.includes(c.field));
    addAudit(db, req, supportSlotsChanged ? 'Pastor Supporter Slots Updated' : (supportChanged ? 'Support Updated' : (changes.some(c => ['hidden','included'].includes(c.field)) ? (entry.hidden ? 'Pastor Hidden' : 'Pastor Restored') : 'Pastor Edited')), {
      quarterId: quarter.id,
      entryId: entry.id,
      pastorName: entry.name,
      changes,
      description: visibilityChanged
        ? `${entry.name} was ${candidate.hidden ? 'hidden' : 'included'} across ${visibilityUpdatedQuarters.length} quarter${visibilityUpdatedQuarters.length === 1 ? '' : 's'}`
        : changes.some(change => change.field === 'pastorType')
        ? `${entry.name}'s pastor type was updated across ${Math.max(1, typeUpdatedQuarters.length)} quarter${typeUpdatedQuarters.length === 1 ? '' : 's'}`
        : supportSlotsChanged
        ? `${entry.name}'s supporter slots were synchronized across ${supportSlotSync.quarterIds.length} quarter${supportSlotSync.quarterIds.length === 1 ? '' : 's'}`
        : `${entry.name} was updated in ${quarter.id}`
    });

    await writeDB(db, { touchLastUpdated: true });
    res.json({ entry: decorateEntrySupportSlots(db, entry), lastUpdated: db.lastUpdated, typeUpdatedQuarters, visibilityUpdatedQuarters, supportSlotUpdatedQuarters: supportSlotSync.quarterIds });
  } catch (err) {
    sendInternalError(res, err);
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
    const now = new Date().toISOString();
    let changedCount = 0;
    quarter.entries.filter(e => !e.hidden).forEach(e => {
      const keys = monthKey === 'all' ? ['m1','m2','m3'] : (['m1','m2','m3'].includes(monthKey) ? [monthKey] : []);
      let changed = false;
      keys.forEach(key => {
        const nextValue = setEnabledSupportStatuses(e[key], e, action === 'check');
        if (String(e[key] || '') !== nextValue) { e[key] = nextValue; changed = true; }
      });
      if (changed) { e.updatedAt = now; changedCount++; }
    });
    if (changedCount) {
      addAudit(db, req, 'Bulk Support Updated', { quarterId: quarter.id, monthKey, action, changedCount, description: `${action === 'check' ? 'Marked' : 'Cleared'} ${monthKey} for ${changedCount} pastor record(s) in ${quarter.id}` });
      await writeDB(db, { touchLastUpdated: true });
    }
    res.json({ message: 'Bulk update applied', quarter, changedCount, lastUpdated: db.lastUpdated });
  } catch (err) {
    sendInternalError(res, err);
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
      if (u.m1 !== undefined) entry.m1 = preserveDisabledSupportMarks(u.m1, before.m1, entry);
      if (u.m2 !== undefined) entry.m2 = preserveDisabledSupportMarks(u.m2, before.m2, entry);
      if (u.m3 !== undefined) entry.m3 = preserveDisabledSupportMarks(u.m3, before.m3, entry);
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
    sendInternalError(res, err);
  }
});

// Hidden pastors: excluded records remain in the database and can be restored.
app.get('/api/hidden-pastors', requireStaff, async (req, res) => {
  try {
    const db = normalizeDB(await readDB());
    const hiddenByIdentity = new Map();
    db.quarters.forEach(q => (q.entries || []).filter(e => e.hidden).forEach(entry => {
      const identity = pastorIdentityKey(entry.name);
      if (!identity) return;
      let pastor = hiddenByIdentity.get(identity);
      if (!pastor) {
        pastor = { name: String(entry.name || '').trim(), quarterCount: 0 };
        hiddenByIdentity.set(identity, pastor);
      }
      pastor.quarterCount += 1;
    }));
    const hidden = [...hiddenByIdentity.values()].sort((a, b) => a.name.localeCompare(b.name));
    res.json({ hidden });
  } catch (err) { sendInternalError(res, err); }
});

// Restore one pastor identity across every quarter where that identity is hidden.
// Quarter entries remain separate so each year's support history is preserved.
app.post('/api/hidden-pastors/include', requireStaff, async (req, res) => {
  try {
    const requestedName = String(req.body?.name || '').trim();
    const identity = pastorIdentityKey(requestedName);
    if (!identity) return res.status(400).json({ error: 'Pastor name is required.' });

    const db = normalizeDB(await readDB());
    const restoredQuarterIds = [];
    let restoredCount = 0;
    db.quarters.forEach(quarter => {
      let changed = false;
      (quarter.entries || []).forEach(entry => {
        if (!entry.hidden || pastorIdentityKey(entry.name) !== identity) return;
        entry.hidden = false;
        restoredCount += 1;
        changed = true;
      });
      if (changed) restoredQuarterIds.push(quarter.id);
    });
    if (!restoredCount) return res.status(404).json({ error: 'No hidden records were found for that pastor.' });

    addAudit(db, req, 'Pastor Included Across Quarters', {
      pastorName: requestedName,
      restoredCount,
      restoredQuarterIds,
      description: `Included ${requestedName} in ${restoredQuarterIds.length} quarter${restoredQuarterIds.length === 1 ? '' : 's'}; existing support marks were preserved.`
    });
    await writeDB(db, { touchLastUpdated: true });
    res.json({
      message: 'Pastor included across quarters.',
      name: requestedName,
      restoredCount,
      restoredQuarterIds,
      lastUpdated: db.lastUpdated
    });
  } catch (err) { sendInternalError(res, err); }
});

app.get('/api/quarters/:id/hidden', requireStaff, async (req, res) => {
  try {
    const db = normalizeDB(await readDB());
    const q = db.quarters.find(x => x.id === req.params.id);
    if (!q) return res.status(404).json({ error: 'Quarter not found' });
    res.json({ quarter: { ...q, entries: (q.entries || []).filter(e => e.hidden).map(entry => decorateEntrySupportSlots(db, entry)) } });
  } catch (err) { sendInternalError(res, err); }
});

// 10. GET audit trail
app.get('/api/audit-trail', requireStaff, async (req, res) => {
  try {
    const db = normalizeDB(await readDB());
    res.json({ auditTrail: db.auditTrail || [], lastUpdated: db.lastUpdated || null });
  } catch (err) {
    sendInternalError(res, err);
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
    sendInternalError(res, err);
  }
});

// 10. Health/status endpoint


// PPTX creation is kept separate from route registration so the Express app
// retains the same report behavior while its entrypoint stays focused.
const { buildPptx, sendPptxDownload } = createPptxService({
  filterQuarterEntries,
  parseSupportSlotStatuses,
  normalizeSlotLabels
});

app.use('/api', createReportRouter({
  readDB,
  normalizeDB,
  filterQuarterForUser,
  buildPptx,
  sendPptxDownload,
  sendInternalError
}));

// 13. Download JSON backup
app.get('/api/backup', requireAdmin, async (req, res) => {
  try {
    const db = normalizeDB(await readDB());
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="mission_support_backup.json"');
    res.send(JSON.stringify(db, null, 2));
  } catch (err) {
    sendInternalError(res, err);
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Mission Support Web App running at http://localhost:${PORT}`);
  });
}

module.exports = app;
