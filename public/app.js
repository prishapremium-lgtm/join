'use strict';
/* ══════════════════════════════════════════════════════════
   פרישה פרימיום – app.js
   4 legal documents: הסכמת לקוח, נספח א (פנסיוני), נספח ב (ביטוח), נספח ה (הר הביטוח)
   PDF: generated in-browser via html2canvas + jsPDF
   Email: sent via /api/submit (Ruby server)
══════════════════════════════════════════════════════════ */

// ── State ─────────────────────────────────────────────────
let formData        = {};
let signaturePad    = null;
let idExtractedData = null;

// ── Helpers ───────────────────────────────────────────────
function formatDate(iso) {
  if (!iso) return '-';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function todayHebrew() {
  return new Date().toLocaleDateString('he-IL', { year: 'numeric', month: 'long', day: 'numeric' });
}

function setLoadingMsg(msg) { document.getElementById('loading-msg').textContent = msg; }
function showLoading(v)     { document.getElementById('loading-overlay').classList.toggle('hidden', !v); }

// ── Step 0 – Intro & ID upload ───────────────────────────
async function compressImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('טעינת תמונה נכשלה')); };
    img.onload = () => {
      try {
        const MAX = 1400;
        const scale  = Math.min(1, MAX / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width  = Math.max(1, Math.round(img.width  * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL('image/jpeg', 0.85).split(',')[1]);
      } catch (e) { URL.revokeObjectURL(url); reject(e); }
    };
    img.src = url;
  });
}

async function extractIdData(file) {
  const statusEl = document.getElementById('ocr-status');
  statusEl.className = 'ocr-status ocr-loading';
  statusEl.textContent = 'מזהה פרטים מהתעודה...';
  statusEl.classList.remove('hidden');
  let base64;
  try {
    base64 = await compressImage(file);
  } catch (err) {
    statusEl.className = 'ocr-status ocr-warn';
    statusEl.textContent = `שגיאה בהכנת התמונה: ${err.message}`;
    console.error('compressImage error:', err);
    return;
  }

  try {
    const res    = await fetch('/api/extract-id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageBase64: base64 }),
    });
    const result = await res.json();
    if (result.success && result.data) {
      idExtractedData = result.data;
      const filled = Object.values(result.data).filter(v => v && v.trim()).length;
      statusEl.className = 'ocr-status ocr-success';
      statusEl.textContent = `✓ זוהו ${filled} שדות – יופיעו במסך הפרטים לעריכה`;
    } else {
      statusEl.className = 'ocr-status ocr-warn';
      statusEl.textContent = `שגיאה: ${result.message || 'לא ידוע'}`;
    }
  } catch (err) {
    statusEl.className = 'ocr-status ocr-warn';
    statusEl.textContent = `שגיאה בשליחה: ${err.message}`;
    console.error('fetch error:', err);
  }
}

function prefillFromId() {
  if (!idExtractedData) return;
  const d = idExtractedData;
  if (d.firstName)   document.getElementById('firstName').value   = d.firstName;
  if (d.lastName)    document.getElementById('lastName').value    = d.lastName;
  if (d.idNumber)    document.getElementById('idNumber').value    = d.idNumber;
  if (d.birthDate)   document.getElementById('birthDate').value   = d.birthDate;
  if (d.idIssueDate) document.getElementById('idIssueDate').value = d.idIssueDate;
  if (d.address)     document.getElementById('address').value     = d.address;
}

function initStep0() {
  document.getElementById('upload-gallery-btn').addEventListener('click', () =>
    document.getElementById('id-file-input').click());
  document.getElementById('upload-camera-btn').addEventListener('click', () =>
    document.getElementById('id-camera-input').click());

  ['id-file-input', 'id-camera-input'].forEach(id => {
    document.getElementById(id).addEventListener('change', e => {
      const file = e.target.files[0];
      if (!file) return;
      const preview = document.getElementById('id-preview');
      preview.src = URL.createObjectURL(file);
      document.getElementById('id-preview-wrapper').classList.remove('hidden');
      extractIdData(file);
    });
  });

  document.getElementById('remove-id-btn').addEventListener('click', () => {
    document.getElementById('id-preview-wrapper').classList.add('hidden');
    document.getElementById('ocr-status').classList.add('hidden');
    document.getElementById('id-file-input').value   = '';
    document.getElementById('id-camera-input').value = '';
    idExtractedData = null;
  });

  document.getElementById('intro-continue-btn').addEventListener('click', () => {
    document.getElementById('step-0').classList.add('hidden');
    document.querySelector('.progress-bar-wrapper').classList.remove('hidden');
    prefillFromId();
    goToStep(1);
  });
}

