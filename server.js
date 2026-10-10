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

// Staging is opt-in. An unset APP_ENV (production) must not change
// subjects, HTML, or response headers.
const STAGING_ROBOTS = 'noindex, nofollow';

function isStagingEnv(appEnv = process.env.APP_ENV) {
  return appEnv === 'staging';
}

function emailSubject(subject, appEnv = process.env.APP_ENV) {
  return isStagingEnv(appEnv) ? `[בדיקה] ${subject}` : subject;
}

function adminNewClientSubject(client = {}) {
  const first = client.firstName || '';
  const last = client.lastName || '';
  const id = client.idNumber || '';
  return `לקוח חדש: ${first} ${last} – ת.ז ${id}`;
}

function applyStagingDocument(html, appEnv = process.env.APP_ENV) {
  if (!isStagingEnv(appEnv)) return html;
  let out = html;
  if (!/name=["']robots["']/i.test(out)) {
    out = out.replace(
      /<head(\s[^>]*)?>/i,
      (match) => `${match}\n  <meta name="robots" content="${STAGING_ROBOTS}" />`,
    );
  }
  if (!out.includes('class="env-banner"')) {
    out = out.replace(
      '<header class="app-header">',
      '<header class="app-header">\n    <div class="env-banner" role="status">סביבת בדיקה</div>',
    );
  }
  return out;
}

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

// Keep ids and names in sync with JOIN_DOCUMENTS in public/app.js.
const JOIN_DOCUMENTS = [
  { id: 'consent',   name: 'הסכמת לקוח' },
  { id: 'pension',   name: 'ייפוי כח פנסיוני' },
  { id: 'insurance', name: 'ייפוי כח ביטוח' },
  { id: 'har',       name: 'ייפוי כח להר הביטוח' },
];

function resolveDocumentSelection(selectedIds) {
  const explicit = selectedIds !== undefined && selectedIds !== null;
  if (!explicit) {
    return { selected: JOIN_DOCUMENTS.slice(), deselected: [], explicit: false };
  }
  const wanted = new Set();
  if (Array.isArray(selectedIds)) {
    for (const raw of selectedIds) {
      const id = String(raw || '').trim();
      if (JOIN_DOCUMENTS.some(doc => doc.id === id)) wanted.add(id);
    }
  }
  return {
    selected:   JOIN_DOCUMENTS.filter(doc => wanted.has(doc.id)),
    deselected: JOIN_DOCUMENTS.filter(doc => !wanted.has(doc.id)),
    explicit:   true,
  };
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function documentNamesHtml(docs) {
  if (!docs.length) return '<p style="margin:0;color:#666;">אין</p>';
  const items = docs.map(doc => `<li style="margin:0 0 4px;">${escapeHtml(doc.name)}</li>`).join('');
  return `<ul style="margin:0;padding:0 18px 0 0;">${items}</ul>`;
}

function renderDocumentSelectionHtml(selection, audience) {
  const selected = documentNamesHtml(selection.selected);
  const box = 'background:#f7eef0;border-right:4px solid #7a1f2b;padding:15px;margin:20px 0;border-radius:4px;';
  if (audience === 'client') {
    return `
      <div style="${box}">
        <p style="margin:0 0 8px;font-weight:bold;">המסמכים החתומים המצורפים</p>
        ${selected}
      </div>`;
  }
  const deselected = selection.deselected.length
    ? documentNamesHtml(selection.deselected)
    : '<p style="margin:0;color:#666;">הלקוח חתם על כל המסמכים.</p>';
  return `
    <div style="${box}">
      <p style="margin:0 0 8px;font-weight:bold;">מסמכים שנחתמו</p>
      ${selected}
      <p style="margin:12px 0 8px;font-weight:bold;">מסמכים שלא סומנו</p>
      ${deselected}
    </div>`;
}

async function sendEmails(client, pdfBuffer, idFile, selection = resolveDocumentSelection(client && client.selectedDocumentIds)) {
  const first   = client.firstName || '';
  const last    = client.lastName  || '';
  const email   = client.email     || '';
  const pdfName = `הצטרפות-${first}-${last}.pdf`;

  const clientHtml = `
<div dir="rtl" style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
  <div style="background:linear-gradient(135deg,#5e1218,#7a1f2b);color:white;padding:30px;text-align:center;border-radius:8px 8px 0 0;">
    <h1 style="margin:0;font-size:24px;">${COMPANY}</h1>
    <p style="margin:8px 0 0;opacity:.8;">אישור הצטרפות</p>
  </div>
  <div style="background:#fff;padding:30px;border:1px solid #eee;border-radius:0 0 8px 8px;">
    <p style="font-size:16px;">שלום <strong>${first} ${last}</strong>,</p>
    <p>תודה על הצטרפותך ל${COMPANY}! אנחנו שמחים לקבל אותך.</p>
    <p>טופס ההצטרפות החתום מצורף לאימייל זה כקובץ PDF.</p>
    ${renderDocumentSelectionHtml(selection, 'client')}
    <div style="background:#f7eef0;border-right:4px solid #7a1f2b;padding:15px;margin:20px 0;border-radius:4px;">
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
  const addressLine = String(client.address || '').trim() || composeAddress(client);
  if (addressLine) rows.push(['כתובת', addressLine]);
  const rowsHtml = rows.map(([label, value], i) => {
    const bg = i % 2 === 0 ? '#f8f9fa' : 'white';
    return `<tr><td style="padding:8px;background:${bg};font-weight:bold;width:40%;">${label}:</td><td style="padding:8px;">${value}</td></tr>`;
  }).join('');

  const adminHtml = `
<div dir="rtl" style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
  <div style="background:#5e1218;color:white;padding:20px;text-align:center;border-radius:8px 8px 0 0;">
    <h2 style="margin:0;">לקוח חדש הצטרף!</h2>
  </div>
  <div style="background:#fff;padding:25px;border:1px solid #eee;border-radius:0 0 8px 8px;">
    <table style="width:100%;border-collapse:collapse;">${rowsHtml}</table>
    <p style="margin-top:20px;color:#666;font-size:13px;">טופס ההצטרפות החתום מצורף.</p>
    ${renderDocumentSelectionHtml(selection, 'admin')}
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
      subject:     emailSubject(`אישור הצטרפות – ${COMPANY}`),
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
      subject:     emailSubject(adminNewClientSubject(client)),
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

/** Best-effort split of free-text Israeli address into city + street.
 *  A trailing 5- or 7-digit postal code is peeled off so it is not treated as the city.
 */
function parseAddress(address) {
  let raw = String(address || '').trim();
  if (!raw) return { city: 'לא צוין', street: 'לא צוין' };
  raw = raw.replace(/(?:^|[\s,]+)(?:\d{7}|\d{5})\s*$/, '').replace(/[\s,]+$/, '').trim();
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

function cleanText(value, max) {
  return String(value == null ? '' : value)
    .replace(/[\u200e\u200f\u202a-\u202e]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function normalizeIsoDate(value) {
  const s = cleanText(value, 40);
  let iso = '';
  const dmy = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/);
  if (dmy) iso = `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  else {
    const ymd = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (ymd) iso = `${ymd[1]}-${ymd[2]}-${ymd[3]}`;
  }
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  const [y, mo, da] = iso.split('-').map(Number);
  if (d.getUTCFullYear() !== y || d.getUTCMonth() + 1 !== mo || d.getUTCDate() !== da) return '';
  return iso;
}

/** Keep a real 9-digit ID. Pad a near-complete number (7–8 digits). Leave shorter fragments unpadded. */
function normalizeIdNumber(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits || digits.length > 9) return '';
  if (digits.length >= 7) return digits.padStart(9, '0');
  return digits;
}

function normalizeZip(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 5 || digits.length === 7) return digits;
  return '';
}

function normalizeGender(value) {
  const s = cleanText(value, 16).toLowerCase();
  if (s === '1' || s === 'זכר' || s === 'male' || s === 'm') return '1';
  if (s === '2' || s === 'נקבה' || s === 'female' || s === 'f') return '2';
  return '';
}

function composeAddress(parts = {}) {
  const street = String(parts.street || '').trim();
  const house = String(parts.houseNumber || '').trim();
  const apt = String(parts.apartment || '').trim();
  const city = String(parts.city || '').trim();
  const zip = String(parts.zip || '').trim();
  let line = [street, house].filter(Boolean).join(' ');
  if (apt) line = line ? `${line}, דירה ${apt}` : `דירה ${apt}`;
  return [line, city, zip].filter(Boolean).join(', ');
}

/** Fill empty address parts from a single printed line. Does not overwrite parts already present. */
function splitIsraeliAddress(address) {
  let raw = String(address || '').replace(/\s+/g, ' ').trim();
  const empty = { street: '', houseNumber: '', apartment: '', city: '', zip: '' };
  if (!raw) return empty;

  let zip = '';
  const zipMatch = raw.match(/(?:^|[\s,]+)(\d{7}|\d{5})\s*$/);
  if (zipMatch) {
    zip = zipMatch[1];
    raw = raw.slice(0, zipMatch.index).replace(/[\s,]+$/, '').trim();
  }

  let apartment = '';
  const aptWord = raw.match(/(?:^|[\s,])(?:דירה|דירת)\s*(\d+[א-ת]?)(?=$|[\s,])/u);
  if (aptWord) {
    apartment = aptWord[1];
    raw = `${raw.slice(0, aptWord.index)} ${raw.slice(aptWord.index + aptWord[0].length)}`
      .replace(/\s+/g, ' ')
      .replace(/\s+,/g, ',')
      .replace(/,\s*,/g, ',')
      .trim();
  }

  let city = '';
  let streetPart = raw;
  if (raw.includes(',')) {
    const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
    if (parts.length >= 2) {
      city = parts[parts.length - 1];
      streetPart = parts.slice(0, -1).join(' ');
    }
  }

  if (!apartment) {
    const slash = streetPart.match(/(\d+[א-ת]?)\s*\/\s*(\d+[א-ת]?)/u);
    if (slash) {
      apartment = slash[2];
      streetPart = streetPart.replace(slash[0], slash[1]);
    }
  }

  streetPart = streetPart.replace(/^רחוב\s+/u, '').trim();

  let street = streetPart;
  let houseNumber = '';
  const house = streetPart.match(/^(.*\D)\s+(\d+[א-ת]?)$/u);
  if (house && house[1].trim()) {
    street = house[1].replace(/[,\s]+$/g, '').trim();
    houseNumber = house[2];
  }

  return { street, houseNumber, apartment, city, zip };
}

function emptyExtracted() {
  return {
    firstName: '', lastName: '', idNumber: '', birthDate: '', idIssueDate: '',
    gender: '', street: '', houseNumber: '', apartment: '', city: '', zip: '', address: '',
  };
}

function normalizeExtracted(raw) {
  const d = raw && typeof raw === 'object' ? raw : {};
  const out = emptyExtracted();
  out.firstName = cleanText(d.firstName, 40);
  out.lastName = cleanText(d.lastName, 40);
  out.idNumber = normalizeIdNumber(d.idNumber);
  out.birthDate = normalizeIsoDate(d.birthDate);
  out.idIssueDate = normalizeIsoDate(d.idIssueDate);
  out.gender = normalizeGender(d.gender);
  out.street = cleanText(d.street, 60).replace(/^רחוב\s+/u, '');
  out.houseNumber = cleanText(d.houseNumber, 12);
  out.apartment = cleanText(d.apartment, 12).replace(/^דירה\s+/u, '');
  out.city = cleanText(d.city, 40);
  out.zip = normalizeZip(d.zip || d.zipCode || d.postalCode);
  out.address = cleanText(d.address, 180);

  const missingPart = !out.street || !out.city || !out.houseNumber || !out.zip || !out.apartment;
  if (out.address && missingPart) {
    const split = splitIsraeliAddress(out.address);
    if (!out.street) out.street = split.street;
    if (!out.houseNumber) out.houseNumber = split.houseNumber;
    if (!out.apartment) out.apartment = split.apartment;
    if (!out.city) out.city = split.city;
    if (!out.zip) out.zip = split.zip;
  }
  if (!out.address) out.address = composeAddress(out);
  return out;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** City + street for Roeto. Structured parts win; otherwise the legacy free-text split. */
function resolveRoetoAddress(client = {}) {
  const hasParts = ['street', 'houseNumber', 'apartment', 'city'].some(k => String(client[k] || '').trim());
  if (!hasParts) return parseAddress(client.address);

  let street = String(client.street || '').trim();
  const house = String(client.houseNumber || '').trim();
  const apt = String(client.apartment || '').trim();
  if (house && !new RegExp(`(?:^|\\s)${escapeRegExp(house)}$`).test(street)) {
    street = street ? `${street} ${house}` : house;
  }
  if (apt && !new RegExp(`דירה\\s+${escapeRegExp(apt)}(?:\\s|$)`).test(street)) {
    street = street ? `${street} דירה ${apt}` : `דירה ${apt}`;
  }
  const city = String(client.city || '').trim();
  return {
    city: city || 'לא צוין',
    street: street || 'לא צוין',
  };
}

function stripDataUrl(value) {
  const s = String(value || '').trim();
  const m = s.match(/^data:[^;]+;base64,([\s\S]+)$/i);
  return (m ? m[1] : s).replace(/\s/g, '');
}

const MAX_ID_IMAGES = 8;

function collectIdImages(body) {
  const src = [];
  if (body && Array.isArray(body.images) && body.images.length) src.push(...body.images);
  else if (body && body.imageBase64) src.push(body.imageBase64);
  const out = [];
  for (const item of src) {
    if (out.length >= MAX_ID_IMAGES) break;
    const clean = stripDataUrl(item);
    if (clean.length < 32) continue;
    out.push(clean);
  }
  return out;
}

function sniffImageMediaType(b64) {
  let buf;
  try { buf = Buffer.from(String(b64).slice(0, 48), 'base64'); }
  catch (_) { return 'image/jpeg'; }
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xD8) return 'image/jpeg';
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return 'image/jpeg';
}

// ── Make Webhook (fail-soft) ──────────────────────────────
function buildMakePayload(client, pdfBase64, pdfFilename, selection = resolveDocumentSelection(client && client.selectedDocumentIds), submittedAt = new Date().toISOString()) {
  const chosen = selection || resolveDocumentSelection(undefined);
  return {
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
    address:     String(client.address || '').trim() || composeAddress(client),
    street:      client.street      || '',
    houseNumber: client.houseNumber || '',
    apartment:   client.apartment   || '',
    city:        client.city        || '',
    zip:         client.zip         || '',
    gender:      client.gender      || '',
    selectedDocuments:   chosen.selected.map(doc => ({ id: doc.id, name: doc.name })),
    deselectedDocuments: chosen.deselected.map(doc => ({ id: doc.id, name: doc.name })),
    pdfBase64,
    pdfFilename,
    submittedAt,
  };
}

async function sendToMake(client, pdfBase64, pdfFilename, selection) {
  if (!MAKE_WEBHOOK) {
    console.log('[Make] skipped – MAKE_WEBHOOK_URL לא הוגדר');
    return { skipped: true };
  }

  const payload = buildMakePayload(client, pdfBase64, pdfFilename, selection);

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
    const { city, street } = resolveRoetoAddress(client);
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
function callClaudeVision(images) {
  return new Promise((resolve) => {
    const list = (Array.isArray(images) ? images : [images]).filter(Boolean).slice(0, MAX_ID_IMAGES);
    if (!ANTHROPIC_KEY) {
      return resolve({ success: false, message: 'מפתח Anthropic API לא הוגדר ב-config.json' });
    }
    if (!list.length) {
      return resolve({ success: false, message: 'תמונה חסרה' });
    }

    const prompt = `You are reading one or more images of a single Israeli identity card (תעודת זהות), in order.
Images may include the front, the back, and the appendix (ספח). Use ALL images together.
Prefer the ספח for the address and for the issue date when those are visible there.
Return ONLY a JSON object, no markdown and no extra text:
{"firstName":"","lastName":"","idNumber":"","birthDate":"YYYY-MM-DD","idIssueDate":"YYYY-MM-DD","gender":"","street":"","houseNumber":"","apartment":"","city":"","zip":"","address":""}
Rules:
- firstName, lastName: Hebrew, exactly as printed
- idNumber: digits only, as printed. Do not invent missing digits.
- birthDate, idIssueDate: YYYY-MM-DD, or "" if unclear
- gender: "1" for זכר, "2" for נקבה, "" if unclear
- street: street name only, without the house number and without the word רחוב
- houseNumber: house number only (digits plus a Hebrew letter when printed, e.g. 12א)
- apartment: apartment number only when דירה is printed, otherwise ""
- city: city or settlement (יישוב) only
- zip: postal code of 5 or 7 digits, otherwise ""
- address: one Hebrew line of the visible parts, e.g. "הרצל 12, דירה 4, תל אביב, 6100000"
- Use "" for anything that is not visible. Do not guess.`;

    const content = list.map(data => ({
      type: 'image',
      source: { type: 'base64', media_type: sniffImageMediaType(data), data },
    }));
    content.push({ type: 'text', text: prompt });

    const body = JSON.stringify({
      model:      'claude-opus-4-6',
      max_tokens: 800,
      messages:   [{ role: 'user', content }],
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
    req.setTimeout(60000, () => { req.destroy(); resolve({ success: false, message: 'תם הזמן – נסה שנית' }); });
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

function sendIndex(_req, res, next) {
  fs.readFile(path.join(__dirname, 'public', 'index.html'), 'utf8', (err, html) => {
    if (err) return next(err);
    res.type('html').send(applyStagingDocument(html));
  });
}

if (isStagingEnv()) {
  app.use((req, res, next) => {
    res.setHeader('X-Robots-Tag', STAGING_ROBOTS);
    next();
  });
  app.get('/', sendIndex);
  app.get('/index.html', sendIndex);
}

app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/extract-id', async (req, res) => {
  const images = collectIdImages(req.body || {});
  if (!images.length) return res.status(400).json({ success: false, message: 'תמונה חסרה' });

  console.error('\n[extract-id] עמודים:', images.length, 'תווים:', images.reduce((sum, img) => sum + img.length, 0));
  const result = await callClaudeVision(images);

  if (result.success) {
    result.data = normalizeExtracted(result.data);
    const filled = Object.entries(result.data).filter(([, v]) => String(v || '').trim()).map(([k]) => k);
    console.error('[extract-id] שדות שזוהו:', filled.join(', ') || '(none)');
    res.json(result);
  } else {
    console.error('[extract-id] שגיאה:', result.message);
    res.status(500).json(result);
  }
});

app.post('/api/submit', async (req, res) => {
  const { clientData: client = {}, pdfBase64 = '', idFile } = req.body;

  if (!client.firstName) return res.status(400).json({ success: false, message: 'נתונים חסרים' });
  if (!pdfBase64)        return res.status(400).json({ success: false, message: 'קובץ PDF חסר' });

  const selection = resolveDocumentSelection(
    Object.prototype.hasOwnProperty.call(client, 'selectedDocumentIds') ? client.selectedDocumentIds : undefined,
  );
  if (selection.explicit && !selection.selected.length) {
    return res.status(400).json({ success: false, message: 'יש לסמן לפחות מסמך אחד לחתימה' });
  }

  try {
    const pdfBuffer  = Buffer.from(pdfBase64, 'base64');
    const pdfFilename = `הצטרפות-${client.firstName || ''}-${client.lastName || ''}.pdf`;
    await sendEmails(client, pdfBuffer, idFile, selection);
    // Make + Roeto: fail-soft — email success is enough for the user response.
    // Roeto still receives only the client record, not the document choice.
    Promise.allSettled([
      sendToMake(client, pdfBase64, pdfFilename, selection),
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
if (require.main === module) {
  app.listen(PORT, () => {
    console.log('');
    console.log('====================================================');
    console.log(`  Server: ${COMPANY}`);
    console.log('====================================================');
    console.log(`  Port:  ${PORT}`);
    console.log(`  Env:   ${isStagingEnv() ? 'staging' : 'production'}`);
    console.log(`  Admin: ${adminRecipients().join(', ')}`);
    console.log(`  URL:   http://localhost:${PORT}`);
    console.log('');
  });
}

module.exports = {
  app,
  composeAddress,
  parseAddress,
  splitIsraeliAddress,
  normalizeExtracted,
  resolveRoetoAddress,
  collectIdImages,
  isStagingEnv,
  emailSubject,
  adminNewClientSubject,
  applyStagingDocument,
  JOIN_DOCUMENTS,
  resolveDocumentSelection,
  renderDocumentSelectionHtml,
  buildMakePayload,
};
