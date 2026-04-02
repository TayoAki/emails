import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { fetchReplies } from '../services/imapService.js';
import logger from '../utils/logger.js';

const router = Router();

router.post('/', validate('checkReplies'), async (req, res) => {
  const { accountId, imap, options } = req.body;

  try {
    const replies = await fetchReplies(imap, options);

    res.json({
      success: true,
      accountId: accountId || null,
      total: replies.length,
      replies,
      requestId: req.id,
    });
  } catch (err) {
    if (err.message === 'SSRF_BLOCKED') {
      return res.status(422).json({
        success: false,
        error: 'CONNECTION_FAILED',
        message: 'Could not connect to the IMAP server. Check host and port.',
        requestId: req.id,
      });
    }

    logger.error({ err: err.message, stack: err.stack, code: err.code }, 'IMAP error');

    const msg = (err.message || '').toLowerCase();
    const isAuth = msg.includes('auth') || msg.includes('login') || msg.includes('credentials');

    if (isAuth) {
      return res.status(401).json({
        success: false,
        accountId: accountId || null,
        error: 'AUTH_FAILED',
        message: 'IMAP authentication failed. Check username and password.',
        requestId: req.id,
      });
    }

    res.status(500).json({
      success: false,
      accountId: accountId || null,
      error: 'IMAP_ERROR',
      message: 'Failed to fetch replies. Check IMAP credentials and try again.',
      requestId: req.id,
    });
  }
});

export default router;
