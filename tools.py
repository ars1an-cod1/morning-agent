"""
Tools the agent can use = ordinary Python functions.

Each tool has two parts:
1. The function itself (the code that does the work)
2. Its description in TOOLS (tells the model what the tool does and which inputs it takes)

To add a tool: write the function, add its description to TOOLS, and register it in FUNCTIONS.
"""

import json
import os
import re
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import requests
from icalendar import Calendar

RIGA = ZoneInfo("Europe/Riga")


def today() -> dict:
    """Today's date, weekday and time (Riga time)."""
    now = datetime.now(RIGA)
    return {"date": now.strftime("%d.%m.%Y"), "weekday": now.strftime("%A"), "time": now.strftime("%H:%M")}


def weather() -> dict:
    """Today's weather in Riga (Open-Meteo: free, no API key needed)."""
    r = requests.get(
        "https://api.open-meteo.com/v1/forecast",
        params={
            "latitude": 56.95,
            "longitude": 24.11,
            "daily": "temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max,weather_code",
            "timezone": "Europe/Riga",
            "forecast_days": 1,
        },
        timeout=20,
    )
    r.raise_for_status()
    d = r.json()["daily"]
    return {
        "max_temp_c": d["temperature_2m_max"][0],
        "min_temp_c": d["temperature_2m_min"][0],
        "rain_chance_percent": d["precipitation_probability_max"][0],
        "wind_kmh": d["wind_speed_10m_max"][0],
        "weather_code": d["weather_code"][0],  # WMO code: 0 = clear, 61-65 = rain, 71-75 = snow ...
    }


RTU_SCHEDULE_URL = "https://nodarbibas.rtu.lv/getSemesterProgEventList"


def classes(days_ahead: int = 0) -> dict:
    """
    Arslan's lessons from the public RTU schedule (nodarbibas.rtu.lv) for today (+ days_ahead days).
    The group is identified by the RTU_SEMESTER_PROGRAM_ID secret
    (find it in DevTools → Network → getSemesterProgEventList → semesterProgramId).
    """
    program_id = os.environ.get("RTU_SEMESTER_PROGRAM_ID")
    if not program_id:
        return {"status": "Class schedule is not connected yet (no RTU_SEMESTER_PROGRAM_ID secret).", "lessons": []}
    today_date = datetime.now(RIGA).date()
    last_day = today_date + timedelta(days=days_ahead)

    events = []
    # The site returns one month per request; fetch every month the range touches.
    months = {(today_date.year, today_date.month), (last_day.year, last_day.month)}
    for year, month in sorted(months):
        r = requests.post(
            RTU_SCHEDULE_URL,
            data={"semesterProgramId": program_id, "year": year, "month": month},
            headers={"X-Requested-With": "XMLHttpRequest", "User-Agent": "Mozilla/5.0 (morning-agent)"},
            timeout=30,
        )
        r.raise_for_status()
        events.extend(r.json())

    return {"lessons": parse_schedule(events, today_date, last_day)}


def _event_day(e: dict) -> date | None:
    """Finds the event's date. RTU sends it as a millisecond timestamp."""
    value = e.get("eventDate")
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value / 1000, RIGA).date()
    if isinstance(value, str):
        try:
            return date.fromisoformat(value[:10])
        except ValueError:
            return None
    return None


def _clock(t: dict | None) -> str:
    return f"{t.get('hour', 0):02d}:{t.get('minute', 0):02d}" if isinstance(t, dict) else ""


LESSON_KINDS = {"lect": "Lecture", "lab": "Lab", "pr": "Practice", "prac": "Practice", "pract": "Practice", "exam": "Exam"}
# One or more type words at the start, e.g. "Lect. ", "Lect, Pr. ", "Lab, Pr. "
_KIND_PREFIX = re.compile(r"^(?:(?:Lect|Lab|Pract|Prac|Pr|Exam)(?:\.\s*,?\s*|\s*,\s*))+", re.IGNORECASE)
# Lecturer names at the end, e.g. ", Ē.Masaļskis" or ", M.Biskars, P.Liepiņš"
_LECTURER_SUFFIX = re.compile(r"(?:,\s*\w{1,3}\.\s?[\w-]+)+\s*$")


def split_subject(raw: str, lecturer: str = "") -> tuple[str, str]:
    """
    RTU names look like "Lect, Pr. Basics of Computer Control, A.Supoņenkovs".
    Returns (kind, clean name): ("Lecture + Practice", "Basics of Computer Control").
    """
    raw = (raw or "").strip()
    kinds = []
    m = _KIND_PREFIX.match(raw)
    if m:
        for word in re.findall(r"[A-Za-z]+", m.group(0)):
            kind = LESSON_KINDS.get(word.lower())
            if kind and kind not in kinds:
                kinds.append(kind)
        raw = raw[m.end():]
    if lecturer and raw.endswith(lecturer):
        raw = raw[: -len(lecturer)]
    raw = _LECTURER_SUFFIX.sub("", raw).strip(" ,")
    return " + ".join(kinds) or "Class", raw


def parse_schedule(events: list[dict], first_day: date, last_day: date) -> list[dict]:
    """Keeps lessons between first_day and last_day and turns them into short, readable records."""
    lessons = []
    for e in events:
        day = _event_day(e)
        if day is None or not (first_day <= day <= last_day):
            continue
        # RTU sends both Latvian and English (…En) versions; prefer English
        lecturer = e.get("lecturerInfoTextEn") or e.get("lecturerInfoText") or ""
        kind, subject = split_subject(e.get("eventTempNameEn") or e.get("eventTempName") or "", lecturer)
        lessons.append(
            {
                "date": day.strftime("%d.%m.%Y"),
                "start": _clock(e.get("customStart")),
                "end": _clock(e.get("customEnd")),
                "type": kind,
                "subject": subject,
                "room": e.get("roomInfoTextEn") or e.get("roomInfoText") or "",
                "lecturer": lecturer,
            }
        )
    return sorted(lessons, key=lambda x: (x["date"][6:] + x["date"][3:5] + x["date"][:2], x["start"]))


