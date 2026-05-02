require('dotenv').config()
const express = require('express')
const path = require('path')
const fs = require('fs')
const multer = require('multer')
const { db, ensureStandardPoints, getPointCost, isAdvanceBooking, owners, getSetting, getAllSettings, setSetting } = require('./database')
const { sendNotification } = require('./mailer')

function fmtDateEmail(dateStr) {
  return new Date(dateStr.slice(0, 10) + 'T12:00:00')
    .toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' })
}

const DB_DIR = process.env.DB_DIR || path.join(__dirname, 'data')
const DOCS_DIR = process.env.DOCS_DIR || path.join(DB_DIR, 'documents')
const DEDICATED_DIR = path.join(DOCS_DIR, 'dedicated')
const INVOICES_DIR = path.join(DOCS_DIR, 'invoices')
const REPORTS_DIR = path.join(DOCS_DIR, 'reports')
fs.mkdirSync(DEDICATED_DIR, { recursive: true })
fs.mkdirSync(INVOICES_DIR, { recursive: true })
fs.mkdirSync(REPORTS_DIR, { recursive: true })

const GATE_USER = (process.env.GATE_USER || 'white').toLowerCase()
const GATE_PASS = (process.env.GATE_PASS || 'horse').toLowerCase()

function parseCookies(req) {
  const cookies = {}
  ;(req.headers.cookie || '').split(';').forEach(c => {
    const [k, v] = c.trim().split('=')
    if (k) cookies[k.trim()] = (v || '').trim()
  })
  return cookies
}

const app = express()
app.use(express.json())

// ---- Gate middleware ----
const GATE_PUBLIC = new Set(['/login.html', '/styles.css', '/api/login'])
app.use((req, res, next) => {
  if (GATE_PUBLIC.has(req.path)) return next()
  if (req.path.startsWith('/images/')) return next()
  if (parseCookies(req)['sp_auth'] === 'granted') return next()
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' })
  res.redirect('/login.html')
})

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {}
  if ((username || '').toLowerCase() === GATE_USER && (password || '').toLowerCase() === GATE_PASS) {
    res.setHeader('Set-Cookie', `sp_auth=granted; Path=/; Max-Age=${30 * 24 * 60 * 60}; HttpOnly; SameSite=Strict`)
    return res.json({ success: true })
  }
  res.json({ success: false })
})

app.get('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'sp_auth=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict')
  res.redirect('/login.html')
})

app.use(express.static(path.join(__dirname, 'public')))
app.use('/uploads', express.static(DOCS_DIR))

