/**
 * morning-agent: Gmail watcher (Google Apps Script, free, runs inside your Google account)
 *
 * Every 15 minutes: looks at new inbox emails, skips payments/ads/newsletters,
 * and sends a short Telegram message for emails from real people or about jobs
 * (recruiters, interviews, applications, LinkedIn job alerts for internships).
 * Every evening at ~20:00: sends a digest of the day's important emails.
 *
 * Setup: see gmail/README.md. Script Properties needed:
 *   GROQ_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 */

const SEEN_LABEL = "morning-agent/seen"; // added to every email we looked at, so it is checked only once
const MODEL = "openai/gpt-oss-120b";
const MAX_EMAILS_PER_RUN = 15;
const BODY_CHARS = 1500; // only the start of an email is sent to Groq

// What counts as a good internship for me (used for LinkedIn job alerts)
const MY_PROFILE = `Computer Systems student at Riga Technical University (2nd of 3 years).
Skills: Python, SQL, some C, Java, Rust; interested in AI agents, data/lakehouse, backend.
Looking for: internships or junior roles. Locations: Berlin/Germany and Riga/Latvia first,
also Estonia, Lithuania, Izmir (Türkiye) or remote.`;

// Obvious noise, skipped without asking the AI (saves Groq requests)
const SKIP_SENDERS = /(no-?reply|noreply|notifications?|newsletter|news|marketing|promo|billing|invoice|receipts?|orders?|payments?|support|info)@/i;
const SKIP_WORDS = /(invoice|receipt|payment|paid|order (confirmation|#)|your order|subscription|renewal|discount|% off|sale|newsletter|unsubscribe|rēķins|maksājums|fatura|ödeme|sipariş|indirim|kampanya)/i;
const JOB_SENDERS = /(jobalerts-noreply@linkedin\.com|jobs-noreply@linkedin\.com|messages-noreply@linkedin\.com|inmail-hit-reply@linkedin\.com|@greenhouse\.io|@lever\.co|@workday|@smartrecruiters|@teamtailor|@personio)/i;

// ---------- Runs every 15 minutes ----------
function checkNewEmails() {
  const label = GmailApp.getUserLabelByName(SEEN_LABEL) || GmailApp.createLabel(SEEN_LABEL);
  const threads = GmailApp.search(`in:inbox newer_than:2d -label:${SEEN_LABEL.replace("/", "-")} -category:promotions -category:social -category:forums`, 0, MAX_EMAILS_PER_RUN);

  for (const thread of threads) {
    const msg = thread.getMessages().pop(); // newest message in the conversation
    const from = msg.getFrom();
    const subject = msg.getSubject() || "(no subject)";
    const isJobSender = JOB_SENDERS.test(from);

    let result = null;
    if (isJobSender || !(SKIP_SENDERS.test(from) || SKIP_WORDS.test(subject))) {
      result = classify(from, subject, msg.getPlainBody().slice(0, BODY_CHARS), isJobSender);
    }

    if (result && result.category !== "skip") {
      const icon = result.category === "job" ? "💼" : "📧";
      const text = `${icon} ${shortName(from)}\n${subject}\n\n${result.summary}`;
      sendTelegram(text);
      rememberForDigest(`${icon} ${shortName(from)}: ${result.summary}`);
    }
    thread.addLabel(label); // never check this email again (it stays unread for you)
  }
}

// ---------- Runs every evening ----------
function sendEveningDigest() {
  const props = PropertiesService.getScriptProperties();
  const items = JSON.parse(props.getProperty("DIGEST") || "[]");
  const text = items.length
    ? `🌙 Bugünün önemli e-postaları (${items.length})\n\n` + items.map((x) => "• " + x).join("\n")
    : "🌙 Bugün önemli bir e-posta yok.";
  sendTelegram(text);
  props.deleteProperty("DIGEST");
}

// ---------- AI: is this email worth a message? ----------
function classify(from, subject, body, isJobSender) {
  const prompt = `You filter Arslan's email. Decide the category of this email:
- "person": written by a real person to him (professor, classmate, friend, family, a recruiter writing personally)
- "job": about jobs or internships: interview invitations, application updates, recruiter messages, job alerts
- "skip": everything else (payments, receipts, ads, newsletters, automatic notifications, security codes)
${isJobSender ? `This is a job alert or ATS email. Only keep internships/junior roles that fit his profile; if none fit, use "skip".\nHis profile: ${MY_PROFILE}` : ""}
Reply ONLY with JSON: {"category": "person|job|skip", "summary": "1-2 short sentences in Turkish: who wants what, or which roles (company, city)"}

From: ${from}
Subject: ${subject}
Body:
${body}`;

  const res = UrlFetchApp.fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + getSecret("GROQ_API_KEY") },
    payload: JSON.stringify({
      model: MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }],
    }),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    console.error("Groq error " + res.getResponseCode());
    return null; // try nothing now; the email is still labelled, so no repeat spam
  }
  try {
    return JSON.parse(JSON.parse(res.getContentText()).choices[0].message.content);
  } catch (e) {
    return null;
  }
}

// ---------- Helpers ----------
function sendTelegram(text) {
  UrlFetchApp.fetch(`https://api.telegram.org/bot${getSecret("TELEGRAM_BOT_TOKEN")}/sendMessage`, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({ chat_id: getSecret("TELEGRAM_CHAT_ID"), text: text.slice(0, 4000) }),
    muteHttpExceptions: true,
  });
}

function rememberForDigest(line) {
  const props = PropertiesService.getScriptProperties();
  const items = JSON.parse(props.getProperty("DIGEST") || "[]");
  items.push(line.slice(0, 300));
  props.setProperty("DIGEST", JSON.stringify(items.slice(-40)));
}

function shortName(from) {
  return from.replace(/<.*>/, "").replace(/"/g, "").trim() || from;
}

function getSecret(name) {
  const value = PropertiesService.getScriptProperties().getProperty(name);
  if (!value) throw new Error(`Script Property ${name} is missing (Project Settings → Script Properties).`);
  return value;
}

// ---------- Run ONCE by hand to install the timers ----------
function setup() {
  ScriptApp.getProjectTriggers().forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("checkNewEmails").timeBased().everyMinutes(15).create();
  ScriptApp.newTrigger("sendEveningDigest").timeBased().everyDays(1).atHour(20).inTimezone("Europe/Riga").create();
  sendTelegram("✅ Gmail izleyici kuruldu. Önemli e-postalar ve iş ilanları buraya gelecek, akşam 20:00'de günün özeti.");
}