STALE_AFTER_DAYS = 14  # remind Arslan to click the bookmarklet again after this


def deadlines(days_ahead: int = 7) -> dict:
    """
    Upcoming deadlines (only the ones not submitted yet).
    Source 1: the DEADLINES_JSON repository variable, saved by the e-studijas bookmarklet
              (see bookmarklet/README.md). It is encrypted with the DEADLINES_KEY password,
              because variables appear in plain text in the Actions logs.
    Source 2 (fallback): an iCal link in the ORTUS_ICAL_URL secret.
    """
    saved = os.environ.get("DEADLINES_JSON")
    if saved:
        try:
            text = decrypt_deadlines(saved, os.environ.get("DEADLINES_KEY", ""))
        except Exception:  # noqa: BLE001 - wrong password or damaged data
            return {"status": "Could not unlock the saved deadlines (check the DEADLINES_KEY secret)."}
        return read_saved_deadlines(text, days_ahead)

    url = os.environ.get("ORTUS_ICAL_URL")
    if not url:
        return {"status": "Deadlines are not connected yet (no bookmarklet sync and no ORTUS_ICAL_URL)."}

    r = requests.get(url, timeout=30)
    r.raise_for_status()
    return {"events": parse_calendar(r.content, days_ahead)}


def decrypt_deadlines(saved: str, password: str) -> str:
    """
    Unlocks what the bookmarklet saved. The bookmarklet locks it with AES-GCM; the key comes
    from the password via PBKDF2 (the same steps as in bookmarklet/sync.js, in reverse).
    Older, unlocked saves (plain JSON) are returned as they are.
    """
    data = json.loads(saved)
    if "events" in data:  # old format, not encrypted
        return saved
    from base64 import b64decode

    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

    salt, iv, box = (b64decode(data[k]) for k in ("salt", "iv", "data"))
    key = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=data["iter"]).derive(password.encode())
    return AESGCM(key).decrypt(iv, box, None).decode("utf-8")


def _course_name(name: str) -> str:
    """'310826_XQM Physics II International 2026 GR' → 'Physics II International 2026 GR'"""
    return re.sub(r"^\d+_[A-Z]+\s+", "", name or "").strip()


def read_saved_deadlines(text: str, days_ahead: int, now: datetime | None = None) -> dict:
    """Reads what the bookmarklet saved and keeps deadlines between now and now + days_ahead."""
    now = now or datetime.now(RIGA)
    data = json.loads(text)
    last_day = now.date() + timedelta(days=days_ahead)

    events = []
    for e in data.get("events", []):
        due = datetime.fromtimestamp(e["due"], RIGA)
        if now <= due and due.date() <= last_day:
            events.append(
                {
                    "title": e.get("title", ""),
                    "course": _course_name(e.get("course", "")),
                    "date": due.strftime("%d.%m.%Y") + ("" if due.strftime("%H:%M") == "00:00" else due.strftime(" %H:%M")),
                    "days_left": (due.date() - now.date()).days,
                }
            )
    events.sort(key=lambda x: x["days_left"])

    result = {"events": events}
    synced = datetime.fromtimestamp(data.get("synced_at", 0), RIGA)
    days_since_sync = (now.date() - synced.date()).days
    result["synced_days_ago"] = days_since_sync
    if days_since_sync > STALE_AFTER_DAYS:
        result["note"] = f"Deadlines were last synced {days_since_sync} days ago. Click the bookmarklet on e-studijas."
    return result


def parse_calendar(ics_content: bytes, days_ahead: int, today_date: date | None = None) -> list[dict]:
    """Extracts events between today and today + days_ahead from an iCal file, sorted by date."""
    today_date = today_date or datetime.now(RIGA).date()
    last_day = today_date + timedelta(days=days_ahead)
    events = []
    for e in Calendar.from_ical(ics_content).walk("VEVENT"):
        start = e.get("DTSTART")
        if start is None:
            continue
        when = start.dt
        if isinstance(when, datetime):
            day = when.astimezone(RIGA).date() if when.tzinfo else when.date()
        else:
            day = when
        if today_date <= day <= last_day:
            events.append(
                {
                    "title": str(e.get("SUMMARY", "")),
                    "course": str(e.get("CATEGORIES").cats[0]) if e.get("CATEGORIES") else "",
                    "date": day.strftime("%d.%m.%Y"),
                    "days_left": (day - today_date).days,
                }
            )
    return sorted(events, key=lambda x: x["days_left"])


# --- Tool descriptions shown to the model (OpenAI/Groq format) ---
TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "today",
            "description": "Returns today's date, weekday and current time (Riga).",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "weather",
            "description": "Returns today's weather in Riga: temperature, chance of rain, wind.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "classes",
            "description": "Returns Arslan's RTU lessons (time, subject, room, lecturer) for today, or for the next days with days_ahead.",
            "parameters": {
                "type": "object",
                "properties": {"days_ahead": {"type": "integer", "description": "0 = only today (default), 1 = today and tomorrow, ..."}},
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "deadlines",
            "description": "Returns Arslan's upcoming, not yet submitted assignment/quiz deadlines from RTU e-studijas. If it includes a 'note', mention it.",
            "parameters": {
                "type": "object",
                "properties": {"days_ahead": {"type": "integer", "description": "How many days ahead to look (default 7)."}},
            },
        },
    },
]

# Tool name → function to run
FUNCTIONS = {"today": today, "weather": weather, "classes": classes, "deadlines": deadlines}