const reportUpload = multer({
  storage: multer.diskStorage({
    destination: REPORTS_DIR,
    filename: (req, file, cb) => {
      const unique = Date.now() + '-' + Math.round(Math.random() * 1e9)
      cb(null, unique + path.extname(file.originalname))
    }
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf']
    cb(null, allowed.includes(file.mimetype))
  }
})

const dedicatedUpload = multer({
  storage: multer.diskStorage({
    destination: DEDICATED_DIR,
    filename: (req, file, cb) => cb(null, file.originalname)
  }),
  limits: { fileSize: 20 * 1024 * 1024 }
})

const invoiceUpload = multer({
  storage: multer.diskStorage({
    destination: INVOICES_DIR,
    filename: (req, file, cb) => {
      const unique = Date.now() + '-' + Math.round(Math.random() * 1e9)
      cb(null, unique + path.extname(file.originalname))
    }
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, file.mimetype === 'application/pdf')
})

// Get all bookings for a given month
app.get('/api/bookings/:year/:month', (req, res) => {
  const { year, month } = req.params
  ensureStandardPoints(parseInt(year), parseInt(month))

  const bookings = db.prepare(`
    SELECT *,
      CASE WHEN date > date('now', 'localtime', '+60 days') THEN 'advance' ELSE 'standard' END AS booking_type
    FROM bookings
    WHERE strftime('%Y', date) = ? AND strftime('%m', date) = ?
    AND status = 'confirmed'
    ORDER BY date
  `).all(year, month.padStart(2, '0'))

  const serviceDays = db.prepare(`
    SELECT * FROM service_days
    WHERE strftime('%Y', date) = ? AND strftime('%m', date) = ?
    ORDER BY date
  `).all(year, month.padStart(2, '0'))

  const holidays = db.prepare(
    `SELECT * FROM public_holidays ORDER BY date`
  ).all()

  res.json({ bookings, serviceDays, holidays })
})

// Get points summary for all owners for a given month
app.get('/api/points/:year/:month', (req, res) => {
  const { year, month } = req.params
  ensureStandardPoints(parseInt(year), parseInt(month))

  const yr = parseInt(year)
  const mo = parseInt(month)
  const monthPad = month.padStart(2, '0')

  const allocations = db.prepare(`
    SELECT * FROM standard_points WHERE year = ? AND month = ?
  `).all(yr, mo)

  const advanceAllocations = db.prepare(`SELECT * FROM advance_credits`).all()

  const standard = allocations.map(row => {
    const { used } = db.prepare(`
      SELECT COALESCE(SUM(points_cost), 0) as used FROM bookings
      WHERE owner_initials = ? AND status = 'confirmed'
      AND strftime('%Y', date) = ? AND strftime('%m', date) = ?
    `).get(row.owner_initials, year, monthPad)
    return { ...row, points_used: used }
  })

  const advance = advanceAllocations.map(row => {
    const { used } = db.prepare(`
      SELECT COALESCE(SUM(points_cost), 0) as used FROM bookings
      WHERE owner_initials = ? AND status = 'confirmed'
      AND date > date('now', 'localtime', '+60 days')
    `).get(row.owner_initials)
    return { ...row, credits_used: used }
  })

  res.json({ standard, advance })
})

// Make a booking
app.post('/api/bookings', (req, res) => {
  const { owner_initials, owner_name, date, notes } = req.body

  // Check date not already booked
  const existing = db.prepare(`
    SELECT id FROM bookings WHERE date = ? AND status = 'confirmed'
  `).get(date)
  if (existing) return res.status(400).json({ error: 'Date already booked' })

  // Check not a service day
  const serviceDay = db.prepare(`
    SELECT id FROM service_days WHERE date = ?
  `).get(date)
  if (serviceDay) return res.status(400).json({ error: 'Date is a service day' })

  const pointCost = getPointCost(date)
  const advance = isAdvanceBooking(date)
  const bookingDate = new Date(date + 'T12:00:00')
  const year = bookingDate.getFullYear()
  const month = bookingDate.getMonth() + 1

  ensureStandardPoints(year, month)

  // Per-month total cap: standard + advance combined cannot exceed allocation.
  // Within-48h bookings are exempt — they get the dollar-excess treatment instead.
  if (!isWithin48Hours(date)) {
    const stdRow = db.prepare(`SELECT * FROM standard_points WHERE owner_initials = ? AND year = ? AND month = ?`).get(owner_initials, year, month)
    const { monthTotal } = db.prepare(`
      SELECT COALESCE(SUM(points_cost), 0) as monthTotal FROM bookings
      WHERE owner_initials = ? AND status = 'confirmed'
      AND strftime('%Y', date) = ? AND strftime('%m', date) = ?
    `).get(owner_initials, String(year), String(month).padStart(2, '0'))
    const monthRemaining = stdRow.points_allocated - monthTotal
    if (monthRemaining < pointCost) {
      const monthName = new Date(year, month - 1, 1).toLocaleString('default', { month: 'long' })
      return res.status(400).json({ error: `Not enough ${monthName} credits. Need ${pointCost}, have ${monthRemaining}` })
    }
  }

  // Advance bookings additionally check the advance credit pool
  if (advance) {
    const advRow = db.prepare(`SELECT * FROM advance_credits WHERE owner_initials = ?`).get(owner_initials)
    const { used } = db.prepare(`
      SELECT COALESCE(SUM(points_cost), 0) as used FROM bookings
      WHERE owner_initials = ? AND status = 'confirmed'
      AND date > date('now', 'localtime', '+60 days')
    `).get(owner_initials)
    const remaining = advRow.credits_allocated - used
    if (remaining < pointCost) {
      return res.status(400).json({ error: `Not enough advance credits. Need ${pointCost}, have ${remaining}` })
    }
  }

  db.prepare(`
    INSERT INTO bookings (owner_initials, owner_name, date, points_cost, booking_type, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(owner_initials, owner_name, date, pointCost, advance ? 'advance' : 'standard', notes || null)

  sendNotification(`${owner_initials} made a booking for ${fmtDateEmail(date)}`).catch(console.error)
  res.json({ success: true, pointCost, bookingType: advance ? 'advance' : 'standard' })
})

// Helper: is this date today, tomorrow, or the day after?
// (Originally called "48-hour rule" but it's really a calendar-day window.)
function isWithin48Hours(dateStr) {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const target = new Date(dateStr + 'T12:00:00')
  target.setHours(0, 0, 0, 0)
  const diffDays = Math.round((target - today) / (1000 * 60 * 60 * 24))
  return diffDays >= 0 && diffDays <= 2
}

// Make multiple bookings atomically — either all succeed or none do
// Within 48 hours of a booking day, the owner may exceed their standard-point
// allocation; the shortfall is tracked in dollars on the honor system (not stored).
app.post('/api/bookings/batch', (req, res) => {
  const { owner_initials, owner_name, dates } = req.body

  if (!Array.isArray(dates) || dates.length === 0) {
    return res.status(400).json({ error: 'No dates provided' })
  }

  // Build a plan for each date: validate everything up front so we can bail cleanly
  const plan = []
  // Per-month totals covering ALL booking types — advance and standard both count toward the monthly cap
  const monthlyCapCheck = {}  // key "YYYY-M" → { mandatory, excessEligible }
  const advanceSpend = { total: 0 }

  for (const date of dates) {
    // Already booked?
    const existing = db.prepare(
      `SELECT id FROM bookings WHERE date = ? AND status = 'confirmed'`
    ).get(date)
    if (existing) return res.status(400).json({ error: `${date} is already booked` })

    // Service day?
    const svc = db.prepare(`SELECT id FROM service_days WHERE date = ?`).get(date)
    if (svc) return res.status(400).json({ error: `${date} is a service day` })

    const pointCost = getPointCost(date)
    const advance = isAdvanceBooking(date)
    const within48 = isWithin48Hours(date)
    const d = new Date(date + 'T12:00:00')
    const year = d.getFullYear()
    const month = d.getMonth() + 1

    ensureStandardPoints(year, month)
    plan.push({ date, pointCost, advance, within48, year, month })

    if (advance) advanceSpend.total += pointCost

    const key = `${year}-${month}`
    if (!monthlyCapCheck[key]) monthlyCapCheck[key] = { mandatory: 0, excessEligible: 0 }
    if (within48) monthlyCapCheck[key].excessEligible += pointCost
    else monthlyCapCheck[key].mandatory += pointCost
  }

  // Verify advance credit pool
  if (advanceSpend.total > 0) {
    const advRow = db.prepare(`SELECT * FROM advance_credits WHERE owner_initials = ?`).get(owner_initials)
    const { used } = db.prepare(`
      SELECT COALESCE(SUM(points_cost), 0) as used FROM bookings
      WHERE owner_initials = ? AND status = 'confirmed'
      AND date > date('now', 'localtime', '+60 days')
    `).get(owner_initials)
    const remaining = advRow.credits_allocated - used
    if (remaining < advanceSpend.total) {
      return res.status(400).json({ error: `Not enough advance credits. Need ${advanceSpend.total}, have ${remaining}` })
    }
  }

  // Per-month total cap: standard + advance combined cannot exceed allocation.
  // Within-48h bookings (excessEligible) are exempt — shortfall is dollar-charged.
  for (const key of Object.keys(monthlyCapCheck)) {
    const [yr, mo] = key.split('-').map(Number)
    const stdRow = db.prepare(
      `SELECT * FROM standard_points WHERE owner_initials = ? AND year = ? AND month = ?`
    ).get(owner_initials, yr, mo)
    const { monthTotal } = db.prepare(`
      SELECT COALESCE(SUM(points_cost), 0) as monthTotal FROM bookings
      WHERE owner_initials = ? AND status = 'confirmed'
      AND strftime('%Y', date) = ? AND strftime('%m', date) = ?
    `).get(owner_initials, String(yr), String(mo).padStart(2, '0'))
    const monthRemaining = stdRow.points_allocated - monthTotal
    const { mandatory } = monthlyCapCheck[key]

    if (mandatory > monthRemaining) {
      const monthName = new Date(yr, mo - 1, 1).toLocaleString('default', { month: 'long' })
      return res.status(400).json({ error: `Not enough ${monthName} credits. Need ${mandatory}, have ${monthRemaining}` })
    }
  }

  // All validated — commit as a single transaction (just inserts; pools are computed on read)
  const commit = db.transaction(() => {
    for (const p of plan) {
      db.prepare(
        `INSERT INTO bookings (owner_initials, owner_name, date, points_cost, booking_type, notes)
         VALUES (?, ?, ?, ?, ?, NULL)`
      ).run(owner_initials, owner_name, p.date, p.pointCost, p.advance ? 'advance' : 'standard')
    }
  })

  try {
    commit()
  } catch (err) {
    return res.status(500).json({ error: 'Booking failed: ' + err.message })
  }

  const dateList = plan.map(p => fmtDateEmail(p.date)).join(', ')
  sendNotification(`${owner_initials} made ${plan.length} booking${plan.length > 1 ? 's' : ''}: ${dateList}`).catch(console.error)
  res.json({ success: true, count: plan.length })
})

// Cancel a booking
app.delete('/api/bookings/:date', (req, res) => {
  const { date } = req.params
  const { owner_initials } = req.body

  const booking = db.prepare(`
    SELECT * FROM bookings WHERE date = ? AND status = 'confirmed'
  `).get(date)

  if (!booking) return res.status(404).json({ error: 'Booking not found' })
  if (booking.owner_initials !== owner_initials) {
    return res.status(403).json({ error: 'You can only cancel your own bookings' })
  }

  db.prepare(`
    UPDATE bookings SET status = 'cancelled' WHERE date = ?
  `).run(date)

  sendNotification(`${owner_initials} cancelled their booking for ${fmtDateEmail(date)}`).catch(console.error)
  res.json({ success: true })
})

// Add a service day
app.post('/api/service-days', (req, res) => {
  const { owner_initials, owner_name, date, notes } = req.body

  const existing = db.prepare(`
    SELECT id FROM bookings WHERE date = ? AND status = 'confirmed'
  `).get(date)
  if (existing) return res.status(400).json({ error: 'Date already has a booking' })

  db.prepare(`
    INSERT OR REPLACE INTO service_days (owner_initials, owner_name, date, notes)
    VALUES (?, ?, ?, ?)
  `).run(owner_initials, owner_name, date, notes || null)

  res.json({ success: true })
})

// Delete a service day
app.delete('/api/service-days/:date', (req, res) => {
  db.prepare(`DELETE FROM service_days WHERE date = ?`).run(req.params.date)
  res.json({ success: true })
})

// Atomically cancel any booking on a past date and mark it Out of Service.
// Any owner can do this regardless of who made the booking.
app.post('/api/convert-to-service-day', (req, res) => {
  const { date, requester_initials, requester_name } = req.body || {}
  if (!date || !requester_initials) {
    return res.status(400).json({ error: 'date and requester_initials are required' })
  }
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  if (new Date(date + 'T12:00:00') > today) {
    return res.status(400).json({ error: 'Cannot convert a future date to Out of Service this way' })
  }
  const booking = db.prepare(`SELECT * FROM bookings WHERE date = ? AND status = 'confirmed'`).get(date)
  const convert = db.transaction(() => {
    if (booking) {
      db.prepare(`UPDATE bookings SET status = 'cancelled' WHERE date = ?`).run(date)
    }
    db.prepare(`INSERT OR REPLACE INTO service_days (owner_initials, owner_name, date, notes) VALUES (?, ?, ?, ?)`)
      .run(requester_initials, requester_name || requester_initials, date, booking ? 'Converted from booking' : null)
  })
  convert()
  res.json({ success: true, bookingCancelled: !!booking, bookedBy: booking?.owner_initials || null })
})

// Get public holidays
app.get('/api/holidays', (req, res) => {
  const holidays = db.prepare(`SELECT * FROM public_holidays ORDER BY date`).all()
  res.json(holidays)
})

// Add a public holiday
app.post('/api/holidays', (req, res) => {
  const { date, name } = req.body
  db.prepare(`INSERT OR REPLACE INTO public_holidays (date, name) VALUES (?, ?)`).run(date, name)
  res.json({ success: true })
})

// Delete a public holiday
app.delete('/api/holidays/:date', (req, res) => {
  db.prepare(`DELETE FROM public_holidays WHERE date = ?`).run(req.params.date)
  res.json({ success: true })
})

app.get('/api/upcoming', (req, res) => {
  const now = new Date()
const today = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`

  const bookings = db.prepare(`
    SELECT owner_initials, owner_name, date, points_cost,
      CASE WHEN date > date('now', 'localtime', '+60 days') THEN 'advance' ELSE 'standard' END AS booking_type,
      'booking' as type
    FROM bookings
    WHERE status = 'confirmed' AND date >= ?
    ORDER BY date
  `).all(today)

  const serviceDays = db.prepare(`
    SELECT owner_initials, owner_name, date, 0 as points_cost, 'service' as booking_type, 'service' as type
    FROM service_days
    WHERE date >= ?
    ORDER BY date
  `).all(today)

  const combined = [...bookings, ...serviceDays]
    .sort((a, b) => a.date.localeCompare(b.date))

  res.json(combined)
})

// ---- Logbook ----

// List all logbook entries, newest first.
app.get('/api/logbook', (req, res) => {
  const entries = db.prepare(`
    SELECT entry_num, trip_date, skipper_initials, skipper_name,
           from_loc, to_loc, notes,
           fuel_start, fuel_finish,
           created_at
    FROM logbook
    ORDER BY entry_num DESC
  `).all()
  res.json(entries)
})

// Create a new logbook entry. entry_num is assigned automatically by SQLite.
// Fuel used and calculated cost are NOT stored — they're computed on the
// client from the current fuel rate, so changing the rate re-values history.
app.post('/api/logbook', (req, res) => {
  const {
    trip_date, skipper_initials, skipper_name,
    from_loc, to_loc, notes,
    fuel_start, fuel_finish
  } = req.body || {}

  if (!trip_date || !skipper_initials || !from_loc || !to_loc) {
    return res.status(400).json({ error: 'trip_date, skipper_initials, from_loc and to_loc are required' })
  }

  const start = Number(fuel_start)
  const finish = Number(fuel_finish)

  if (!Number.isFinite(start) || start < 0) {
    return res.status(400).json({ error: 'fuel_start must be a non-negative number' })
  }
  if (!Number.isFinite(finish) || finish < 0) {
    return res.status(400).json({ error: 'fuel_finish must be a non-negative number' })
  }

  const info = db.prepare(`
    INSERT INTO logbook
      (trip_date, skipper_initials, skipper_name, from_loc, to_loc, notes,
       fuel_start, fuel_finish)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    trip_date, skipper_initials, skipper_name || null,
    from_loc, to_loc, notes || null,
    start, finish
  )

  sendNotification(`${skipper_initials} added a logbook entry: ${fmtDateEmail(trip_date)}, ${from_loc} to ${to_loc}`).catch(console.error)
  res.json({ success: true, entry_num: info.lastInsertRowid })
})

app.put('/api/logbook/:entry_num', (req, res) => {
  const { trip_date, skipper_initials, skipper_name, from_loc, to_loc, notes, fuel_start, fuel_finish } = req.body || {}
  if (!trip_date || !skipper_initials || !from_loc || !to_loc) {
    return res.status(400).json({ error: 'trip_date, skipper_initials, from_loc and to_loc are required' })
  }
  const start = Number(fuel_start)
  const finish = Number(fuel_finish)
  if (!Number.isFinite(start) || start < 0 || !Number.isFinite(finish) || finish < 0) {
    return res.status(400).json({ error: 'fuel values must be non-negative numbers' })
  }
  const result = db.prepare(`
    UPDATE logbook SET trip_date=?, skipper_initials=?, skipper_name=?, from_loc=?, to_loc=?, notes=?, fuel_start=?, fuel_finish=?
    WHERE entry_num=?
  `).run(trip_date, skipper_initials, skipper_name || null, from_loc, to_loc, notes || null, start, finish, req.params.entry_num)
  if (result.changes === 0) return res.status(404).json({ error: 'Entry not found' })
  res.json({ success: true })
})

// ---- Reports ----

app.get('/api/reports', (req, res) => {
  const reports = db.prepare(`SELECT * FROM reports ORDER BY report_date DESC, created_at DESC`).all()
  const replies = db.prepare(`SELECT * FROM report_replies ORDER BY created_at ASC`).all()
  const attachments = db.prepare(`SELECT * FROM report_attachments ORDER BY created_at ASC`).all()
  const replyMap = {}
  for (const r of replies) {
    if (!replyMap[r.report_id]) replyMap[r.report_id] = []
    replyMap[r.report_id].push(r)
  }
  const reportAttachMap = {}
  const replyAttachMap = {}
  for (const a of attachments) {
    if (a.reply_id) {
      if (!replyAttachMap[a.reply_id]) replyAttachMap[a.reply_id] = []
      replyAttachMap[a.reply_id].push(a)
    } else {
      if (!reportAttachMap[a.report_id]) reportAttachMap[a.report_id] = []
      reportAttachMap[a.report_id].push(a)
    }
  }
  res.json(reports.map(r => ({
    ...r,
    attachments: reportAttachMap[r.id] || [],
    replies: (replyMap[r.id] || []).map(rep => ({ ...rep, attachments: replyAttachMap[rep.id] || [] }))
  })))
})

app.post('/api/reports', (req, res) => {
  const { type, author_initials, author_name, body, report_date } = req.body || {}
  if (!type || !author_initials || !body || !report_date) {
    return res.status(400).json({ error: 'type, author_initials, body and report_date are required' })
  }
  if (!['service', 'damage'].includes(type)) {
    return res.status(400).json({ error: 'type must be service or damage' })
  }
  const info = db.prepare(
    `INSERT INTO reports (type, author_initials, author_name, body, report_date) VALUES (?, ?, ?, ?, ?)`
  ).run(type, author_initials, author_name || author_initials, body.trim(), report_date)
  const reportSnippet = body.trim().length > 100 ? body.trim().slice(0, 100) + '…' : body.trim()
  sendNotification(`${author_initials} submitted a ${type} report: ${reportSnippet}`).catch(console.error)
  res.json({ success: true, id: info.lastInsertRowid })
})

app.put('/api/reports/:id', (req, res) => {
  const { body, author_initials } = req.body || {}
  const report = db.prepare(`SELECT * FROM reports WHERE id = ?`).get(req.params.id)
  if (!report) return res.status(404).json({ error: 'Report not found' })
  if (report.author_initials !== author_initials) return res.status(403).json({ error: 'Cannot edit another owner\'s report' })
  if (!body || !body.trim()) return res.status(400).json({ error: 'body is required' })
  db.prepare(`UPDATE reports SET body = ? WHERE id = ?`).run(body.trim(), req.params.id)
  res.json({ success: true })
})

app.put('/api/reports/:id/complete', (req, res) => {
  const report = db.prepare(`SELECT * FROM reports WHERE id = ?`).get(req.params.id)
  if (!report) return res.status(404).json({ error: 'Report not found' })
  db.prepare(`UPDATE reports SET status = 'complete' WHERE id = ?`).run(req.params.id)
  res.json({ success: true })
})

app.post('/api/reports/:id/replies', (req, res) => {
  const { author_initials, author_name, body } = req.body || {}
  if (!author_initials || !body || !body.trim()) {
    return res.status(400).json({ error: 'author_initials and body are required' })
  }
  const report = db.prepare(`SELECT id FROM reports WHERE id = ?`).get(req.params.id)
  if (!report) return res.status(404).json({ error: 'Report not found' })
  const info = db.prepare(
    `INSERT INTO report_replies (report_id, author_initials, author_name, body) VALUES (?, ?, ?, ?)`
  ).run(req.params.id, author_initials, author_name || author_initials, body.trim())
  res.json({ success: true, id: info.lastInsertRowid })
})

app.post('/api/reports/:id/attachments', reportUpload.single('file'), (req, res) => {
  const { uploaded_by } = req.body || {}
  if (!req.file) return res.status(400).json({ error: 'No file provided' })
  if (!uploaded_by) return res.status(400).json({ error: 'uploaded_by is required' })
  const report = db.prepare(`SELECT id FROM reports WHERE id = ?`).get(req.params.id)
  if (!report) return res.status(404).json({ error: 'Report not found' })
  const info = db.prepare(
    `INSERT INTO report_attachments (report_id, filename, original_name, uploaded_by) VALUES (?, ?, ?, ?)`
  ).run(req.params.id, req.file.filename, req.file.originalname, uploaded_by)
  res.json({ success: true, id: info.lastInsertRowid })
})

app.post('/api/reports/:id/replies/:replyId/attachments', reportUpload.single('file'), (req, res) => {
  const { uploaded_by } = req.body || {}
  if (!req.file) return res.status(400).json({ error: 'No file provided' })
  if (!uploaded_by) return res.status(400).json({ error: 'uploaded_by is required' })
  const reply = db.prepare(`SELECT id FROM report_replies WHERE id = ? AND report_id = ?`).get(req.params.replyId, req.params.id)
  if (!reply) return res.status(404).json({ error: 'Reply not found' })
  const info = db.prepare(
    `INSERT INTO report_attachments (report_id, reply_id, filename, original_name, uploaded_by) VALUES (?, ?, ?, ?, ?)`
  ).run(req.params.id, req.params.replyId, req.file.filename, req.file.originalname, uploaded_by)
  res.json({ success: true, id: info.lastInsertRowid })
})

app.delete('/api/reports/:id/attachments/:attachmentId', (req, res) => {
  const { requester_initials } = req.body || {}
  const att = db.prepare(`SELECT * FROM report_attachments WHERE id = ? AND report_id = ?`).get(req.params.attachmentId, req.params.id)
  if (!att) return res.status(404).json({ error: 'Attachment not found' })
  if (att.uploaded_by !== requester_initials) return res.status(403).json({ error: 'Cannot delete another owner\'s attachment' })
  const filePath = path.join(REPORTS_DIR, att.filename)
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
  db.prepare(`DELETE FROM report_attachments WHERE id = ?`).run(req.params.attachmentId)
  res.json({ success: true })
})

// ---- Todos ----

app.get('/api/todos', (req, res) => {
  const all = req.query.all === '1'
  const todos = all
    ? db.prepare(`SELECT * FROM todos ORDER BY created_at DESC`).all()
    : db.prepare(`
        SELECT * FROM todos
        WHERE done_at IS NULL OR done_at >= datetime('now', '-7 days')
        ORDER BY created_at DESC
      `).all()
  res.json(todos)
})

app.post('/api/todos', (req, res) => {
  const { entered_by, entered_by_name, item, assigned_to } = req.body || {}
  if (!entered_by || !entered_by.trim()) return res.status(400).json({ error: 'entered_by is required' })
  if (!item || !item.trim()) return res.status(400).json({ error: 'item is required' })
  const info = db.prepare(`
    INSERT INTO todos (entered_by, entered_by_name, item, assigned_to)
    VALUES (?, ?, ?, ?)
  `).run(entered_by.trim(), entered_by_name || entered_by.trim(), item.trim(), assigned_to || null)
  const assignedNote = assigned_to ? `, assigned to ${assigned_to}` : ''
  sendNotification(`${entered_by} added a to-do item: ${item.trim()}${assignedNote}`).catch(console.error)
  res.json({ success: true, id: info.lastInsertRowid })
})

app.put('/api/todos/:id', (req, res) => {
  const { item, assigned_to, editor_initials } = req.body || {}
  const todo = db.prepare(`SELECT * FROM todos WHERE id = ?`).get(req.params.id)
  if (!todo) return res.status(404).json({ error: 'Todo not found' })
  if (todo.entered_by !== editor_initials) return res.status(403).json({ error: "Cannot edit another owner's todo" })
  if (!item || !item.trim()) return res.status(400).json({ error: 'item is required' })
  db.prepare(`UPDATE todos SET item = ?, assigned_to = ? WHERE id = ?`)
    .run(item.trim(), assigned_to || null, req.params.id)
  res.json({ success: true })
})

app.put('/api/todos/:id/done', (req, res) => {
  const { done_by } = req.body || {}
  const todo = db.prepare(`SELECT * FROM todos WHERE id = ?`).get(req.params.id)
  if (!todo) return res.status(404).json({ error: 'Todo not found' })
  db.prepare(`UPDATE todos SET done_at = datetime('now'), done_by = ? WHERE id = ?`)
    .run(done_by || null, req.params.id)
  res.json({ success: true })
})

app.put('/api/todos/:id/undone', (req, res) => {
  const todo = db.prepare(`SELECT * FROM todos WHERE id = ?`).get(req.params.id)
  if (!todo) return res.status(404).json({ error: 'Todo not found' })
  db.prepare(`UPDATE todos SET done_at = NULL, done_by = NULL WHERE id = ?`).run(req.params.id)
  res.json({ success: true })
})

app.put('/api/todos/:id/assign', (req, res) => {
  const { assigned_to } = req.body || {}
  const todo = db.prepare(`SELECT * FROM todos WHERE id = ?`).get(req.params.id)
  if (!todo) return res.status(404).json({ error: 'Todo not found' })
  db.prepare(`UPDATE todos SET assigned_to = ? WHERE id = ?`).run(assigned_to || null, req.params.id)
  res.json({ success: true })
})

app.delete('/api/todos/:id', (req, res) => {
  const { requester_initials } = req.body || {}
  const todo = db.prepare(`SELECT * FROM todos WHERE id = ?`).get(req.params.id)
  if (!todo) return res.status(404).json({ error: 'Todo not found' })
  if (todo.entered_by !== requester_initials) return res.status(403).json({ error: "Cannot delete another owner's todo" })
  db.prepare(`DELETE FROM todos WHERE id = ?`).run(req.params.id)
  res.json({ success: true })
})

// ---- Documents ----

app.get('/api/documents/dedicated', (req, res) => {
  try {
    const files = fs.readdirSync(DEDICATED_DIR)
      .filter(f => !f.startsWith('.'))
      .sort()
      .map(f => ({
        name: path.basename(f, path.extname(f)),
        filename: f,
        ext: path.extname(f).toLowerCase(),
        url: `/uploads/dedicated/${encodeURIComponent(f)}`
      }))
    res.json(files)
  } catch (err) {
    res.json([])
  }
})

app.post('/api/documents/dedicated', dedicatedUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' })
  res.json({ success: true, filename: req.file.filename })
})

app.delete('/api/documents/dedicated/:filename', (req, res) => {
  const filename = req.params.filename
  if (filename.includes('/') || filename.includes('..')) {
    return res.status(400).json({ error: 'Invalid filename' })
  }
  const filePath = path.join(DEDICATED_DIR, filename)
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' })
  fs.unlinkSync(filePath)
  res.json({ success: true })
})

app.get('/api/invoices', (req, res) => {
  const invoices = db.prepare(`SELECT * FROM invoices ORDER BY invoice_date DESC, created_at DESC`).all()
  res.json(invoices)
})

app.post('/api/invoices', invoiceUpload.single('file'), (req, res) => {
  const { invoice_date, vendor, category, amount, description } = req.body || {}
  if (!invoice_date || !vendor || !category || !amount) {
    if (req.file) fs.unlinkSync(req.file.path)
    return res.status(400).json({ error: 'invoice_date, vendor, category and amount are required' })
  }
  const amt = Number(amount)
  if (!Number.isFinite(amt) || amt < 0) {
    if (req.file) fs.unlinkSync(req.file.path)
    return res.status(400).json({ error: 'amount must be a non-negative number' })
  }
  const info = db.prepare(`
    INSERT INTO invoices (invoice_date, vendor, category, amount, description, filename, original_name)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(invoice_date, vendor.trim(), category, amt, description?.trim() || null,
        req.file ? req.file.filename : null,
        req.file ? req.file.originalname : null)
  res.json({ success: true, id: info.lastInsertRowid })
})

app.delete('/api/invoices/:id', (req, res) => {
  const inv = db.prepare(`SELECT * FROM invoices WHERE id = ?`).get(req.params.id)
  if (!inv) return res.status(404).json({ error: 'Invoice not found' })
  if (inv.filename) {
    const filePath = path.join(INVOICES_DIR, inv.filename)
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
  }
  db.prepare(`DELETE FROM invoices WHERE id = ?`).run(req.params.id)
  res.json({ success: true })
})

// ---- Monthly Report ----

app.get('/api/monthly-report/:year/:month', (req, res) => {
  const year = parseInt(req.params.year)
  const month = parseInt(req.params.month)

  ensureStandardPoints(year, month)

  const excessCostPerPoint = Number(db.prepare(`SELECT value FROM settings WHERE key = 'excess_cost_per_point'`).get()?.value || 5)
  const fuelPricePerLitre = Number(db.prepare(`SELECT value FROM settings WHERE key = 'fuel_price_per_litre'`).get()?.value || 3.35)

  const standardAllocations = db.prepare(`
    SELECT * FROM standard_points WHERE year = ? AND month = ?
  `).all(year, month)

  const monthPadMR = String(month).padStart(2, '0')

  const pointUsage = owners.map(o => {
    const alloc = standardAllocations.find(p => p.owner_initials === o.initials) || { points_allocated: 210 }
    const { points_used } = db.prepare(`
      SELECT COALESCE(SUM(points_cost), 0) as points_used FROM bookings
      WHERE owner_initials = ? AND status = 'confirmed'
      AND strftime('%Y', date) = ? AND strftime('%m', date) = ?
    `).get(o.initials, String(year), monthPadMR)
    const excessPoints = Math.max(0, points_used - alloc.points_allocated)
    return {
      owner_initials: o.initials,
      owner_name: o.name,
      points_used,
      points_allocated: alloc.points_allocated,
      excess_points: excessPoints,
      excess_due: excessPoints * excessCostPerPoint
    }
  })

  const logbookEntries = db.prepare(`
    SELECT * FROM logbook
    WHERE strftime('%Y', trip_date) = ? AND strftime('%m', trip_date) = ?
    ORDER BY entry_num ASC
  `).all(String(year), String(month).padStart(2, '0'))

  const enrichedEntries = logbookEntries.map(e => {
    const fuelUsed = Math.max(0, Number(e.fuel_start) - Number(e.fuel_finish))
    return { ...e, fuel_used: fuelUsed, fuel_cost: fuelUsed * fuelPricePerLitre, rate_per_litre: fuelPricePerLitre }
  })

  const totalCosts = pointUsage.map(pu => {
    const fuelDue = enrichedEntries
      .filter(e => e.skipper_initials === pu.owner_initials)
      .reduce((sum, e) => sum + e.fuel_cost, 0)
    return { owner_initials: pu.owner_initials, owner_name: pu.owner_name, excess_due: pu.excess_due, fuel_due: fuelDue, total_cost: pu.excess_due + fuelDue }
  })

  res.json({ year, month, fuelPricePerLitre, excessCostPerPoint, pointUsage, logbookEntries: enrichedEntries, totalCosts })
})

// ---- Settings ----
app.get('/api/settings', (req, res) => {


  res.json(getAllSettings())
})

app.put('/api/settings', (req, res) => {
  const updates = req.body || {}
  const allowedKeys = new Set(['excess_cost_per_point', 'fuel_price_per_litre'])
  for (const key of Object.keys(updates)) {
    if (!allowedKeys.has(key)) {
      return res.status(400).json({ error: `Unknown setting: ${key}` })
    }
  }
  // Validate excess_cost_per_point is a non-negative number
  if ('excess_cost_per_point' in updates) {
    const n = Number(updates.excess_cost_per_point)
    if (!Number.isFinite(n) || n < 0) {
      return res.status(400).json({ error: 'excess_cost_per_point must be a non-negative number' })
    }
    setSetting('excess_cost_per_point', n)
  }
  // Validate fuel_price_per_litre is a non-negative number
  if ('fuel_price_per_litre' in updates) {
    const n = Number(updates.fuel_price_per_litre)
    if (!Number.isFinite(n) || n < 0) {
      return res.status(400).json({ error: 'fuel_price_per_litre must be a non-negative number' })
    }
    setSetting('fuel_price_per_litre', n)
  }
  res.json({ success: true, settings: getAllSettings() })
})

// ---- Admin ----

app.get('/admin/backup', (req, res) => {
  const dbDir = process.env.DB_DIR || path.join(__dirname, 'data')
  const dbPath = path.join(dbDir, 'sloaney.db')

  try {
    const mode = db.pragma('journal_mode', { simple: true })
    if (mode === 'wal') db.pragma('wal_checkpoint(FULL)')
  } catch (e) {
    // Not in WAL mode or checkpoint failed — safe to continue
  }

  const date = new Date().toISOString().slice(0, 10)
  res.download(dbPath, `sloaney-backup-${date}.db`)
})

const PORT = process.env.PORT || 3001
app.listen(PORT, () => {
  console.log(`Sloaney Pony running at http://localhost:${PORT}`)
})