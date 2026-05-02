const Database = require('better-sqlite3')
const path = require('path')

const DB_DIR = process.env.DB_DIR || path.join(__dirname, 'data')
const db = new Database(path.join(DB_DIR, 'sloaney.db'))

db.exec(`
  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_initials TEXT NOT NULL,
    owner_name TEXT NOT NULL,
    date TEXT NOT NULL,
    points_cost INTEGER NOT NULL,
    booking_type TEXT NOT NULL DEFAULT 'standard',
    status TEXT NOT NULL DEFAULT 'confirmed',
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS standard_points (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_initials TEXT NOT NULL,
    year INTEGER NOT NULL,
    month INTEGER NOT NULL,
    points_allocated INTEGER NOT NULL DEFAULT 210,
    points_used INTEGER NOT NULL DEFAULT 0,
    UNIQUE(owner_initials, year, month)
  );

  CREATE TABLE IF NOT EXISTS advance_credits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_initials TEXT NOT NULL UNIQUE,
    credits_allocated INTEGER NOT NULL DEFAULT 210,
    credits_used INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS public_holidays (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS service_days (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL UNIQUE,
    owner_initials TEXT NOT NULL,
    owner_name TEXT NOT NULL,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

CREATE TABLE IF NOT EXISTS logbook (
    entry_num INTEGER PRIMARY KEY AUTOINCREMENT,
    trip_date TEXT NOT NULL,
    skipper_initials TEXT NOT NULL,
    skipper_name TEXT,
    from_loc TEXT NOT NULL,
    to_loc TEXT NOT NULL,
    notes TEXT,
    fuel_start REAL NOT NULL,
    fuel_finish REAL NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_date TEXT NOT NULL,
    vendor TEXT NOT NULL,
    category TEXT NOT NULL,
    amount REAL NOT NULL,
    description TEXT,
    filename TEXT,
    original_name TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL DEFAULT 'service',
    author_initials TEXT NOT NULL,
    author_name TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    report_date TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS report_replies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id INTEGER NOT NULL,
    author_initials TEXT NOT NULL,
    author_name TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS report_attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id INTEGER NOT NULL,
    reply_id INTEGER,
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    uploaded_by TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS todos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    entered_by TEXT NOT NULL,
    entered_by_name TEXT,
    item TEXT NOT NULL,
    assigned_to TEXT,
    done_at TEXT,
    done_by TEXT
  );
`)

// ---- Migration: add reply_id to report_attachments if missing ----
try {
  db.exec(`ALTER TABLE report_attachments ADD COLUMN reply_id INTEGER`)
} catch (e) { /* column already exists — safe to ignore */ }

// ---- Migration: drop old UNIQUE constraint on bookings.date ----
// The original schema had `date TEXT NOT NULL UNIQUE`, which blocks new
// bookings on a date that has any cancelled row. We rebuild the table
// without the column-level UNIQUE, and add a partial unique index so
// only confirmed bookings conflict.
function needsMigration() {
  const row = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='bookings'`
  ).get()
  return row && /date\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(row.sql)
}

if (needsMigration()) {
  console.log('Migrating bookings table — removing UNIQUE(date) constraint…')
  db.exec(`
    BEGIN;
    CREATE TABLE bookings_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_initials TEXT NOT NULL,
      owner_name TEXT NOT NULL,
      date TEXT NOT NULL,
      points_cost INTEGER NOT NULL,
      booking_type TEXT NOT NULL DEFAULT 'standard',
      status TEXT NOT NULL DEFAULT 'confirmed',
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    INSERT INTO bookings_new
      (id, owner_initials, owner_name, date, points_cost, booking_type, status, notes, created_at)
      SELECT id, owner_initials, owner_name, date, points_cost, booking_type, status, notes, created_at
      FROM bookings;
    DROP TABLE bookings;
    ALTER TABLE bookings_new RENAME TO bookings;
    COMMIT;
  `)
  console.log('Migration complete.')
}

// Partial unique index — safe to run every startup, only confirmed rows conflict
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_confirmed_date
    ON bookings(date) WHERE status = 'confirmed';
`)

