'use strict';
/* ══════════════════════════════════════════════════════════
   פרישה פרימיום – app.js
   4 legal documents: הסכמת לקוח, נספח א (פנסיוני), נספח ב (ביטוח), נספח ה (הר הביטוח)
   PDF: generated in-browser via html2canvas + jsPDF
   Email: sent via /api/submit
══════════════════════════════════════════════════════════ */

// ── State ─────────────────────────────────────────────────
let formData        = {};
let signaturePad    = null;
let idExtractedData = null;
let idFileData      = null; // { base64, mimeType, filename } — מסמך הזיהוי המאוחד לאדמין
let lastPdfBase64   = null;
let lastPdfFilename = null;
let tabsReady       = false;

// Keep ids and names in sync with JOIN_DOCUMENTS in server.js.
// pdfOrder is the existing capture order: pension, insurance, har habituach, consent.
const JOIN_DOCUMENTS = [
  {
    id: 'consent', tab: '0', panel: 'doc-panel-0', pdfOrder: 4,
    name: 'הסכמת לקוח',
    description: 'הסכמה לשימוש במידע ולקבלת דבר פרסומת, כדי שנוכל ליצור קשר ולהתאים עבורך מידע על שירותים.',
  },
  {
    id: 'pension', tab: '1', panel: 'doc-panel-1', pdfOrder: 1,
    name: 'ייפוי כח פנסיוני',
    description: 'הרשאה לקבלת מידע על תוכניות פנסיוניות באמצעות המסלקה הפנסיונית. לקריאה בלבד, בלי פעולה בחשבונות.',
  },
  {
    id: 'insurance', tab: '2', panel: 'doc-panel-2', pdfOrder: 2,
    name: 'ייפוי כח ביטוח',
    description: 'הרשאה לפנייה לחברות הביטוח לקבלת מידע על פוליסות ביטוח פרטיות.',
  },
  {
    id: 'har', tab: '3', panel: 'doc-panel-3', pdfOrder: 3,
    name: 'ייפוי כח להר הביטוח',
    description: 'הרשאה לפנייה להר הביטוח לאיתור מוצרי הביטוח שברשותך.',
  },
];

function selectedDocuments() {
  return JOIN_DOCUMENTS.filter(doc => {
    const box = document.getElementById(`doc-select-${doc.id}`);
    return !!(box && box.checked);
  });
}

function pdfPanelsForSelection(docs) {
  return docs.slice().sort((a, b) => a.pdfOrder - b.pdfOrder).map(doc => doc.panel);
}

function joinHebrewNames(names) {
  if (names.length <= 1) return names[0] || '';
  if (names.length === 2) return `${names[0]} ו${names[1]}`;
  return `${names.slice(0, -1).join(', ')} ו${names[names.length - 1]}`;
}

function applyDocumentSelection() {
  const selected = selectedDocuments();
  const selectedIds = new Set(selected.map(doc => doc.id));
  let activeStillVisible = false;

  JOIN_DOCUMENTS.forEach(doc => {
    const on = selectedIds.has(doc.id);
    const tab = document.querySelector(`.doc-tab[data-tab="${doc.tab}"]`);
    const panel = document.getElementById(doc.panel);
    if (tab) tab.classList.toggle('hidden', !on);
    if (!panel) return;
    if (!on) {
      panel.classList.add('hidden');
      panel.classList.remove('active');
      return;
    }
    if (panel.classList.contains('active')) activeStillVisible = true;
  });

  if (selected.length && !activeStillVisible) {
    document.querySelectorAll('.doc-tab').forEach(tab => tab.classList.remove('active'));
    document.querySelectorAll('.doc-panel').forEach(panel => {
      panel.classList.remove('active');
      panel.classList.add('hidden');
    });
    const first = selected[0];
    const tab = document.querySelector(`.doc-tab[data-tab="${first.tab}"]`);
    const panel = document.getElementById(first.panel);
    if (tab) tab.classList.add('active');
    if (panel) {
      panel.classList.remove('hidden');
      panel.classList.add('active');
    }
  }

  const tabs = document.querySelector('.doc-tabs');
  if (tabs) tabs.classList.toggle('hidden', selected.length === 0);

  const names = document.getElementById('sig-scope-names');
  const error = document.getElementById('doc-picker-error');
  if (names) names.textContent = selected.length ? joinHebrewNames(selected.map(doc => doc.name)) : '';
  if (error) error.textContent = selected.length ? '' : 'יש לסמן לפחות מסמך אחד כדי להמשיך';
  return selected;
}

