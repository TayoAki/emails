import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { v4 as uuidv4 } from 'uuid';

import logger from './utils/logger.js';
import { apiKeyAuth } from './middleware/apiKeyAuth.js';
import { errorHandler } from './middleware/errorHandler.js';

import healthRouter from './routes/health.js';
import testConnectionRouter from './routes/testConnection.js';
import sendRouter from './routes/send.js';
import sendBatchRouter from './routes/sendBatch.js';
import batchStatusRouter from './routes/batchStatus.js';
import checkRepliesRouter from './routes/checkReplies.js';

// ─── Startup validation ───────────────────────────────────────────────────────
const required = { API_KEY: process.env.API_KEY, ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS };

for (const [key, val] of Object.entries(required)) {
  if (!val) {
    logger.fatal(`FATAL: ${key} environment variable is not set. Exiting.`);
    process.exit(1);
  }
}

if (process.env.API_KEY.length < 32) {
  logger.fatal('FATAL: API_KEY must be at least 32 characters. Generate one with: openssl rand -hex 32');
  process.exit(1);
}

// ─── App setup ────────────────────────────────────────────────────────────────
const app = express();

// Trust Railway/Hetzner proxy for accurate IP in rate limiting
app.set('trust proxy', 1);

// Attach a unique requestId to every request
app.use((req, _res, next) => {
  req.id = uuidv4();
  next();
});

// Security headers — tuned for a JSON API (no browser UI in production)
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },
}));

// CORS — locked to ALLOWED_ORIGINS
const allowedOrigins = process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim());
app.use(cors({
  origin: (origin, cb) => {
    // Allow server-to-server calls (no origin header)
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST'],
}));

// Body parsing — hard cap at 512kb
app.use(express.json({ limit: '512kb' }));

// ─── Rate limiting ────────────────────────────────────────────────────────────
const defaultLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10),
  max: parseInt(process.env.RATE_LIMIT_MAX || '100', 10),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.status(429).json({
    success: false,
    error: 'RATE_LIMITED',
    message: 'Too many requests. Please try again later.',
    requestId: req.id,
  }),
});

const batchLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10),
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.status(429).json({
    success: false,
    error: 'RATE_LIMITED',
    message: 'Batch rate limit exceeded. Please try again later.',
    requestId: req.id,
  }),
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/health', healthRouter);

app.use('/api/test-connection', defaultLimiter, apiKeyAuth, testConnectionRouter);
app.use('/api/send', defaultLimiter, apiKeyAuth, sendRouter);
app.use('/api/send-batch', batchLimiter, apiKeyAuth, sendBatchRouter);
app.use('/api/batch-status', defaultLimiter, apiKeyAuth, batchStatusRouter);
app.use('/api/check-replies', defaultLimiter, apiKeyAuth, checkRepliesRouter);

// Test UI — only available in development
if (process.env.NODE_ENV !== 'production') {
  const { default: path } = await import('path');
  const { fileURLToPath } = await import('url');
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  app.use(express.static(path.join(__dirname, '../public')));
}

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'NOT_FOUND',
    message: `${req.method} ${req.path} not found.`,
    requestId: req.id,
  });
});

// Global error handler
app.use(errorHandler);

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000', 10);
app.listen(PORT, () => {
  logger.info({ port: PORT, env: process.env.NODE_ENV }, 'SMTP microservice started');
});

export default app;
