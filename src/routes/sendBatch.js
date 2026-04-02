import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { enqueueBatch, canAcceptBatch } from '../services/batchQueue.js';

const router = Router();

// POST /api/send-batch — enqueue a batch job
router.post('/', validate('sendBatch'), (req, res) => {
  const { accountId, smtp, emails, options } = req.body;

  const maxPerBatch = parseInt(process.env.MAX_PER_BATCH || '50', 10);

  if (emails.length > maxPerBatch) {
    return res.status(400).json({
      success: false,
      error: 'BATCH_TOO_LARGE',
      message: `Batch exceeds the maximum of ${maxPerBatch} recipients per job.`,
      requestId: req.id,
    });
  }

  if (!canAcceptBatch()) {
    return res.status(503).json({
      success: false,
      error: 'BATCH_CAPACITY_EXCEEDED',
      message: 'Service is at batch capacity. Try again shortly.',
      requestId: req.id,
    });
  }

  const jobId = enqueueBatch({ accountId, smtp, emails, options });

  res.status(202).json({
    success: true,
    accountId: accountId || null,
    jobId,
    total: emails.length,
    status: 'queued',
    requestId: req.id,
  });
});

export default router;
