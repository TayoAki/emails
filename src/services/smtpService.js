import nodemailer from 'nodemailer';
import validateHost from '../utils/validateHost.js';
import logger from '../utils/logger.js';

function createTransport(smtp) {
  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: {
      user: smtp.auth.user,
      pass: smtp.auth.pass,
    },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
    pool: false,
  });
}

export async function verifyConnection(smtp) {
  await validateHost(smtp.host);

  const transporter = createTransport(smtp);
  try {
    await transporter.verify();
  } finally {
    transporter.close();
  }
}

export async function sendEmail(smtp, email) {
  await validateHost(smtp.host);

  const transporter = createTransport(smtp);
  try {
    const result = await transporter.sendMail({
      from: email.from,
      to: email.to,
      replyTo: email.replyTo,
      subject: email.subject,
      text: email.text,
      html: email.html,
      headers: email.headers,
    });

    logger.info(
      {
        smtpHost: smtp.host,
        smtpUser: smtp.auth.user,
        to: email.to,
        messageId: result.messageId,
      },
      'Email sent'
    );

    return {
      messageId: result.messageId,
      accepted: result.accepted,
      rejected: result.rejected,
    };
  } finally {
    transporter.close();
  }
}

// Classify Nodemailer errors into our error codes
export function classifySmtpError(err) {
  const msg = (err.message || '').toLowerCase();
  const code = (err.code || '').toLowerCase();
  const responseCode = err.responseCode || 0;

  if (responseCode === 535 || msg.includes('auth') || msg.includes('credentials')) {
    return { type: 'AUTH_FAILED', status: 401 };
  }
  if (code === 'econnrefused' || code === 'etimedout' || code === 'enotfound' || msg.includes('ssrf')) {
    return { type: 'CONNECTION_FAILED', status: 422 };
  }
  return { type: 'SEND_FAILED', status: 500 };
}
