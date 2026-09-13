const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pptxgen = require('pptxgenjs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

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
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
    status: user.status,
    email: user.email || '',
    phone: user.phone || '',
    assignedPastors: Array.isArray(user.assignedPastors) ? user.assignedPastors : (user.assignedPastor ? [user.assignedPastor] : []),
    assignedPastor: user.assignedPastor || (Array.isArray(user.assignedPastors) && user.assignedPastors[0]) || null,
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
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
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

function getSupporterEntryFilter(user) {
  if (user?.role !== 'supporter') return () => true;
  const assignedList = Array.isArray(user.assignedPastors) ? user.assignedPastors : (user.assignedPastor ? [user.assignedPastor] : []);
  if (!assignedList.length) return () => false;
  const keys = assignedList.map(assigned => ({
    key: normalizePastorKey(assigned.name, assigned.number),
    name: String(assigned.name || '').trim().toLowerCase(),
    number: String(assigned.number || '').trim()
  }));
  return (entry) => keys.some(assigned => normalizePastorKey(entry.name, entry.number) === assigned.key ||
    (String(entry.name || '').trim().toLowerCase() === assigned.name && (!assigned.number || String(entry.number || '') === assigned.number)));
}

function filterQuarterForUser(q, user) {
  if (user?.role !== 'supporter') return q;
  return { ...q, entries: (q.entries || []).filter(getSupporterEntryFilter(user)) };
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

app.post('/api/auth/users', requireAuth, requireStaff, async (req, res) => {
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

app.put('/api/auth/users/:id', requireAuth, requireStaff, async (req, res) => {
  try {
    const db = ensureAuthState(await readDB());
    const user = db.users.find(u => u.id === req.params.id);
    if (!user) return res.status(404).json({ error:'User not found.' });
    if (user.role === 'admin' && req.user.id !== user.id) return res.status(403).json({ error:'Admin account cannot be edited by another user here.' });
    if (req.body?.name !== undefined) user.name = String(req.body.name).trim();
    if (req.body?.email !== undefined) user.email = String(req.body.email).trim().toLowerCase();
    if (req.body?.phone !== undefined) user.phone = String(req.body.phone).trim();
    if (req.body?.status && ['active','disabled','pending_assignment'].includes(req.body.status)) user.status = req.body.status;
    if (req.body?.role && req.user.role === 'admin' && ['staff','supporter'].includes(req.body.role)) user.role = req.body.role;
    if (req.body?.password) {
      if (String(req.body.password).length < 8) return res.status(400).json({ error:'Password must be at least 8 characters.' });
      const credentials = hashPassword(req.body.password); user.passwordSalt=credentials.salt; user.passwordHash=credentials.hash;
    }
    addAudit(db, req, 'USER_UPDATED', { userId:user.id, username:user.username });
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
    if (!pastors.length && req.body?.name) pastors = [{ name:req.body.name, number:req.body.number }];
    pastors = pastors.map(p => ({ name:String(p?.name || '').trim(), number:String(p?.number ?? '').trim() }))
      .filter(p => p.name)
      .filter((p, i, arr) => arr.findIndex(x => normalizePastorKey(x.name, x.number) === normalizePastorKey(p.name, p.number)) === i);
    if (!pastors.length) return res.status(400).json({ error:'Select at least one pastor.' });

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

function ensureRecycleBin(db) {
  if (!Array.isArray(db.recycleBin)) db.recycleBin = [];
  return db.recycleBin;
}

function normalizePastorType(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'local') return 'Local';
  if (v === 'foreign') return 'Foreign';
  return 'Unassigned';
}

function normalizeEntry(entry) {
  entry.pastorType = normalizePastorType(entry.pastorType);
  return entry;
}

function normalizeDB(db) {
  if (!Array.isArray(db.quarters)) db.quarters = [];
  db.quarters.forEach(q => {
    if (!Array.isArray(q.entries)) q.entries = [];
    q.entries.forEach(normalizeEntry);
  });
  ensureRecycleBin(db);
  ensureAuditTrail(db);
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
  let entries = (q.entries || []).map(normalizeEntry);
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
    const summary = db.quarters.map(q => {
      const visibleEntries = q.entries.filter(getSupporterEntryFilter(req.user));
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
    if (copyFromQuarterId) {
      const sourceQ = db.quarters.find(q => q.id === copyFromQuarterId);
      if (sourceQ) {
        entries = sourceQ.entries.map((e, idx) => ({
          id: `${qKey}-${idx + 1}`,
          number: e.number || (idx + 1),
          name: e.name,
          rawName: e.rawName || `${e.number || (idx + 1)}. ${e.name}`,
          m1: '',
          m2: '',
          m3: '',
          notes: '',
          pastorType: normalizePastorType(e.pastorType)
        }));
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
    await writeDB(db);

    res.status(201).json(newQuarter);
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
    await writeDB(db);
    res.json({ message: 'Quarter deleted', deleted: deleted[0].id });
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
    const num = number ? parseInt(number) : (quarter.entries.length + 1);

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
      updatedAt: now
    };

    quarter.entries.push(newEntry);
    addAudit(db, req, 'Pastor Added', { quarterId: quarter.id, entryId: newEntry.id, pastorName, description: `${pastorName} was added to ${quarter.id}` });

    // Optional: add to all active quarters
    if (addToAllQuarters) {
      db.quarters.forEach(q => {
        if (q.id !== quarter.id && !q.entries.some(e => e.name.toLowerCase() === pastorName.toLowerCase())) {
          const nextNum = q.entries.length + 1;
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
            updatedAt: now
          });
        }
      });
    }

    await writeDB(db);
    res.status(201).json(newEntry);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. PUT update Pastor entry
app.put('/api/quarters/:quarterId/entries/:entryId', requireStaff, async (req, res) => {
  try {
    const { name, number, m1, m2, m3, notes, pastorType } = req.body;
    const db = normalizeDB(await readDB());
    const quarter = db.quarters.find(q => q.id === req.params.quarterId);
    if (!quarter) return res.status(404).json({ error: 'Quarter not found' });

    const entry = quarter.entries.find(e => e.id === req.params.entryId);
    if (!entry) return res.status(404).json({ error: 'Pastor entry not found' });

    const before = { name: entry.name, number: entry.number, m1: entry.m1 || '', m2: entry.m2 || '', m3: entry.m3 || '', notes: entry.notes || '', pastorType: normalizePastorType(entry.pastorType) };
    const now = new Date().toISOString();
    if (name !== undefined) entry.name = name.trim();
    if (number !== undefined) entry.number = parseInt(number);
    if (m1 !== undefined) entry.m1 = m1;
    if (m2 !== undefined) entry.m2 = m2;
    if (m3 !== undefined) entry.m3 = m3;
    if (notes !== undefined) entry.notes = notes;
    if (pastorType !== undefined) entry.pastorType = normalizePastorType(pastorType);
    entry.updatedAt = now;
    entry.rawName = `${entry.number}. ${entry.name}`;

    const changes = [];
    ['name','number','m1','m2','m3','notes','pastorType'].forEach(key => {
      const after = entry[key] ?? '';
      if (String(before[key] ?? '') !== String(after)) {
        const monthName = key === 'm1' ? quarter.months?.[0] : key === 'm2' ? quarter.months?.[1] : key === 'm3' ? quarter.months?.[2] : null;
        changes.push({ field: monthName || key, from: before[key] ?? '', to: after });
      }
    });
    if (changes.length) {
      addAudit(db, req, changes.some(c => ['m1','m2','m3'].includes(c.field) || quarter.months?.includes(c.field)) ? 'Support Updated' : 'Pastor Edited', {
        quarterId: quarter.id, entryId: entry.id, pastorName: entry.name, changes,
        description: `${entry.name} was updated in ${quarter.id}`
      });
    }

    await writeDB(db);
    res.json(entry);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. DELETE Pastor entry
app.delete('/api/quarters/:quarterId/entries/:entryId', requireStaff, async (req, res) => {
  try {
    const db = normalizeDB(await readDB());
    const quarter = db.quarters.find(q => q.id === req.params.quarterId);
    if (!quarter) return res.status(404).json({ error: 'Quarter not found' });

    const idx = quarter.entries.findIndex(e => e.id === req.params.entryId);
    if (idx === -1) return res.status(404).json({ error: 'Pastor entry not found' });

    const removed = quarter.entries.splice(idx, 1);
    const deletedEntry = { ...normalizeEntry(removed[0]), deletedAt: new Date().toISOString(), deletedFromQuarterId: quarter.id, deletedFromQuarterTitle: quarter.title, deletedFromNumber: removed[0].number || (idx + 1) };
    ensureRecycleBin(db).unshift(deletedEntry);
    addAudit(db, req, 'Pastor Deleted', { quarterId: quarter.id, entryId: deletedEntry.id, pastorName: deletedEntry.name, description: `${deletedEntry.name} was moved to the Recycle Bin from ${quarter.id}` });
    // Renumber remaining pastors
    quarter.entries.forEach((e, i) => {
      e.number = i + 1;
      e.rawName = `${e.number}. ${e.name}`;
    });

    await writeDB(db);
    res.json({ message: 'Pastor moved to Recycle Bin', removed: deletedEntry });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 8. POST bulk update support status
app.post('/api/quarters/:quarterId/bulk', requireStaff, async (req, res) => {
  try {
    const { monthKey, action } = req.body; // monthKey: 'm1' | 'm2' | 'm3' | 'all', action: 'check' | 'uncheck'
    const db = normalizeDB(await readDB());
    const quarter = db.quarters.find(q => q.id === req.params.quarterId);
    if (!quarter) return res.status(404).json({ error: 'Quarter not found' });

    const val = action === 'check' ? '✓' : '';
    const now = new Date().toISOString();
    quarter.entries.forEach(e => {
      if (monthKey === 'all') {
        e.m1 = val;
        e.m2 = val;
        e.m3 = val;
      } else if (['m1', 'm2', 'm3'].includes(monthKey)) {
        e[monthKey] = val;
      }
      e.updatedAt = now;
    });

    addAudit(db, req, 'Bulk Support Updated', { quarterId: quarter.id, monthKey, action, description: `${action === 'check' ? 'Marked' : 'Cleared'} ${monthKey} for all pastors in ${quarter.id}` });
    await writeDB(db);
    res.json({ message: 'Bulk update applied', quarter });
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
      const entry = quarter.entries.find(e => e.id === u.id);
      if (!entry) return;
      const before = { m1: entry.m1 || '', m2: entry.m2 || '', m3: entry.m3 || '', notes: entry.notes || '' };
      if (u.m1 !== undefined) entry.m1 = u.m1;
      if (u.m2 !== undefined) entry.m2 = u.m2;
      if (u.m3 !== undefined) entry.m3 = u.m3;
      if (u.notes !== undefined) entry.notes = u.notes;
      entry.updatedAt = now;

      ['m1','m2','m3','notes'].forEach(key => {
        const after = entry[key] ?? '';
        if (String(before[key]) !== String(after)) {
          const monthName = key === 'm1' ? quarter.months?.[0] : key === 'm2' ? quarter.months?.[1] : key === 'm3' ? quarter.months?.[2] : 'Notes';
          auditChanges.push({ pastorName: entry.name, field: monthName, from: before[key], to: after });
        }
      });
      updatedCount++;
    });

    if (auditChanges.length) {
      addAudit(db, req, 'Batch Support Updated', {
        quarterId: quarter.id,
        updatedCount,
        changes: auditChanges.map(c => ({ field: `${c.pastorName} — ${c.field}`, from: c.from, to: c.to })),
        description: `${auditChanges.length} status change(s) saved across ${updatedCount} pastor record(s) in ${quarter.id}`
      });
    }
    await writeDB(db);
    res.json({ message: 'Batch updates saved successfully', updatedCount, quarter, lastUpdated: db.lastUpdated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 9. Recycle Bin
app.get('/api/recycle-bin', requireStaff, async (req, res) => {
  try {
    const db = normalizeDB(await readDB());
    res.json({ recycleBin: db.recycleBin || [], lastUpdated: db.lastUpdated || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/recycle-bin/:entryId/restore', requireStaff, async (req, res) => {
  try {
    const db = normalizeDB(await readDB());
    const bin = ensureRecycleBin(db);
    const idx = bin.findIndex(e => e.id === req.params.entryId);
    if (idx === -1) return res.status(404).json({ error: 'Deleted pastor not found in Recycle Bin' });
    const item = bin[idx];
    const quarter = db.quarters.find(q => q.id === item.deletedFromQuarterId);
    if (!quarter) return res.status(404).json({ error: 'Original quarter no longer exists' });
    if (quarter.entries.some(e => e.id === item.id)) return res.status(400).json({ error: 'Pastor already exists in the original quarter' });
    const restored = { ...item };
    const originalNumber = Number(restored.deletedFromNumber) || (quarter.entries.length + 1);
    delete restored.deletedAt;
    delete restored.deletedFromQuarterId;
    delete restored.deletedFromQuarterTitle;
    delete restored.deletedFromNumber;
    restored.pastorType = normalizePastorType(restored.pastorType);
    const insertAt = Math.max(0, Math.min(originalNumber - 1, quarter.entries.length));
    quarter.entries.splice(insertAt, 0, restored);
    quarter.entries.forEach((e, i) => { e.number = i + 1; e.rawName = `${e.number}. ${e.name}`; });
    restored.updatedAt = new Date().toISOString();
    bin.splice(idx, 1);
    addAudit(db, req, 'Pastor Restored', { quarterId: quarter.id, entryId: restored.id, pastorName: restored.name, description: `${restored.name} was restored to ${quarter.id}` });
    await writeDB(db);
    res.json({ message: 'Pastor restored successfully', restored, quarterId: quarter.id, lastUpdated: db.lastUpdated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/recycle-bin/:entryId', requireStaff, async (req, res) => {
  try {
    const db = normalizeDB(await readDB());
    const bin = ensureRecycleBin(db);
    const idx = bin.findIndex(e => e.id === req.params.entryId);
    if (idx === -1) return res.status(404).json({ error: 'Deleted pastor not found in Recycle Bin' });
    const removed = bin.splice(idx, 1)[0];
    addAudit(db, req, 'Pastor Permanently Deleted', { quarterId: removed.deletedFromQuarterId, entryId: removed.id, pastorName: removed.name, description: `${removed.name} was permanently deleted from the Recycle Bin` });
    await writeDB(db);
    res.json({ message: 'Pastor permanently deleted', removed, lastUpdated: db.lastUpdated });
  } catch (err) {
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
    await writeDB(db);
    res.json({ message: 'Database reset to original PowerPoint reference successfully', quartersCount: db.quarters.length });
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
    const buffer = await pptx.write({ outputType: 'nodebuffer' });
    const filename = `Mission_Support_${q.id}.pptx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
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
    const buffer = await pptx.write({ outputType: 'nodebuffer' });
    const label = ids.length === 1 ? ids[0] : `${quarterList[0].year}-${quarterList[quarterList.length - 1].year}`;
    const filename = `Mission_Support_Report_${label}.pptx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
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
    const buffer = await pptx.write({ outputType: 'nodebuffer' });
    const filename = 'Mission_Support_All_Quarters.pptx';

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (err) {
    console.error('Export error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 13. Download JSON backup
app.get('/api/backup', requireStaff, async (req, res) => {
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