function initDocumentPicker() {
  const list = document.getElementById('doc-picker-list');
  if (!list || list.childElementCount) return;
  JOIN_DOCUMENTS.forEach(doc => {
    const label = document.createElement('label');
    label.className = 'doc-picker-item';
    label.innerHTML = `
      <input type="checkbox" id="doc-select-${doc.id}" checked />
      <span>
        <span class="doc-picker-name"></span>
        <span class="doc-picker-desc"></span>
      </span>`;
    label.querySelector('.doc-picker-name').textContent = doc.name;
    label.querySelector('.doc-picker-desc').textContent = doc.description;
    label.querySelector('input').addEventListener('change', () => applyDocumentSelection());
    list.appendChild(label);
  });
  applyDocumentSelection();
}

function fillSuccessDocuments() {
  const names = selectedDocuments().map(doc => doc.name);
  const el = document.getElementById('success-docs');
  if (!el) return;
  el.textContent = names.length === 1
    ? `נחתם מסמך אחד: ${names[0]}`
    : `נחתמו ${names.length} מסמכים: ${joinHebrewNames(names)}`;
}

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
// Keep in sync with composeAddress in server.js
const MAX_ID_PAGES = 8;
const MAX_ID_FILE_BYTES = 25 * 1024 * 1024;
// Admin PDF only. ~1800px on the long edge is about 160–240 dpi once the
// photo sits on A4, and JPEG 0.72 keeps the ID readable. OCR is encoded
// separately from the full enhanced image and does not use these limits.
const ID_PDF_MAX_SIDE = 1800;
const ID_PDF_JPEG_QUALITY = 0.72;
const ID_FIELD_KEYS = ['firstName','lastName','idNumber','birthDate','idIssueDate','gender','street','houseNumber','apartment','city','zip'];

let idPages = [];
let idPageSeq = 1;
let idJobToken = 0;
let idPipeline = Promise.resolve();

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

function yieldToUi() {
  return new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

function enqueueIdWork(fn) {
  const run = idPipeline.then(() => fn());
  idPipeline = run.then(() => {}, err => { console.error('id pipeline', err); });
  return run;
}

function setOcrStatus(kind, text) {
  const statusEl = document.getElementById('ocr-status');
  statusEl.className = `ocr-status ocr-${kind}`;
  statusEl.textContent = text;
  statusEl.classList.remove('hidden');
}

function friendlyOcrError(message) {
  const msg = String(message || '');
  if (/מפתח|לא הוגדר|ANTHROPIC/i.test(msg)) return 'זיהוי אוטומטי לא זמין כרגע. אפשר להמשיך ולמלא ידנית.';
  if (/תם הזמן|timeout/i.test(msg)) return 'הזיהוי לקח יותר מדי זמן. אפשר לנסות שוב או למלא ידנית.';
  return 'לא הצלחנו לזהות את הפרטים אוטומטית. אפשר להמשיך ולמלא ידנית.';
}

const scriptPromises = {};
function loadScript(src) {
  if (scriptPromises[src]) return scriptPromises[src];
  scriptPromises[src] = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      delete scriptPromises[src];
      reject(new Error('טעינת כלי עזר נכשלה'));
    };
    document.head.appendChild(s);
  });
  return scriptPromises[src];
}

function isHeic(file) {
  const type = (file.type || '').toLowerCase();
  const name = (file.name || '').toLowerCase();
  return type.includes('heic') || type.includes('heif') || name.endsWith('.heic') || name.endsWith('.heif');
}

function blobToImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('הדפדפן לא הצליח לקרוא את הקובץ')); };
    img.src = url;
  });
}

