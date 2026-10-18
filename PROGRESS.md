# PROGRESS (עודכן 2026-10-18)

## 1. שלב נוכחי
**הבוט עובד מקצה לקצה מול Claude אמיתי ו-Supabase. `test:live` עבר 15/15 (2026-10-18), כולל 6 תרחישי התקיפה. הצעד הבא נבחר על ידי המשתמש (סעיף 5).**
- **קישורי כניסה (`c340c65`, מוזג):** קישור מ-`/login` ל-`/admin/login` ובחזרה. לאדמין ולמאמן יכול להיות אותו מייל, אבל אלה שני חשבונות נפרדים, עם סיסמאות נפרדות ועמודי כניסה נפרדים. המשתמש התבלבל ביניהם.
- **מסד הנתונים הפעיל הוא עכשיו Supabase** (`DATABASE_URL` ב-`.env`). הדשבורד, ה-CLI והשרת עובדים מולו. `.data/pglite` לא בשימוש, והנתונים שבו לא הועברו (היו רק בדיקות). הבדיקות האוטומטיות רצות בזיכרון ולא נוגעות ב-Supabase.
- שלבים 1 עד 5 מוזגו ל-`master` (עד `db0f397`), והחיזוק אחריהם. ה-branches של השלבים, `security-hardening`, `approved-clients`, `supabase-demo` ו-`login-links` נשארו מקומית.
- האפיון המקורי נמצא ב-`C:\Users\elira\.claude\plans\joyful-herding-matsumoto.md`.
- **נוהל עבודה:** כל עבודה נבנית ב-branch משלה, ומתחילה רק אחרי תוכנית מאושרת. בסוף: בדיקות, README בעברית והוראות לבדיקה ידנית, ואז מחכים לאישור. אחרי האישור: commit, ואז `git merge --ff-only` ל-`master`. חתימת commit: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **GitHub:** repo פרטי בכתובת https://github.com/EliranK-code/fitcoach (remote `origin`, ענף `master`). הועלה ב-2026-10-18, עד `c340c65`. push רק באישור מפורש. `gh` מותקן אבל לא ב-PATH של bash: `"/c/Program Files/GitHub CLI/gh.exe"`.
- **שפה:** הכל בעברית, כולל תיבת הסיכום. **כשמחכים לאישור שולחים התראה לטלפון** (PushNotification).
- `CLAUDE.md` (כולל "כללי אבטחה קבועים") ו-`PROGRESS.md` נמצאים ב-git וב-repo, לבקשת המשתמש. `.vscode/` (הגדרת עורך של המשתמש) לא ב-git.

## 2. מה הושלם
- **שלב 1, מנוע:** `packages/core/src/`: engine, llm, safety, consent, crypto, tenancy, repos, knowledge, privacy. CLI ב-`apps/cli/`. מאמן הדמו "גל ברק" (`demo`) ב-`seed/demo-coach/`.
- **שלב 2, וואטסאפ:** `core/src/whatsapp/`. שרת Fastify ב-`apps/server/`.
- **שלב 3, דשבורד:** `apps/dashboard/` (Next 16, RTL).
- **שלב 4:** מדיה, תזכורות, opt-out ו-PLATFORM_HASH.
- **שלב 5:** RLS (`withTenant`), השעיה ומחיקה של מאמן, פאנל אדמין עם MFA והזמנות, מדידה ותקציב רך, Embedded Signup.
- **בדיקת אבטחה וחיזוק (`03af50f`, 2026-10-18):** Git נקי. 6 הממצאים ברמה "חשוב" תוקנו: תקרות הוצאה (`spend.ts`), IP אמין (`clientIp`), TLS לדאטאבייס (`postgresSsl`), הגבלת גודל ב-webhook, CSP עם nonce (`proxy.ts` ו-`lib/csp.ts`) ו-HSTS, והגנה על הבוט (Confidentiality ושומר `quotesVerbatim`). פירוט ב-README. נבדק בדפדפן ב-dev וב-production בלי אף הפרת CSP.
- **לקוחות מאושרים בלבד (`8257c8d`):** `access.ts` ו-`clients.approved_at` (מיגרציה 0011 אישרה את הקיימים). מספר לא מאושר מקבל הודעה קצרה פעם ביממה, בלי AI ובלי שמירה, ונפתחת התראת `join_request`. אחרי אישור יוצאת מיד הודעת ההסכמה (`engine.promptConsent`). בדשבורד: הוספה, אישור והסרת גישה. ב-CLI: `client:approve` ו-`client:revoke`.
- **בדיקות:** 197 עוברות, typecheck נקי ו-`dashboard:build` עובר. בדפדפן נבדק כל המסלול (בקשה, אישור, הוספה, הסרה) מול webhook חתום.
- **Supabase (`9dc3d4b`, 2026-10-18):**
  - Postgres 17 דרך Transaction pooler (פורט 6543), עם TLS.
  - כל 29 הטבלאות ו-12 המיגרציות במקום. RLS פעיל על כל 25 טבלאות המאמן. נבדק שמאמן רואה רק את השורות שלו, ושה-role `app_tenant` חסום מטבלאות הפלטפורמה.
  - `npm run seed` מסמן את המאמן `settings.demo`, ומוצג תג "דמו" בפאנל. `npm run demo:remove` רק מציג מה יימחק, ועם `-- --confirm demo` מוחק (`removeDemoCoaches` ב-`platform.ts`).
  - `npm run chat` מול Supabase עובד: הסכמה, פתיחה בקול המאמן ו-onboarding. הפרופיל וההודעות נשמרים מוצפנים, והשימוש נמדד (3 קריאות Opus עלו כ-‎$0.10).
  - נוצרו ב-Supabase משתמש דשבורד (של מאמן הדמו) ואדמין פלטפורמה. ה-TOTP של האדמין יוגדר בכניסה הראשונה ל-`/admin`.
  - 198 בדיקות עוברות.

