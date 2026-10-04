'use strict';

const express    = require('express');
const https      = require('https');
const fs         = require('fs');
const path       = require('path');

// ── Config ────────────────────────────────────────────────
const CFG_FILE = path.join(__dirname, 'config.json');
const CFG = fs.existsSync(CFG_FILE)
  ? JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'))
  : {};

const COMPANY         = process.env.COMPANY_NAME    || CFG.company_name      || 'פרישה פרימיום';
const ANTHROPIC_KEY   = process.env.ANTHROPIC_KEY   || CFG.anthropic_api_key || '';
const ADMIN           = process.env.ADMIN_EMAIL      || CFG.admin_email       || '';
// service@prishap.co.il is paused until the Resend sending domain is verified
// (sandbox from onboarding@resend.dev only allows the account owner email).

function parseEmailList(value) {
  const items = Array.isArray(value) ? value : String(value || '').split(/[,;]/);
  const seen = new Set();
  const out = [];
  for (const raw of items) {
    const email = String(raw || '').trim();
    const key = email.toLowerCase();
    if (!email || seen.has(key)) continue;
    seen.add(key);
    out.push(email);
  }
  return out;
}

function adminRecipients() {
  return parseEmailList(ADMIN);
}
const SMTP_USER       = process.env.SMTP_USER        || CFG.smtp_user         || '';
const RESEND_KEY      = process.env.RESEND_API_KEY   || CFG.resend_api_key    || '';
const PORT            = parseInt(process.env.PORT    || CFG.port              || 3000, 10);
const MAKE_WEBHOOK    = process.env.MAKE_WEBHOOK_URL || CFG.make_webhook_url  || '';
const ROETO_API_URL   = (process.env.ROETO_API_URL || CFG.roeto_api_url || 'https://api.roeto.co.il/api/v1').replace(/\/$/, '');
const ROETO_CLIENT_ID = process.env.ROETO_CLIENT_ID || CFG.roeto_client_id || '';
const ROETO_CLIENT_SECRET = process.env.ROETO_CLIENT_SECRET || CFG.roeto_client_secret || '';
const INTEGRATION_TIMEOUT_MS = 20000;

// ── Mailer via Resend HTTPS API ──────────────────────────
// Railway blocks outbound Gmail SMTP; Resend works over HTTPS.
// Custom domain not verified yet — send from onboarding@resend.dev.
const RESEND_FROM = process.env.RESEND_FROM
  || `${COMPANY} <onboarding@resend.dev>`;
const RESEND_TIMEOUT_MS = 25000;

