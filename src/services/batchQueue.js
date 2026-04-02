import Queue from 'better-queue';
import { v4 as uuidv4 } from 'uuid';
import { sendEmail } from './smtpService.js';
import sleep from '../utils/sleep.js';
import logger from '../utils/logger.js';

/**
 * Build an array of delays (in ms) between each email.
 * If schedule.windowMinutes is set, randomize delays to spread sends across the window.
 * Otherwise, use the fixed delayMs.
 */
function buildDelays(count, options) {
  if (count <= 1) return [];

  const gaps = count - 1;

  if (options.schedule?.windowMinutes) {
    const windowMs = options.schedule.windowMinutes * 60 * 1000;
    // Generate random points within the window, then sort to get intervals
    const points = Array.from({ length: gaps }, () => Math.random() * windowMs);
    points.sort((a, b) => a - b);
    // Convert absolute points to gaps between them
    const delays = [];
    let prev = 0;
    for (const point of points) {
      delays.push(Math.max(point - prev, 1000)); // minimum 1s between sends
      prev = point;
    }
    return delays;
  }

  // Fixed delay mode
  return Array(gaps).fill(options.delayMs);
}

// In-memory job store: jobId → job state
const jobs = new Map();

// TTL eviction: remove completed jobs after 1 hour
const JOB_TTL_MS = 60 * 60 * 1000;

function evictJob(jobId) {
  setTimeout(() => jobs.delete(jobId), JOB_TTL_MS);
}

// Track active batch count for capacity check
let activeBatches = 0;
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_BATCHES || '5', 10);

const queue = new Queue(
  async (task, done) => {
    const { jobId, smtp, emails, options } = task;
    const job = jobs.get(jobId);
    if (!job) { activeBatches--; return done(); }

    job.status = 'running';

    // Calculate delays: random spread across window, or fixed delay
    const delays = buildDelays(emails.length, options);

    for (let i = 0; i < emails.length; i++) {
      const email = emails[i];
      try {
        const result = await sendEmail(smtp, {
          from: options.from,
          replyTo: options.replyTo,
          to: email.to,
          subject: email.subject,
          text: email.text,
          html: email.html,
        });

        job.sent++;
        job.results.push({
          index: i,
          to: email.to,
          status: 'sent',
          messageId: result.messageId,
        });
      } catch (err) {
        job.failed++;
        job.results.push({
          index: i,
          to: email.to,
          status: 'failed',
          error: 'Send failed',
        });
        logger.warn({ jobId, to: email.to, err: err.message }, 'Batch email failed');
      }

      // Delay between sends (skip after last email)
      if (i < emails.length - 1) {
        await sleep(delays[i]);
      }
    }

    job.status = job.failed > 0 && job.sent === 0 ? 'failed' : 'done';
    job.completedAt = new Date().toISOString();
    activeBatches--;
    evictJob(jobId);

    logger.info({ jobId, sent: job.sent, failed: job.failed }, 'Batch job complete');
    done();
  },
  { concurrent: MAX_CONCURRENT }
);

export function canAcceptBatch() {
  return activeBatches < MAX_CONCURRENT;
}

export function enqueueBatch({ accountId, smtp, emails, options }) {
  if (!canAcceptBatch()) {
    return null;
  }

  const maxPerBatch = parseInt(process.env.MAX_PER_BATCH || '50', 10);
  if (emails.length > maxPerBatch) {
    throw new Error('BATCH_TOO_LARGE');
  }

  const jobId = uuidv4();
  jobs.set(jobId, {
    jobId,
    accountId: accountId || null,
    status: 'queued',
    total: emails.length,
    sent: 0,
    failed: 0,
    results: [],
    createdAt: new Date().toISOString(),
    completedAt: null,
  });

  activeBatches++;
  queue.push({ jobId, smtp, emails, options });

  return jobId;
}

export function getJob(jobId) {
  return jobs.get(jobId) || null;
}
