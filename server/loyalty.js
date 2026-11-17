'use strict';

const { CARD_SIZE, SHOP_TIMEZONE } = require('./config');

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
    const stamps = free ? 0 : user.current_stamps + 1;

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

function cardSummary(db, user, now = Date.now()) {
  return {
    cardSize: CARD_SIZE,
    currentStamps: user.current_stamps,
    nextIsFree: user.current_stamps >= PAID_STAMPS_FOR_FREE,
    visitsUntilFree: Math.max(0, PAID_STAMPS_FOR_FREE - user.current_stamps),
    stampedToday: stampedOnDay(db, user.id, shopDay(now)),
    lifetimePoints: user.lifetime_points,
    lifetimeVisits: user.lifetime_coffees,
    freeRedeemed: user.free_redeemed,
  };
}

module.exports = { recordVisit, cardSummary, shopDay, PAID_STAMPS_FOR_FREE };
