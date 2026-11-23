# morning-agent

A personal AI agent that runs by itself every morning on GitHub Actions:
date + Riga weather + today's RTU lessons + deadlines → a short Telegram message.

Model: **Groq** (free tier, open-source `openai/gpt-oss-120b`). Switching to Claude later only changes `llm.py`.

## How it works

```
GitHub Actions (04:23 UTC) → agent.py
   ↓ asks the model, giving it a task + tool list
   ↓ the model asks for tools → we run them → send results back   (loop)
   ↓ the model writes a short caption
   ↓ card.py draws the picture card from the same tools (plain Python, no AI → no tokens)
Telegram (photo + caption)
```

| File | What it does |
|---|---|
| `agent.py` | The agent loop: ask the model → run tools → send results back → send the message to Telegram |
| `tools.py` | The agent's tools (plain Python functions) and the descriptions shown to the model |
| `card.py` | Draws the dark, iPhone-widget style card (weather, lessons, deadline countdown) with Pillow |
| `bookmarklet/` | One-click bookmark that syncs e-studijas deadlines to the `DEADLINES_JSON` variable (see its README) |
| `llm.py` | The only place that talks to the model (Groq) |
| `.github/workflows/morning.yml` | Runs every day at 04:23 UTC (06:23 Riga in winter), or by hand |

## Setup (GitHub → Settings → Secrets and variables → Actions)

**Secrets** tab:

| Secret | Where to get it | Required |
|---|---|---|
| `GROQ_API_KEY` | console.groq.com → API Keys | ✅ |
| `TELEGRAM_BOT_TOKEN` | Telegram → @BotFather → /newbot | ✅ (without it the message only appears in the logs) |
| `TELEGRAM_CHAT_ID` | Send your bot a message, then open `https://api.telegram.org/bot<TOKEN>/getUpdates` | ✅ |
| `RTU_SEMESTER_PROGRAM_ID` | Your group's ID on nodarbibas.rtu.lv: DevTools → Network → `getSemesterProgEventList` → `semesterProgramId` | ✅ for classes |
| `DEADLINES_KEY` | A password you make up; the same one you type into the bookmarklet once | ✅ for deadlines |
| `ORTUS_ICAL_URL` | iCal link (fallback only; RTU has export disabled, so use the bookmarklet instead) | Optional |

**Variables** tab (optional):
- `MESSAGE_LANGUAGE` — e.g. `Turkish`. Default: `English`.

## Run it

GitHub → **Actions** → **Morning agent** → **Run workflow**.

Locally:

```bash
pip install -r requirements.txt
export GROQ_API_KEY=...   # Windows PowerShell: $env:GROQ_API_KEY="..."
python agent.py
```
