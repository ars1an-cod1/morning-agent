"""
Mimoza morning agent.

The agent loop:
  1. Give the model its task and the list of tools.
  2. The model either writes an answer (done) or asks to call a tool.
  3. We run the tool and send the result back to the model.
  4. Repeat steps 2-3 until the model is done.
Then Python draws a picture card (card.py, no AI) and sends it to Telegram
with the model's short message as the caption.
"""

import json
import os
from datetime import datetime

import requests

from card import make_card
from llm import ask_llm
from tools import FUNCTIONS, TOOLS, classes, deadlines, today, weather
from tools import RIGA, _course_name, decrypt_deadlines

MAX_STEPS = 8  # safety limit so the loop can never run forever
LANGUAGE = os.environ.get("MESSAGE_LANGUAGE", "English")  # language of the morning message

SYSTEM_PROMPT = f"""You are Arslan's personal morning assistant. Arslan studies Computer Systems
at Riga Technical University (RTU). Every morning he gets a picture card that already shows
the date, the weather, today's lessons and upcoming deadlines. You write the short caption under it.

Use your tools to gather: today's date, the weather, today's lessons, and upcoming assignment/exam deadlines.
Then write the caption in {LANGUAGE}, at most 3 short lines:
- A friendly greeting
- The ONE most important thing today: e.g. a deadline due today/tomorrow, the first lesson's time,
  a free day, or an umbrella if rain is likely
- A short study tip or a bit of motivation

Do not list all lessons or deadlines (the card shows them). Never make anything up:
only use information returned by the tools. Plain text only (no Markdown like ** or #), emojis are fine."""


def run_tool(name: str, arguments: str | None) -> str:
    """Runs the tool the model asked for. On error, tells the model instead of crashing."""
    try:
        function = FUNCTIONS[name]
        result = function(**json.loads(arguments or "{}"))
    except Exception as error:  # noqa: BLE001 - we want to report any error back to the model
        result = {"error": f"{type(error).__name__}: {error}"}
    return json.dumps(result, ensure_ascii=False)


def run(task: str = "Prepare today's morning message.") -> str:
    messages = [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": task}]
    done_calls = set()  # (tool, arguments) already run: the model sometimes asks for the same tool again and again

    for step in range(1, MAX_STEPS + 1):
        reply = ask_llm(messages, TOOLS)
        tool_calls = reply.get("tool_calls") or []

        if not tool_calls:  # the model did not ask for a tool → it is done
            return (reply.get("content") or "").strip()

        messages.append({"role": "assistant", "content": reply.get("content") or "", "tool_calls": tool_calls})
        for call in tool_calls:
            name, arguments = call["function"]["name"], call["function"].get("arguments")
            print(f"[step {step}] tool: {name}({arguments or ''})")
            key = (name, json.dumps(json.loads(arguments or "{}"), sort_keys=True))
            if key in done_calls:
                result = json.dumps({"note": "You already have this result above. Do not call it again; write the message now."})
            else:
                done_calls.add(key)
                result = run_tool(name, arguments)
            messages.append({"role": "tool", "tool_call_id": call["id"], "content": result})

    # Out of steps: ask once more WITHOUT tools, so the model has to write the message with what it has
    print("Step limit reached, asking for the final message without tools.")
    messages.append({"role": "user", "content": "Stop using tools. Write the caption now with the information you have."})
    return (ask_llm(messages, []).get("content") or "").strip() or "Good morning! Have a great day. ☀️"


def _safe(function, *args, fallback=None):
    """Runs a tool for the card; if it fails, the card just shows that part as empty."""
    try:
        return function(*args)
    except Exception as error:  # noqa: BLE001
        print(f"Card data error in {function.__name__}: {error}")
        return fallback if fallback is not None else {}


def build_card() -> bytes:
    """Collects the data with the same tools (no AI) and draws the picture."""
    return make_card(
        today=_safe(today),
        weather=_safe(weather),
        lessons=_safe(classes, 0, fallback={"lessons": []}).get("lessons", []),
        deadlines=_safe(deadlines, 7, fallback={"status": "error"}),
    )


def send_to_telegram(text: str, image: bytes | None = None) -> None:
    token, chat_id = os.environ.get("TELEGRAM_BOT_TOKEN"), os.environ.get("TELEGRAM_CHAT_ID")
    if not token or not chat_id:
        print("No Telegram credentials, so the message is only shown here.")
        return
    api = f"https://api.telegram.org/bot{token}"
    if image:  # picture + caption (Telegram allows max 1024 characters in a caption)
        r = requests.post(
            f"{api}/sendPhoto",
            data={"chat_id": chat_id, "caption": text[:1024]},
            files={"photo": ("morning.png", image, "image/png")},
            timeout=30,
        )
    else:
        r = requests.post(f"{api}/sendMessage", json={"chat_id": chat_id, "text": text}, timeout=20)
    if not r.ok:  # Telegram explains the problem, e.g. "chat not found" (safe to print, no secrets)
        raise RuntimeError(f"Telegram error {r.status_code}: {r.json().get('description', r.text)}")
    print("Sent to Telegram" + (" (with card)." if image else "."))


def chat_snapshot() -> dict:
    """Classes for the next 2 weeks + upcoming deadlines, so the Telegram chat agent can answer questions."""
    snapshot = {
        "updated_at": datetime.now(RIGA).isoformat(timespec="minutes"),
        "classes": _safe(classes, 13, fallback={"lessons": []}).get("lessons", []),
        "deadlines": [],
    }
    saved = os.environ.get("DEADLINES_JSON")
    if saved:
        try:
            events = json.loads(decrypt_deadlines(saved, os.environ.get("DEADLINES_KEY", ""))).get("events", [])
            now = datetime.now(RIGA).timestamp()
            snapshot["deadlines"] = [
                {"title": e.get("title", ""), "course": _course_name(e.get("course", "")), "due": e["due"]}
                for e in events
                if e["due"] >= now
            ]
        except Exception as error:  # noqa: BLE001
            print(f"Could not read deadlines for the chat: {type(error).__name__}")
    return snapshot


def push_to_worker() -> None:
    """Sends the snapshot to the Cloudflare Worker (stored privately in its KV). Optional."""
    url, key = os.environ.get("WORKER_URL"), os.environ.get("WORKER_KEY")
    if not url or not key:
        return
    r = requests.post(f"{url.rstrip('/')}/data", json=chat_snapshot(), headers={"X-Worker-Key": key}, timeout=30)
    print(f"Chat data sent to the Worker ({r.status_code}).")


if __name__ == "__main__":
    message = run()
    if os.environ.get("GITHUB_ACTIONS"):  # Actions logs are public in a public repo: don't show the content
        print(f"Morning message ready ({len(message)} characters).")
    else:
        print("\n--- Morning message ---\n" + message + "\n")

    try:
        card = build_card()
        with open("morning.png", "wb") as f:  # also saved, so you can look at it when running locally
            f.write(card)
    except Exception as error:  # noqa: BLE001 - if drawing fails, still send the text
        print(f"Could not draw the card: {error}")
        card = None

    send_to_telegram(message, card)

    try:
        push_to_worker()
    except Exception as error:  # noqa: BLE001 - the card is already sent; the chat data is a bonus
        print(f"Could not send chat data to the Worker: {type(error).__name__}")