const owners = [
  { initials: 'DR', name: 'Daniel Righetti' },
  { initials: 'LM', name: 'Larry McIntosh' },
  { initials: 'PO', name: 'Paul Oen' },
  { initials: 'PA', name: 'Peter Abery' }
]

function initAdvanceCredits() {
  for (const owner of owners) {
    db.prepare(`
      INSERT OR IGNORE INTO advance_credits (owner_initials, credits_allocated)
      VALUES (?, 210)
    `).run(owner.initials)
  }
}

function ensureStandardPoints(year, month) {
  for (const owner of owners) {
    db.prepare(`
      INSERT OR IGNORE INTO standard_points
        (owner_initials, year, month, points_allocated)
      VALUES (?, ?, ?, 210)
    `).run(owner.initials, year, month)
  }
}

function getPointCost(dateStr) {
  const date = new Date(dateStr + 'T12:00:00')
  const dow = date.getDay()
  const isHoliday = db.prepare(
    'SELECT id FROM public_holidays WHERE date = ?'
  ).get(dateStr)
  if (isHoliday) return 70
  if (dow === 5) return 30
  if (dow === 6 || dow === 0) return 50
  return 20
}

function isAdvanceBooking(dateStr) {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const bookingDate = new Date(dateStr + 'T12:00:00')
  const diffDays = Math.floor((bookingDate - today) / (1000 * 60 * 60 * 24))
  return diffDays > 60
}

// ---- Auto-fetch Western Australian public holidays ----
// Pulls from date.nager.at (free, no key, CORS-enabled) for the current year
// and the next two years, so the calendar always has ~2 years of runway.
// Only inserts missing rows — never modifies or deletes existing ones —
// so any manual entries the syndicate has added are preserved.
async function refreshPublicHolidays() {
  const now = new Date()
  const years = [now.getFullYear(), now.getFullYear() + 1, now.getFullYear() + 2]
  const insert = db.prepare(`INSERT OR IGNORE INTO public_holidays (date, name) VALUES (?, ?)`)
  let totalAdded = 0

  for (const year of years) {
    try {
      const res = await fetch(`https://date.nager.at/api/v3/publicholidays/${year}/AU`)
      if (!res.ok) {
        console.warn(`Holiday API returned ${res.status} for ${year}`)
        continue
      }
      const holidays = await res.json()
      // Keep only nationwide + WA-specific ones
      const relevant = holidays.filter(h => h.global || (h.counties || []).includes('AU-WA'))
      for (const h of relevant) {
        const result = insert.run(h.date, h.name)
        if (result.changes > 0) totalAdded++
      }
    } catch (err) {
      console.warn(`Failed to fetch holidays for ${year}: ${err.message}`)
    }
  }

  if (totalAdded > 0) {
    console.log(`Added ${totalAdded} public holiday(s).`)
  }
}

// ---- Settings (key-value) ----
const SETTING_DEFAULTS = {
  excess_cost_per_point: '5',
  fuel_price_per_litre: '3.35'
}

function seedSettings() {
  const stmt = db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`)
  for (const [k, v] of Object.entries(SETTING_DEFAULTS)) stmt.run(k, v)
}

function getSetting(key) {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key)
  return row ? row.value : null
}

function getAllSettings() {
  const rows = db.prepare(`SELECT key, value FROM settings`).all()
  const out = {}
  for (const r of rows) out[r.key] = r.value
  return out
}

function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value))
}

initAdvanceCredits()
seedSettings()

// Kick off holiday refresh on startup. Non-blocking — if the API is slow
// or unreachable, the server still starts normally.
refreshPublicHolidays().catch(err => {
  console.warn('Initial holiday refresh failed:', err.message)
})

// Belt-and-braces: also refresh once a week, in case the server runs
// for more than a year without a restart.
setInterval(() => {
  refreshPublicHolidays().catch(err => {
    console.warn('Scheduled holiday refresh failed:', err.message)
  })
}, 7 * 24 * 60 * 60 * 1000)

module.exports = {
  db,
  ensureStandardPoints,
  getPointCost,
  isAdvanceBooking,
  owners,
  getSetting,
  getAllSettings,
  setSetting,
  refreshPublicHolidays
}