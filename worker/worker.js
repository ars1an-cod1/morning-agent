/**
 * morning-agent Cloudflare Worker (free plan)
 *
 * 1. Cron trigger (every morning, exactly on time):
 *    asks GitHub to run the "Morning agent" workflow, which draws and sends the card.
 *    GitHub's own schedule was starting hours late, so the Worker now does the timing.
 * 2. Telegram webhook (always on):
 *    when Arslan writes to the bot, an AGENT answers: Groq decides which tools to use
 *    (date, weather, classes, deadlines, important emails), the Worker runs them, Groq writes the reply.
 * 3. POST /data (from the morning GitHub job): saves classes + deadlines in KV for the chat agent.
 *    Commands: /morning (send the card now), /gmail (important emails now), /reset, /help.
 *
 * Secrets (Worker → Settings → Variables and Secrets):
 *   GROQ_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, GITHUB_TOKEN, WEBHOOK_SECRET
 *   GMAIL_WEBAPP_URL, GMAIL_KEY (for /gmail: the Apps Script Web App in gmail/Code.gs)
 *   WORKER_KEY (the morning GitHub job uses it to send classes + deadlines; same value as the GitHub secret)
 * Binding (Worker → Settings → Bindings → KV namespace), optional:
 *   MEMORY: keeps the last messages (and the classes/deadlines snapshot). /reset clears the conversation.
 */

const REPO = "ars1an-cod1/morning-agent";
const WORKFLOW = "morning.yml";
const MODEL = "openai/gpt-oss-120b";
const MEMORY_MESSAGES = 20; // last 20 messages (10 questions + 10 answers)
const MEMORY_DAYS = 7; // a conversation is forgotten after 7 days without messages
const MAX_STEPS = 5; // safety limit for the agent loop

const SYSTEM_PROMPT = `You are Arslan's personal assistant on Telegram, a friendly, natural conversation partner.
Arslan is a Computer Systems student at Riga Technical University (RTU) in Riga. He builds AI agents,
learns data/platform engineering, and is looking for an internship (Berlin and Riga first).
Talk like a helpful friend: answer in the language he writes in (usually Turkish), short and clear,
plain text (no Markdown tables, no ** bold). Emojis are fine but don't overdo them.
You have tools for the current date/time, Riga weather, his RTU classes, his assignment deadlines
and today's important emails / job alerts. Use them whenever the answer depends on them
(e.g. "yarın dersim var mı?", "bu hafta neyi teslim etmeliyim?", "şemsiye lazım mı?", "önemli mail var mı?").
Never invent classes, deadlines or emails: only use what the tools return. If a tool has no data, say so.`;

const HELP = `Merhaba! 👋
• Bana istediğini yaz, cevap vereyim. Derslerini, deadline'larını, havayı ve önemli e-postalarını sorabilirsin.
• /morning: sabah kartını şimdi gönder
• /gmail: önemli e-postalar ve iş ilanları
• /reset: konuşma hafızasını sil
• /help: bu mesaj`;

export default {
  // Telegram sends every new message here (and you can open /setup once to connect it)
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/setup") return setup(url, env);

    // The morning GitHub job sends classes + deadlines here (stored privately in KV)
    if (url.pathname === "/data" && request.method === "POST") {
      if (!env.WORKER_KEY || request.headers.get("X-Worker-Key") !== env.WORKER_KEY) {
        return new Response("forbidden", { status: 403 });
      }
      if (!env.MEMORY) return new Response("no KV binding", { status: 500 });
      await env.MEMORY.put("snapshot", await request.text());
      return new Response("saved");
    }

    if (url.pathname === "/telegram" && request.method === "POST") {
      // Only Telegram knows this secret, so nobody else can talk to the Worker
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      const update = await request.json();
      // Answer Telegram right away; do the slow part (Groq) in the background
      ctx.waitUntil(handleMessage(update, env).catch((e) => console.error(e)));
      return new Response("ok");
    }

    return new Response("morning-agent worker is running");
  },

  // Cron trigger: runs at the time set in Settings → Triggers (UTC)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(startMorningCard(env));
  },
};

