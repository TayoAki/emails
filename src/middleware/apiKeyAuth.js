import crypto from 'crypto';

const API_KEY = process.env.API_KEY;

// Validated at startup in server.js — this is a runtime guard
export function apiKeyAuth(req, res, next) {
  const provided = req.headers['x-api-key'];

  if (!provided) {
    return res.status(401).json({
      success: false,
      error: 'UNAUTHORIZED',
      message: 'Missing x-api-key header.',
      requestId: req.id,
    });
  }

  // Constant-time comparison — reject mismatched lengths first,
  // then compare bytes directly without padding (padding creates bypass vectors)
  const providedBuf = Buffer.from(String(provided));
  const keyBuf = Buffer.from(API_KEY);

  const match =
    providedBuf.byteLength === keyBuf.byteLength &&
    crypto.timingSafeEqual(providedBuf, keyBuf);

  if (!match) {
    return res.status(401).json({
      success: false,
      error: 'UNAUTHORIZED',
      message: 'Invalid API key.',
      requestId: req.id,
    });
  }

  next();
}
