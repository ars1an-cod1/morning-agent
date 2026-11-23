"""
Draws the morning card: a dark, iPhone-widget style image with
weather, today's lessons and deadline countdowns.

No AI here: Python draws the picture from the tool results, so it costs no Groq tokens.
"""

import io
from pathlib import Path

import matplotlib
from PIL import Image, ImageDraw, ImageFont

# --- Look & feel (iOS dark mode colors) ---
BG = "#000000"
TILE = "#1C1C1E"
TILE_2 = "#2C2C2E"
WHITE = "#FFFFFF"
GRAY = "#8E8E93"
BLUE, GREEN, ORANGE, RED, YELLOW, PURPLE, CYAN = (
    "#0A84FF", "#30D158", "#FF9F0A", "#FF453A", "#FFD60A", "#BF5AF2", "#64D2FF",
)

WIDTH = 1080   # final image width in pixels
SCALE = 2      # we draw 2x bigger, then shrink: gives smooth edges
PAD = 40       # space around and between tiles
RADIUS = 44    # tile corner roundness

# DejaVu fonts ship with matplotlib, so they exist on every machine (also GitHub Actions)
_FONT_DIR = Path(matplotlib.get_data_path()) / "fonts" / "ttf"


def _font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    name = "DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf"
    return ImageFont.truetype(str(_FONT_DIR / name), size * SCALE)