function imageToCanvas(img) {
  const sw = img.naturalWidth || img.width;
  const sh = img.naturalHeight || img.height;
  if (!sw || !sh) throw new Error('התמונה ריקה');
  const long = Math.max(sw, sh);
  const scale = long > 2400 ? 2400 / long : 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sw * scale));
  canvas.height = Math.max(1, Math.round(sh * scale));
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function downscaleCanvas(canvas, maxSide) {
  const long = Math.max(canvas.width, canvas.height);
  if (long <= maxSide) return canvas;
  const scale = maxSide / long;
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(canvas.width * scale));
  out.height = Math.max(1, Math.round(canvas.height * scale));
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, out.width, out.height);
  return out;
}

function percentileFromHist(hist, n, q) {
  const target = Math.max(0, Math.min(n - 1, Math.floor(n * q)));
  let acc = 0;
  for (let i = 0; i < 256; i++) {
    acc += hist[i];
    if (acc > target) return i;
  }
  return 255;
}

function boxBlurLuma(src, w, h, radius) {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const win = radius * 2 + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) {
        const xx = Math.min(w - 1, Math.max(0, x + k));
        sum += src[row + xx];
      }
      tmp[row + x] = sum / win;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) {
        const yy = Math.min(h - 1, Math.max(0, y + k));
        sum += tmp[yy * w + x];
      }
      out[y * w + x] = sum / win;
    }
  }
  return out;
}

function applyReadability(imageData) {
  const { data, width, height } = imageData;
  const n = width * height;
  if (n < 16) return;
  const hist = new Uint32Array(256);
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const y = (data[i] * 54 + data[i + 1] * 183 + data[i + 2] * 19) >> 8;
    hist[y]++;
  }
  let black = percentileFromHist(hist, n, 0.005);
  let white = percentileFromHist(hist, n, 0.995);
  if (white - black < 16) {
    let sum = 0;
    let count = 0;
    for (let v = 0; v < 256; v++) { sum += hist[v] * v; count += hist[v]; }
    const mean = count ? sum / count : 128;
    black = Math.max(0, Math.round(mean - 50));
    white = Math.min(255, Math.round(mean + 50));
  }
  if (white - black < 8) return;

  const lut = new Uint8Array(256);
  const span = white - black;
  for (let v = 0; v < 256; v++) {
    let x = (v - black) / span;
    if (x < 0) x = 0;
    else if (x > 1) x = 1;
    x = x + 0.06 * Math.sin((x - 0.5) * Math.PI);
    if (x < 0) x = 0;
    else if (x > 1) x = 1;
    lut[v] = Math.round(x * 255);
  }

  const luma = new Float32Array(n);
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    data[i] = lut[data[i]];
    data[i + 1] = lut[data[i + 1]];
    data[i + 2] = lut[data[i + 2]];
    luma[p] = (data[i] * 54 + data[i + 1] * 183 + data[i + 2] * 19) >> 8;
  }

  const blur = boxBlurLuma(luma, width, height, 2);
  const amount = 0.8;
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const delta = (luma[p] - blur[p]) * amount;
    data[i]     = clampByte(data[i] + delta);
    data[i + 1] = clampByte(data[i + 1] + delta);
    data[i + 2] = clampByte(data[i + 2] + delta);
  }
}

function clampByte(v) {
  if (v < 0) return 0;
  if (v > 255) return 255;
  return v | 0;
}

