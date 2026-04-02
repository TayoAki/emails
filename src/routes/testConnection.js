import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { verifyConnection, classifySmtpError } from '../services/smtpService.js';

const router = Router();

router.post('/', validate('testConnection'), async (req, res) => {
  const { accountId, smtp } = req.body;

  try {
    await verifyConnection(smtp);

    res.json({
      success: true,
      accountId: accountId || null,
      message: 'SMTP connection verified successfully.',
      requestId: req.id,
    });
  } catch (err) {
    if (err.message === 'SSRF_BLOCKED') {
      return res.status(422).json({
        success: false,
        error: 'CONNECTION_FAILED',
        message: 'Could not connect to the SMTP server. Check host and port.',
        requestId: req.id,
      });
    }

    const { type, status } = classifySmtpError(err);

    const messages = {
      AUTH_FAILED: 'Authentication failed. Check username and password.',
      CONNECTION_FAILED: 'Could not connect to the SMTP server. Check host and port.',
    };

    res.status(status).json({
      success: false,
      accountId: accountId || null,
      error: type,
      message: messages[type] || 'Connection test failed.',
      requestId: req.id,
    });
  }
});

export default router;