class Canvas:
    """Small helper so the drawing code can use normal (1x) coordinates."""

    def __init__(self, height: int):
        self.img = Image.new("RGB", (WIDTH * SCALE, height * SCALE), BG)
        self.d = ImageDraw.Draw(self.img)

    def box(self, x, y, w, h, fill=TILE, r=RADIUS):
        self.d.rounded_rectangle(_s(x, y, x + w, y + h), r * SCALE, fill=fill)

    def text(self, x, y, s, size, color=WHITE, bold=False, anchor="la"):
        self.d.text(_s(x, y), s, font=_font(size, bold), fill=color, anchor=anchor)

    def width_of(self, s, size, bold=False) -> float:
        return self.d.textlength(s, font=_font(size, bold)) / SCALE

    def fit(self, s, size, max_w, bold=False) -> str:
        """Cuts text with '…' so it fits into max_w pixels."""
        if self.width_of(s, size, bold) <= max_w:
            return s
        while s and self.width_of(s + "…", size, bold) > max_w:
            s = s[:-1]
        return s.rstrip() + "…"

    def png(self) -> bytes:
        w, h = self.img.size
        out = self.img.resize((w // SCALE, h // SCALE), Image.LANCZOS)
        buf = io.BytesIO()
        out.save(buf, "PNG", optimize=True)
        return buf.getvalue()


def _s(*v):
    return [round(n * SCALE) for n in v]


# --- Little icons, drawn from simple shapes ---

def _sun(c: Canvas, cx, cy, r, color=YELLOW):
    import math
    for i in range(8):
        a = i * math.pi / 4
        x1, y1 = cx + math.cos(a) * r * 1.35, cy + math.sin(a) * r * 1.35
        x2, y2 = cx + math.cos(a) * r * 1.75, cy + math.sin(a) * r * 1.75
        c.d.line(_s(x1, y1, x2, y2), fill=color, width=round(r * 0.22 * SCALE))
    c.d.ellipse(_s(cx - r, cy - r, cx + r, cy + r), fill=color)


def _cloud(c: Canvas, cx, cy, r, color="#D1D1D6"):
    c.d.ellipse(_s(cx - r * 1.6, cy - r * 0.2, cx - r * 0.2, cy + r * 1.0), fill=color)
    c.d.ellipse(_s(cx - r * 0.9, cy - r * 1.0, cx + r * 0.7, cy + r * 0.6), fill=color)
    c.d.ellipse(_s(cx + r * 0.1, cy - r * 0.5, cx + r * 1.5, cy + r * 0.9), fill=color)
    c.d.rounded_rectangle(_s(cx - r * 1.1, cy + r * 0.1, cx + r * 1.0, cy + r * 1.0), round(r * 0.4 * SCALE), fill=color)


def _drop(c: Canvas, cx, cy, r, color=CYAN):
    c.d.polygon(_s(cx, cy - r * 1.6, cx - r * 0.85, cy - r * 0.1, cx + r * 0.85, cy - r * 0.1), fill=color)
    c.d.ellipse(_s(cx - r, cy - r, cx + r, cy + r), fill=color)


def _snow(c: Canvas, cx, cy, r, color=WHITE):
    import math
    for i in range(3):
        a = i * math.pi / 3
        dx, dy = math.cos(a) * r, math.sin(a) * r
        c.d.line(_s(cx - dx, cy - dy, cx + dx, cy + dy), fill=color, width=round(r * 0.25 * SCALE))


def _bolt(c: Canvas, cx, cy, r, color=YELLOW):
    c.d.polygon(_s(cx + r * 0.2, cy - r, cx - r * 0.6, cy + r * 0.15, cx - r * 0.05, cy + r * 0.15,
                   cx - r * 0.3, cy + r, cx + r * 0.6, cy - r * 0.2, cx + r * 0.05, cy - r * 0.2), fill=color)


def _wind(c: Canvas, x, y, w, color=GRAY):
    for i, k in enumerate((1.0, 0.7, 0.85)):
        yy = y + i * w * 0.32
        c.d.line(_s(x, yy, x + w * k, yy), fill=color, width=round(w * 0.11 * SCALE))


def _weather_icon(c: Canvas, cx, cy, code: int | None):
    """WMO weather code (Open-Meteo) → icon."""
    code = code if isinstance(code, int) else 3
    if code <= 1:
        _sun(c, cx, cy, 36)
    elif code <= 3 or code in (45, 48):
        if code == 2:
            _sun(c, cx + 26, cy - 22, 24)
        _cloud(c, cx - 6, cy + 4, 38)
    elif code in (71, 73, 75, 77, 85, 86):
        _cloud(c, cx, cy - 10, 36)
        for dx in (-30, 0, 30):
            _snow(c, cx + dx, cy + 52, 11)
    elif code >= 95:
        _cloud(c, cx, cy - 10, 36, "#8E8E93")
        _bolt(c, cx + 4, cy + 50, 24)
    else:  # drizzle / rain / showers
        _cloud(c, cx, cy - 10, 36, "#AEAEB2")
        for dx in (-30, 0, 30):
            _drop(c, cx + dx, cy + 56, 8)


def _dot(c: Canvas, cx, cy, r, color):
    c.d.ellipse(_s(cx - r, cy - r, cx + r, cy + r), fill=color)


# --- Helpers for the data ---

LESSON_TYPES = [  # (prefix RTU uses, short label, color)
    ("Lect.", "LECTURE", BLUE),
    ("Lab.", "LAB", GREEN),
    ("Pr.", "PRACTICE", ORANGE),
    ("Prac.", "PRACTICE", ORANGE),
    ("Pract.", "PRACTICE", ORANGE),
    ("Exam", "EXAM", RED),
]


def _lesson_type(subject: str):
    for prefix, label, color in LESSON_TYPES:
        if subject.startswith(prefix):
            return label, color, subject[len(prefix):].strip()
    return "CLASS", PURPLE, subject


def _urgency(days_left: int):
    if days_left <= 1:
        return RED
    if days_left <= 3:
        return ORANGE
    return GREEN


def _days_text(days_left: int) -> str:
    return {0: "today", 1: "tomorrow"}.get(days_left, f"in {days_left} days")


# --- The card ---

def make_card(today: dict, weather: dict, lessons: list[dict], deadlines: dict) -> bytes:
    """
    today     = result of tools.today()
    weather   = result of tools.weather()
    lessons   = list from tools.classes()["lessons"]
    deadlines = result of tools.deadlines()  ({"events": [...]} or {"status": "..."})
    Returns a PNG image as bytes.
    """
    events = deadlines.get("events") if isinstance(deadlines, dict) else None
    connected = events is not None
    events = events or []
    shown_events = events[:5]

    inner = WIDTH - 2 * PAD
    half = (inner - PAD) // 2
    row_h = 112
    lessons_h = 120 + max(len(lessons), 1) * row_h
    deadlines_h = 120 + max(len(shown_events), 1) * 96
    height = PAD + 150 + 400 + PAD + lessons_h + PAD + deadlines_h + PAD

    c = Canvas(height)
    x0 = PAD

    # Header: weekday + date
    weekday = str(today.get("weekday", "")).upper()
    c.text(x0 + 8, PAD + 6, weekday, 30, RED, bold=True)
    c.text(x0 + 8, PAD + 46, _pretty_date(today.get("date", "")), 64, WHITE, bold=True)
    y = PAD + 150

    # Tile 1: weather
    c.box(x0, y, half, 400)
    c.text(x0 + 36, y + 34, "RIGA", 24, GRAY, bold=True)
    _weather_icon(c, x0 + half - 100, y + 92, weather.get("weather_code"))
    tmax, tmin = weather.get("max_temp_c"), weather.get("min_temp_c")
    c.text(x0 + 32, y + 150, f"{_round(tmax)}°", 110, WHITE, bold=True)
    c.text(x0 + 38, y + 285, f"↓{_round(tmin)}°   ↑{_round(tmax)}°", 30, GRAY)
    rain = weather.get("rain_chance_percent")
    _drop(c, x0 + 50, y + 352, 10)
    c.text(x0 + 72, y + 336, f"{rain if rain is not None else '–'}%", 30, CYAN, bold=True)
    _wind(c, x0 + 200, y + 342, 34)
    c.text(x0 + 246, y + 336, f"{_round(weather.get('wind_kmh'))} km/h", 30, GRAY)

    # Tile 2: next deadline countdown
    x1 = x0 + half + PAD
    c.box(x1, y, half, 400)
    c.text(x1 + 36, y + 34, "NEXT DEADLINE", 24, GRAY, bold=True)
    if events:
        nxt = events[0]
        color = _urgency(nxt["days_left"])
        big = "!" if nxt["days_left"] == 0 else str(nxt["days_left"])
        c.text(x1 + 32, y + 80, big, 130, color, bold=True)
        unit = "TODAY" if nxt["days_left"] == 0 else ("DAY" if nxt["days_left"] == 1 else "DAYS")
        c.text(x1 + 40 + c.width_of(big, 130, True), y + 170, unit, 32, color, bold=True)
        c.text(x1 + 36, y + 260, c.fit(nxt.get("title", ""), 30, half - 72, True), 30, WHITE, bold=True)
        c.text(x1 + 36, y + 305, c.fit(nxt.get("course", ""), 26, half - 72), 26, GRAY)
        c.text(x1 + 36, y + 345, nxt.get("date", ""), 26, GRAY)
    else:
        c.text(x1 + 32, y + 100, "—", 110, TILE_2, bold=True)
        msg = "Nothing this week" if connected else "ORTUS not connected"
        c.text(x1 + 36, y + 290, msg, 30, WHITE if connected else GRAY, bold=connected)
    y += 400 + PAD

    # Tile 3: today's lessons (timeline)
    c.box(x0, y, inner, lessons_h)
    c.text(x0 + 36, y + 36, "TODAY'S CLASSES", 24, GRAY, bold=True)
    if lessons:
        c.text(x0 + inner - 36, y + 36, str(len(lessons)), 24, GRAY, bold=True, anchor="ra")
    ry = y + 96
    if not lessons:
        c.text(x0 + 36, ry + 10, "Free day — no classes", 36, GREEN, bold=True)
    for lesson in lessons:
        label, color, name = _lesson_type(lesson.get("subject", ""))
        c.box(x0 + 36, ry + 4, 8, row_h - 30, fill=color, r=4)
        c.text(x0 + 66, ry + 2, lesson.get("start", ""), 32, WHITE, bold=True)
        c.text(x0 + 66, ry + 44, lesson.get("end", ""), 26, GRAY)
        tx = x0 + 210
        tag_w = c.width_of(label, 20, True) + 24
        c.box(tx, ry + 2, tag_w, 34, fill=TILE_2, r=10)
        c.text(tx + 12, ry + 8, label, 20, color, bold=True)
        c.text(tx + tag_w + 14, ry + 2, c.fit(name, 30, inner - 210 - tag_w - 50, True), 30, WHITE, bold=True)
        info = "  ·  ".join(p for p in (lesson.get("room", ""), lesson.get("lecturer", "")) if p)
        c.text(tx, ry + 46, c.fit(info, 26, inner - 210 - 36), 26, GRAY)
        ry += row_h
    y += lessons_h + PAD

    # Tile 4: deadline list
    c.box(x0, y, inner, deadlines_h)
    c.text(x0 + 36, y + 36, "UPCOMING DEADLINES", 24, GRAY, bold=True)
    ry = y + 96
    if not connected:
        c.text(x0 + 36, ry + 10, "Connect ORTUS calendar to see deadlines", 30, GRAY)
    elif not shown_events:
        c.text(x0 + 36, ry + 10, "No deadlines in the next 7 days", 32, GREEN, bold=True)
    for ev in shown_events:
        color = _urgency(ev["days_left"])
        pill = _days_text(ev["days_left"])
        pill_w = max(c.width_of(pill, 24, True) + 32, 130)
        c.box(x0 + 36, ry, pill_w, 46, fill=color, r=23)
        c.text(x0 + 36 + pill_w / 2, ry + 23, pill, 24, "#000000", bold=True, anchor="mm")
        tx = x0 + 36 + pill_w + 24
        c.text(tx, ry - 2, c.fit(ev.get("title", ""), 30, inner - (tx - x0) - 36, True), 30, WHITE, bold=True)
        sub = "  ·  ".join(p for p in (ev.get("course", ""), ev.get("date", "")) if p)
        c.text(tx, ry + 38, c.fit(sub, 24, inner - (tx - x0) - 36), 24, GRAY)
        ry += 96

    return c.png()


def _round(v):
    return "–" if v is None else round(v)


def _pretty_date(d: str) -> str:
    """'23.11.2026' → '23 November'"""
    months = ["January", "February", "March", "April", "May", "June", "July",
              "August", "September", "October", "November", "December"]
    try:
        day, month, _ = d.split(".")
        return f"{int(day)} {months[int(month) - 1]}"
    except (ValueError, IndexError):
        return d
