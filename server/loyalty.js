'use strict';

const { CARD_SIZE, SHOP_TIMEZONE, VOUCHER_MS } = require('./config');

const PAID_STAMPS_FOR_FREE = CARD_SIZE - 1; // 7 stamped days, the 8th visit's coffee is free

/** Calendar day (YYYY-MM-DD) in the shop's time zone. */
function shopDay(ms = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: SHOP_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ms));
}

function stampedOnDay(db, userId, day) {
  return !!db.prepare('SELECT 1 FROM transactions WHERE user_id = ? AND day = ?').get(userId, day);
}

/**
 * Record today's visit for a customer. One card action per customer per day,
 * however many drinks they buy — so a drip coffee and a latte earn the same.
 *
 * - Fewer than 7 stamps: the visit earns one stamp (one lifetime point).
 * - 7 stamps: this visit's coffee is free and the card starts over.
 *
 * A UNIQUE(user_id, day) index backs this up, so two baristas tapping at the
 * same moment can't double-stamp.
 */
function recordVisit(db, { userId, staffId, now = Date.now() }) {
  const day = shopDay(now);
  db.exec('BEGIN IMMEDIATE');
  try {
    const user = db.prepare('SELECT current_stamps FROM users WHERE id = ? AND role = ?').get(userId, 'customer');
    if (!user) throw Object.assign(new Error('Member not found.'), { status: 404 });
    if (stampedOnDay(db, userId, day)) {
      throw Object.assign(new Error("Already stamped today — next stamp is available tomorrow."), { status: 409 });
    }

    const free = user.current_stamps >= PAID_STAMPS_FOR_FREE;
    // Extra stamps an admin added beyond a full card carry over to the next card.
    const stamps = free ? user.current_stamps - PAID_STAMPS_FOR_FREE : user.current_stamps + 1;

    db.prepare('INSERT INTO transactions (user_id, staff_id, kind, day, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(userId, staffId, free ? 'free_coffee' : 'stamp', day, now);
    db.prepare(`
      UPDATE users SET
        current_stamps   = ?,
        lifetime_points  = lifetime_points + ?,
        lifetime_coffees = lifetime_coffees + 1,
        free_redeemed    = free_redeemed + ?
      WHERE id = ?
    `).run(stamps, free ? 0 : 1, free ? 1 : 0, userId);

    db.exec('COMMIT');
    return { kind: free ? 'free_coffee' : 'stamp', currentStamps: stamps };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Admin adjustment: add any number of stamps, ignoring the once-a-day rule
 * (for a missed day, a mistake, a goodwill gesture). Each stamp also counts
 * as a lifetime point and a visit. Stamps beyond a full card are kept and
 * carry over to the next card after the free coffee.
 */
function addStamps(db, { userId, adminId, count, note, now = Date.now() }) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const user = db.prepare('SELECT id FROM users WHERE id = ? AND role = ?').get(userId, 'customer');
    if (!user) throw Object.assign(new Error('Member not found.'), { status: 404 });
    db.prepare('INSERT INTO adjustments (user_id, admin_id, stamps, note, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(userId, adminId, count, note || null, now);
    db.prepare(`
      UPDATE users SET
        current_stamps   = current_stamps + ?,
        lifetime_points  = lifetime_points + ?,
        lifetime_coffees = lifetime_coffees + ?
      WHERE id = ?
    `).run(count, count, count, userId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

const fail = (status, message) => Object.assign(new Error(message), { status });

/**
 * Admin correction: take stamps off the current card (e.g. too many were
 * added). Can't go below zero. Lifetime points and visits are reduced to
 * match (never below zero). Recorded as a negative adjustment so the
 * customer's history shows it.
 */
function removeStamps(db, { userId, adminId, count, note, now = Date.now() }) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const user = db.prepare('SELECT current_stamps FROM users WHERE id = ? AND role = ?').get(userId, 'customer');
    if (!user) throw fail(404, 'Member not found.');
    if (user.current_stamps === 0) throw fail(400, 'Their card has no stamps to remove.');
    if (count > user.current_stamps) {
      throw fail(400, `Their card only has ${user.current_stamps} stamp${user.current_stamps === 1 ? '' : 's'}.`);
    }
    db.prepare('INSERT INTO adjustments (user_id, admin_id, stamps, note, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(userId, adminId, -count, note || null, now);
    db.prepare(`
      UPDATE users SET
        current_stamps   = current_stamps - ?,
        lifetime_points  = MAX(0, lifetime_points - ?),
        lifetime_coffees = MAX(0, lifetime_coffees - ?)
      WHERE id = ?
    `).run(count, count, count, userId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Admin correction: undo the stamp a customer earned today (wrong person,
 * double scan...). Takes the stamp back off the card and frees up their
 * daily stamp so they can collect it again today. The original visit stays
 * in the history, with a matching "-1" correction next to it.
 */
function undoTodayStamp(db, { userId, adminId, now = Date.now() }) {
  const day = shopDay(now);
  db.exec('BEGIN IMMEDIATE');
  try {
    const tx = db.prepare('SELECT id, kind FROM transactions WHERE user_id = ? AND day = ?').get(userId, day);
    if (!tx) throw fail(400, "They haven't been stamped today.");
    if (tx.kind !== 'stamp') throw fail(400, "Today's visit was a free coffee, which can't be undone here.");
    const user = db.prepare('SELECT current_stamps FROM users WHERE id = ?').get(userId);
    // Keep the record, but release the once-a-day slot.
    db.prepare('UPDATE transactions SET day = NULL WHERE id = ?').run(tx.id);
    const taken = Math.min(1, user.current_stamps);
    db.prepare('INSERT INTO adjustments (user_id, admin_id, stamps, note, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(userId, adminId, -1, "Today's stamp undone", now);
    db.prepare(`
      UPDATE users SET
        current_stamps   = current_stamps - ?,
        lifetime_points  = MAX(0, lifetime_points - 1),
        lifetime_coffees = MAX(0, lifetime_coffees - 1)
      WHERE id = ?
    `).run(taken, userId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function cardSummary(db, user, now = Date.now()) {
  // A free coffee redeemed in the last 30 minutes: the phone shows a live voucher.
  const lastFree = db.prepare(`
    SELECT created_at FROM transactions
    WHERE user_id = ? AND kind = 'free_coffee' AND created_at > ? ORDER BY id DESC LIMIT 1
  `).get(user.id, now - VOUCHER_MS);
  return {
    cardSize: CARD_SIZE,
    currentStamps: Math.min(user.current_stamps, PAID_STAMPS_FOR_FREE),
    extraStamps: Math.max(0, user.current_stamps - PAID_STAMPS_FOR_FREE),
    nextIsFree: user.current_stamps >= PAID_STAMPS_FOR_FREE,
    visitsUntilFree: Math.max(0, PAID_STAMPS_FOR_FREE - user.current_stamps),
    stampedToday: stampedOnDay(db, user.id, shopDay(now)),
    todayKind: db.prepare('SELECT kind FROM transactions WHERE user_id = ? AND day = ?').get(user.id, shopDay(now))?.kind || null,
    lifetimePoints: user.lifetime_points,
    lifetimeVisits: user.lifetime_coffees,
    freeRedeemed: user.free_redeemed,
    voucher: lastFree ? { redeemedAt: lastFree.created_at, expiresAt: lastFree.created_at + VOUCHER_MS } : null,
  };
}

module.exports = { recordVisit, addStamps, removeStamps, undoTodayStamp, cardSummary, shopDay, PAID_STAMPS_FOR_FREE };
