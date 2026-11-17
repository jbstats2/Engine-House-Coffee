'use strict';

module.exports = {
  // Number of slots on a stamp card. The last slot is the free drink:
  // 7 stamped visits, and the 8th visit's coffee is on the house.
  CARD_SIZE: 8,
  // Customers earn at most one stamp per calendar day. A new day starts at
  // 12:00am Eastern Time (America/New_York follows EST/EDT automatically).
  SHOP_TIMEZONE: process.env.SHOP_TIMEZONE || 'America/New_York',
  // After a free coffee is redeemed by scanning, the customer's phone shows a
  // live voucher for this long so they can show the barista.
  VOUCHER_MS: 30 * 60 * 1000,
  SESSION_TTL_MS: 30 * 24 * 60 * 60 * 1000, // 30 days
  SESSION_COOKIE: 'ehc_session',
  MAX_FAILED_LOGINS: 5,
  LOCKOUT_MS: 15 * 60 * 1000,
};