## 3. החלטות שהתקבלו
- **מוצר:** מספרים מנוהלים תחת חשבון ה-Meta של הפלטפורמה, או מספר של המאמן דרך Embedded Signup. OpenAI ל-embeddings ולתמלול. PGlite עכשיו, Supabase בהמשך.
- **טכנולוגיה:** TypeScript 7, Node 26, npm workspaces, vitest, tsx, Drizzle, zod 4, pino, Fastify 5, postgres-js, sharp, qrcode. Next 16, React 19, Tailwind 4.
- **קוד:** ייבוא יחסי בלי `.js` (בגלל Turbopack). `loadConfig` מוצא את שורש הפרויקט לפי `.env`, ומשתני סביבה גוברים על `.env`.
- **מסד נתונים:**
  - PGlite עם pgvector, **תהליך אחד בלבד**.
  - ב-production: Supabase דרך `DATABASE_URL`, עם TLS אוטומטי לכל שרת שאינו localhost. Transaction pooler (6543) עובד, כולל מיגרציות ו-RLS (בזכות `prepare: false` ו-`set_config` מקומי לטרנזקציה). בסיסמה: בלי `[]`, ו-`@` נכתב `%40`.
  - מיגרציות: `npm run db:generate`, ואחר כך משנים את שם הקובץ לשם תיאורי (ב-`_journal.json` גם).
- **Claude:** `claude-opus-5-5`, effort medium, thinking adaptive, `fallbacks:"default"`. tools ב-strict.
- **פרומפט:** שלוש שכבות system ב-cache. שינוי ב-`PLATFORM_RULES` משנה את PLATFORM_HASH, ואז האפיזודות מתחלפות.
- **בטיחות:** red-flags, רף קלורי 1200/1500, תרגילים אסורים, output guards (מספרי תזונה כשיש סיכון להפרעת אכילה, ודליפת הנחיות).
- **פרטיות:** מפתח AES-GCM לכל מאמן, עטוף במפתח ראשי. הטלפון נשמר כ-HMAC. סודות הפלטפורמה ב-`platformScope()`.
- **RLS:** role `app_tenant`. נתיבי פלטפורמה (תור, webhook, auth, ההוצאה של כל הפלטפורמה) רצים כ-owner.
- **גישה:** ברירת המחדל היא `clientAccess: "approved_only"`. `"open"` מאשר מספר חדש אוטומטית. השער רק בוואטסאפ, ולקוחות טרמינל ומגרש משחקים תמיד מאושרים. טסטים של צינור הוואטסאפ רצים ב-`openToEveryone` (ב-helpers).
- **עלות:** תקציב רך (באנר בלבד). תקרות קשיחות: ללקוח 30 בשעה ו-150 ביממה, למאמן ‎$200 בחודש (אדמין יכול לקבוע `monthlyCapUsd` משלו), לפלטפורמה ‎$100 ביום לפי UTC. כשמגיעים לתקרה, ההודעה נשמרת בסטטוס `over_cap`, ונפתחת התראת `spend_cap` אחת ביום.
- **אבטחת הדשבורד:** CSP עם nonce ו-`strict-dynamic`, ומקורות של Facebook רק ב-`/settings`. `style-src 'unsafe-inline'` בשביל `style=` של פסי התקציב. בלי `upgrade-insecure-requests`, כדי ש-`next start` יעבוד על localhost.
- **סביבה:**
  - npm cache ב-`D:\npm-cache`.
  - סקריפטים זמניים ב-scratchpad, כ-`.cjs` או כ-`.mts` שרצים עם `npx tsx`.
  - בדיקה בדפדפן: wrapper ב-node שמגדיר `PGLITE_DIR` ו-`WHATSAPP_DRY_RUN`, עם הגדרה זמנית ב-`.claude/launch.json`. מסירים אותה בסוף.
  - בלי Playwright (כונן C:).

