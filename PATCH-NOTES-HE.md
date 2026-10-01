# מעבר מ-Resend ל-Gmail SMTP (טיוטת פאץ')

## מה השתנה בקוד
- `server.js`: במקום Resend API → nodemailer + Gmail SMTP (`smtp.gmail.com:465`)
- `package.json` (+ lock): נוספה תלות `nodemailer`
- אין יותר צורך ב-`RESEND_API_KEY` לשליחה

## משתני Railway (להגדיר)
| משתנה | ערך מומלץ | חובה? |
|--------|-----------|--------|
| `SMTP_USER` | `AmirL@prishap.co.il` | כן |
| `SMTP_PASSWORD` | סיסמת אפליקציה של Gmail (16 תווים) | כן (מומלץ השם הזה) |
| `ADMIN_EMAIL` | מייל לקבלת עותק אדמין | כן (כמו היום) |
| `COMPANY_NAME` | פרישה פרימיום | אופציונלי |
| `ANTHROPIC_KEY` | כמו היום | כמו היום |
| `MAKE_WEBHOOK_URL` | כמו היום | כמו היום |
| `RESEND_API_KEY` | אפשר למחוק | לא נחוץ אחרי הפריסה |

שמות חלופיים לסיסמה (הקוד מקבל גם אותם): `SMTP_PASS` או `GMAIL_APP_PASSWORD`.

## יצירת סיסמת אפליקציה (Gmail) – שלבים פשוטים
1. להיכנס לחשבון Google של `AmirL@prishap.co.il`
2. לוודא שמופעלת אימות דו-שלבי (2-Step Verification)
3. ללכת ל: חשבון Google → אבטחה → סיסמאות אפליקציות (App passwords)
   או ישירות: https://myaccount.google.com/apppasswords
4. ליצור סיסמה חדשה (למשל שם: "join Railway")
5. להעתיק את 16 התווים ל-Railway כ-`SMTP_PASSWORD` (בלי רווחים)
6. **לא** לשלוח את הסיסמה לצ'אט / לקובץ בקוד

## גישה ל-GitHub
- חשבון Cursor: `amirl-lgtm`
- ל-repo `prishapremium-lgtm/join`: **יש pull, אין push**
- לכן אי אפשר לדחוף ישירות ל-main מפה

## איך להכניס את השינוי ל-GitHub / Railway
אפשרות א (מומלץ): בעל ה-repo (`prishapremium-lgtm`) נותן ל-`amirl-lgtm` הרשאת Write, ואז אפשר לפתוח PR/push.
אפשרות ב: Fork ל-`amirl-lgtm/join` → push לשם → PR חזרה ל-`prishapremium-lgtm/join`.
אפשרות ג: להדביק ידנית את השינויים מ-`/workspace/join-gmail-smtp.patch` או מתיקיית `/workspace/join-gmail-patch`.

אחרי merge ל-main: Railway יפרוס מחדש → לוודא env vars → ניסיון הצטרפות אחד (בלי לשלוח סיסמה לצ'אט).

## קבצים בתיבה
- קוד מוכן: `/workspace/join-gmail-patch/` (כולל `node_modules` – לא לדחוף ל-git)
- דיף מאוחד: `/workspace/join-gmail-smtp.patch`
