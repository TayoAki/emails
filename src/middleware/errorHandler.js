import logger from '../utils/logger.js';

export function errorHandler(err, req, res, next) {
  // Log the full error internally (credentials already redacted by Pino config)
  logger.error({ err, requestId: req.id }, 'Unhandled error');

  // Never forward raw error messages to the client
  res.status(500).json({
    success: false,
    error: 'INTERNAL_ERROR',
    message: 'An unexpected error occurred.',
    requestId: req.id,
  });
}
