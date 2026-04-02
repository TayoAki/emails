import { ImapFlow } from 'imapflow';
import validateHost from '../utils/validateHost.js';
import logger from '../utils/logger.js';

function parseHeader(headersBuf, name) {
  if (!headersBuf) return '';
  const text = Buffer.isBuffer(headersBuf) ? headersBuf.toString() : String(headersBuf);
  const match = text.match(new RegExp(`^${name}:\\s*(.+)`, 'im'));
  return match ? match[1].trim() : '';
}

export async function fetchReplies(imap, options) {
  await validateHost(imap.host);

  const client = new ImapFlow({
    host: imap.host,
    port: imap.port,
    secure: imap.secure,
    auth: {
      user: imap.auth.user,
      pass: imap.auth.pass,
    },
    connectionTimeout: 10000,
    logger: false, // suppress ImapFlow's own logging; we use Pino
  });

  const replies = [];

  try {
    await client.connect();

    const lock = await client.getMailboxLock(options.folder);
    try {
      // Build search criteria
      const since = options.since
        ? new Date(options.since)
        : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      const searchCriteria = { since };

      const uids = await client.search(searchCriteria, { uid: true });

      if (!uids || uids.length === 0) {
        return [];
      }

      // Cap results
      const limited = uids.slice(-options.limit);

      for await (const msg of client.fetch(limited, {
        envelope: true,
        headers: ['in-reply-to', 'message-id'],
        bodyParts: ['1'],
      }, { uid: true })) {
        const subject = msg.envelope?.subject || '';

        // Filter by subject prefixes if provided
        if (options.filterSubjects && options.filterSubjects.length > 0) {
          const matches = options.filterSubjects.some((filter) =>
            subject.toLowerCase().includes(filter.toLowerCase())
          );
          if (!matches) continue;
        }

        // Extract plain text snippet (first 200 chars)
        let snippet = '';
        if (msg.bodyParts) {
          for (const [, buf] of msg.bodyParts) {
            snippet = buf.toString('utf8').replace(/\s+/g, ' ').trim().slice(0, 200);
            break;
          }
        }

        replies.push({
          from: msg.envelope?.from?.[0]?.address || '',
          subject,
          date: msg.envelope?.date || null,
          snippet,
          messageId: parseHeader(msg.headers, 'message-id'),
          inReplyTo: parseHeader(msg.headers, 'in-reply-to'),
        });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }

  logger.info(
    { imapHost: imap.host, imapUser: imap.auth.user, count: replies.length },
    'IMAP replies fetched'
  );

  return replies;
}
