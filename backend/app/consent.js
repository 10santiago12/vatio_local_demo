'use strict';

const { HttpError } = require('../http/http-error');

// Keep these identifiers in sync with the published documents.
const CONSENT_VERSIONS = Object.freeze({ policyVersion: '2026-11-10.1', termsVersion: '2026-11-10.1' });

function requireConsent({ consents, userId, input, now, ip, userAgent }) {
  if (consents.has(userId, CONSENT_VERSIONS)) return;
  const { policyVersion, termsVersion } = CONSENT_VERSIONS;
  if (input?.habeasDataAccepted !== true || input.termsAccepted !== true ||
      input.policyVersion !== policyVersion || input.termsVersion !== termsVersion) {
    throw new HttpError(428, 'Para activar tu acceso, autoriza el tratamiento y acepta los términos vigentes.',
      'consent_required', CONSENT_VERSIONS);
  }
  consents.append({
    userId, timestampUtc: new Date(now).toISOString(), ipAddress: ip || null,
    userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 512) : null,
    ...CONSENT_VERSIONS,
  });
}

module.exports = { CONSENT_VERSIONS, requireConsent };