async function handleMessage(update, env) {
  const message = update.message;
  if (!message || !message.text) return;
  // Only answer Arslan; ignore everyone else
  if (String(message.chat.id) !== String(env.TELEGRAM_CHAT_ID)) return;

  const text = message.text.trim();
  const chatId = message.chat.id;

  if (text === "/start" || text === "/help") return sendMessage(env, chatId, HELP);

  if (text === "/reset") {
    if (env.MEMORY) await env.MEMORY.delete(memoryKey(chatId));
    return sendMessage(env, chatId, "🧹 Hafıza silindi, yeni bir konuşma başlıyor.");
  }

  if (text === "/gmail") {
    if (!env.GMAIL_WEBAPP_URL || !env.GMAIL_KEY) return sendMessage(env, chatId, "⚠️ Gmail bağlı değil (GMAIL_WEBAPP_URL / GMAIL_KEY eksik).");
    await sendMessage(env, chatId, "📬 Gmail kontrol ediliyor...");
    // The Apps Script sends the result to Telegram itself; it can take a while, so we don't wait for an answer here
    const r = await fetch(`${env.GMAIL_WEBAPP_URL}?key=${encodeURIComponent(env.GMAIL_KEY)}`).catch(() => null);
    if (r && (await r.text()).includes("forbidden")) return sendMessage(env, chatId, "⚠️ GMAIL_KEY, Apps Script'teki WEBAPP_KEY ile aynı değil.");
    return;
  }

  if (text === "/morning") {
    const ok = await startMorningCard(env);
    return sendMessage(env, chatId, ok ? "☀️ Kart hazırlanıyor, 1-2 dakika içinde gelir." : "⚠️ GitHub'a ulaşamadım, GITHUB_TOKEN'ı kontrol et.");
  }

  await sendChatAction(env, chatId); // shows "typing..." while Groq thinks
  const history = await loadMemory(env, chatId);
  const answer = await askGroq(env, history, text);
  await saveMemory(env, chatId, [...history, { role: "user", content: text }, { role: "assistant", content: answer }]);
  return sendMessage(env, chatId, answer);
}

// --- Memory (Cloudflare KV): one entry per chat with the last messages ---

function memoryKey(chatId) {
  return `chat:${chatId}`;
}

async function loadMemory(env, chatId) {
  if (!env.MEMORY) return []; // no KV binding yet: work without memory
  return (await env.MEMORY.get(memoryKey(chatId), "json")) || [];
}

async function saveMemory(env, chatId, messages) {
  if (!env.MEMORY) return;
  await env.MEMORY.put(memoryKey(chatId), JSON.stringify(messages.slice(-MEMORY_MESSAGES)), {
    expirationTtl: MEMORY_DAYS * 24 * 3600,
  });
}

// --- The chat agent: Groq picks tools, the Worker runs them, repeat until Groq writes the answer ---

const TOOLS = [
  tool("get_now", "Current date, weekday and time in Riga.", {}),
  tool("get_weather", "Riga weather forecast for one day.", {
    day_offset: { type: "integer", description: "0 = today, 1 = tomorrow, ... up to 6" },
  }),
  tool("get_classes", "Arslan's RTU classes (time, subject, type, room, lecturer) from a day for some days.", {
    day_offset: { type: "integer", description: "First day: 0 = today, 1 = tomorrow" },
    days: { type: "integer", description: "How many days (default 1, max 14)" },
  }),
  tool("get_deadlines", "Arslan's upcoming assignment/quiz deadlines that are not submitted yet.", {
    days: { type: "integer", description: "Look this many days ahead (default 14)" },
  }),
  tool("get_important_emails", "Today's important emails and job alerts (already filtered: no ads or receipts).", {}),
];

function tool(name, description, properties) {
  return { type: "function", function: { name, description, parameters: { type: "object", properties } } };
}

async function askGroq(env, history, text) {
  const messages = [{ role: "system", content: SYSTEM_PROMPT }, ...history, { role: "user", content: text }];
  const done = new Set(); // the same tool call is only run once

  for (let step = 0; step < MAX_STEPS; step++) {
    const reply = await callGroq(env, messages, TOOLS);
    if (reply.error) return reply.error;
    const calls = reply.tool_calls || [];
    if (!calls.length) return (reply.content || "…").trim();

    messages.push({ role: "assistant", content: reply.content || "", tool_calls: calls });
    for (const call of calls) {
      const key = call.function.name + call.function.arguments;
      let result;
      if (done.has(key)) {
        result = { note: "You already have this result above. Answer now." };
      } else {
        done.add(key);
        result = await runTool(env, call.function.name, safeJson(call.function.arguments));
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  // Out of steps: one last answer without tools
  messages.push({ role: "user", content: "Answer now with what you have, without tools." });
  const last = await callGroq(env, messages, null);
  return last.error || (last.content || "…").trim();
}

async function callGroq(env, messages, tools) {
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.GROQ_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, temperature: 0.5, messages, ...(tools ? { tools, tool_choice: "auto" } : {}) }),
  });
  if (!r.ok) {
    console.error("Groq error", r.status, await r.text());
    return { error: `⚠️ Groq hatası (${r.status}). Biraz sonra tekrar dene. (Sorun sürerse /reset yaz.)` };
  }
  const data = await r.json();
  return data.choices?.[0]?.message || {};
}