// ── Progress bar ──────────────────────────────────────────
function goToStep(n) {
  [1, 2, 3].forEach(i => {
    document.getElementById(`step-${i}`).classList.toggle('hidden', i !== n);
    const ind = document.getElementById(`step-indicator-${i}`);
    ind.classList.remove('active', 'completed');
    if (i < n) ind.classList.add('completed');
    if (i === n) ind.classList.add('active');
  });
  [1, 2].forEach(i => {
    const line = document.getElementById(`line-${i}-${i + 1}`);
    if (line) line.classList.toggle('completed', i < n);
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ── Validation ────────────────────────────────────────────
const rules = {
  firstName:   v => v.trim().length >= 2 ? null : 'שם פרטי חייב להכיל לפחות 2 תווים',
  lastName:    v => v.trim().length >= 2 ? null : 'שם משפחה חייב להכיל לפחות 2 תווים',
  idNumber:    v => /^\d{9}$/.test(v.trim()) ? null : 'מספר ת.ז חייב להכיל 9 ספרות',
  phone:       v => /^0\d{1,2}[-\s]?\d{7}$/.test(v.trim()) ? null : 'מספר טלפון לא תקין',
  email:       v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()) ? null : 'כתובת אימייל לא תקינה',
  birthDate:   v => v ? null : 'יש לבחור תאריך לידה',
};

function showError(input, msg) {
  input.classList.toggle('error', !!msg);
  const err = input.closest('.form-group').querySelector('.field-error');
  if (err) err.textContent = msg || '';
}

function validateAll() {
  let ok = true;
  Object.keys(rules).forEach(name => {
    const el  = document.getElementById(name);
    const err = rules[name](el.value);
    showError(el, err);
    if (err) ok = false;
  });
  return ok;
}

function setupLiveValidation() {
  Object.keys(rules).forEach(name => {
    const el = document.getElementById(name);
    el.addEventListener('blur',  () => showError(el, rules[name](el.value)));
    el.addEventListener('input', () => { if (el.classList.contains('error')) showError(el, rules[name](el.value)); });
  });
}

// ── Tabs ──────────────────────────────────────────────────
function initTabs() {
  document.querySelectorAll('.doc-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const idx = tab.dataset.tab;
      document.querySelectorAll('.doc-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.doc-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`doc-panel-${idx}`).classList.add('active');
      // mark as read after 2s of viewing
      setTimeout(() => tab.classList.add('read'), 2000);
    });
  });
  // first tab: mark as read after 2s
  setTimeout(() => document.querySelector('.doc-tab[data-tab="0"]').classList.add('read'), 2000);
}

// ── Signature Pad ─────────────────────────────────────────
function initSignaturePad() {
  const canvas  = document.getElementById('signature-canvas');
  const wrapper = document.getElementById('canvas-wrapper');
  const hint    = document.getElementById('canvas-hint');

  function resize() {
    const r = Math.max(window.devicePixelRatio || 1, 1);
    canvas.width  = canvas.offsetWidth  * r;
    canvas.height = canvas.offsetHeight * r;
    canvas.getContext('2d').scale(r, r);
    if (signaturePad) signaturePad.clear();
  }

  signaturePad = new SignaturePad(canvas, {
    backgroundColor: 'rgb(255,255,255)',
    penColor: '#1a1a2e',
    minWidth: 1.5,
    maxWidth: 3,
  });

  resize();
  window.addEventListener('resize', resize);

  ['mousedown','touchstart'].forEach(ev =>
    canvas.addEventListener(ev, () => { wrapper.classList.add('signing'); hint.style.opacity = '0'; }, { passive: true })
  );

  signaturePad.addEventListener('afterUpdateStroke', () => {
    if (!signaturePad.isEmpty()) {
      wrapper.classList.remove('signing');
      wrapper.classList.add('signed');
      document.getElementById('signature-error').textContent = '';
    }
  });

  document.getElementById('clear-btn').addEventListener('click', () => {
    signaturePad.clear();
    wrapper.classList.remove('signed', 'signing');
    hint.style.opacity = '1';
  });
}

