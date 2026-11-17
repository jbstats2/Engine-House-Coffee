'use strict';

const { CARD_SIZE } = require('./config');

const PAID_STAMPS_FOR_FREE = CARD_SIZE - 1; // 7 paid coffees, the 8th is free

/**
 * Record `count` coffees for a customer, applying the stamp-card rule:
 * each paid coffee earns one stamp (one lifetime point). When the card already
 * holds 7 stamps, the next coffee is free and the card starts over.
 *
 * Runs in a single transaction so the card can never be double-counted.
 */
function recordCoffees(db, { userId, staffId, count }) {
  const now = Date.now();
  db.exec('BEGIN IMMEDIATE');
  try {
    const user = db.prepare('SELECT current_stamps FROM users WHERE id = ? AND role = ?').get(userId, 'customer');
    if (!user) throw Object.assign(new Error('Member not found.'), { status: 404 });

    let stamps = user.current_stamps;
    let paid = 0;
    let free = 0;
    const insertTx = db.prepare('INSERT INTO transactions (user_id, staff_id, kind, created_at) VALUES (?, ?, ?, ?)');

    for (let i = 0; i < count; i++) {
      if (stamps >= PAID_STAMPS_FOR_FREE) {
        stamps = 0;
        free++;
        insertTx.run(userId, staffId, 'free_coffee', now);
      } else {
        stamps++;
        paid++;
        insertTx.run(userId, staffId, 'stamp', now);
      }
    }

    db.prepare(`
      UPDATE users SET
        current_stamps   = ?,
        lifetime_points  = lifetime_points + ?,
        lifetime_coffees = lifetime_coffees + ?,
        free_redeemed    = free_redeemed + ?
      WHERE id = ?
    `).run(stamps, paid, count, free, userId);

    db.exec('COMMIT');
    return { stampsAdded: paid, freeCoffees: free, currentStamps: stamps };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function cardSummary(user) {
  return {
    cardSize: CARD_SIZE,
    currentStamps: user.current_stamps,
    nextIsFree: user.current_stamps >= PAID_STAMPS_FOR_FREE,
    coffeesUntilFree: Math.max(0, PAID_STAMPS_FOR_FREE - user.current_stamps),
    lifetimePoints: user.lifetime_points,
    lifetimeCoffees: user.lifetime_coffees,
    freeRedeemed: user.free_redeemed,
  };
}

module.exports = { recordCoffees, cardSummary, PAID_STAMPS_FOR_FREE };
