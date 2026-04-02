// Set default "since" date to 7 days ago
const d = new Date();
d.setDate(d.getDate() - 7);
document.getElementById('r-since').value = d.toISOString().split('T')[0];

function apiKey() {
  return document.getElementById('globalApiKey').value.trim();
}

function smtpPayload(prefix) {
  return {
    host: document.getElementById(`${prefix}-host`).value.trim(),
    port: parseInt(document.getElementById(`${prefix}-port`).value),
    secure: document.getElementById(`${prefix}-secure`).value === 'true',
    auth: {
      user: document.getElementById(`${prefix}-user`).value.trim(),
      pass: document.getElementById(`${prefix}-pass`).value.trim(),
    },
  };
}

function showResult(id, data, type = 'info') {
  const el = document.getElementById(id);
  el.textContent = JSON.stringify(data, null, 2);
  el.className = `result ${type}`;
  el.style.display = 'block';
}

function setLoading(btn, loading) {
  if (loading) {
    btn.dataset.label = btn.textContent;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>Working…';
  } else {
    btn.disabled = false;
    btn.textContent = btn.dataset.label || btn.textContent;
  }
}

async function call(endpoint, body) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey(),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

// ── Test Connection ──────────────────────────────────────
document.getElementById('btn-test-connection').addEventListener('click', async function () {
  setLoading(this, true);
  try {
    const { data } = await call('/api/test-connection', { smtp: smtpPayload('tc') });
    showResult('tc-result', data, data.success ? 'success' : 'error');
  } catch (e) {
    showResult('tc-result', { error: e.message }, 'error');
  }
  setLoading(this, false);
});

// ── Send Single Email ────────────────────────────────────
document.getElementById('btn-send').addEventListener('click', async function () {
  setLoading(this, true);
  try {
    const { data } = await call('/api/send', {
      smtp: smtpPayload('s'),
      email: {
        from: document.getElementById('s-from').value.trim(),
        to: document.getElementById('s-to').value.trim(),
        subject: document.getElementById('s-subject').value.trim(),
        text: document.getElementById('s-text').value.trim(),
      },
    });
    showResult('s-result', data, data.success ? 'success' : 'error');
  } catch (e) {
    showResult('s-result', { error: e.message }, 'error');
  }
  setLoading(this, false);
});

// ── Send Batch ───────────────────────────────────────────
document.getElementById('btn-batch').addEventListener('click', async function () {
  setLoading(this, true);
  try {
    const lines = document.getElementById('b-recipients').value
      .split('\n').map(l => l.trim()).filter(Boolean);

    const emails = lines.map(line => {
      const [to, subject, text] = line.split('|').map(s => s.trim());
      return { to, subject: subject || 'Test', text: text || 'Test email.' };
    });

    const { data } = await call('/api/send-batch', {
      smtp: smtpPayload('b'),
      emails,
      options: {
        from: document.getElementById('b-from').value.trim(),
        delayMs: parseInt(document.getElementById('b-delay').value),
      },
    });

    if (data.jobId) {
      document.getElementById('b-jobid').value = data.jobId;
    }
    showResult('b-result', data, data.success ? 'success' : 'error');
  } catch (e) {
    showResult('b-result', { error: e.message }, 'error');
  }
  setLoading(this, false);
});

// ── Poll Batch Status ────────────────────────────────────
document.getElementById('btn-poll').addEventListener('click', async function () {
  const jobId = document.getElementById('b-jobid').value.trim();
  if (!jobId) return showResult('b-poll-result', { error: 'No job ID' }, 'error');

  setLoading(this, true);
  try {
    const res = await fetch(`/api/batch-status/status/${jobId}`, {
      headers: { 'x-api-key': apiKey() },
    });
    const data = await res.json();
    const isDone = data.status === 'done' || data.status === 'failed';
    showResult('b-poll-result', data, isDone ? (data.failed === 0 ? 'success' : 'error') : 'info');
  } catch (e) {
    showResult('b-poll-result', { error: e.message }, 'error');
  }
  setLoading(this, false);
});

// ── Check Replies ────────────────────────────────────────
document.getElementById('btn-replies').addEventListener('click', async function () {
  setLoading(this, true);
  try {
    const subjects = document.getElementById('r-subjects').value
      .split(',').map(s => s.trim()).filter(Boolean);

    const { data } = await call('/api/check-replies', {
      imap: {
        host: document.getElementById('r-host').value.trim(),
        port: parseInt(document.getElementById('r-port').value),
        secure: document.getElementById('r-secure').value === 'true',
        auth: {
          user: document.getElementById('r-user').value.trim(),
          pass: document.getElementById('r-pass').value.trim(),
        },
      },
      options: {
        since: document.getElementById('r-since').value,
        limit: parseInt(document.getElementById('r-limit').value),
        ...(subjects.length && { filterSubjects: subjects }),
      },
    });
    showResult('r-result', data, data.success ? 'success' : 'error');
  } catch (e) {
    showResult('r-result', { error: e.message }, 'error');
  }
  setLoading(this, false);
});
