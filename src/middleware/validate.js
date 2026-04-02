import Joi from 'joi';

// Reusable SMTP credentials schema
const smtpSchema = Joi.object({
  host: Joi.string().hostname().required(),
  port: Joi.number().integer().valid(465, 587, 2525).required(),
  secure: Joi.boolean().required(),
  auth: Joi.object({
    user: Joi.string().email().required(),
    pass: Joi.string().min(1).max(256).required(),
  }).required(),
}).required();

// Reusable IMAP credentials schema
const imapSchema = Joi.object({
  host: Joi.string().hostname().required(),
  port: Joi.number().integer().valid(993, 143).required(),
  secure: Joi.boolean().required(),
  auth: Joi.object({
    user: Joi.string().email().required(),
    pass: Joi.string().min(1).max(256).required(),
  }).required(),
}).required();

// Custom header names: X- prefix only, safe characters
const headerNamePattern = /^X-[a-zA-Z0-9\-]{1,64}$/;
// Header values: printable ASCII only, no CRLF
const headerValuePattern = /^[\x20-\x7E]{1,998}$/;

const customHeadersSchema = Joi.object()
  .pattern(headerNamePattern, Joi.string().pattern(headerValuePattern).required())
  .max(10);

// Single email object schema
const emailSchema = Joi.object({
  from: Joi.string().max(320).pattern(/^[^\r\n]+$/).required(),
  to: Joi.string().email().required(),
  replyTo: Joi.string().email(),
  subject: Joi.string().max(998).pattern(/^[^\r\n]+$/).required(),
  text: Joi.string().max(100000),
  html: Joi.string().max(500000),
  headers: customHeadersSchema,
}).or('text', 'html').required();

// Batch email item (no from/replyTo — those come from options)
const batchEmailSchema = Joi.object({
  to: Joi.string().email().required(),
  subject: Joi.string().max(998).required(),
  text: Joi.string().max(100000),
  html: Joi.string().max(500000),
}).or('text', 'html').required();

// IMAP folder: alphanumeric + safe punctuation only
const folderPattern = /^[a-zA-Z0-9_.\-/]{1,100}$/;

// filterSubjects: no IMAP literal chars
const subjectPattern = /^[^{}\r\n]{1,200}$/;

// Schemas per endpoint
export const schemas = {
  testConnection: Joi.object({
    accountId: Joi.string().max(128),
    smtp: smtpSchema,
  }),

  send: Joi.object({
    accountId: Joi.string().max(128),
    smtp: smtpSchema,
    email: emailSchema,
  }),

  sendBatch: Joi.object({
    accountId: Joi.string().max(128),
    smtp: smtpSchema,
    emails: Joi.array().items(batchEmailSchema).min(1).required(),
    options: Joi.object({
      from: Joi.string().max(320).pattern(/^[^\r\n]+$/).required(),
      replyTo: Joi.string().email(),
      delayMs: Joi.number().integer().min(1000).max(30000).default(3000),
      schedule: Joi.object({
        windowMinutes: Joi.number().integer().min(5).max(1440).required(),
      }),
    }).required(),
  }),

  checkReplies: Joi.object({
    accountId: Joi.string().max(128),
    imap: imapSchema,
    options: Joi.object({
      folder: Joi.string().pattern(folderPattern).default('INBOX'),
      since: Joi.string().isoDate(),
      limit: Joi.number().integer().min(1).max(200).default(50),
      filterSubjects: Joi.array().items(
        Joi.string().pattern(subjectPattern).max(200)
      ).max(20).default([]),
    }).default(),
  }),
};

// Middleware factory
export function validate(schemaName) {
  return (req, res, next) => {
    const schema = schemas[schemaName];
    const { error, value } = schema.validate(req.body, {
      abortEarly: false,
      allowUnknown: false,
      stripUnknown: true,
    });

    if (error) {
      return res.status(400).json({
        success: false,
        error: 'VALIDATION_ERROR',
        message: error.details.map((d) => d.message).join('; '),
        requestId: req.id,
      });
    }

    req.body = value;
    next();
  };
}
