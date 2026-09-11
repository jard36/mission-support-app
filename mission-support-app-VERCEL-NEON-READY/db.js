const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'mission_support_db.json');
const BACKUP_PATH = path.join(__dirname, 'data', 'mission_support_db.backup.json');

let sql = null;
let dbReady = false;
let dbInitPromise = null;

function hasNeon() {
  return Boolean(process.env.DATABASE_URL);
}

async function getSql() {
  if (!hasNeon()) return null;
  if (!sql) {
    const { neon } = require('@neondatabase/serverless');
    sql = neon(process.env.DATABASE_URL);
  }
  return sql;
}

function readJsonDB() {
  if (!fs.existsSync(DB_PATH)) {
    if (fs.existsSync(BACKUP_PATH)) {
      fs.copyFileSync(BACKUP_PATH, DB_PATH);
    } else {
      return { quarters: [], summaryNotes: [], auditTrail: [] };
    }
  }
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

function writeJsonDB(data) {
  data.lastUpdated = new Date().toISOString();
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf8');
}

async function ensureNeon() {
  const database = await getSql();
  if (!database) return null;
  if (dbReady) return database;
  if (!dbInitPromise) {
    dbInitPromise = (async () => {
      await database`
        CREATE TABLE IF NOT EXISTS mission_support_state (
          id INTEGER PRIMARY KEY,
          data JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;

      const rows = await database`SELECT id FROM mission_support_state WHERE id = 1 LIMIT 1`;
      if (!rows.length) {
        const initial = readJsonDB();
        await database`
          INSERT INTO mission_support_state (id, data, updated_at)
          VALUES (1, ${JSON.stringify(initial)}::jsonb, NOW())
        `;
      }
      dbReady = true;
      return database;
    })().catch(err => {
      dbInitPromise = null;
      throw err;
    });
  }
  return dbInitPromise;
}

async function readDB() {
  const database = await ensureNeon();
  if (!database) return readJsonDB();
  const rows = await database`SELECT data FROM mission_support_state WHERE id = 1 LIMIT 1`;
  if (!rows.length) throw new Error('Mission support database is not initialized.');
  return rows[0].data;
}

async function writeDB(data) {
  data.lastUpdated = new Date().toISOString();
  const database = await ensureNeon();
  if (!database) {
    writeJsonDB(data);
    return data;
  }
  await database`
    UPDATE mission_support_state
    SET data = ${JSON.stringify(data)}::jsonb, updated_at = NOW()
    WHERE id = 1
  `;
  return data;
}

async function resetDB() {
  const backup = readJsonDBFromBackup();
  const current = await readDB();
  backup.auditTrail = current.auditTrail || [];
  return writeDB(backup);
}

function readJsonDBFromBackup() {
  if (!fs.existsSync(BACKUP_PATH)) throw new Error('Backup file not found');
  return JSON.parse(fs.readFileSync(BACKUP_PATH, 'utf8'));
}

function getDatabaseMode() {
  return hasNeon() ? 'neon-postgres' : 'local-json';
}

module.exports = { readDB, writeDB, resetDB, getDatabaseMode, DB_PATH, BACKUP_PATH };
