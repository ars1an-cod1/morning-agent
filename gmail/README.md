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

Change what counts as a good internship in `MY_PROFILE` at the top of `Code.gs`.
