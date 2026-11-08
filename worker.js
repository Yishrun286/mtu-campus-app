/* ============================================================
   MTU Verify — Cloudflare Worker
   ------------------------------------------------------------
   Routes
     POST /send     Proxy for Telegram sendPhoto. Holds the bot token
                    server-side so it never appears in browser JS.
     POST /webhook  Telegram webhook. Receives callback_query when an
                    admin taps ✅ Approve / ❌ Reject, then:
                     1. checks the click came from your admin group
                     2. updates Firestore verifications/{requestId}
                     3. edits the Telegram message (caption + removes buttons)

   Secrets / vars (wrangler secret put NAME)
     BOT_TOKEN             secret  – from @BotFather (use a NEW token)
     WEBHOOK_SECRET        secret  – any random string (A-Z a-z 0-9 _ -)
     FIREBASE_PROJECT_ID    var     – e.g. "mtu-campus"
     FIREBASE_CLIENT_EMAIL  secret  – service account "client_email"
     FIREBASE_PRIVATE_KEY   secret  – service account "private_key"
     FIREBASE_SERVICE_ACCOUNT secret – OPTIONAL: the whole service account
                                      JSON (used instead of the two above)
     ADMIN_CHAT_ID          var     – e.g. "-1003635976490"
     ADMIN_USER_IDS         var     – optional, comma-separated Telegram
                                      user IDs allowed to approve. Empty =
                                      any member of the admin group.
     ALLOWED_ORIGIN         var     – your app origin for CORS, e.g.
                                      "https://mtu-campus.pages.dev" (or "*")
   ============================================================ */


export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      // Handle CORS preflight requests
      if (request.method === "OPTIONS") {
        return cors(env, new Response(null, { status: 204 }), request);
      }

      let response;

      if (url.pathname === "/send" && request.method === "POST") {
        response = await handleSend(request, env);

      } else if (url.pathname === "/webhook" && request.method === "POST") {
        response = await handleWebhook(request, env);

      } else if (url.pathname === "/" && request.method === "GET") {
        response = new Response("MTU Verify worker is running", {
          status: 200
        });

      } else {
        response = json(
          { ok: false, error: "Route not found" },
          404
        );
      }

      return cors(env, response, request);

    } catch (error) {
      console.error("Worker error:", error);

      return cors(env, json(
        { ok: false, error: "Internal server error" },
        500
      ), request);
    }
  }
};


// ---------------- CORS ----------------

function cors(env, response, request) {
  const headers = new Headers(response.headers);
  const allowed = (env.ALLOWED_ORIGIN || "*").split(",").map((s) => s.trim());
  const origin = request.headers.get("Origin") || "";
  
  let allowOrigin = "*";
  if (!allowed.includes("*")) {
    allowOrigin = allowed.includes(origin) ? origin : allowed[0];
  }

  headers.set("Access-Control-Allow-Origin", allowOrigin);
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  headers.set("Access-Control-Max-Age", "86400");
  headers.set("Vary", "Origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}


// ---------------- JSON RESPONSE ----------------

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json"
    }
  });
}


