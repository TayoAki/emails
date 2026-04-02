import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { sendEmail, classifySmtpError } from '../services/smtpService.js';

const router = Router();

router.post('/', validate('send'), async (req, res) => {
  const { accountId, smtp, email } = req.body;

  try {
    const result = await sendEmail(smtp, email);

    res.json({
      success: true,
      accountId: accountId || null,
      messageId: result.messageId,
      accepted: result.accepted,
      rejected: result.rejected,
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
      AUTH_FAILED: 'Authentication failed. Check SMTP credentials.',
      CONNECTION_FAILED: 'Could not connect to the SMTP server. Check host and port.',
      SEND_FAILED: 'Sending failed. Check SMTP credentials and try again.',
    };

    res.status(status).json({
      success: false,
      accountId: accountId || null,
      error: type,
      message: messages[type] || 'Send failed.',
      requestId: req.id,
    });
  }
});

export default router;