async function runTool(env, name, args) {
  try {
    if (name === "get_now") return nowInRiga();
    if (name === "get_weather") return await getWeather(args.day_offset || 0);
    if (name === "get_classes") return await getClasses(env, args.day_offset || 0, args.days || 1);
    if (name === "get_deadlines") return await getDeadlines(env, args.days || 14);
    if (name === "get_important_emails") return await getEmails(env);
    return { error: `unknown tool ${name}` };
  } catch (e) {
    return { error: String(e) };
  }
}

// --- Tools ---

function rigaDate(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Riga", day: "2-digit", month: "2-digit", year: "numeric" }).format(d).replaceAll("/", ".");
}

function nowInRiga() {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Riga", weekday: "long", hour: "2-digit", minute: "2-digit" }).format(new Date());
  return { date: rigaDate(0), now: parts };
}

async function getWeather(dayOffset) {
  const day = Math.min(Math.max(dayOffset, 0), 6);
  const r = await fetch(
    "https://api.open-meteo.com/v1/forecast?latitude=56.95&longitude=24.11&timezone=Europe/Riga&forecast_days=7" +
      "&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max"
  );
  const d = (await r.json()).daily;
  return {
    date: rigaDate(day),
    max_temp_c: d.temperature_2m_max[day],
    min_temp_c: d.temperature_2m_min[day],
    rain_chance_percent: d.precipitation_probability_max[day],
    wind_kmh: d.wind_speed_10m_max[day],
  };
}

async function loadSnapshot(env) {
  const snap = env.MEMORY ? await env.MEMORY.get("snapshot", "json") : null;
  return snap || { classes: [], deadlines: [], note: "No data yet: it arrives with the next morning run (/morning)." };
}

async function getClasses(env, dayOffset, days) {
  const snap = await loadSnapshot(env);
  const wanted = Array.from({ length: Math.min(Math.max(days, 1), 14) }, (_, i) => rigaDate(dayOffset + i));
  const lessons = snap.classes.filter((l) => wanted.includes(l.date));
  return { days: wanted, lessons, data_from: snap.updated_at, ...(snap.note ? { note: snap.note } : {}) };
}

async function getDeadlines(env, days) {
  const snap = await loadSnapshot(env);
  const now = Date.now() / 1000;
  const list = snap.deadlines
    .filter((d) => d.due >= now && d.due <= now + days * 86400)
    .map((d) => ({
      title: d.title,
      course: d.course,
      due: new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Riga", dateStyle: "medium", timeStyle: "short" }).format(new Date(d.due * 1000)),
      hours_left: Math.round((d.due - now) / 3600),
    }));
  return { deadlines: list, data_from: snap.updated_at, ...(snap.note ? { note: snap.note } : {}) };
}

async function getEmails(env) {
  if (!env.GMAIL_WEBAPP_URL || !env.GMAIL_KEY) return { note: "Gmail is not connected." };
  const r = await fetch(`${env.GMAIL_WEBAPP_URL}?key=${encodeURIComponent(env.GMAIL_KEY)}&mode=list`);
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch {
    return { note: "Gmail did not return a list (update the Apps Script Web App to the new version)." };
  }
}

function safeJson(s) {
  try {
    return JSON.parse(s || "{}");
  } catch {
    return {};
  }
}

// Asks GitHub to run the morning workflow now (same as pressing "Run workflow")
async function startMorningCard(env) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "morning-agent-worker", // GitHub requires a User-Agent
    },
    body: JSON.stringify({ ref: "main" }),
  });
  if (!r.ok) console.error("GitHub dispatch failed", r.status, await r.text());
  return r.ok;
}

async function sendMessage(env, chatId, text) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4096) }), // Telegram's max length
  });
}

async function sendChatAction(env, chatId) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action: "typing" }),
  });
}

// Open https://<worker>/setup?key=<WEBHOOK_SECRET> once: tells Telegram to send messages to this Worker
async function setup(url, env) {
  if (url.searchParams.get("key") !== env.WEBHOOK_SECRET) return new Response("wrong key", { status: 403 });
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: `${url.origin}/telegram`,
      secret_token: env.WEBHOOK_SECRET,
      allowed_updates: ["message"],
    }),
  });
  const data = await r.json();
  return new Response(data.ok ? "✅ Telegram is connected to this Worker." : `❌ ${data.description}`, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
