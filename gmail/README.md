# Gmail watcher (Google Apps Script)

Runs inside my Google account for free. Every 15 minutes it checks new inbox emails and sends a
Telegram message only for **emails from real people** and **job-related emails** (recruiters,
interviews, application updates, LinkedIn job alerts that fit my profile). Payments, receipts,
ads and newsletters are skipped. At 20:00 it sends a digest of the day.

LinkedIn has no public job-search API and scraping is against its terms, so internships come in
through **LinkedIn Job Alerts** (set on linkedin.com/jobs), which LinkedIn emails to Gmail.

Privacy: only the first 1,500 characters of a non-skipped email are sent to Groq to decide and summarize.
Emails stay unread; checked ones get the `morning-agent/seen` label.

## Setup

1. script.google.com → **New project** → name it `morning-agent-gmail`.
2. Replace the code in `Code.gs` with [`Code.gs`](Code.gs) → **Save**.
3. ⚙️ **Project Settings** → **Script Properties** → add `GROQ_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
4. Back in the editor, choose the `setup` function → **Run** → allow access
   (Google shows "unverified app": **Advanced → Go to morning-agent-gmail**, because it's my own script).
5. Telegram should say "Gmail izleyici kuruldu".

### /gmail command (optional)

6. Add one more Script Property: `WEBAPP_KEY` (a long random word you make up).
7. **Deploy → New deployment** → type **Web app** → Execute as **Me**, Who has access **Anyone** → Deploy → copy the **Web app URL**.
   ("Anyone" is safe here: without the right `key` the script answers "forbidden".)
8. In the Cloudflare Worker add secrets `GMAIL_WEBAPP_URL` (that URL) and `GMAIL_KEY` (same word as `WEBAPP_KEY`).
9. Send `/gmail` to the bot.

After changing `Code.gs`, use **Deploy → Manage deployments → Edit → Version: New version**, so the Web App runs the new code.

Change what counts as a good internship in `MY_PROFILE` at the top of `Code.gs`.
