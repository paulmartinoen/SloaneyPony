const express = require('express')
const path = require('path')
const { db, ensureStandardPoints, getPointCost, isAdvanceBooking, owners, getSetting, getAllSettings, setSetting } = require('./database')

const app = express()
app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

// Get all bookings for a given month
app.get('/api/bookings/:year/:month', (req, res) => {
  const { year, month } = req.params
  ensureStandardPoints(parseInt(year), parseInt(month))

  const bookings = db.prepare(`
    SELECT * FROM bookings
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

  const standard = db.prepare(`
    SELECT * FROM standard_points
    WHERE year = ? AND month = ?
  `).all(parseInt(year), parseInt(month))

  const advance = db.prepare(`
    SELECT * FROM advance_credits
  `).all()

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

  if (advance) {
    // Check advance credits
    const credits = db.prepare(`
      SELECT * FROM advance_credits WHERE owner_initials = ?
    `).get(owner_initials)
    const remaining = credits.credits_allocated - credits.credits_used
    if (remaining < pointCost) {
      return res.status(400).json({ error: `Not enough advance credits. Need ${pointCost}, have ${remaining}` })
    }
    db.prepare(`
      UPDATE advance_credits SET credits_used = credits_used + ? WHERE owner_initials = ?
    `).run(pointCost, owner_initials)
  } else {
    // Check standard points
    const pts = db.prepare(`
      SELECT * FROM standard_points WHERE owner_initials = ? AND year = ? AND month = ?
    `).get(owner_initials, year, month)
    const remaining = pts.points_allocated - pts.points_used
    if (remaining < pointCost) {
      return res.status(400).json({ error: `Not enough points. Need ${pointCost}, have ${remaining}` })
    }
    db.prepare(`
      UPDATE standard_points SET points_used = points_used + ?
      WHERE owner_initials = ? AND year = ? AND month = ?
    `).run(pointCost, owner_initials, year, month)
  }

  db.prepare(`
    INSERT INTO bookings (owner_initials, owner_name, date, points_cost, booking_type, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(owner_initials, owner_name, date, pointCost, advance ? 'advance' : 'standard', notes || null)

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
  // Per-month standard tallies split into "mandatory" (must fit in points) and "excess-eligible" (within 48h, may overflow)
  const standardByMonth = {}  // key "YYYY-M" → { mandatory, excessEligible }
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

    if (advance) {
      advanceSpend.total += pointCost
    } else {
      const key = `${year}-${month}`
      if (!standardByMonth[key]) standardByMonth[key] = { mandatory: 0, excessEligible: 0 }
      if (within48) standardByMonth[key].excessEligible += pointCost
      else standardByMonth[key].mandatory += pointCost
    }
  }

  // Verify cumulative advance spend
  if (advanceSpend.total > 0) {
    const credits = db.prepare(
      `SELECT * FROM advance_credits WHERE owner_initials = ?`
    ).get(owner_initials)
    const remaining = credits.credits_allocated - credits.credits_used
    if (remaining < advanceSpend.total) {
      return res.status(400).json({ error: `Not enough advance credits. Need ${advanceSpend.total}, have ${remaining}` })
    }
  }

  // For each month, mandatory bookings must fit in the balance.
  // Excess-eligible (within-48h) bookings may overflow — shortfall is dollar-charged.
  // We also record how many points to actually deduct per month (capped at allocation).
  const standardDeduction = {}  // key "YYYY-M" → points to deduct from allocation
  for (const key of Object.keys(standardByMonth)) {
    const [year, month] = key.split('-').map(Number)
    const pts = db.prepare(
      `SELECT * FROM standard_points WHERE owner_initials = ? AND year = ? AND month = ?`
    ).get(owner_initials, year, month)
    const remaining = pts.points_allocated - pts.points_used
    const { mandatory, excessEligible } = standardByMonth[key]

    if (mandatory > remaining) {
      const monthName = new Date(year, month - 1, 1).toLocaleString('default', { month: 'long' })
      return res.status(400).json({ error: `Not enough ${monthName} points. Need ${mandatory}, have ${remaining}` })
    }

    // Remaining after mandatory is absorbed by excess-eligible bookings up to what's available.
    const leftover = remaining - mandatory
    const pointsForExcess = Math.min(leftover, excessEligible)
    standardDeduction[key] = mandatory + pointsForExcess
  }

  // All validated — commit as a single transaction
  const commit = db.transaction(() => {
    // Deduct points per month
    for (const key of Object.keys(standardDeduction)) {
      const [year, month] = key.split('-').map(Number)
      db.prepare(
        `UPDATE standard_points SET points_used = points_used + ?
         WHERE owner_initials = ? AND year = ? AND month = ?`
      ).run(standardDeduction[key], owner_initials, year, month)
    }
    // Deduct advance credits (single owner row, sum total)
    if (advanceSpend.total > 0) {
      db.prepare(
        `UPDATE advance_credits SET credits_used = credits_used + ? WHERE owner_initials = ?`
      ).run(advanceSpend.total, owner_initials)
    }
    // Insert every booking row — points_cost is always the day's full cost
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

  const bookingDate = new Date(date + 'T12:00:00')
  const year = bookingDate.getFullYear()
  const month = bookingDate.getMonth() + 1

  // Refund points. Clamp at zero — if the original booking was partially
  // paid in dollars (honor system), the refund is only the portion that
  // was actually deducted from points.
  if (booking.booking_type === 'advance') {
    db.prepare(`
      UPDATE advance_credits SET credits_used = MAX(0, credits_used - ?) WHERE owner_initials = ?
    `).run(booking.points_cost, owner_initials)
  } else {
    db.prepare(`
      UPDATE standard_points SET points_used = MAX(0, points_used - ?)
      WHERE owner_initials = ? AND year = ? AND month = ?
    `).run(booking.points_cost, owner_initials, year, month)
  }

  db.prepare(`
    UPDATE bookings SET status = 'cancelled' WHERE date = ?
  `).run(date)

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
    SELECT owner_initials, owner_name, date, points_cost, booking_type, 'booking' as type
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

function convertAdvanceBookings() {
  const now = new Date()
  const today = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`
  
  const cutoffDate = new Date(now)
  cutoffDate.setDate(cutoffDate.getDate() + 60)
  const cutoff = `${cutoffDate.getFullYear()}-${String(cutoffDate.getMonth()+1).padStart(2,'0')}-${String(cutoffDate.getDate()).padStart(2,'0')}`

  console.log(`Conversion check: today=${today}, cutoff=${cutoff}`)

  const toConvert = db.prepare(`
    SELECT * FROM bookings
    WHERE booking_type = 'advance'
    AND status = 'confirmed'
    AND date <= ?
  `).all(cutoff)

  console.log(`Found ${toConvert.length} bookings to convert`)

  for (const booking of toConvert) {
    const bookingDate = new Date(booking.date + 'T12:00:00')
    const year = bookingDate.getFullYear()
    const month = bookingDate.getMonth() + 1

    ensureStandardPoints(year, month)

    db.prepare(`
      UPDATE standard_points
      SET points_used = points_used + ?
      WHERE owner_initials = ? AND year = ? AND month = ?
    `).run(booking.points_cost, booking.owner_initials, year, month)

    db.prepare(`
      UPDATE advance_credits
      SET credits_used = credits_used - ?
      WHERE owner_initials = ?
    `).run(booking.points_cost, booking.owner_initials)

    db.prepare(`
      UPDATE bookings SET booking_type = 'standard' WHERE id = ?
    `).run(booking.id)

    console.log(`Converted advance booking ${booking.date} for ${booking.owner_initials} to standard`)
  }
}

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

  res.json({ success: true, entry_num: info.lastInsertRowid })
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

const PORT = 3001
app.listen(PORT, () => {
  convertAdvanceBookings()
  console.log(`Sloaney Pony running at http://localhost:${PORT}`)
})