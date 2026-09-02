'use strict';

const express    = require('express');
const nodemailer = require('nodemailer');
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
const SMTP_USER       = process.env.SMTP_USER        || CFG.smtp_user         || '';
const SMTP_PASS       = process.env.SMTP_PASSWORD    || CFG.smtp_password     || '';
const PORT            = parseInt(process.env.PORT    || CFG.port              || 3000, 10);
const MAKE_WEBHOOK    = process.env.MAKE_WEBHOOK_URL || CFG.make_webhook_url  || '';

// ── Mailer ────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  host:   'smtp.gmail.com',
  port:   587,
  secure: false,
  auth:   { user: SMTP_USER, pass: SMTP_PASS },
});

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

  const pdfAttachment = { filename: pdfName, content: pdfBuffer, contentType: 'application/pdf' };

  const promises = [];

  if (email) {
    promises.push(transporter.sendMail({
      from:        `"${COMPANY}" <${SMTP_USER}>`,
      to:          email,
      subject:     `אישור הצטרפות – ${COMPANY}`,
      html:        clientHtml,
      attachments: [pdfAttachment],
    }));
  }

  if (ADMIN) {
    const adminAttachments = [pdfAttachment];
    if (idFile && idFile.base64) {
      adminAttachments.push({
        filename:    idFile.filename || 'תעודת-זהות',
        content:     Buffer.from(idFile.base64, 'base64'),
        contentType: idFile.mimeType || 'image/jpeg',
      });
    }
    promises.push(transporter.sendMail({
      from:        `"${COMPANY}" <${SMTP_USER}>`,
      to:          ADMIN,
      subject:     `לקוח חדש: ${first} ${last}`,
      html:        adminHtml,
      attachments: adminAttachments,
    }));
  }

  await Promise.all(promises);
}

// ── Make Webhook ──────────────────────────────────────────
function dmyToISO(dateStr) {
  if (!dateStr) return '';
  const [d, m, y] = dateStr.split('/');
  return (d && m && y) ? `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}T00:00:00.000Z` : dateStr;
}

function sendToMake(client, pdfBase64, pdfFilename) {
  if (!MAKE_WEBHOOK) return;

  const payload = JSON.stringify({
    firstName:   client.firstName   || '',
    lastName:    client.lastName    || '',
    idNumber:    client.idNumber    || '',
    birthDate:   dmyToISO(client.birthDate),
    idIssueDate: dmyToISO(client.idIssueDate),
    phone:       client.phone       || '',
    email:       client.email       || '',
    address:     client.address     || '',
    gender:      client.gender      || '',
    pdfBase64,
    pdfFilename,
    submittedAt: new Date().toISOString(),
  });

  const url  = new URL(MAKE_WEBHOOK);
  const opts = {
    hostname: url.hostname,
    path:     url.pathname,
    method:   'POST',
    headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
  };

  const req = https.request(opts, (res) => {
    console.log('[Make] webhook status:', res.statusCode);
  });
  req.on('error', (e) => console.error('[Make] webhook error:', e.message));
  req.write(payload);
  req.end();
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
    sendToMake(client, pdfBase64, pdfFilename);
    res.json({ success: true, message: 'המסמכים נשלחו בהצלחה!' });
  } catch (e) {
    console.error('שגיאת שליחת מייל:', e.message);
    const msg = e.message.includes('Invalid login') || e.message.includes('auth')
      ? 'שגיאת אימות – בדוק smtp_user ו-smtp_password ב-config.json'
      : `שגיאה פנימית: ${e.message}`;
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
  console.log(`  Admin: ${ADMIN}`);
  console.log(`  URL:   http://localhost:${PORT}`);
  console.log('');
});