function enhanceForReadability(source) {
  const limited = downscaleCanvas(source, 2400);
  const sw = limited.width;
  const sh = limited.height;
  const long = Math.max(sw, sh);
  const scale = long < 1500 ? Math.min(2.2, 2000 / Math.max(long, 1)) : 1;
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if (scale > 1.7) {
    const mid = document.createElement('canvas');
    const m = Math.sqrt(scale);
    mid.width = Math.max(1, Math.round(sw * m));
    mid.height = Math.max(1, Math.round(sh * m));
    const mctx = mid.getContext('2d');
    mctx.imageSmoothingEnabled = true;
    mctx.imageSmoothingQuality = 'high';
    mctx.drawImage(limited, 0, 0, mid.width, mid.height);
    ctx.drawImage(mid, 0, 0, w, h);
  } else {
    ctx.drawImage(limited, 0, 0, w, h);
  }
  const imageData = ctx.getImageData(0, 0, w, h);
  applyReadability(imageData);
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

async function pdfToCanvases(file) {
  if (!window.pdfjsLib) throw new Error('ספריית PDF לא נטענה');
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const data = new Uint8Array(await file.arrayBuffer());
  let pdf;
  try {
    pdf = await pdfjsLib.getDocument({ data }).promise;
  } catch (err) {
    throw new Error('לא הצלחנו לקרוא את ה-PDF');
  }
  const canvases = [];
  const count = Math.min(pdf.numPages, MAX_ID_PAGES);
  for (let i = 1; i <= count; i++) {
    const page = await pdf.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.max(1.2, Math.min(3.2, 2200 / Math.max(base.width, base.height)));
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(vp.width));
    canvas.height = Math.max(1, Math.round(vp.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    canvases.push(canvas);
  }
  if (pdf.numPages > count) canvases.truncated = pdf.numPages;
  return canvases;
}

async function heicToCanvases(file) {
  if (!window.heic2any) {
    await loadScript('https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js');
  }
  let out;
  try {
    out = await window.heic2any({ blob: file, toType: 'image/jpeg', quality: 0.92 });
  } catch (err) {
    throw new Error('לא הצלחנו לקרוא קובץ HEIC');
  }
  const blobs = (Array.isArray(out) ? out : [out]).filter(Boolean);
  if (!blobs.length) throw new Error('לא הצלחנו לקרוא קובץ HEIC');
  const canvases = [];
  for (const blob of blobs) canvases.push(imageToCanvas(await blobToImage(blob)));
  return canvases;
}

async function tiffToCanvases(file) {
  if (!window.UTIF) {
    await loadScript('https://cdn.jsdelivr.net/npm/utif@3.1.0/UTIF.js');
  }
  const buf = await file.arrayBuffer();
  const ifds = window.UTIF.decode(buf);
  if (!ifds || !ifds.length) throw new Error('קובץ TIFF ריק');
  const canvases = [];
  for (const ifd of ifds) {
    window.UTIF.decodeImage(buf, ifd);
    const rgba = window.UTIF.toRGBA8(ifd);
    if (!ifd.width || !ifd.height) continue;
    const canvas = document.createElement('canvas');
    canvas.width = ifd.width;
    canvas.height = ifd.height;
    const ctx = canvas.getContext('2d');
    const imageData = ctx.createImageData(ifd.width, ifd.height);
    imageData.data.set(rgba);
    ctx.putImageData(imageData, 0, 0);
    canvases.push(canvas);
  }
  if (!canvases.length) throw new Error('קובץ TIFF ריק');
  return canvases;
}

async function fileToCanvases(file) {
  const type = (file.type || '').toLowerCase();
  const name = (file.name || '').toLowerCase();
  if (type === 'application/pdf' || name.endsWith('.pdf')) return pdfToCanvases(file);
  if (type === 'image/tiff' || type === 'image/tif' || name.endsWith('.tif') || name.endsWith('.tiff')) {
    return tiffToCanvases(file);
  }
  if (isHeic(file)) return heicToCanvases(file);
  try {
    return [imageToCanvas(await blobToImage(file))];
  } catch (err) {
    throw new Error('פורמט לא נתמך או קובץ פגום');
  }
}

function canvasToBlob(canvas, type, quality) {
  return new Promise(resolve => canvas.toBlob(resolve, type, quality));
}

async function canvasToIdPage(source, filename) {
  const enhanced = enhanceForReadability(source);
  const pdfCanvas = downscaleCanvas(enhanced, ID_PDF_MAX_SIDE);
  const pdfDataUrl = pdfCanvas.toDataURL('image/jpeg', ID_PDF_JPEG_QUALITY);
  const ocrCanvas = downscaleCanvas(enhanced, 1600);
  const ocrBase64 = ocrCanvas.toDataURL('image/jpeg', 0.82).split(',')[1];
  const thumb = downscaleCanvas(enhanced, 360);
  const thumbBlob = await canvasToBlob(thumb, 'image/jpeg', 0.8);
  const thumbUrl = URL.createObjectURL(thumbBlob || new Blob());
  return { id: idPageSeq++, filename, pdfDataUrl, ocrBase64, thumbUrl };
}

async function buildIdPdf(dataUrls) {
  if (!window.jspdf || !window.jspdf.jsPDF) throw new Error('ספריית PDF לא זמינה');
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4', compress: true });
  const pw = pdf.internal.pageSize.getWidth();
  const ph = pdf.internal.pageSize.getHeight();
  const margin = 8;
  for (let i = 0; i < dataUrls.length; i++) {
    if (i) pdf.addPage();
    const props = pdf.getImageProperties(dataUrls[i]);
    const maxW = pw - margin * 2;
    const maxH = ph - margin * 2;
    const ratio = Math.min(maxW / props.width, maxH / props.height);
    const w = props.width * ratio;
    const h = props.height * ratio;
    pdf.addImage(dataUrls[i], 'JPEG', (pw - w) / 2, (ph - h) / 2, w, h, undefined, 'FAST');
  }
  return pdf.output('datauristring').split(',')[1];
}

function renderIdPages() {
  const wrap = document.getElementById('id-pages');
  wrap.replaceChildren();
  idPages.forEach((page, i) => {
    const fig = document.createElement('figure');
    fig.className = 'id-page';
    const img = document.createElement('img');
    img.src = page.thumbUrl;
    img.alt = `עמוד ${i + 1}`;
    const cap = document.createElement('figcaption');
    cap.textContent = `עמוד ${i + 1}`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-ghost btn-small';
    btn.textContent = 'הסר';
    const pageId = page.id;
    btn.addEventListener('click', () => enqueueIdWork(() => removeIdPage(pageId)));
    fig.append(img, cap, btn);
    wrap.appendChild(fig);
  });
  document.getElementById('id-preview-wrapper').classList.toggle('hidden', idPages.length === 0);
}

function releaseIdPages() {
  idPages.forEach(page => URL.revokeObjectURL(page.thumbUrl));
  idPages = [];
}

function clearIdPages() {
  idJobToken++;
  releaseIdPages();
  idFileData = null;
  idExtractedData = null;
  renderIdPages();
  const statusEl = document.getElementById('ocr-status');
  statusEl.classList.add('hidden');
  statusEl.textContent = '';
}

async function removeIdPage(pageId) {
  const index = idPages.findIndex(page => page.id === pageId);
  if (index < 0) return;
  const [removed] = idPages.splice(index, 1);
  if (removed) URL.revokeObjectURL(removed.thumbUrl);
  renderIdPages();
  await rebuildAndExtract();
}

async function extractIdData(images, token, note) {
  setOcrStatus('loading', `מזהה פרטים מ-${images.length === 1 ? 'עמוד אחד' : images.length + ' עמודים'}...`);
  try {
    const res = await fetch('/api/extract-id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images }),
    });
    const result = await res.json().catch(() => ({}));
    if (token !== idJobToken) return;
    const suffix = note ? ` ${note}` : '';
    if (result.success && result.data) {
      idExtractedData = result.data;
      const filled = ID_FIELD_KEYS.filter(key => String(result.data[key] || '').trim()).length;
      if (filled > 0) {
        setOcrStatus('success', `זוהו ${filled} שדות. אפשר לערוך אותם במסך הבא.${suffix}`);
      } else {
        setOcrStatus('warn', `לא זוהו פרטים בתעודה. אפשר להמשיך ולמלא ידנית.${suffix}`);
      }
    } else {
      setOcrStatus('warn', `${friendlyOcrError(result.message)}${suffix}`);
    }
  } catch (err) {
    if (token !== idJobToken) return;
    console.error('fetch error:', err);
    setOcrStatus('warn', `לא הצלחנו לזהות את הפרטים אוטומטית. אפשר להמשיך ולמלא ידנית.${note ? ` ${note}` : ''}`);
  }
}

async function rebuildAndExtract(problems = []) {
  if (!idPages.length) {
    idJobToken++;
    idFileData = null;
    idExtractedData = null;
    const statusEl = document.getElementById('ocr-status');
    if (problems.length) {
      setOcrStatus('warn', `לא הצלחנו לקרוא את הקבצים. ${problems.join(' · ')} אפשר להמשיך ולמלא את הפרטים ידנית.`);
    } else {
      statusEl.classList.add('hidden');
      statusEl.textContent = '';
    }
    return;
  }

  const token = ++idJobToken;
  setOcrStatus('loading', 'משפר חדות ובונה מסמך אחד קריא...');
  await yieldToUi();
  try {
    const pdfB64 = await buildIdPdf(idPages.map(page => page.pdfDataUrl));
    if (token !== idJobToken) return;
    idFileData = { base64: pdfB64, mimeType: 'application/pdf', filename: 'תעודת-זהות.pdf' };
  } catch (err) {
    console.error(err);
    if (token !== idJobToken) return;
    const fallback = (idPages[0].pdfDataUrl || '').split(',')[1] || '';
    idFileData = fallback
      ? { base64: fallback, mimeType: 'image/jpeg', filename: 'תעודת-זהות.jpg' }
      : null;
  }
  const note = problems.length ? `(${problems.join(' · ')})` : '';
  await extractIdData(idPages.map(page => page.ocrBase64), token, note);
}

async function addIdFiles(files) {
  const problems = [];
  let added = 0;
  for (let i = 0; i < files.length; i++) {
    if (idPages.length >= MAX_ID_PAGES) {
      problems.push(`אפשר עד ${MAX_ID_PAGES} עמודים`);
      break;
    }
    const file = files[i];
    const label = file.name || 'תמונה';
    setOcrStatus('loading', `קורא קובץ ${i + 1} מתוך ${files.length}: ${label}`);
    await yieldToUi();
    try {
      if (file.size > MAX_ID_FILE_BYTES) throw new Error('הקובץ גדול מדי');
      const canvases = await fileToCanvases(file);
      if (canvases.truncated) problems.push(`נקראו ${canvases.length} העמודים הראשונים מתוך ${canvases.truncated}`);
      for (const canvas of canvases) {
        if (idPages.length >= MAX_ID_PAGES) {
          problems.push(`אפשר עד ${MAX_ID_PAGES} עמודים`);
          break;
        }
        const page = await canvasToIdPage(canvas, label);
        canvas.width = 0;
        canvas.height = 0;
        idPages.push(page);
        added++;
        renderIdPages();
        await yieldToUi();
      }
    } catch (err) {
      problems.push(`${label}: ${err.message || 'לא נקרא'}`);
    }
  }
  renderIdPages();
  if (!added && !idPages.length) {
    setOcrStatus('warn', `לא הצלחנו לקרוא את הקבצים. ${problems.join(' · ')} אפשר להמשיך ולמלא את הפרטים ידנית.`);
    return;
  }
  await rebuildAndExtract(problems);
}

function prefillFromId() {
  if (!idExtractedData) return;
  const d = idExtractedData;
  ['firstName','lastName','idNumber','birthDate','idIssueDate','street','houseNumber','apartment','city','zip'].forEach(name => {
    const el = document.getElementById(name);
    if (el && d[name]) el.value = d[name];
  });
  const gender = document.getElementById('gender');
  if (gender && (d.gender === '1' || d.gender === '2')) gender.value = d.gender;
}

function initStep0() {
  document.getElementById('upload-gallery-btn').addEventListener('click', () =>
    document.getElementById('id-file-input').click());
  document.getElementById('upload-camera-btn').addEventListener('click', () =>
    document.getElementById('id-camera-input').click());

  ['id-file-input', 'id-camera-input'].forEach(id => {
    document.getElementById(id).addEventListener('change', e => {
      const files = Array.from(e.target.files || []);
      e.target.value = '';
      if (!files.length) return;
      enqueueIdWork(() => addIdFiles(files));
    });
  });

  document.getElementById('remove-id-btn').addEventListener('click', () => {
    enqueueIdWork(async () => { clearIdPages(); });
  });

  document.getElementById('intro-continue-btn').addEventListener('click', async () => {
    const btn = document.getElementById('intro-continue-btn');
    btn.disabled = true;
    try {
      await idPipeline;
      document.getElementById('step-0').classList.add('hidden');
      document.querySelector('.progress-bar-wrapper').classList.remove('hidden');
      prefillFromId();
      goToStep(1);
    } finally {
      btn.disabled = false;
    }
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
  zip:         v => !String(v || '').trim() || /^\d{5}(\d{2})?$/.test(String(v).trim()) ? null : 'מיקוד צריך להיות 5 או 7 ספרות',
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
  if (tabsReady) return;
  tabsReady = true;
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

  // Sign only the documents the client left checked, in the existing PDF order.
  const panels = pdfPanelsForSelection(selectedDocuments());
  if (!panels.length) throw new Error('לא נבחרו מסמכים');
  const phs = panels.flatMap(panelId => (
    [...document.getElementById(panelId).querySelectorAll('.sig-placeholder')]
  ));
  phs.forEach(ph => {
    const img = document.createElement('img');
    img.src = sigDataUrl;
    img.style.cssText = 'max-width:150px;max-height:50px;display:block;';
    ph.innerHTML = '';
    ph.appendChild(img);
  });

  await new Promise(r => setTimeout(r, 150));
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

  lastPdfFilename = `מסמכי-הצטרפות-${formData.firstName}-${formData.lastName}.pdf`;
  lastPdfBase64   = pdf.output('datauristring').split(',')[1];
  return lastPdfBase64;
}

// ── Submit ────────────────────────────────────────────────
async function handleSubmit() {
  const sigErr = document.getElementById('signature-error');
  const conErr = document.getElementById('consent-error');
  const picked = applyDocumentSelection();
  let ok = true;

  if (!picked.length) {
    const picker = document.getElementById('doc-picker-error');
    if (picker) picker.scrollIntoView({ behavior: 'smooth', block: 'center' });
    ok = false;
  }

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

    formData.selectedDocumentIds = picked.map(doc => doc.id);
    const res    = await fetch('/api/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientData: formData, signature: sigDataUrl, pdfBase64, idFile: idFileData }),
    });
    const result = await res.json();
    showLoading(false);

    document.getElementById('success-name').textContent = `${formData.firstName} ${formData.lastName}`;
    fillSuccessDocuments();
    if (result.success) {
      goToStep(3);
    } else {
      alert('שגיאה בשליחת האימייל:\n' + result.message + '\n\nהמסמכים הורדו בהצלחה למחשבך.');
      document.getElementById('tl-email').classList.remove('done');
      goToStep(3);
    }
  } catch (err) {
    showLoading(false);
    console.error(err);
    alert('המסמכים הורדו בהצלחה.\nשגיאה בשליחת האימייל – ודא שהשרת פועל.');
    document.getElementById('tl-email').classList.remove('done');
    document.getElementById('success-name').textContent = `${formData.firstName} ${formData.lastName}`;
    fillSuccessDocuments();
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
  const street = document.getElementById('street').value.trim();
  const houseNumber = document.getElementById('houseNumber').value.trim();
  const apartment = document.getElementById('apartment').value.trim();
  const city = document.getElementById('city').value.trim();
  const zip = document.getElementById('zip').value.trim();
  formData = {
    firstName:   document.getElementById('firstName').value.trim(),
    lastName:    document.getElementById('lastName').value.trim(),
    idNumber:    document.getElementById('idNumber').value.trim(),
    phone:       document.getElementById('phone').value.trim(),
    email:       document.getElementById('email').value.trim(),
    birthDate:   formatDate(document.getElementById('birthDate').value),
    idIssueDate: formatDate(document.getElementById('idIssueDate').value),
    street,
    houseNumber,
    apartment,
    city,
    zip,
    address:     composeAddress({ street, houseNumber, apartment, city, zip }),
    gender:      document.getElementById('gender').value || idExtractedData?.gender || '1',
    passport:    document.querySelector('input[name="passport"]:checked')?.value || 'לא',
    travel:      document.querySelector('input[name="travel"]:checked')?.value  || 'לא',
  };
  populateDocuments(formData);
  goToStep(2);
  setTimeout(() => { applyDocumentSelection(); initSignaturePad(); initTabs(); }, 80);
});

document.getElementById('back-btn').addEventListener('click',   () => goToStep(1));
document.getElementById('submit-btn').addEventListener('click', handleSubmit);


document.getElementById('download-pdf-btn').addEventListener('click', () => {
  if (!lastPdfBase64 || !lastPdfFilename) return;
  const a = document.createElement('a');
  a.href     = 'data:application/pdf;base64,' + lastPdfBase64;
  a.download = lastPdfFilename;
  a.click();
});

// ── Init ──────────────────────────────────────────────────
setupLiveValidation();
document.querySelector('.progress-bar-wrapper').classList.add('hidden');
initDocumentPicker();
initStep0();
