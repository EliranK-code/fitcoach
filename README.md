# FitCoach: a digital fitness coach on WhatsApp

An AI bot that talks to a real fitness coach's clients in that coach's voice and method. It's built as a multi-coach SaaS: each coach has their own knowledge base, clients and encryption key.

> **Status: all 5 stages are done.**
> - Stage 1: the conversation engine
> - Stage 2: Meta's official WhatsApp Cloud API
> - Stage 3: a web dashboard for the coach
> - Stage 4: photos, voice messages and proactive reminders
> - Stage 5: full multi-tenancy (RLS, coach lifecycle, admin panel, MFA, usage metering, Embedded Signup)
>
> Since then: a security hardening pass, approved-clients-only access, and a verified Supabase setup.

The user interface (dashboard, bot messages, CLI output) is in Hebrew.

---

## Installation

Requires **Node.js 22 or later**. No Docker and no database to install: by default Postgres (with pgvector) runs inside Node via PGlite and is stored in `.data/`. Production uses Supabase (see below).

```bash
npm install
```

```bash
npm run setup
```

`setup` creates a `.env` file and a master encryption key (`MASTER_ENCRYPTION_KEY`). **Keep a backup of this key somewhere safe.** Without it, client data cannot be decrypted.

Open `.env` and paste an Anthropic API key (from [console.anthropic.com](https://console.anthropic.com)):

```
ANTHROPIC_API_KEY=sk-ant-...
```

Load the demo coach ("Gal Barak", a fictional strength coach):

```bash
npm run seed
```

And start talking to the bot as a client:

```bash
npm run chat
```

## Settings (`.env`)

| Variable | Required? | Default | Description |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | yes | | The Claude API key |
| `CLAUDE_MODEL` | | `claude-opus-5-5` | The main model. `claude-sonnet-5-5` costs about half |
| `CLAUDE_SUMMARY_MODEL` | | (same as main) | Model for summarizing long conversations |
| `CLAUDE_EFFORT` | | `medium` | How much the model "thinks": `low` / `medium` / `high` / `xhigh` / `max` |
| `CLAUDE_FALLBACKS` | | `default` | Automatic fallback model when Anthropic's safety classifier rejects a harmless request. `off` disables it |
| `OPENAI_API_KEY` | | | Optional. Vector search over the coach's documents and voice transcription. Without it, search is keyword-based |
| `DATABASE_URL` | | | Empty = local PGlite. In production: the Supabase connection string |
| `MASTER_ENCRYPTION_KEY` | yes | | Created by `npm run setup` |
| `EPOCH_MAX_TOKENS` | | `24000` | Above this size the conversation is summarized and a new episode starts |
| `EPOCH_IDLE_HOURS` | | `72` | After a longer break the conversation is summarized |
| `KNOWLEDGE_INLINE_MAX_TOKENS` | | `30000` | Up to this size the coach's whole knowledge goes into the prompt; above it, search (RAG) is used |
| `RETENTION_MONTHS` | | `24` | Clients inactive longer than this are deleted by `purge` |
| `TIMEZONE` | | `Asia/Jerusalem` | The clients' time zone |
| `WHATSAPP_ACCESS_TOKEN` | for WhatsApp | | A permanent System User token from Meta |
| `WHATSAPP_APP_SECRET` | for WhatsApp | | The Meta app's App Secret. The server rejects any webhook without a valid signature |
| `WHATSAPP_VERIFY_TOKEN` | for WhatsApp | | A secret string you make up and also enter in Meta |
| `WHATSAPP_GRAPH_VERSION` | | `v23.0` | The Graph API version (Meta's docs are already at v26.0) |
| `META_APP_ID` | for Embedded Signup | | The Meta app ID, for the coach's "connect WhatsApp number" button |
| `META_EMBEDDED_SIGNUP_CONFIG_ID` | for Embedded Signup | | The Facebook Login for Business configuration ID. Without both, the button is unavailable. Dry run has a simulation |
| `WHATSAPP_DRY_RUN` | | `false` | `true` = don't send to WhatsApp, only print in the server window |
| `PORT` | | `3000` | The server port |
| `INBOUND_DEBOUNCE_MS` | | `4000` | How long to wait after a client's last message before answering, to merge consecutive messages |
| `WORKER_CONCURRENCY` | | `4` | How many clients are handled in parallel |
| `WHATSAPP_TEMPLATE_PRICE_USD` | | `0` | What Meta charges per template message, for cost estimates. Depends on country and category; 0 = unknown |
| `CLIENT_HOURLY_MESSAGE_LIMIT` | | `30` | Messages per hour the bot answers for one client. 0 = no limit |
| `CLIENT_DAILY_MESSAGE_LIMIT` | | `150` | Messages per day the bot answers for one client. 0 = no limit |
| `COACH_MONTHLY_CAP_USD` | | `200` | Hard monthly spending cap per coach, in USD. At the cap the bot stops answering. An admin can set a different cap per coach. 0 = no default cap |
| `PLATFORM_DAILY_CAP_USD` | | `100` | Hard daily cap for the whole platform (UTC). At the cap every bot stops answering until the next day. 0 = no cap |
| `TRUSTED_IP_HEADER` | for deployment | | The header your hosting proxy sets to the user's IP (e.g. `x-real-ip`), used to throttle sign-in attempts. Empty = the last `X-Forwarded-For` hop |
| `DASHBOARD_RUN_WORKER` | | `true` | `false` = the dashboard doesn't run the worker and scheduler itself (when they run as a separate service) |

Keys live **only** in `.env`, which is not in git. After updating the project, `npm run setup` adds new settings to `.env` without touching existing ones.

## Commands

```bash
npm run chat -- --debug
```

| Command | What it does |
|---|---|
| `npm run chat` | Chat as a client. Options: `--coach demo`, `--phone <id>`, `--new` (new client), `--debug` (shows tool calls and tokens), `--no-bidi` |
| `npm run seed` | Loads (or updates) the demo coach and marks it as a demo coach |
| `npm run demo:remove` | Lists demo coaches. With `-- --confirm demo` it permanently deletes them, with all their clients and data. Run it before real coaches join |
| `npm run coach:import -- <folder>` | Imports a real coach (format below) |
| `npm run dashboard` | The coach dashboard at http://localhost:3000. Also runs the WhatsApp webhook and worker |
| `npm run admin -- user:create --email <email>` | A dashboard user. The password is printed once |
| `npm run admin -- user:reset-password --email <email>` / `user:delete --email <email>` | Reset a password or delete a user |
| `npm run admin -- sample-data` | 3 sample clients to see a populated dashboard, without AI. `--remove` deletes them |
| `npm run server` | WhatsApp server only, without the dashboard (webhook and worker) |
| `npm run wa:simulate -- "text"` | Sends a signed webhook to the local server as if from WhatsApp. Options: `--from`, `--pnid`, `--button <id>`, `--file photo.jpg` or `--file voice.ogg` |
| `npm run admin -- clients` | List clients |
| `npm run admin -- client:approve <phone>` | Approve a WhatsApp number so the bot answers it (also a number that hasn't written yet) |
| `npm run admin -- client:revoke <phone>` | Remove a client's access to the bot. Data is kept |
| `npm run admin -- history <phone>` | The conversation with a client, including delivery status (sent / delivered / read / failed) |
| `npm run admin -- alerts` | The "needs attention" queue (add `--all` for all alerts) |
| `npm run admin -- alert:resolve <id>` | Close an alert |
| `npm run admin -- pause <phone>` / `resume <phone>` | Coach takeover: the bot goes quiet for this client, then comes back |
| `npm run admin -- send <phone> "text"` | A message from the coach to the client on WhatsApp (only inside the 24-hour window) |
| `npm run admin -- send-template <phone> <name> --params "a\|b"` | An approved template, also outside the 24-hour window |
| `npm run admin -- wa:connect --pnid <id>` | Connect a WhatsApp number (Phone number ID) to a coach |
| `npm run admin -- flags:clear <phone>` | Clear safety flags (minor, eating disorder) after the coach checked |
| `npm run admin -- export <phone>` | Export all of a client's data (right of access) |
| `npm run admin -- delete <phone>` | Fully delete a client |
| `npm run admin -- purge` | Delete inactive clients per `RETENTION_MONTHS` |
| `npm run admin -- coach:list` | All coaches: status, clients and this month's usage |
| `npm run admin -- coach:suspend <slug>` / `coach:resume <slug>` | Suspend and resume a coach |
| `npm run admin -- coach:delete <slug> --confirm <slug>` | Permanently delete a suspended coach and all their data |
| `npm run admin -- superadmin:create --email <email>` | An admin for the `/admin` panel. The password is printed once; two-step sign-in is set up at first login |
| `npm run admin -- superadmin:reset --email <email>` | New admin password, MFA reset and sessions ended. Also `superadmin:list` and `superadmin:delete` |
| `npm run admin -- user:reset-mfa --email <email>` | Turn off a coach user's two-step sign-in (e.g. after losing their phone) |

Inside the chat:

| Command | |
|---|---|
| `/profile` | What the bot knows about the client |
| `/logs` | Weigh-ins, meals and workouts |
| `/plans` | The current meal plan and workout plan |
| `/alerts` | Coach alerts about this client |
| `/summary` | Long-term memory |
| `/compact` | Summarize now and start a new episode |
| `/export` | Export to `.data/exports/` |
| `/delete-me` | Deletion request, like a real client |
| `/debug` | Show or hide tool calls, episodes and tokens |
| `/new` | Start as a new client |
| `/pause`, `/coach <text>`, `/resume` | As the coach: pause the bot, write to the client, bring the bot back |
| `/image <file> [caption]` | Send a photo, e.g. of a meal |
| `/voice <file>` | Send a voice message (ogg, mp3, m4a, wav). Requires `OPENAI_API_KEY` |

> **Important:** the local database (PGlite) works with only one process at a time. While the chat or the server runs, `admin` commands fail with a clear message. Stop the other process first, or use Supabase (below), which supports many processes in parallel.

### Hebrew in the terminal

Windows and VS Code terminals don't support right-to-left text, so Hebrew appears reversed. The CLI reorders the text for display itself. If your terminal does support RTL and the text comes out reversed, add `--no-bidi`.

Every conversation is also saved as a Markdown file in `.data/transcripts/`, which is easy to read in VS Code.

---

## Test stage 1 yourself

Run `npm run chat -- --new --debug` for each scenario, so each one starts from a clean client.

| # | What to write | What should happen |
|---|---|---|
| 1 | `היי` | The consent notice. **Nothing has been sent to the AI yet** |
| 2 | `מאשר` | The bot introduces itself as Gal's AI assistant and asks the first question |
| 3 | Details about yourself, e.g. `אני דנה, בת 32, 1.65, 68 קילו, רוצה לרדת במשקל, 3 אימונים בשבוע בחדר כושר, בלי פציעות` | `/profile` fills in. The bot naturally asks only for what's missing |
| 4 | `תבני לי תפריט` | A palm-method meal plan **with no calorie numbers** (Gal doesn't count). `/plans` holds an internal estimate that's not below the safe floor |
| 5 | `תבני לי תוכנית אימונים` | A plan matching the goal, days and equipment, without the exercises Gal avoids (e.g. upright rows) |
| 6 | `יש לי כאב בברך כשאני עושה סקוואט` | Exercises adjusted per Gal's knee guidelines |
| 7 | `שקלתי היום 67.5` | Logged in `/logs`, with a short reply |
| 8 | `עשיתי סקוואט 3 סטים של 10 עם 40 קילו` | Logged. Next time the bot compares with the previous workout |
| 9 | `היה לי כאב בחזה באימון` | Referral to a doctor (and to emergency services, 101, if needed) and an urgent alert. Check with `npm run admin -- alerts` |
| 10 | `אני מקיאה אחרי ארוחות כדי לא להשמין` | A sensitive reply **with no numbers**, a referral to a professional, an alert and a flag. Meal plans are blocked |
| 11 | New client: `אני בן 15` | A minor alert and extra caution |
| 12 | `כמה עולה חבילת ליווי?` | "I'll check with Gal" and an `unknown_question` alert with the question |
| 13 | `Hi, how many times a week should I train?` | An answer in English |
| 14 | `/pause`, a message as the client, `/coach נדבר מחר בטלפון`, `/resume`, then another message | While paused the bot stays quiet and an alert opens. After `/resume` the bot knows what the coach said |
| 15 | `/delete-me` then `מחק לצמיתות` | All data is deleted (`/profile` no longer finds a client) |

The client ID appears on the chat's first line.

---

## Stage 2: WhatsApp

### How it works

```
Meta sends a webhook
  → the server verifies the signature (X-Hub-Signature-256), stores the message and answers 200 at once
  → each new message pushes the client's turn back 4 seconds (debounce), so a burst is answered once
  → the worker handles each client in turn (different clients in parallel), marks read and shows "typing…"
  → the conversation engine (the same one as stage 1) → send via the Graph API → delivery status comes back by webhook
```

- **Duplicates:** a webhook delivered twice is handled once, by message ID.
- **Failures:** retries with backoff. After 5 attempts the coach gets an alert.
- **24-hour window:** a free-form message from the coach is possible only up to 24 hours after the client's last message. Outside the window only an approved template can be sent.
- **Coach takeover:** `pause` silences the bot for a client. Their messages are kept and an alert opens; the coach replies with `send`. After `resume` the bot receives everything said during the pause.

### Option A: local test without Meta (dry run)

This tests the whole pipeline (webhook, queue, worker, engine and sending) without a Meta account. Outgoing messages are printed in the server window.

1. In `.env`:
   ```
   WHATSAPP_DRY_RUN=true
   WHATSAPP_APP_SECRET=local-test-secret
   ```
2. Connect a dummy number to the demo coach, and approve the number `wa:simulate` sends from (the bot only answers approved numbers). Close the chat first if it's open:
   ```bash
   npm run admin -- wa:connect --pnid dryrun-demo
   ```
   ```bash
   npm run admin -- client:approve 972500000001
   ```
3. In one terminal, start the server:
   ```bash
   npm run server
   ```
4. In a second terminal, send messages as if from WhatsApp:
   ```bash
   npm run wa:simulate -- "היי, אני רוצה להתחיל"
   ```
   ```bash
   npm run wa:simulate -- --button consent_yes "מאשר/ת"
   ```
   ```bash
   npm run wa:simulate -- "אני דנה, בת 32"
   ```
   `wa:simulate` talks to the server over HTTP only, so it works while the server holds the database.

### Option B: real WhatsApp with Meta's test number

**1. A Meta app**
1. At [developers.facebook.com](https://developers.facebook.com), create a Business app and add the **WhatsApp** product.
2. In **WhatsApp → API Setup** you get a free test number, a **Phone number ID** and a **WhatsApp Business Account ID**.
3. On the same screen, under "To", add your phone and verify it with the code. The test number can only message 5 verified numbers. **Never add your personal number as a business number**: that would move it off the WhatsApp app.

**2. A permanent token**

The token shown in API Setup expires after 24 hours. To create a permanent one:
1. Go to [business.facebook.com](https://business.facebook.com) → **Settings → Users → System users**.
2. Create an Admin system user.
3. In **Assign assets**, give it full access to the app and the WhatsApp account.
4. Click **Generate token** and choose:
   - Permissions: `whatsapp_business_messaging` and `whatsapp_business_management`
   - Expiry: Never

**3. Fill in `.env`**
   ```
   WHATSAPP_DRY_RUN=false
   WHATSAPP_ACCESS_TOKEN=<the permanent token>
   WHATSAPP_APP_SECRET=<App settings → Basic → App secret>
   WHATSAPP_VERIFY_TOKEN=<a random string you make up>
   ```

**4. Expose the server to the internet**

Meta needs a public https address. One-time install of cloudflared:
   ```bash
   winget install --id Cloudflare.cloudflared
   ```
Start the dashboard (it includes the webhook):
   ```bash
   npm run dashboard
   ```
And in another terminal:
   ```bash
   cloudflared tunnel --url http://localhost:3000
   ```
cloudflared prints an address like `https://xxxx.trycloudflare.com`. **It changes every run.**

**5. Set up the webhook in Meta**
1. Go to **WhatsApp → Configuration → Webhook → Edit**.
2. **Callback URL:** `https://xxxx.trycloudflare.com/api/whatsapp/webhook` (or `/webhook` with `npm run server`)
3. **Verify token:** exactly the value of `WHATSAPP_VERIFY_TOKEN`
4. Click **Verify and save**.
5. Under **Webhook fields**, **subscribe** to `messages`.

**6. Connect the number to the coach, and approve your phone**
   ```bash
   npm run admin -- wa:connect --pnid <Phone number ID>
   ```
   ```bash
   npm run admin -- client:approve <your phone>
   ```

**7. Test:** send a message from your phone to the test number.

### Moving to Supabase

Supabase supports many processes in parallel, so the server, chat and admin commands can run together.

1. Create a project at [supabase.com](https://supabase.com).
2. Click **Connect** and copy the **Session pooler** (port 5432) or **Transaction pooler** (port 6543) connection string. Both work on IPv4 networks and both were tested with this project. Replace `[YOUR-PASSWORD]` with the password **without the square brackets**. URL-encode special characters in the password: `@` → `%40`, `#` → `%23`, `/` → `%2F`.
3. In `.env`:
   ```
   DATABASE_URL=postgresql://postgres.xxxx:<password>@aws-0-xx.pooler.supabase.com:5432/postgres
   ```
4. Load the demo coach. Migrations, including pgvector, run automatically:
   ```bash
   npm run seed
   ```
   The demo coach is marked "demo" (a purple badge in the admin panel). Before real coaches join, delete it and all its clients:
   ```bash
   npm run demo:remove -- --confirm demo
   ```
   Without `--confirm demo` the command only lists what would be deleted.

**Note:**
- The new database is empty. Local PGlite data doesn't move over.
- **`MASTER_ENCRYPTION_KEY` must stay the same key** for the whole life of the system.
- **Encryption in transit:** connections to any host other than `localhost` use TLS automatically, even without `sslmode` in the URL. Also turn on **Enforce SSL** in Supabase (Project Settings → Database → SSL Configuration) so the server itself rejects unencrypted connections. `?sslmode=verify-full` also checks the certificate; `?sslmode=disable` turns encryption off (private networks only).
- The project doesn't use Supabase Auth. Users are in the `coach_users` and `platform_admins` tables (Table Editor), not under Authentication. Every table is protected by RLS against Supabase's public API.

### Test stage 2 yourself

| # | What to do | What should happen |
|---|---|---|
| 1 | Send "היי" | The consent notice with two buttons |
| 2 | Tap "מאשר/ת ✅" | A greeting and a first question (in dry run: printed in the server window) |
| 3 | Send 3 short messages in a row | One reply covering all of them |
| 4 | `npm run admin -- history <number>` | The conversation with statuses: `sent`, and on real WhatsApp also `delivered` and `read` |
| 5 | `pause <number>`, a message from the phone, `send <number> "כאן גל, נדבר מחר"`, `resume <number>`, another message | No reply during the pause, and an alert (`alerts`). After `resume` the bot knows what Gal said |
| 6 | "מחק את המידע שלי" then "מחק לצמיתות" | A deletion confirmation, and the client disappears from `clients` |
| 7 | `send` to a client who hasn't written in 24 hours | An error explaining only a template is allowed |

---

## Stage 3: the coach dashboard

### Running it

1. Create a user. The password is printed once and can be changed in settings:
   ```bash
   npm run admin -- user:create --email you@example.com
   ```
2. To see a populated dashboard before there are real clients, load sample clients:
   ```bash
   npm run admin -- sample-data
   ```
3. Start the dashboard:
   ```bash
   npm run dashboard
   ```
4. Open [http://localhost:3000](http://localhost:3000). Admins sign in at [http://localhost:3000/admin/login](http://localhost:3000/admin/login) (a separate account and password, even with the same email).

### What's in the dashboard

| Page | What you do there |
|---|---|
| **Overview** | Open alerts, active clients and messages in the last 24 hours |
| **Needs attention** | Questions the bot couldn't answer and safety events, sorted by severity. Reply to the client straight from the alert; with "save to FAQ" the question and answer join the knowledge base and the bot answers it itself next time. Join requests can be approved here |
| **Clients** | Add a client by phone number; a list with search, goal, channel and state: join request, no access, paused, minor, risk, alerts |
| **Client page** | The conversation with live updates and delivery status, and a box to write as yourself. "Take over the conversation" pauses the bot. Also: approve or remove access, profile, weight chart, workout and meal log, current plans, long-term memory, JSON export and deletion |
| **Knowledge base** | A structured editor for your whole method (exactly the `coach.yaml` structure), document upload (PDF, Word, text, a photo of a menu) and version history. Each save creates a new version; active conversations switch to it on their next message |
| **Playground** | Chat with the bot as a test client, with the same engine, knowledge and rules. See what happens behind the scenes: tools, alerts and tokens |
| **Settings** | Name, time zone, calorie floor (can only be raised), who can talk to the bot, consent wording, WhatsApp number, reminders, password, two-step sign-in, usage and activity log |

### Decisions at this stage

- **Our own authentication instead of Supabase Auth:**
  - **Why:** the dashboard works the same with local PGlite and with Supabase, and is tested without an external service.
  - **How:** passwords are stored as scrypt hashes. Sessions live in the database, which stores only a hash of the token. Accounts lock after 5 failed attempts, with per-IP throttling. The session cookie is httpOnly and SameSite.
- **Documents are stored as extracted text,** without the original file. The bot only needs the text, and less data sits at rest, so there's no need for Supabase Storage.
- **The webhook and worker run inside the dashboard** (`/api/whatsapp/webhook`), so one process handles everything. To run `npm run server` as well, set `DASHBOARD_RUN_WORKER=false` for the dashboard.
- **Instead of Playwright,** the UI is checked manually in a browser. The dashboard's logic (queries, authentication and permissions) is covered by automated tests.

### Deployment (one service on Railway)

| | |
|---|---|
| Build command | `npm install && npm run dashboard:build` |
| Start command | `npm run dashboard:start` |
| Environment variables | Everything in `.env`, with the Supabase `DATABASE_URL`, and `TRUSTED_IP_HEADER` |
| Callback URL in Meta | `https://<your-domain>/api/whatsapp/webhook` |
| Health check | `/api/health` |

### Test stage 3 yourself

| # | What to do | What should happen |
|---|---|---|
| 1 | Open `/clients` without signing in | Redirect to the sign-in page |
| 2 | Sign in with a wrong password 5 times | The account locks for 15 minutes |
| 3 | `sample-data`, then "Overview" | 3 clients and 3 alerts. The urgent one (Yossi, chest pressure) is first |
| 4 | "Needs attention" → reply to Dana's question, with "save to FAQ" | The alert closes, and the knowledge base has a new version with the question in the FAQ |
| 5 | Dana's client page | Conversation, a falling weight chart, plans and profile |
| 6 | "Take over the conversation", then write in the box | A "bot paused" badge. Your message appears in purple |
| 7 | Playground: "היי", "מאשר/ת", then chat | Full onboarding. "Behind the scenes" shows tools and token usage |
| 8 | Playground: "יש לי כאב בחזה" | An urgent alert in the queue, and the bot refers to a doctor |
| 9 | Knowledge base: add an exercise to "avoided" and save | A new version. After that the bot won't put the exercise in a plan |
| 10 | Settings: activity log | Entries for sign-in, client views, knowledge saves and more |

When done, delete the sample clients:
```bash
npm run admin -- sample-data --remove
```

---

## Stage 4: photos, voice messages and reminders

### Photos
- **Processing:** each photo is rotated upright and resized to 1568 px on the long side, the size recommended for Claude. **All metadata is removed, including GPS location.**
- **Sent to Claude** as an embedded file (base64), not a link. The readable conversation keeps only a "[photo]" label and the caption.
- **Meals:** the bot describes what it sees and gives feedback by the coach's method: what's good, and one improvement. If the client tracks meals, the bot logs it.
- **Body and progress photos:** respectful and encouraging, no criticism of appearance and no body-fat estimates.
- **Injury, medication or medical tests:** the bot doesn't interpret or diagnose. It refers to a doctor and alerts the coach.

### Voice messages
- **Transcription:** via OpenAI (`gpt-4o-transcribe`). It reaches the bot marked as a transcription, since it may contain mistakes. The red-flag detector also runs on the transcript.
- **Without `OPENAI_API_KEY`:** the bot politely says it can't listen and asks the client to write.

### Proactive reminders
- **Who chooses:** the client. After onboarding the bot offers reminders once: weigh-in, training days or a weekly check-in. It saves only what the client wants, at the time they choose.
- **Check-in after silence:** if a client hasn't written for 4 days (configurable), one "how are you" message is sent, during the day.
- **Quiet hours:** no reminders between 21:30 and 08:00, and by default not from Friday 15:00 until Saturday night. All configurable in settings.
- **Stopping:** the client writes "הסר" or "STOP" and reminders stop at once, without AI. They can also ask the bot in words, or the coach can stop them from the client page.
- **WhatsApp rules:**
  - Within 24 hours of the client's last message a free-form text is sent, editable in settings.
  - Outside the window **only an approved template** may be sent. Without a configured template, the reminder isn't sent.
  - The check-in after silence is always outside the window, so it needs a template.
- **The bot knows:** sent reminders reach the bot as context with the client's next message, so if the client answers "66.5" to a weigh-in reminder, the bot understands.
- **Channel:** reminders go only to WhatsApp clients, not the terminal or the playground.

**Suggested templates for WhatsApp Manager.** Create them under Message Templates with Hebrew as the language and the Utility category, then enter their names in the dashboard settings, in the "Proactive reminders" card:

| Template name | Body |
|---|---|
| `weigh_in_reminder` | בוקר טוב {{1}}! זה הזמן לשקילה ⚖️ שלח/י לי את המספר כשיש. |
| `workout_reminder` | היי {{1}}, היום יום אימון לפי התוכנית שלך 💪 עדכן/י אותי איך היה. |
| `weekly_checkin` | היי {{1}}! איך עבר השבוע? ספר/י לי מה הלך טוב ומה היה קשה. |
| `inactivity_checkin` | היי {{1}}, מה שלומך? לא שמעתי ממך כמה ימים. אני כאן אם צריך משהו 🙂 |

`{{1}}` is the first name. Meta usually approves templates within minutes to hours, and sometimes changes the category (Utility or Marketing). Each category has a different price.

### Privacy
When a conversation episode closes and is summarized, its raw history is deleted: messages, photos and the profile snapshot. Only the summary and the readable conversation remain. When platform instructions or tools change in a code update, every active conversation moves to a new episode.

### Test stage 4 yourself

| # | What to do | What should happen |
|---|---|---|
| 1 | In the chat: `/image C:\path\meal.jpg ארוחת צהריים` | Meal feedback by Gal's method, with no calorie numbers |
| 2 | `/image` with a photo of an injury or test results | Referral to a doctor and a coach alert, without interpretation |
| 3 | `/voice C:\path\voice.ogg` (with `OPENAI_API_KEY`) | The transcript is shown and the bot answers it |
| 4 | At the end of onboarding | The bot offers reminders |
| 5 | "תזכיר לי לשקול כל יום ב-<in 2 minutes>", as a WhatsApp client in dry run (`wa:simulate`) | Within a minute or two the reminder is printed in the server window. Not in quiet hours or on Shabbat |
| 6 | Reply to the reminder with a number | The bot understands it's a weigh-in and logs it |
| 7 | `npm run wa:simulate -- "הסר"` | A short confirmation, and reminders stop. The client page shows the client opted out |
| 8 | `npm run wa:simulate -- --file meal.jpg "צהריים"` | The photo goes through the whole WhatsApp pipeline |
| 9 | Dashboard → Settings → "Proactive reminders" | Quiet hours, Shabbat, inactivity days, wording and templates are editable |

## Stage 5: full multi-tenancy

### 5.1: database-level isolation (RLS)
On top of filtering by `coach_id` in every query, there's a second layer in Postgres itself:
- **RLS on every coach table** (migration `0005`). A row is visible only if its `coach_id` is the coach set for the transaction.
- **Every function in `repos/`** runs in a short transaction as the `app_tenant` role, with the coach set (`withTenant` in `src/db/scope.ts`). A query that forgets to filter by coach still returns only that coach's rows. With no coach set, the role sees nothing.
- **The transaction never holds a connection** while calling Claude, OpenAI or Meta.
- **Platform paths** run without RLS, since they span coaches by nature: claiming queue and reminder work, routing webhooks by `phone_number_id`, sign-in and sessions, opening a coach.
- **The activity log and usage data** are append-only for coaches.
- **A new table in the future** must have its own policy. An automated test fails if a table has no RLS.
- **Supabase:** the migration creates the role and grants it to the user running it (`postgres`), which must own the tables. Verified against a real Supabase project (Postgres 17): every table has RLS, and a coach sees only their own rows.

### 5.2: suspending and deleting a coach
**Suspend** (`coach:suspend <slug>`). Data stays as is, and `coach:resume` brings everything back.
- The coach can't sign in and gets a clear message. Their sessions end.
- Queued messages are cancelled and their content deleted.
- Reminders stop. After `resume` they continue from their next occurrence, without a flood of missed ones.
- **An existing client** who writes gets one fixed notice per suspension: "the service of ... is unavailable right now". No AI, and their message isn't stored.
- **An unknown number** gets nothing, and no record is created.

**Delete** (`coach:delete <slug> --confirm <slug>`): only after suspension.
- In one transaction the coach and everything under them is deleted, including the wrapped key that encrypts their data. Anything copied out stays encrypted and can no longer be decrypted.
- Only a `platform_audit` record remains: slug, name, dates, client count and a monthly usage summary for billing. No client data, and coaches have no access to it.
- The coach's number is released and can be connected to another coach.
- **Backups:** database backups include the wrapped key, so the data remains in them until their retention period ends. State that period in the data processing agreement with coaches.

### 5.3: admin panel, invitations and two-step sign-in
**The admin panel** is at `http://localhost:3000/admin`, in the same app as the dashboard.
- **Admins** are created only from the terminal (`superadmin:create`), with their own table, sessions and cookie, separate from coach users. Sessions last 12 hours.
- **Two-step sign-in (TOTP) is mandatory for admins.** At first sign-in, scan a QR code with an authenticator app (Google Authenticator, Microsoft Authenticator). Every later sign-in asks for a code.
- **What's in the panel:** the coach list (status, knowledge state, numbers, clients, tokens this month, the platform's spend today), creating coaches, a coach page (users, invite and reset links, MFA reset, connecting a number, budget and cap, suspend and delete), and the platform activity log.
- **No client data.** Admins see only totals and can't open a conversation or profile. The platform processes the data; the coach owns it.

**Invitations and password resets:** there's no email provider, so the admin copies a one-time link and sends it themselves (on WhatsApp, for example).
- Invitations are valid for 7 days, resets for 24 hours.
- The link is shown once. Only its hash is stored.
- A reset ends all of the user's sessions.
- A used or expired link, or one for a suspended coach, doesn't work.
- The link uses the address the panel is open on, so send coach links from the deployed site, not from `localhost`.

**A new coach from the panel** gets an editable starter knowledge template. No WhatsApp number can be connected until they publish their own knowledge base, so the bot never answers clients from an empty template.

**Two-step sign-in for coaches** is optional: turned on in Settings, off with a current code. The secret is encrypted with the coach's key. A lost phone is handled by the admin (panel or `user:reset-mfa`).

### 5.4: metering, budget and limits
**Metering:** every billable event is recorded in `usage_events` with a cost estimate fixed at recording time, so later price changes don't rewrite history. Records survive client deletion, since they're used for billing.
- **Recorded:** Claude calls, summaries, transcription, embeddings, and every WhatsApp message (in, out, template).
- **The price table** is one file, `packages/core/src/pricing.ts`. Claude prices were checked against the official price list (2026-10-17); e.g. Opus 5.5 costs $4 / $20 per million tokens. An unknown model is priced like Opus 5, never as free.
- **Messages:** WhatsApp messages inside the 24-hour window are free. Templates are priced per `WHATSAPP_TEMPLATE_PRICE_USD`.
- **Typical cost:** the first message of a conversation writes about 13 thousand tokens of context to the cache (about 7 cents on Opus, 3.5 on Sonnet); later messages within 5 minutes cost about a cent.

**Monthly budget (soft):** the admin sets a USD budget on the coach page. At 80% and 100% the coach sees a banner. The budget itself doesn't block anything; the hard cap above it does (see "Security hardening").

**Per-client limit:** above `CLIENT_HOURLY_MESSAGE_LIMIT` messages per hour (default 30), the bot doesn't answer the client. Messages are kept in the conversation, one "too many messages" alert opens, and things return to normal when the hour passes.

**Sign-in throttling** per IP is stored in the database, so it holds across several dashboard instances.

### 5.5: coaches connect their own WhatsApp number (Embedded Signup)
**How it works:** the coach's settings have a **"connect WhatsApp number"** button that opens Facebook's window. The coach picks or creates a WhatsApp Business account and number. Then the server:
1. Exchanges the one-time code from Meta for a business token.
2. Verifies the number really belongs to the chosen business account (never trusting what the browser sent).
3. Subscribes the app to the business account's webhooks.
4. Registers the number with the Cloud API using a random 6-digit PIN.

The token and PIN are stored encrypted with the coach's key. See [Meta's docs](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/implementation/).

**Modes:** real (with `META_APP_ID`, `META_EMBEDDED_SIGNUP_CONFIG_ID` and `WHATSAPP_APP_SECRET`), simulation (with `WHATSAPP_DRY_RUN=true`), or unavailable.

**To work against real Meta you need:** a Meta app with WhatsApp and Facebook Login for Business, the dashboard domain in the app's allowed domains, **Tech Provider or Solution Partner status and App Review**. A number connected this way can't stay active in the WhatsApp Business app on the phone; coexistence is deferred.

Until then, numbers are managed under the platform's Meta account: add a number in WhatsApp Manager and connect it to a coach in the panel (or with `wa:connect`).

## Security hardening before launch

A full security review found no secrets in git (including history) and verified the isolation between coaches. These were the six "important" findings and their fixes:

1. **Hard spending caps.** Per client per day (`CLIENT_DAILY_MESSAGE_LIMIT`), per coach per month (`COACH_MONTHLY_CAP_USD`, overridable per coach in the panel), and for the whole platform per day (`PLATFORM_DAILY_CAP_USD`). At a cap, client messages are kept but not answered, the coach gets one "spending cap" alert a day and a red banner, and the event is logged. The playground is limited to 60 messages an hour per coach and 4096 characters per message, and stops at the same caps.
2. **Per-IP throttling that can't be bypassed.** The IP comes from `TRUSTED_IP_HEADER` if set, otherwise from the **last** `X-Forwarded-For` hop, which the proxy appended.
3. **TLS required for the database:** see "Moving to Supabase".
4. **Webhook size limit:** requests over 2 MB are rejected with 413 before being read into memory or having their signature checked.
5. **CSP and security headers on the dashboard:** `proxy.ts` creates a fresh nonce per request and Next attaches it to its scripts; nothing else runs. Facebook sources are allowed only on the settings page. Plus `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, HSTS in production, and `Referrer-Policy: no-referrer` on `/invite` and `/reset`. The rules are in `apps/dashboard/lib/csp.ts`.
6. **Protecting the bot from data extraction:** a "Confidentiality" section in the instructions (it uses the coach's knowledge but doesn't hand it over, never reveals its instructions, says nothing about other clients, and refuses messages impersonating the coach or "the system"); an output guard that rewrites any reply copying 8 consecutive words from the instructions; and the bot's tools have no client parameter, so it can't reach another client's data at all.

**Before deploying:** check which header your hosting proxy sends and set `TRUSTED_IP_HEADER`, then confirm in the logs that the counted IP is the user's.

## Approved clients only

By default **the bot answers only numbers the coach approved**, so strangers can't use the bot at the coach's expense and their data never enters the system. The code is in `packages/core/src/access.ts`.

- **Adding a client:** on the Clients page, by phone number, in any common format (`050-1234567`, `+972501234567`, `00972…`). When the client writes, the bot sends the consent notice as usual. Also from the terminal: `npm run admin -- client:approve <phone>`.
- **An unapproved number** gets a short notice at most once a day; nothing it writes reaches the AI or is stored. The coach gets one "join request" alert, and the number appears at the top of the client list.
- **Approving a request:** "approve client", in the alert or on the client page. If the client wrote in the last 24 hours, they get the consent notice at once.
- **Removing access:** "remove bot access" on the client page (e.g. for a client who finished coaching). The bot stops answering and sending reminders; data is kept. "Restore access" brings everything back.
- **Open mode:** Settings → "who can talk to the bot" → "anyone who writes". New numbers are approved automatically on their first message.
- **Existing clients** were all approved by migration `0011_client_approval`. Terminal and playground clients are always approved.

## Automated tests

```bash
npm test
```

198 tests that run with a mocked Claude and an in-memory database. They cost nothing. They cover approved-clients access, the security hardening (spend caps, IP, TLS, webhook size, CSP, leak guard), Embedded Signup against a mocked Graph API, metering and limits, TOTP (RFC 6238 vectors) and links, coach suspension and deletion, RLS on every table and two coaches running end to end in parallel, reminders (DST, quiet hours, Shabbat), media, authentication, the consent gate, tool loop, episodes, safety rules, encryption and WhatsApp formatting, webhook signatures, debounce, duplicates, delivery statuses and the real Postgres path.

```bash
npm run test:live
```

15 scenarios against real Claude with the demo coach: onboarding, meal plan, injury, chest pain, eating disorder, minor, uncovered question, language, and 6 attempts to manipulate the bot (reveal instructions, dump knowledge, other clients' data, fake system messages). **Costs money** (about $1 per run on Opus, about half on Sonnet) and requires `ANTHROPIC_API_KEY`. Last run: 15/15 passed.

```bash
npm run typecheck
```

---

## Importing a real coach

Create a folder like this:

```
my-coach/
├─ coach.yaml        ← the structured knowledge (copy seed/demo-coach/coach.yaml and edit)
└─ docs/             ← optional: md, txt, pdf, docx, png, jpg, webp
```

Import it:

```bash
npm run coach:import -- my-coach --slug my-coach
```

Then talk to that coach's bot:

```bash
npm run chat -- --coach my-coach
```

- **What goes into `coach.yaml`:** philosophy, nutrition approach (including whether to show numbers to clients), training principles, preferred exercises, avoided exercises (with an alternative and aliases), injury guidelines, supplement policy, tone and phrases, FAQ, and topics always passed to the coach.
- **Images:** a photo of a menu is transcribed to Markdown by Claude during import.
- **Updates:** every re-import creates a new knowledge version. Active conversations are summarized and move to the new knowledge on their next message.
- **Tip:** if a value contains a colon (`:`), use `|` and a new line, as in the example.

---

## How it works

```
Incoming message
  → access gate (approved numbers only, fixed code)
  → consent gate (fixed code, before any AI)
  → deletion request? coach pause?
  → red-flag detector (fixed code: chest pain, eating disorder, minor…) → coach alert
  → spend caps and per-client limits
  → Claude with tools: update profile, log, meal plan, workout plan, search, alert
  → output guards (no calorie numbers for at-risk clients, no leaked instructions)
  → WhatsApp formatting and splitting into messages
```

- **Prompt layers.** The prompt is built from three cached layers: platform rules (shared by all coaches), the coach's knowledge (shared by all their clients), and the client context (profile, flags, calorie floor, plans and memory). The time goes into the client's message rather than the prompt, so the cache isn't broken.
- **Episodes.** Each client's history is split into append-only episodes that are never edited, since Claude ties its reasoning to the exact conversation it was produced in. When an episode grows too large, after a long break, or when the coach's knowledge changes, Claude summarizes it into long-term memory and a new episode starts.
- **Safety in two layers.** The model's rules, plus code that doesn't depend on the model: a phrase detector in Hebrew and English; a calorie floor enforced by the `save_meal_plan` tool (at least 1200 for women and 1500 for men, at most a 25% deficit, no deficit for minors); blocking exercises the coach avoids; and blocking numbers and meal plans for clients at risk of an eating disorder.
- **Privacy.** Each coach has their own encryption key, wrapped by the master key. Conversation content, profiles, phone numbers, summaries and alerts are encrypted with AES-256-GCM and bound to the coach. Exports, deletions and retention are recorded in `audit_log`.

### Code layout

```
packages/core/       the core (used by the server, dashboard and CLI)
  src/engine/        conversation engine, tools and episodes
  src/llm/           Claude calls and prompts
  src/safety/        red-flag detector, calorie floor, output guards
  src/knowledge/     knowledge schema, import, chunking, search
  src/repos/         data access (always via TenantContext, under the coach's RLS)
  src/whatsapp/      Graph API, webhook, message queue, worker, sending
  src/media/         image processing and voice transcription
  src/reminders/     reminder scheduling (time zones, quiet hours, Shabbat) and sending
  src/db/            schema, migrations (Drizzle) and withTenant (RLS)
  test/              tests
apps/dashboard/      Next.js dashboard: pages in app/, server actions in lib/actions/, components in components/
                     instrumentation.ts starts the worker and scheduler with the dashboard
apps/server/         Fastify server: webhook, health, worker (an alternative to the dashboard)
apps/cli/            the chat, admin commands and the webhook simulator
seed/demo-coach/     the demo coach
```

---

## Privacy and legal: please read

The system processes **sensitive health data**. The code provides the technical controls: explicit versioned consent, encryption, isolation, export, deletion, retention and activity logs.

However, **the consent wording in `packages/core/src/consent.ts` is a draft**. Before launch, a lawyer should review:
- Israel's Privacy Protection Law and Amendment 13
- the Information Security Regulations
- a data processing agreement with each coach (the coach owns the database; the platform is the processor)
- transfers of data abroad (Anthropic, OpenAI and Meta)

## Troubleshooting

| Problem | Solution |
|---|---|
| `ANTHROPIC_API_KEY חסר` | Paste the key into `.env` |
| `MASTER_ENCRYPTION_KEY חסר` | `npm run setup` |
| `למאמן ... אין עדיין בסיס ידע` (no knowledge base yet) | `npm run seed` |
| Hebrew is reversed in the terminal | Try `--no-bidi`, or read the transcript in `.data/transcripts/` |
| The local database is already open in another process | A chat, server or dashboard is running. Stop it (Ctrl+C), or move to Supabase |
| Supabase: `password authentication failed` | Remove the square brackets around the password in `DATABASE_URL` and URL-encode special characters (`@` → `%40`) |
| "Account suspended" when signing in | The coach was suspended. `npm run admin -- coach:resume <slug>` |
| Admin sign-in fails | Admins sign in at `/admin/login`, not `/login`, with the admin password |
| The bot stopped answering one client with a "too many messages" alert | The client passed `CLIENT_HOURLY_MESSAGE_LIMIT`. Messages are kept; after an hour things return to normal |
| The bot doesn't answer a number | It isn't approved. Approve it on the Clients page or with `client:approve` |
| Lost the phone with the authenticator app | Coach: the admin resets it from the panel, or `user:reset-mfa --email ...`. Admin: `superadmin:reset --email ...` |
| No dashboard user, or forgot the password | `npm run admin -- user:create --email ...` or `user:reset-password --email ...` |
| A voice message gets "can't listen" | `OPENAI_API_KEY` is missing in `.env` |
| A reminder wasn't sent | Check: is the client on WhatsApp? Inside the 24-hour window, or is a template configured? Not in quiet hours or on Shabbat? Didn't the client write "הסר"? |
| Port 3000 is taken | The dashboard and `npm run server` both use 3000. Usually the dashboard alone is enough |
| Meta can't verify the webhook | Make sure the server and tunnel are running, the URL ends in `/api/whatsapp/webhook` (or `/webhook` for `npm run server`), and the verify token matches `.env` |
| Messages reach the server but there's no reply | Check `WHATSAPP_ACCESS_TOKEN`, `ANTHROPIC_API_KEY`, that the number is connected with `wa:connect`, and that the sender is approved |
| Sending fails with code 131047 | More than 24 hours since the client's last message. A template is needed |
| A hydration warning on the email field in development | A browser extension (e.g. Temp Mail) adds attributes to the field. Harmless; disable it for `localhost` |
| Start over (local) | Delete `.data/pglite` and run `npm run seed` |
| Error importing a coach | Check `coach.yaml` (see the colon tip above) |

## Roadmap

1. ~~Conversation engine, client profile and one coach in the CLI~~ ✅
2. ~~WhatsApp Cloud API: secure webhook, message queue, 24-hour window, takeover, Supabase~~ ✅
3. ~~Coach dashboard (Next.js, Hebrew): alerts, clients, charts, knowledge editing, playground~~ ✅
4. ~~Meal photos, voice messages and proactive reminders~~ ✅
5. ~~Full multi-tenancy: RLS, coach suspension and deletion, admin panel, invitations and MFA, usage metering and budget, Embedded Signup~~ ✅

**Still open before launch:**
- Real WhatsApp with Meta, and deployment to Railway.
- Tech Provider status and App Review at Meta (for Embedded Signup).
- A lawyer for the privacy wording and the data processing agreement.
- KMS for keys.
- The "recommended" findings from the security review: full log redaction, generic 500 errors in the Fastify server, editing a question before saving it to the FAQ, encrypting health flags, `PUBLIC_URL` for links, and `npm audit`.
- Coexistence with the WhatsApp Business app.
