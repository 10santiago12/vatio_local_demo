'use strict';

const nodemailer = require('nodemailer');
const { HttpError } = require('../http/http-error');

/** Sends only a fixed test message to the administrator-configured recipient. */
function createEmail({ config, access, transportFactory = nodemailer.createTransport }) {
  let transport;
  return {
    configured: () => Boolean(config.smtp),
    async sendTest(user) {
      if (!config.smtp) throw new HttpError(503, 'El correo no está configurado.', 'email_unconfigured');
      const { host, port, user: username, password, from, to } = config.smtp;
      if (!transport) transport = transportFactory({
        host, port, secure: port === 465, requireTLS: port === 587,
        auth: { user: username, pass: password },
        connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
      });
      try {
        const result = await transport.sendMail({
          from, to, subject: 'Vatio - prueba de correo',
          text: 'La integración de correo de Vatio está configurada.',
        });
        if (!result.accepted || result.accepted.length !== 1 || result.rejected?.length) {
          throw new Error('SMTP did not accept the configured recipient');
        }
        access.audit({ user, event: 'email_test_sent', result: 'executed', details: {} });
      } catch {
        access.audit({ user, event: 'email_test_failed', result: 'rejected', details: {} });
        throw new HttpError(502, 'No se pudo enviar el correo de prueba. Revise la configuración.', 'email_failed');
      }
      return { ok: true };
    },
    close() { transport?.close(); },
  };
}

module.exports = { createEmail };