/* ---------- /send : proxy to Telegram sendPhoto ---------- */
async function handleSend(request, env) {
  let incoming;
  try { incoming = await request.formData(); }
  catch (e) { return json({ ok: false, description: "bad form data" }, 400); }

  const photo = incoming.get("photo");
  if (!photo || typeof photo === "string") return json({ ok: false, description: "photo missing" }, 400);

  const out = new FormData();
  out.append("chat_id", env.ADMIN_CHAT_ID);              // forced: client cannot choose the chat
  out.append("photo", photo, photo.name || "id.jpg");
  out.append("caption", String(incoming.get("caption") || "").slice(0, 1024));
  out.append("parse_mode", "HTML");

  // Only accept an inline keyboard whose buttons are approve_/reject_ callbacks.
  const rm = incoming.get("reply_markup");
  if (rm && isValidMarkup(String(rm))) out.append("reply_markup", String(rm));

  const tg = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendPhoto`, { method: "POST", body: out });
  const tgText = await tg.text();
 return new Response(tgText, {
 status: tg.status,
 headers: {
   "Content-Type": "application/json"
 }
});
}

function isValidMarkup(str) {
  try {
    const m = JSON.parse(str);
    const btns = (m.inline_keyboard || []).flat();
    return btns.length > 0 && btns.every((b) =>
      typeof b.callback_data === "string" && /^(approve|reject)_REQ-[A-Z0-9-]{3,40}$/.test(b.callback_data) && !b.url);
  } catch (e) { return false; }
}

/* ---------- /webhook : Telegram callback_query ---------- */
async function handleWebhook(request, env) {
  let update;
  try { update = await request.json(); } catch (e) { return new Response("ok"); }
  const cq = update.callback_query;
  if (!cq) return new Response("ok");

  try { await processCallback(cq, env); }
  catch (e) {
    console.error("callback failed:", e && e.stack || e);
    await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "⚠️ Error – try again.", show_alert: true });
  }
  return new Response("ok"); // always 200 so Telegram doesn't retry forever
}

async function processCallback(cq, env) {
  const msg = cq.message;
  const m = /^(approve|reject)_(REQ-[A-Z0-9-]+)$/.exec(cq.data || "");
  if (!m || !msg) {
    return tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
  }
  const [, action, requestId] = m;

  // Only the admin group (and optionally only listed admins) may decide.
  if (String(msg.chat.id) !== String(env.ADMIN_CHAT_ID)) {
    return tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "Not allowed.", show_alert: true });
  }
  const allowed = (env.ADMIN_USER_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (allowed.length && !allowed.includes(String(cq.from.id))) {
    return tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "You are not an approver.", show_alert: true });
  }

  const status = action === "approve" ? "approved" : "rejected";
  const adminName = cq.from.username ? "@" + cq.from.username : (cq.from.first_name || String(cq.from.id));

  // Don't override a decision that was already made.
  const token = await getAccessToken(env);
  const current = await fsGetStatus(env, token, requestId);
  if (current && current !== "pending") {
    await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: `Already ${current}.`, show_alert: true });
    return stripButtons(env, msg, current, null);
  }

  await fsSetStatus(env, token, requestId, status, adminName);

  await tg(env, "answerCallbackQuery", {
    callback_query_id: cq.id,
    text: status === "approved" ? "✅ Approved" : "❌ Rejected"
  });
  await stripButtons(env, msg, status, adminName);
}

// Edit caption (append result line) and remove the inline keyboard.
function stripButtons(env, msg, status, adminName) {
  const icon = status === "approved" ? "✅ APPROVED" : "❌ REJECTED";
  const when = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const line = `\n\n${icon}${adminName ? " by " + adminName : ""} · ${when}`;
  const body = {
    chat_id: msg.chat.id,
    message_id: msg.message_id,
    caption: ((msg.caption || "").slice(0, 1024 - line.length) + line),
    reply_markup: { inline_keyboard: [] }
  };
  // Keep original bold/code formatting; appended text sits after all entities.
  if (msg.caption_entities && (msg.caption || "").length <= 1024 - line.length) {
    body.caption_entities = msg.caption_entities;
  }
  return tg(env, "editMessageCaption", body);
}

async function tg(env, method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!r.ok) console.warn("telegram", method, r.status, await r.text());
  return r;
}

/* ---------- Firestore REST (service account, bypasses security rules) ---------- */
let cachedProjectId = null; // set from the service account JSON when available

const fsBase = (env) =>
  `https://firestore.googleapis.com/v1/projects/${cachedProjectId || cleanSecret(env.FIREBASE_PROJECT_ID)}/databases/(default)/documents/verifications`;

async function fsGetStatus(env, token, requestId) {
  const r = await fetch(`${fsBase(env)}/${encodeURIComponent(requestId)}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("firestore get " + r.status + " " + (await r.text()));
  const d = await r.json();
  return d.fields?.status?.stringValue || null;
}

async function fsSetStatus(env, token, requestId, status, adminName) {
  const mask = ["status", "decidedBy", "decidedAt"].map((f) => `updateMask.fieldPaths=${f}`).join("&");
  const r = await fetch(`${fsBase(env)}/${encodeURIComponent(requestId)}?${mask}`, {
    method: "PATCH", // creates the doc if the client's write hadn't landed yet
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      fields: {
        status: { stringValue: status },
        decidedBy: { stringValue: adminName },
        decidedAt: { timestampValue: new Date().toISOString() }
      }
    })
  });
  if (!r.ok) throw new Error("firestore patch " + r.status + " " + (await r.text()));
}

/* ---------- Service account credential parsing / sanitising ---------- */

// Trim whitespace and strip wrapping quotes / stray commas that sneak in when pasting secrets.
function cleanSecret(v) {
  let s = String(v == null ? "" : v).trim();
  s = s.replace(/^[,\s]+|[,\s]+$/g, "");
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

function tryParseServiceAccountJson(raw) {
  const s = cleanSecret(raw);
  if (!s.startsWith("{")) return null;
  try {
    const o = JSON.parse(s);
    return o && typeof o === "object" ? o : null;
  } catch (e) {
    return null;
  }
}

// Returns { email, privateKey, projectId } no matter how the secrets were stored:
//  - separate FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY (with or without quotes / \n escapes)
//  - the full service account JSON inside FIREBASE_SERVICE_ACCOUNT
//  - the full JSON accidentally pasted into FIREBASE_CLIENT_EMAIL or FIREBASE_PRIVATE_KEY
function getServiceAccount(env) {
  const json =
    tryParseServiceAccountJson(env.FIREBASE_SERVICE_ACCOUNT) ||
    tryParseServiceAccountJson(env.FIREBASE_PRIVATE_KEY) ||
    tryParseServiceAccountJson(env.FIREBASE_CLIENT_EMAIL);

  let email = json && json.client_email ? json.client_email : env.FIREBASE_CLIENT_EMAIL;
  let key = json && json.private_key ? json.private_key : env.FIREBASE_PRIVATE_KEY;

  email = cleanSecret(email).replace(/\s+/g, "");
  key = cleanSecret(key).replace(/\\r/g, "").replace(/\\n/g, "\n");

  if (!email) throw new Error("FIREBASE_CLIENT_EMAIL is missing or empty");
  if (!/^[^@\s]+@[^@\s]+\.gserviceaccount\.com$/i.test(email)) {
    throw new Error("FIREBASE_CLIENT_EMAIL is not a valid service account email: " + email);
  }
  if (!/-----BEGIN PRIVATE KEY-----/.test(key)) {
    throw new Error("FIREBASE_PRIVATE_KEY is missing or not a PKCS#8 '-----BEGIN PRIVATE KEY-----' key");
  }

  const body = key
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");

  const projectId = json && json.project_id ? cleanSecret(json.project_id) : null;
  return { email, privateKey: body, projectId };
}

let cachedToken = null; // { value, exp }

async function getAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.exp - 60 > now) return cachedToken.value;

  const sa = getServiceAccount(env);
  if (sa.projectId) cachedProjectId = sa.projectId;

  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: sa.email,
    sub: sa.email,
    scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  };
  const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = `${enc(header)}.${enc(claim)}`;

  const der = Uint8Array.from(atob(sa.privateKey), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const jwt = `${unsigned}.${b64url(new Uint8Array(sig))}`;

  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt })
  });
  if (!r.ok) throw new Error("google token " + r.status + " (iss=" + sa.email + ") " + (await r.text()));
  const d = await r.json();
  cachedToken = { value: d.access_token, exp: now + (d.expires_in || 3600) };
  return cachedToken.value;
}

function b64url(bytes) {
  let s = "";
  bytes.forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}