// ── Helpers ───────────────────────────────────────────────
// מציג מספר ת.ז בתיבות ספרות בודדות (כמו מספר רישיון)
function fillIdBoxes(elId, value) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.innerHTML = '';
  el.className = 'pdf-license-box';
  for (const ch of (value || '').toString()) {
    const s = document.createElement('span');
    s.className = 'pdf-license-digit';
    s.textContent = ch;
    el.appendChild(s);
  }
}

// ── Populate all documents ────────────────────────────────
function populateDocuments(d) {
  const today = todayHebrew();
  const full  = `${d.firstName} ${d.lastName}`;

  // Doc 0 – הסכמת לקוח
  document.getElementById('d0-date').textContent = today;
  document.getElementById('d0-name').textContent = full;

  // Doc 1 – ייפוי כח פנסיוני
  document.getElementById('d1-name').textContent    = full;
  fillIdBoxes('d1-id', d.idNumber);
  document.getElementById('d1-address').textContent = d.address;
  document.getElementById('d1-date').textContent    = today;
  document.getElementById('d1-name2').textContent   = full;
  fillIdBoxes('d1-id2', d.idNumber);
  document.getElementById('d1-date2').textContent   = today;

  // Doc 2 – ייפוי כח ביטוח
  document.getElementById('d2-name').textContent = full;
  document.getElementById('d2-id').textContent   = d.idNumber;
  document.getElementById('d2-date').textContent = today;

  // Doc 3 – הר הביטוח
  document.getElementById('d3-id').textContent       = d.idNumber;
  document.getElementById('d3-name').textContent     = full;
  document.getElementById('d3-id2').textContent      = d.idNumber;
  document.getElementById('d3-issue').textContent    = d.idIssueDate;
  document.getElementById('d3-passport').textContent = '';
  document.getElementById('d3-travel').textContent   = '';
  document.getElementById('d3-date').textContent     = today;
}

// ── Capture one document panel as image ───────────────────
async function captureDocPanel(panelId) {
  await document.fonts.ready;
  const el = document.getElementById(panelId);
  const wasActive = el.classList.contains('active');
  const wasHidden = el.classList.contains('hidden');
  const origMax      = el.style.maxHeight;
  const origOverflow = el.style.overflow;

  el.classList.remove('hidden');   // הסר לפני הצילום — hidden כולל !important
  el.style.maxHeight = 'none';
  el.style.overflow  = 'visible';
  el.classList.add('active');

  await new Promise(r => setTimeout(r, 120));

  const canvas = await html2canvas(el, {
    scale: 2.5,
    useCORS: true,
    allowTaint: true,
    backgroundColor: '#ffffff',
    logging: false,
    windowWidth: Math.max(el.scrollWidth + 2, 750),
  });

  el.style.maxHeight = origMax;
  el.style.overflow  = origOverflow;
  if (!wasActive) el.classList.remove('active');
  if (wasHidden)  el.classList.add('hidden');    // שחזר מצב מקורי

  return canvas;
}

// ── Generate combined PDF ─────────────────────────────────
async function generatePDF(sigDataUrl) {
  const { jsPDF } = window.jspdf;
  const pdf  = new jsPDF('p', 'mm', 'a4');
  const pw   = pdf.internal.pageSize.getWidth();
  const ph   = pdf.internal.pageSize.getHeight();
  const marg = 10;
  const imgW = pw - marg * 2;

  // Inject signature into sig-placeholder elements for capture
  const phs = document.querySelectorAll('.sig-placeholder');
  phs.forEach(ph => {
    const img = document.createElement('img');
    img.src = sigDataUrl;
    img.style.cssText = 'max-width:150px;max-height:50px;display:block;';
    ph.innerHTML = '';
    ph.appendChild(img);
  });

  await new Promise(r => setTimeout(r, 150));

  const panels = ['doc-panel-1','doc-panel-2','doc-panel-3','doc-panel-0'];
  let isFirstPage = true;

  for (const panelId of panels) {
    const canvas  = await captureDocPanel(panelId);
    const imgData = canvas.toDataURL('image/jpeg', 0.97);
    const imgH    = (canvas.height * imgW) / canvas.width;

    if (!isFirstPage) pdf.addPage();
    isFirstPage = false;

    if (imgH <= ph - marg * 2) {
      pdf.addImage(imgData, 'JPEG', marg, marg, imgW, imgH);
    } else {
      // multi-page for long document
      let remaining = imgH;
      let yOffset   = 0;
      let firstSlice = true;
      const sliceH = ph - marg * 2;
      while (remaining > 0) {
        if (!firstSlice) pdf.addPage();
        pdf.addImage(imgData, 'JPEG', marg, marg - yOffset, imgW, imgH);
        yOffset   += sliceH;
        remaining -= sliceH;
        firstSlice = false;
      }
    }
  }

  // Restore sig placeholders
  phs.forEach(ph => {
    ph.innerHTML = '';
    ph.className = 'sig-placeholder';
  });

  // Download
  pdf.save(`מסמכי-הצטרפות-${formData.firstName}-${formData.lastName}.pdf`);

  return pdf.output('datauristring').split(',')[1];
}

