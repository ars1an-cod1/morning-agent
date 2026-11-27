/**
 * morning-agent Cloudflare Worker (free plan)
 *
 * 1. Cron trigger (every morning, exactly on time):
 *    asks GitHub to run the "Morning agent" workflow, which draws and sends the card.
 *    GitHub's own schedule was starting hours late, so the Worker now does the timing.
 * 2. Telegram webhook (always on):
 *    when Arslan writes to the bot, the Worker asks Groq and replies.
 *    Commands: /morning (send the card now), /gmail (important emails now), /reset, /help.
 *
 * Secrets (Worker → Settings → Variables and Secrets):
 *   GROQ_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, GITHUB_TOKEN, WEBHOOK_SECRET
 *   GMAIL_WEBAPP_URL, GMAIL_KEY (for /gmail: the Apps Script Web App in gmail/Code.gs)
 * Binding (Worker → Settings → Bindings → KV namespace), optional:
 *   MEMORY: keeps the last messages so the bot remembers the conversation. /reset clears it.
 */

const REPO = "ars1an-cod1/morning-agent";
const WORKFLOW = "morning.yml";
const MODEL = "openai/gpt-oss-120b";
const MEMORY_MESSAGES = 20; // last 20 messages (10 questions + 10 answers)
const MEMORY_DAYS = 7; // a conversation is forgotten after 7 days without messages

const SYSTEM_PROMPT = `You are Arslan's personal assistant on Telegram. Arslan is a Computer Systems
student at Riga Technical University (RTU) in Riga, learning software development with Python.
Answer in the language he writes in (usually Turkish). Keep answers short and clear: he prefers
concise, conceptual explanations over long texts. Plain text only, no Markdown tables.
If he asks for his class schedule or deadlines, tell him to send /morning to get today's card.
If he asks about his emails or job alerts, tell him to send /gmail.`;

const HELP = `Merhaba! 👋
• Bana istediğini yaz, cevap vereyim.
• /morning: sabah kartını şimdi gönder
• /gmail: önemli e-postalar ve iş ilanları
• /reset: konuşma hafızasını sil
• /help: bu mesaj`;

export default {
  // Telegram sends every new message here (and you can open /setup once to connect it)
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/setup") return setup(url, env);

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

async function askGroq(env, history, text) {
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.GROQ_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.5,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...history, { role: "user", content: text }],
    }),
  });
  if (!r.ok) return `⚠️ Groq hatası (${r.status}). Biraz sonra tekrar dene. (Sorun sürerse /reset yaz.)`;
  const data = await r.json();
  return (data.choices?.[0]?.message?.content || "…").trim();
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
