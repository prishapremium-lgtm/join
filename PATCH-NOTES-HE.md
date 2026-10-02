# חיבור Make.com + Roeto אחרי הצטרפות

## מה קורה ב־`/api/submit` (אחרי מיילים מוצלחים)
1. **Resend** — אימייל ללקוח + לאדמין (חובה להצלחת התגובה למשתמש)
2. **Make.com** — POST ל־`MAKE_WEBHOOK_URL` עם פרטי הלקוח + PDF (base64). אם חסר/נכשל → לוג בלבד
3. **Roeto** — יצירת לקוח **טרום־יועץ** (`create-trom-yeutz-client`) לאחר OAuth (`client_credentials` + Basic). אם הלקוח כבר קיים → דילוג על יצירה (אופציונלי: `set-id-issue-date`). אם חסר/נכשל → לוג בלבד

לא נוצרת בקשת מסלקה אוטומטית (בטיחות).

## משתני Railway להגדיר (שמות בלבד — בלי ערכים ב־Git)
| משתנה | חובה? | הערה |
|--------|--------|------|
| `MAKE_WEBHOOK_URL` | מומלץ | כתובת ה־webhook מ־Make (hook.eu1.make.com/…) |
| `ROETO_API_URL` | אופציונלי | ברירת מחדל: `https://api.roeto.co.il/api/v1` |
| `ROETO_CLIENT_ID` | מומלץ | מזהה לקוח API מרואטו |
| `ROETO_CLIENT_SECRET` | מומלץ | סוד לקוח API מרואטו |
| `RESEND_API_KEY` | כן | כבר קיים |
| `ADMIN_EMAIL` | כן | כבר קיים |
| `ANTHROPIC_KEY` | OCR | כבר קיים |

ערכים מקומיים נמצאים ב־`config.json` בשולחן העבודה (לא להעלות ל־Git).

## מקור תיעוד Roeto
- `https://api.roeto.co.il/api-docs/`
- קבצי עזר מקומיים: `Roeto_API_Full_Reference.md`, `Roeto_Client_Onboarding_Mislaka_Flow.md`