function resendSend({ to, subject, html, attachments = [] }) {
  return new Promise((resolve, reject) => {
    if (!RESEND_KEY) return reject(new Error('מפתח Resend לא הוגדר (RESEND_API_KEY)'));

    const recipients = parseEmailList(to);
    if (!recipients.length) return reject(new Error('לא הוגדר נמען למייל'));

    const payload = {
      from:    RESEND_FROM,
      to:      recipients,
      subject,
      html,
    };
    if (SMTP_USER) payload.reply_to = SMTP_USER;
    if (attachments.length) payload.attachments = attachments;

    const body = JSON.stringify(payload);

    const req = https.request({
      hostname: 'api.resend.com',
      path:     '/emails',
      method:   'POST',
      headers:  {
        'Authorization':  `Bearer ${RESEND_KEY}`,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
        } else {
          console.error('[Resend] Error', res.statusCode, raw);
          reject(new Error(`Resend ${res.statusCode}: ${raw}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(RESEND_TIMEOUT_MS, () => {
      req.destroy();
      reject(new Error(`Resend timeout after ${RESEND_TIMEOUT_MS / 1000}s`));
    });
    req.write(body);
    req.end();
  });
}

async function sendEmails(client, pdfBuffer, idFile) {
  const first   = client.firstName || '';
  const last    = client.lastName  || '';
  const email   = client.email     || '';
  const pdfName = `הצטרפות-${first}-${last}.pdf`;

  const clientHtml = `
<div dir="rtl" style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
  <div style="background:linear-gradient(135deg,#1a1a2e,#0f3460);color:white;padding:30px;text-align:center;border-radius:8px 8px 0 0;">
    <h1 style="margin:0;font-size:24px;">${COMPANY}</h1>
    <p style="margin:8px 0 0;opacity:.8;">אישור הצטרפות</p>
  </div>
  <div style="background:#fff;padding:30px;border:1px solid #eee;border-radius:0 0 8px 8px;">
    <p style="font-size:16px;">שלום <strong>${first} ${last}</strong>,</p>
    <p>תודה על הצטרפותך ל${COMPANY}! אנחנו שמחים לקבל אותך.</p>
    <p>טופס ההצטרפות החתום מצורף לאימייל זה כקובץ PDF.</p>
    <div style="background:#f0f7ff;border-right:4px solid #0f3460;padding:15px;margin:20px 0;border-radius:4px;">
      <p style="margin:0;font-weight:bold;">מה קורה עכשיו?</p>
      <p style="margin:8px 0 0;">אנו פונים כעת לגופים הרלוונטיים (קרנות פנסיה, קופות גמל ועוד) לקבלת המידע המלא אודות חסכונותיך ונכסיך. נחזור אליך עם תמונה מלאה בהקדם האפשרי.</p>
    </div>
    <p>בברכה,<br><strong>צוות ${COMPANY}</strong></p>
  </div>
</div>`;

  const rows = [
    ['שם מלא',     `${first} ${last}`],
    ['מספר ת.ז',   client.idNumber    || ''],
    ['טלפון',      client.phone       || ''],
    ['אימייל',     email],
    ['תאריך לידה', client.birthDate   || ''],
    ['הנפקת ת.ז',  client.idIssueDate || ''],
  ];
  const rowsHtml = rows.map(([label, value], i) => {
    const bg = i % 2 === 0 ? '#f8f9fa' : 'white';
    return `<tr><td style="padding:8px;background:${bg};font-weight:bold;width:40%;">${label}:</td><td style="padding:8px;">${value}</td></tr>`;
  }).join('');

  const adminHtml = `
<div dir="rtl" style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
  <div style="background:#1a1a2e;color:white;padding:20px;text-align:center;border-radius:8px 8px 0 0;">
    <h2 style="margin:0;">לקוח חדש הצטרף!</h2>
  </div>
  <div style="background:#fff;padding:25px;border:1px solid #eee;border-radius:0 0 8px 8px;">
    <table style="width:100%;border-collapse:collapse;">${rowsHtml}</table>
    <p style="margin-top:20px;color:#666;font-size:13px;">טופס ההצטרפות החתום מצורף.</p>
  </div>
</div>`;

  const pdfAttachment = {
    content:  pdfBuffer.toString('base64'),
    filename: pdfName,
  };

  const promises = [];

  if (email) {
    promises.push(resendSend({
      to:          email,
      subject:     `אישור הצטרפות – ${COMPANY}`,
      html:        clientHtml,
      attachments: [pdfAttachment],
    }));
  }

  const adminTo = adminRecipients();
  if (adminTo.length) {
    const adminAttachments = [pdfAttachment];
    if (idFile && idFile.base64) {
      adminAttachments.push({
        content:  idFile.base64,
        filename: idFile.filename || 'תעודת-זהות',
      });
    }
    promises.push(resendSend({
      to:          adminTo,
      subject:     `לקוח חדש: ${first} ${last}`,
      html:        adminHtml,
      attachments: adminAttachments,
    }));
  }

  await Promise.all(promises);
}

// ── Shared HTTPS JSON helper ──────────────────────────────
function httpsJson({ url, method = 'GET', headers = {}, body = null, timeoutMs = INTEGRATION_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      return reject(new Error(`URL לא תקין: ${url}`));
    }
    const payload = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const opts = {
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method,
      headers:  { ...headers },
    };
    if (payload != null) {
      opts.headers['Content-Type'] = opts.headers['Content-Type'] || 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = https.request(opts, (res) => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        let data = null;
        if (raw) {
          try { data = JSON.parse(raw); } catch (_) { data = raw; }
        }
        resolve({ status: res.statusCode || 0, data, raw });
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`timeout after ${timeoutMs / 1000}s`));
    });
    if (payload != null) req.write(payload);
    req.end();
  });
}

// ── Date / address helpers ────────────────────────────────
function dmyToISO(dateStr) {
  if (!dateStr) return '';
  // DD/MM/YYYY from the form
  if (dateStr.includes('/')) {
    const [d, m, y] = dateStr.split('/');
    return (d && m && y) ? `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}T00:00:00.000Z` : dateStr;
  }
  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) return `${dateStr.slice(0, 10)}T00:00:00.000Z`;
  return dateStr;
}

/** Convert join form dates (DD/MM/YYYY or YYYY-MM-DD) → Roeto DD-MM-YYYY */
function toRoetoDate(dateStr) {
  if (!dateStr || dateStr === '-') return '';
  if (dateStr.includes('/')) {
    const [d, m, y] = dateStr.split('/');
    if (d && m && y) return `${d.padStart(2,'0')}-${m.padStart(2,'0')}-${y}`;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) {
    const [y, m, d] = dateStr.slice(0, 10).split('-');
    return `${d}-${m}-${y}`;
  }
  if (/^\d{2}-\d{2}-\d{4}$/.test(dateStr)) return dateStr;
  return '';
}

function digitsOnly(s) {
  return String(s || '').replace(/\D/g, '');
}

/** Best-effort split of free-text Israeli address into city + street */
function parseAddress(address) {
  const raw = String(address || '').trim();
  if (!raw) return { city: 'לא צוין', street: 'לא צוין' };
  const parts = raw.split(',').map(p => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    return { city: parts[parts.length - 1], street: parts.slice(0, -1).join(', ') };
  }
  const tokens = raw.split(/\s+/);
  if (tokens.length >= 2) {
    return { city: tokens[tokens.length - 1], street: tokens.slice(0, -1).join(' ') };
  }
  return { city: 'לא צוין', street: raw };
}

// ── Make Webhook (fail-soft) ──────────────────────────────
async function sendToMake(client, pdfBase64, pdfFilename) {
  if (!MAKE_WEBHOOK) {
    console.log('[Make] skipped – MAKE_WEBHOOK_URL לא הוגדר');
    return { skipped: true };
  }

  const payload = {
    source:      'join',
    company:     COMPANY,
    firstName:   client.firstName   || '',
    lastName:    client.lastName    || '',
    idNumber:    client.idNumber    || '',
    birthDate:   dmyToISO(client.birthDate),
    // Roeto Make module expects birthDay (DD-MM-YYYY), same value as birthDate
    birthDay:    toRoetoDate(client.birthDate),
    idIssueDate: dmyToISO(client.idIssueDate),
    phone:       client.phone       || '',
    email:       client.email       || '',
    address:     client.address     || '',
    gender:      client.gender      || '',
    pdfBase64,
    pdfFilename,
    submittedAt: new Date().toISOString(),
  };

  try {
    const res = await httpsJson({ url: MAKE_WEBHOOK, method: 'POST', body: payload });
    console.log('[Make] webhook status:', res.status);
    return { ok: res.status >= 200 && res.status < 300, status: res.status };
  } catch (e) {
    console.error('[Make] webhook error:', e.message);
    return { ok: false, error: e.message };
  }
}

// ── Roeto (trom-yeutz create, fail-soft) ──────────────────
let roetoTokenCache = { token: '', expiresAt: 0 };

async function getRoetoToken() {
  if (!ROETO_CLIENT_ID || !ROETO_CLIENT_SECRET) {
    throw new Error('חסרים ROETO_CLIENT_ID / ROETO_CLIENT_SECRET');
  }
  const now = Date.now();
  if (roetoTokenCache.token && roetoTokenCache.expiresAt > now + 60_000) {
    return roetoTokenCache.token;
  }
  const basic = Buffer.from(`${ROETO_CLIENT_ID}:${ROETO_CLIENT_SECRET}`).toString('base64');
  const res = await httpsJson({
    url:    `${ROETO_API_URL}/oauth/token`,
    method: 'POST',
    headers: { Authorization: `Basic ${basic}` },
    body:   { grant_type: 'client_credentials' },
  });
  if (res.status < 200 || res.status >= 300 || !res.data || !res.data.token) {
    const msg = (res.data && (res.data.message || res.data.error)) || res.raw || `HTTP ${res.status}`;
    throw new Error(`Roeto auth failed: ${msg}`);
  }
  // JWT lifetime unknown — cache ~50 minutes
  roetoTokenCache = { token: res.data.token, expiresAt: now + 50 * 60 * 1000 };
  return res.data.token;
}

async function sendToRoeto(client) {
  if (!ROETO_CLIENT_ID || !ROETO_CLIENT_SECRET) {
    console.log('[Roeto] skipped – credentials לא הוגדרו');
    return { skipped: true };
  }

  const personalID = digitsOnly(client.idNumber);
  if (!/^\d{9}$/.test(personalID)) {
    console.warn('[Roeto] skipped – ת.ז לא תקינה');
    return { skipped: true, reason: 'invalid_id' };
  }

  try {
    const token = await getRoetoToken();
    const authHeaders = { Authorization: `Bearer ${token}` };
    const { city, street } = parseAddress(client.address);
    const birthDay = toRoetoDate(client.birthDate);
    const gender = (client.gender === '2' || client.gender === 2) ? '2' : '1';
    const phone = digitsOnly(client.phone);

    // Soft existence check (search) — if found, do not create again
    try {
      const search = await httpsJson({
        url: `${ROETO_API_URL}/clients/search?userID=${encodeURIComponent(personalID)}`,
        method: 'GET',
        headers: authHeaders,
      });
      if (search.status === 200 && Array.isArray(search.data) && search.data.length > 0) {
        console.log('[Roeto] client already exists – skip create, try idIssueDate');
        const idIssue = toRoetoDate(client.idIssueDate);
        if (idIssue) {
          const upd = await httpsJson({
            url: `${ROETO_API_URL}/clients/${encodeURIComponent(personalID)}/set-id-issue-date`,
            method: 'POST',
            headers: authHeaders,
            body: { idIssueDate: idIssue },
          });
          console.log('[Roeto] set-id-issue-date status:', upd.status);
        }
        return { ok: true, existed: true, userID: personalID };
      }
    } catch (e) {
      console.warn('[Roeto] search warning:', e.message);
    }

    const body = {
      personalID,
      firstName:    client.firstName || '',
      lastName:     client.lastName  || '',
      gender,
      birthDay:     birthDay || '01-01-1970',
      primaryPhone: phone || '0500000000',
      email:        client.email || '',
      city,
      street,
    };

    const create = await httpsJson({
      url: `${ROETO_API_URL}/clients/create-trom-yeutz-client`,
      method: 'POST',
      headers: authHeaders,
      body,
    });

    if (create.status >= 200 && create.status < 300) {
      console.log('[Roeto] trom-yeutz created for', personalID);
      const idIssue = toRoetoDate(client.idIssueDate);
      if (idIssue) {
        try {
          const upd = await httpsJson({
            url: `${ROETO_API_URL}/clients/${encodeURIComponent(personalID)}/set-id-issue-date`,
            method: 'POST',
            headers: authHeaders,
            body: { idIssueDate: idIssue },
          });
          console.log('[Roeto] set-id-issue-date status:', upd.status);
        } catch (e) {
          console.warn('[Roeto] set-id-issue-date warning:', e.message);
        }
      }
      return { ok: true, created: true, userID: personalID, data: create.data };
    }

    // 400 often means already exists — treat as soft success
    if (create.status === 400) {
      console.warn('[Roeto] create 400 (possibly exists):', typeof create.data === 'string' ? create.data : JSON.stringify(create.data));
      return { ok: true, existed: true, userID: personalID, status: 400 };
    }

    console.error('[Roeto] create failed', create.status, typeof create.data === 'string' ? create.data : JSON.stringify(create.data));
    return { ok: false, status: create.status, data: create.data };
  } catch (e) {
    console.error('[Roeto] error:', e.message);
    return { ok: false, error: e.message };
  }
}


// ── Claude Vision ─────────────────────────────────────────
function callClaudeVision(imageB64) {
  return new Promise((resolve) => {
    if (!ANTHROPIC_KEY) {
      return resolve({ success: false, message: 'מפתח Anthropic API לא הוגדר ב-config.json' });
    }

    const prompt = `This is an image of an Israeli ID card (תעודת זהות), possibly including the appendix (ספח).
Extract the following fields and return ONLY a valid JSON object — no other text before or after:
{"firstName":"","lastName":"","idNumber":"","birthDate":"YYYY-MM-DD","idIssueDate":"YYYY-MM-DD","address":"","gender":""}
Rules:
- firstName, lastName: in Hebrew exactly as printed on the card
- idNumber: exactly 9 digits
- birthDate, idIssueDate: YYYY-MM-DD format
- address: full address from the ספח (appendix) if visible
- gender: "1" if the card shows זכר (male), "2" if it shows נקבה (female), "" if unclear
- Use empty string "" for any field that is unclear or not visible
Return ONLY the JSON object, nothing else.`;

    const body = JSON.stringify({
      model:      'claude-opus-4-6',
      max_tokens: 256,
      messages:   [{
        role:    'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageB64 } },
          { type: 'text',  text: prompt },
        ],
      }],
    });

    const req = https.request({
      hostname: 'api.anthropic.com',
      path:     '/v1/messages',
      method:   'POST',
      headers:  {
        'x-api-key':         ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
        'content-length':    Buffer.byteLength(body),
      },
    }, (res) => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try {
          const data = JSON.parse(raw);
          if (res.statusCode === 200) {
            const text    = (data.content?.[0]?.text || '').trim();
            const match   = text.match(/\{[\s\S]*\}/);
            if (match) {
              resolve({ success: true, data: JSON.parse(match[0]) });
            } else {
              resolve({ success: false, message: 'לא ניתן לפרש את התשובה' });
            }
          } else {
            resolve({ success: false, message: `שגיאת API: ${data.error?.message || res.statusCode}` });
          }
        } catch (e) {
          resolve({ success: false, message: `שגיאת פריסה: ${e.message}` });
        }
      });
    });

    req.on('error', e => resolve({ success: false, message: `שגיאה: ${e.message}` }));
    req.setTimeout(30000, () => { req.destroy(); resolve({ success: false, message: 'תם הזמן – נסה שנית' }); });
    req.write(body);
    req.end();
  });
}

// ── App ───────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '50mb' }));
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/extract-id', async (req, res) => {
  const imageB64 = (req.body.imageBase64 || '').trim();
  if (!imageB64) return res.status(400).json({ success: false, message: 'תמונה חסרה' });

  console.error('\n[extract-id] קיבלתי בקשה, גודל base64:', imageB64.length);
  const result = await callClaudeVision(imageB64);
  console.error('[extract-id] תשובה:', JSON.stringify(result));

  if (result.success) {
    res.json(result);
  } else {
    res.status(500).json(result);
  }
});

app.post('/api/submit', async (req, res) => {
  const { clientData: client = {}, pdfBase64 = '', idFile } = req.body;

  if (!client.firstName) return res.status(400).json({ success: false, message: 'נתונים חסרים' });
  if (!pdfBase64)        return res.status(400).json({ success: false, message: 'קובץ PDF חסר' });

  try {
    const pdfBuffer  = Buffer.from(pdfBase64, 'base64');
    const pdfFilename = `הצטרפות-${client.firstName || ''}-${client.lastName || ''}.pdf`;
    await sendEmails(client, pdfBuffer, idFile);
    // Make + Roeto: fail-soft — email success is enough for the user response
    Promise.allSettled([
      sendToMake(client, pdfBase64, pdfFilename),
      sendToRoeto(client),
    ]).then((results) => {
      console.log('[integrations] Make:', results[0].status, results[0].value || results[0].reason);
      console.log('[integrations] Roeto:', results[1].status, results[1].value || results[1].reason);
    });
    res.json({ success: true, message: 'המסמכים נשלחו בהצלחה!' });
  } catch (e) {
    console.error('שגיאת שליחת מייל:', e.message);
    let msg;
    if (/timeout/i.test(e.message)) {
      msg = 'שליחת המייל נכשלה – תם הזמן. נסה שוב.';
    } else if (/api.?key|unauthorized|401|RESEND_API_KEY/i.test(e.message)
      && !/validation_error|403/i.test(e.message)) {
      msg = 'שגיאת אימות – בדוק RESEND_API_KEY ב-Railway';
    } else {
      let detail = e.message;
      const m = String(e.message || '').match(/Resend\s+\d+:\s*(.+)$/i);
      if (m) {
        try {
          const parsed = JSON.parse(m[1]);
          if (parsed && parsed.message) detail = parsed.message;
        } catch (_) { /* keep raw */ }
      }
      msg = `שגיאת Resend: ${detail}`;
    }
    res.status(500).json({ success: false, message: msg });
  }
});

// ── Start ─────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('====================================================');
  console.log(`  Server: ${COMPANY}`);
  console.log('====================================================');
  console.log(`  Port:  ${PORT}`);
  console.log(`  Admin: ${adminRecipients().join(', ')}`);
  console.log(`  URL:   http://localhost:${PORT}`);
  console.log('');
});
