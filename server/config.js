'use strict';

module.exports = {
  // Number of slots on a stamp card. The last slot is the free drink:
  // buy 7, the 8th coffee is on the house.
  CARD_SIZE: 8,
  SESSION_TTL_MS: 30 * 24 * 60 * 60 * 1000, // 30 days
  SESSION_COOKIE: 'ehc_session',
  MAX_COFFEES_PER_VISIT: 20,
  MAX_FAILED_LOGINS: 5,
  LOCKOUT_MS: 15 * 60 * 1000,
};
