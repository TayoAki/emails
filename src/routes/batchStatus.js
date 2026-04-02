import { Router } from 'express';
import { getJob } from '../services/batchQueue.js';

const router = Router();

// GET /api/batch-status/:jobId — poll for job status
router.get('/:jobId', (req, res) => {
  const job = getJob(req.params.jobId);

  if (!job) {
    return res.status(404).json({
      success: false,
      error: 'JOB_NOT_FOUND',
      message: 'Job not found or expired.',
      requestId: req.id,
    });
  }

  const isDone = job.status === 'done' || job.status === 'failed';
  const httpStatus = isDone ? 200 : 202;

  res.status(httpStatus).json({
    success: job.failed === 0,
    accountId: job.accountId,
    jobId: job.jobId,
    status: job.status,
    total: job.total,
    sent: job.sent,
    failed: job.failed,
    ...(isDone && { results: job.results, completedAt: job.completedAt }),
    requestId: req.id,
  });
});

export default router;
