'use strict';

function createConsentsRepository(db) {
  const current = db.prepare('SELECT 1 FROM consents WHERE user_id = ? AND policy_version = ? AND terms_version = ?');
  const append = db.prepare(`
    INSERT INTO consents (user_id, timestamp_utc, ip_address, user_agent, policy_version, terms_version, habeas_data_accepted, terms_accepted)
    VALUES (?, ?, ?, ?, ?, ?, 1, 1)
    ON CONFLICT (user_id, policy_version, terms_version) DO NOTHING`);
  const list = db.prepare('SELECT * FROM consents WHERE user_id = ? ORDER BY id');
  return {
    has: (userId, { policyVersion, termsVersion }) => Boolean(current.get(userId, policyVersion, termsVersion)),
    append: ({ userId, timestampUtc, ipAddress, userAgent, policyVersion, termsVersion }) =>
      append.run(userId, timestampUtc, ipAddress, userAgent, policyVersion, termsVersion),
    list: (userId) => list.all(userId),
  };
}

module.exports = { createConsentsRepository };
