# פרישה פרימיום – מערכת קליטת לקוח

אפליקציית web לקליטת לקוחות חדשים לחברת ייעוץ פנסיוני **פרישה פרימיום** (אמיר לוי).

## הפעלה

```bash
ruby server.rb
# או לחיצה כפולה על start.command בפיינדר
```

ניגש ל: `http://localhost:3000` (פורט מוגדר ב-`config.json`)

## ארכיטקטורה

**שרת:** Ruby WEBrick — ללא gems חיצוניים, רק ספריות מובנות.  
**UI:** HTML/CSS/JS טהור — ללא framework.  
**מייל:** Gmail SMTP דרך `net/smtp` (App Password).  
**OCR:** Claude Vision API (claude-opus-4-6) לזיהוי פרטים מת.ז.  
**PDF:** נוצר בדפדפן — html2canvas + jsPDF.

## קבצים עיקריים

| קובץ | תפקיד |
|------|--------|
| `server.rb` | שרת WEBrick — 2 endpoints: `/api/extract-id`, `/api/submit` |
| `config.json` | הגדרות (SMTP, Anthropic key, admin email, port) |
| `public/index.html` | UI — כל שלבי התהליך בקובץ אחד |
| `public/app.js` | לוגיקה: ולידציה, OCR, PDF, חתימה, submit |
| `public/style.css` | עיצוב |

## תהליך 3 שלבים

1. **שלב 0 (Intro):** הסבר על ייפויי הכח + העלאת ת.ז אופציונלית (תמונה או PDF)
2. **שלב 1:** פרטים אישיים (שם, ת.ז, תאריכי לידה+הנפקה, טלפון, מייל, כתובת)
3. **שלב 2:** קריאת 4 מסמכים משפטיים + חתימה דיגיטלית
4. **שלב 3:** מסך הצלחה + כפתור הורדת המסמכים

## 4 מסמכים משפטיים

- **נספח א** — הרשאה חד פעמית לקבלת מידע פנסיוני
- **נספח ב** — ייפוי כח מהמועמד לביטוח (ביטוחים פרטיים)
- **נספח ה** — הרשאת שימוש פרטנית לאתר הר הביטוח
- **הסכמת לקוח** — הסכמה לשימוש במידע ולקבלת פרסומת

## ספריות CDN (בדפדפן)

```html
pdf.js 3.11.174       <!-- המרת PDF לתמונה לצורך OCR -->
signature_pad 4.1.7   <!-- חתימה דיגיטלית -->
html2canvas 1.4.1     <!-- צילום מסמכים לתמונה -->
jsPDF 2.5.1           <!-- יצירת PDF -->
```

## config.json — מבנה

```json
{
  "admin_email":       "כתובת המייל של אמיר לוי",
  "smtp_user":         "prishapremium@gmail.com",
  "smtp_password":     "Gmail App Password (16 תווים)",
  "anthropic_api_key": "sk-ant-api03-...",
  "company_name":      "פרישה פרימיום",
  "port":              3000
}
```

## זרימת הנתונים

```
משתמש מעלה ת.ז
  → client: PDF.js (אם PDF) → JPEG base64
  → POST /api/extract-id → Claude Vision → שדות ממולאים

משתמש חותם ושולח
  → client: html2canvas+jsPDF → PDF base64 (+ הורדה אוטומטית)
  → POST /api/submit { clientData, pdfBase64, idFile }
  → server: Gmail SMTP
      ├─ ללקוח: PDF חתום
      └─ ל-admin: PDF חתום + קובץ הזיהוי המקורי
```

## State גלובלי ב-app.js

```javascript
formData        // פרטי הלקוח מהטופס
signaturePad    // אובייקט החתימה
idExtractedData // נתונים שהוחזרו מה-OCR
idFileData      // { base64, mimeType, filename } — קובץ הזיהוי המקורי לצרופה
lastPdfBase64   // PDF החתום לכפתור ההורדה
lastPdfFilename // שם הקובץ להורדה
```

## נקודות חשובות

- **אין gems חיצוניים** — `Gemfile` ריק בכוונה. כל הפונקציונליות דרך stdlib של Ruby.
- **הת.ז נשמרת ב-OCR כ-JPEG** בלבד (לא בשרת), הקובץ המקורי עובר ישירות ל-admin.
- **PDF נוצר בצד הלקוח** — השרת מקבל base64 ולא יוצר PDF בעצמו.
- **האפליקציה RTL מלאה** — `dir="rtl"` על ה-html, גופן Heebo.
- **Gmail App Password** — לא סיסמת Gmail רגילה. נוצר ב: Google Account → Security → 2FA → App Passwords.

## פיצ'רים שפותחו

- [x] העלאת ת.ז כתמונה + OCR לזיהוי פרטים אוטומטי
- [x] העלאת ת.ז כ-PDF (כולל PDF מרובה עמודים)
- [x] 4 מסמכים משפטיים מובנים עם שדות דינמיים
- [x] חתימה דיגיטלית על כל המסמכים
- [x] יצירת PDF חתום והורדה אוטומטית
- [x] כפתור הורדה חוזרת במסך ההצלחה
- [x] שליחת מייל ללקוח (PDF חתום)
- [x] שליחת מייל ל-admin (PDF חתום + קובץ זיהוי)
