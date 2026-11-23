// Mimoza deadline sync. Click it on estudijas.rtu.lv while logged in.
// Reads your not-yet-submitted deadlines (the same list as the "Timeline" block)
// and saves them to the DEADLINES_JSON repository variable of morning-agent
// Locked with your DEADLINES_KEY password (AES-GCM), because variables show up in the Actions logs.
(async () => {
  const REPO = "ars1an-cod1/morning-agent", VAR = "DEADLINES_JSON", KEY = "mimozaGithubToken", PKEY = "mimozaDeadlinesKey";
  const show = (text, ok) => {
    const b = document.createElement("div");
    b.textContent = text;
    b.style.cssText = `position:fixed;top:20px;right:20px;z-index:99999;max-width:420px;padding:16px 20px;border-radius:14px;font:15px sans-serif;white-space:pre-wrap;color:#fff;background:${ok ? "#1f7a3f" : "#a32020"};box-shadow:0 6px 24px rgba(0,0,0,.3);cursor:pointer`;
    b.onclick = () => b.remove();
    document.body.appendChild(b);
    setTimeout(() => b.remove(), 12000);
  };
  try {
    if (!window.M || !M.cfg || !M.cfg.sesskey) throw new Error("Open estudijas.rtu.lv first (logged in).");

    // 1. Ask e-studijas for upcoming deadlines (uses your open session; nothing leaves the page yet)
    const now = Math.floor(Date.now() / 1000);
    const r = await fetch(`${M.cfg.wwwroot}/lib/ajax/service.php?sesskey=${M.cfg.sesskey}&info=mimoza`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify([{ index: 0, methodname: "core_calendar_get_action_events_by_timesort",
        args: { timesortfrom: now - 86400, timesortto: now + 120 * 86400, limitnum: 50, limittononsuspendedevents: true } }]),
    });
    const [res] = await r.json();
    if (res.error) throw new Error("e-studijas: " + (res.exception?.message || "error"));

    const clean = s => (s || "").replace(/\s+/g, " ")
      .replace(/ (ir pieejams|tiks slēgts|atveras|is due|closes|opens)$/i, "").replace(/\s*\(Izpildes termiņš\)$/, "").trim();
    // Course names in English: Moodle's display name (shown in English on the dashboard),
    // or the course code mapped to its English name, or the name without "(English)(1),26/27-R"
    const EN = { DE0034: "Basics of Computer Control", DE0133: "Discrete Structures of Computer Science",
      DA0101: "Physics", DE0013: "Operating Systems", DE0917: "Programming Languages",
      DE0136: "Fundamentals of Computer Simulation and Modelling", DE0278: "Numerical Methods" };
    const strip = s => (s || "").replace(/<[^>]+>/g, "").replace(/\(English\).*$/, "").replace(/,\d\d\/\d\d-[A-Z]$/, "").trim();
    const course = c => {
      const code = ((c?.shortname || "").match(/^[A-Z]{2}\d{4}/) || [])[0];
      if (code && EN[code]) return EN[code];
      const shown = strip(c?.fullnamedisplay);
      return /[āčēģīķļņšūž]/i.test(shown) ? strip(c?.fullname) : (shown || strip(c?.fullname));
    };
    const events = res.data.events.map(e => ({
      title: clean(e.activityname || e.name),
      course: course(e.course),
      due: e.timesort,
      type: e.modulename || "",
    }));

    // 2. Save them to GitHub (token only needed once; stored in this browser)
    let token = localStorage.getItem(KEY);
    if (!token) {
      token = (prompt("Paste your GitHub token (mimoza-deadlines). Only needed once.") || "").trim();
      if (!token) throw new Error("No token, nothing saved.");
    }
    const api = `https://api.github.com/repos/${REPO}/actions/variables`;
    const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" };
    // Lock the list with your password (the bot has the same password as the DEADLINES_KEY secret)
    let password = localStorage.getItem(PKEY);
    if (!password) {
      password = prompt("Type your DEADLINES_KEY password (the same as the GitHub secret). Only needed once.") || "";
      if (!password) throw new Error("No password, nothing saved.");
    }
    const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
    const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12)), iter = 200000;
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
    const aes = await crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: iter, hash: "SHA-256" }, base,
      { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
    const box = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aes,
      new TextEncoder().encode(JSON.stringify({ synced_at: now, events })));
    const value = JSON.stringify({ v: 1, iter, salt: b64(salt), iv: b64(iv), data: b64(box) });
    // Update the variable; if it does not exist yet, create it
    let save = await fetch(`${api}/${VAR}`, { method: "PATCH", headers, body: JSON.stringify({ name: VAR, value }) });
    if (save.status === 404) save = await fetch(api, { method: "POST", headers, body: JSON.stringify({ name: VAR, value }) });
    if (save.status === 401) { localStorage.removeItem(KEY); throw new Error("GitHub token is wrong or expired. Click again and paste a new one."); }
    if (save.status === 403) throw new Error("GitHub token has no 'Variables: Read and write' permission. Edit the token on GitHub and add it.");
    if (!save.ok) throw new Error("GitHub: " + save.status + " " + (await save.text()).slice(0, 200));
    localStorage.setItem(KEY, token);
    localStorage.setItem(PKEY, password);

    show(`✓ ${events.length} deadlines saved, locked with your password\n\n` +
      events.map(e => `• ${new Date(e.due * 1000).toLocaleDateString("en-GB")}  ${e.title}`).join("\n"), true);
  } catch (err) {
    show("✗ " + err.message, false);
  }
})();
