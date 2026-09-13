const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
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

function ensureAuditTrail(db) {
  if (!Array.isArray(db.auditTrail)) db.auditTrail = [];
  return db.auditTrail;
}

function addAudit(db, req, action, details = {}) {
  const auditTrail = ensureAuditTrail(db);
  auditTrail.unshift({
    id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    actor: req.body?.actor || req.headers['x-user-name'] || 'Local User',
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
      const total = q.entries.length;
      const countM1 = q.entries.filter(e => e.m1 && e.m1.includes('✓')).length;
      const countM2 = q.entries.filter(e => e.m2 && e.m2.includes('✓')).length;
      const countM3 = q.entries.filter(e => e.m3 && e.m3.includes('✓')).length;
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
    res.json(q);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. POST new quarter
app.post('/api/quarters', async (req, res) => {
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
app.delete('/api/quarters/:id', async (req, res) => {
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
app.post('/api/quarters/:quarterId/entries', async (req, res) => {
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
app.put('/api/quarters/:quarterId/entries/:entryId', async (req, res) => {
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
app.delete('/api/quarters/:quarterId/entries/:entryId', async (req, res) => {
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
app.post('/api/quarters/:quarterId/bulk', async (req, res) => {
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
app.post('/api/quarters/:quarterId/batch-save', async (req, res) => {
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
app.get('/api/recycle-bin', async (req, res) => {
  try {
    const db = normalizeDB(await readDB());
    res.json({ recycleBin: db.recycleBin || [], lastUpdated: db.lastUpdated || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/recycle-bin/:entryId/restore', async (req, res) => {
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

app.delete('/api/recycle-bin/:entryId', async (req, res) => {
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
app.get('/api/audit-trail', async (req, res) => {
  try {
    const db = normalizeDB(await readDB());
    res.json({ auditTrail: db.auditTrail || [], lastUpdated: db.lastUpdated || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 9. Reset DB to original backup
app.post('/api/reset', async (req, res) => {
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
app.get('/api/health', async (req, res) => {
  try {
    const db = normalizeDB(await readDB());
    res.json({ ok: true, database: getDatabaseMode(), quarters: db.quarters?.length || 0, lastUpdated: db.lastUpdated || null });
  } catch (err) {
    res.status(500).json({ ok: false, database: getDatabaseMode(), error: err.message });
  }
});

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
          { text: nameLabel, options: { fontSize: 20, color: 'FFFFFF', fill: { color: rowBg }, bold: true, align: 'left', valign: 'middle', fit: 'shrink', margin: 0.08 } },
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
    const q = db.quarters.find(x => x.id === req.params.quarterId);
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
    const pptx = await buildPptx(db.quarters, { pastorType: req.query.pastorType || 'All', statusFilter: req.query.statusFilter || 'All', latestQuarterId: latestId });
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
app.get('/api/backup', async (req, res) => {
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
