import pino from 'pino';

const logger = pino({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  redact: {
    paths: [
      'smtp.auth.pass',
      'imap.auth.pass',
      '*.smtp.auth.pass',
      '*.imap.auth.pass',
      'body.smtp.auth.pass',
      'body.imap.auth.pass',
      'err.auth.pass',
      'err.config.auth.pass',
      '*.auth.pass',
      '*.auth.password',
    ],
    censor: '[REDACTED]',
  },
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
});

export default logger;