// ── Submit ────────────────────────────────────────────────
async function handleSubmit() {
  const sigErr = document.getElementById('signature-error');
  const conErr = document.getElementById('consent-error');
  let ok = true;

  if (!signaturePad || signaturePad.isEmpty()) {
    sigErr.textContent = 'יש לחתום לפני שליחה';
    document.getElementById('signature-canvas').scrollIntoView({ behavior: 'smooth', block: 'center' });
    ok = false;
  } else {
    sigErr.textContent = '';
  }

  if (!document.getElementById('consent-checkbox').checked) {
    conErr.textContent = 'יש לאשר קריאת המסמכים לפני המשך';
    ok = false;
  } else {
    conErr.textContent = '';
  }

  if (!ok) return;

  const sigDataUrl = signaturePad.toDataURL('image/png');

  try {
    setLoadingMsg('מכין את מסמכי ההצטרפות...');
    showLoading(true);

    const pdfBase64 = await generatePDF(sigDataUrl);

    setLoadingMsg('שולח אימייל אישור...');

    const res    = await fetch('/api/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientData: formData, signature: sigDataUrl, pdfBase64 }),
    });
    const result = await res.json();
    showLoading(false);

    if (result.success) {
      document.getElementById('success-name').textContent = `${formData.firstName} ${formData.lastName}`;
      goToStep(3);
    } else {
      alert('שגיאה בשליחת האימייל:\n' + result.message + '\n\nהמסמכים הורדו בהצלחה למחשבך.');
      document.getElementById('tl-email').classList.remove('done');
      document.getElementById('success-name').textContent = `${formData.firstName} ${formData.lastName}`;
      goToStep(3);
    }
  } catch (err) {
    showLoading(false);
    console.error(err);
    alert('המסמכים הורדו בהצלחה.\nשגיאה בשליחת האימייל – ודא שהשרת פועל.');
    document.getElementById('tl-email').classList.remove('done');
    document.getElementById('success-name').textContent = `${formData.firstName} ${formData.lastName}`;
    goToStep(3);
  }
}

// ── Event wiring ──────────────────────────────────────────
document.getElementById('personal-form').addEventListener('submit', e => {
  e.preventDefault();
  if (!validateAll()) {
    document.querySelector('input.error')?.focus();
    return;
  }
  formData = {
    firstName:   document.getElementById('firstName').value.trim(),
    lastName:    document.getElementById('lastName').value.trim(),
    idNumber:    document.getElementById('idNumber').value.trim(),
    phone:       document.getElementById('phone').value.trim(),
    email:       document.getElementById('email').value.trim(),
    birthDate:   formatDate(document.getElementById('birthDate').value),
    idIssueDate: formatDate(document.getElementById('idIssueDate').value),
    address:     document.getElementById('address').value.trim(),
    passport:    document.querySelector('input[name="passport"]:checked')?.value || 'לא',
    travel:      document.querySelector('input[name="travel"]:checked')?.value  || 'לא',
  };
  populateDocuments(formData);
  goToStep(2);
  setTimeout(() => { initSignaturePad(); initTabs(); }, 80);
});

document.getElementById('back-btn').addEventListener('click',   () => goToStep(1));
document.getElementById('submit-btn').addEventListener('click', handleSubmit);

// ── Init ──────────────────────────────────────────────────
setupLiveValidation();
document.querySelector('.progress-bar-wrapper').classList.add('hidden');
initStep0();