## 4. בעיות פתוחות
- `OPENAI_API_KEY` ריק: אין RAG וקטורי ואין תמלול.
- **לא נבדקו:**
  - Meta אמיתי (כולל Embedded Signup תחת ה-CSP) ו-Railway.
  - לוודא שב-Supabase דלוק Enforce SSL (Database → Settings). מהצד שלנו TLS תמיד חובה.
  - לבדוק איזו כותרת IP הפרוקסי שולח, ולהגדיר `TRUSTED_IP_HEADER`.
- **ממצאי "מומלץ" שלא תוקנו** (המשתמש בחר לדחות):
  - מ1: להשלים את `.gitignore`.
  - מ2: הסתרה בלוגים. רשימת REDACT חלקית, וב-dry run נרשם הטלפון.
  - מ3: שגיאות 500 גנריות ב-Fastify.
  - מ4: עריכת שאלה לפני שמירה ל-FAQ.
  - מ5: הצפנת דגלי בריאות.
  - מ6: `PUBLIC_URL` לקישורים.
  - מ8: `npm audit`, 7 ברמה moderate: drizzle-kit, ו-mammoth→sprintf-js.
- נוסחי הפרטיות וה-DPA הם טיוטה. גיבויים כוללים את ה-DEK העטוף (פתרון מלא דורש KMS).
- **לאמת:** מחיר התמלול של OpenAI. גרסת Graph: אצלנו v23.0, והתיעוד כבר ב-v26.0.

## 5. הצעד הבא
**לבחור עם המשתמש** (CLAUDE.md: שלב אחד בכל פעם, באישור). האפשרויות, לפי הסדר המומלץ:
1. וואטסאפ אמיתי עם מספר הבדיקה של Meta: `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_APP_SECRET` ו-`WHATSAPP_VERIFY_TOKEN` (המשתמש יוצר אפליקציה ב-developers.facebook.com).
2. פריסה ל-Railway מתוך ה-repo ב-GitHub (צריך גם `TRUSTED_IP_HEADER` וטוקן קבוע של Meta).
3. ממצאי ה"מומלץ" מבדיקת האבטחה.
4. `OPENAI_API_KEY`, שהוא רשות. Embedded Signup בסוף.

## 6. איך להריץ ולבדוק
```
npm install
npm run setup                 # .env + MASTER_ENCRYPTION_KEY, ומוסיף משתנים חדשים
npm run seed                  # מאמן הדמו (מסומן כדמו)
npm run demo:remove           # מציג. עם -- --confirm demo מוחק את מאמני הדמו
npm test && npm run typecheck # 198 בדיקות
npm run chat -- --new --debug
npm run admin -- user:create --email you@example.com
npm run admin -- superadmin:create --email ops@example.com
npm run admin -- sample-data
npm run dashboard             # http://localhost:3000 (ו-/admin)
npm run dashboard:build
npm run test:live             # מול Claude אמיתי, דורש ANTHROPIC_API_KEY, עולה כסף
```
- **וואטסאפ ב-dry run:** `WHATSAPP_DRY_RUN=true` ו-`WHATSAPP_APP_SECRET=x`, ואז `npm run admin -- wa:connect --pnid dryrun-demo` ו-`npm run wa:simulate -- "היי"`.
- **בדיקה ידנית של החיזוק:** README, הסעיף "חיזוק אבטחה לפני עלייה לאוויר".
- **חשוב:** עם PGlite (בלי `DATABASE_URL`) רק תהליך אחד רץ. מול Supabase אין מגבלה כזו.
