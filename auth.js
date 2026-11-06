/* ============================================================
   MTU Campus — auth.js  v2  (photo-ID verification + admin notify)
   ------------------------------------------------------------
   FLOW
     1. User taps a gated button (default: "Accept & Contact").
     2. Not verified → glassmorphic modal asks for:
          Full Name · MTU ID Number · ID card photo
     3. Submit → photo + details are sent to your Telegram admin
        group via Bot API `sendPhoto`, tagged with a unique REQUEST ID.
     4. Status is saved in localStorage as "pending". While pending,
        every gated action is blocked and the user sees a
        "pending admin approval" screen.
     5. Approval (see APPROVAL below) flips the status to "approved".

   NON-DESTRUCTIVE: edits no existing function, style or DOM node.
   It adds one capture-phase click listener, its own <style> and its
   own <dialog>. Load it AFTER app.js.

   ⚠ SECURITY — READ THIS
     A bot token placed in browser JS is PUBLIC: anyone can open
     DevTools, copy it, and spam/read your admin group.
     Recommended: set CONFIG.telegram.endpoint to a tiny proxy
     (Cloudflare Worker / Firebase Cloud Function) that holds the
     token server-side and forwards the multipart request. Leave
     botToken empty in that case. Direct mode is for testing only.

   APPROVAL (client-side limitation)
     localStorage cannot be changed by you remotely. The practical
     approval path is the optional Firestore status doc
     `verifications/{requestId}`: the app writes {status:"pending"};
     you set status to "approved" (or "rejected") in the Firebase
     console, and the user's app picks it up live.
     Needs a Firestore rule such as:
       match /verifications/{id} {
         allow create, read: if true;       // tighten later
         allow update, delete: if false;    // admin uses console
       }
     Without it the user simply stays "pending".
   ============================================================ */
(function () {
  "use strict";

  if (window.MTUAuth) return; // never initialise twice

  /* ============================================================
     1. CONFIG — edit this block only
     ============================================================ */
  const CONFIG = {
    // Buttons that require a verified student.
    gatedSelectors: ['[data-action="contact-errand"]'],

    telegram: {
    botToken: "9284758024:AAE9KanKejA1SiezTdK_cFcL0S6yef2oabQ",
    adminChatId: "-1003635976490",
    endpoint: "",        
    timeoutMs: 25000
},

    // Optional live status sync through Firestore (uses the app's existing `db`).
    useFirestoreStatus: true,
    statusCollection: "verifications",

    // MTU ID: 5–20 chars, letters/digits and / - . _  (e.g. MTU/1234/14). Tighten to your real format.
    idPattern: /^[A-Z0-9][A-Z0-9\/\-._]{4,19}$/,
    minNameWords: 2,

    // ID photo handling
    maxPhotoInputBytes: 15 * 1024 * 1024, // reject absurdly large originals
    photoMaxSide: 1600,                   // px, longest side after compression
    photoMaxBytes: 4 * 1024 * 1024,       // Telegram limit is 10 MB; stay well below

    keys: {
      user: "mtu_auth_user",         // this device's account / request
      registry: "mtu_auth_registry"  // ID hashes claimed in this browser
    }
  };

  const STATUS = Object.freeze({ PENDING: "pending", APPROVED: "approved", REJECTED: "rejected" });

  /* ============================================================
     2. Helpers
     ============================================================ */
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  };
  function readJSON(k, fallback) {
    try { const v = JSON.parse(store.get(k)); return v ?? fallback; } catch (e) { return fallback; }
  }
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const normName = (s) => String(s || "").trim().replace(/\s+/g, " ");
  const normId = (s) => String(s || "").trim().toUpperCase().replace(/\s+/g, "");

  async function hashId(id) {
    try {
      if (window.crypto?.subtle) {
        const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("mtu:" + id));
        return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
      }
    } catch (e) { /* fall through */ }
    return "plain:" + id; // insecure-context fallback
  }

  function toast(msg) {
    if (typeof window.showToast === "function") window.showToast(msg);
    else console.log("[MTUAuth]", msg);
  }

  function tgUser() {
    try { return window.Telegram?.WebApp?.initDataUnsafe?.user || null; } catch (e) { return null; }
  }
  function deviceId() { return store.get("mtu_device_id") || ""; }

  // Unique, human-friendly request id, e.g. REQ-LX3K9A-7QF2
  function makeRequestId() {
    const t = Date.now().toString(36).toUpperCase();
    const r = Math.random().toString(36).slice(2, 6).toUpperCase().padEnd(4, "0");
    return `REQ-${t}-${r}`;
  }

  function appDb() {
    // app.js declares `let db` at top level → reachable by bare name, not via window.
    try { return typeof db !== "undefined" && db ? db : null; } catch (e) { return null; }
  }

  /* ============================================================
     3. Account / verification state (localStorage)
        Record shape:
        { name, idHash, idMasked, requestId, status, createdAt, updatedAt }
        Legacy v1 records (no status) are treated as approved.
     ============================================================ */
  function getRecord() {
    const u = readJSON(CONFIG.keys.user, null);
    if (!u || !u.name || !u.idHash) return null;
    if (!u.status) u.status = STATUS.APPROVED; // v1 migration
    return u;
  }
  function saveRecord(rec) {
    rec.updatedAt = Date.now();
    return store.set(CONFIG.keys.user, JSON.stringify(rec));
  }
  const getStatus = () => getRecord()?.status || null;
  const isApproved = () => getStatus() === STATUS.APPROVED;
  const isPending = () => getStatus() === STATUS.PENDING;

  function registryList() {
    const r = readJSON(CONFIG.keys.registry, []);
    return Array.isArray(r) ? r : [];
  }
  function registryAdd(hash) {
    const r = registryList();
    if (!r.includes(hash)) r.push(hash);
    store.set(CONFIG.keys.registry, JSON.stringify(r));
  }
  function registryRemove(hash) {
    store.set(CONFIG.keys.registry, JSON.stringify(registryList().filter((h) => h !== hash)));
  }

  /* ============================================================
     4. Photo: validate + compress (canvas → JPEG Blob)
     ============================================================ */
  async function loadBitmap(file) {
    if (typeof createImageBitmap === "function") {
      try { return await createImageBitmap(file); } catch (e) { /* fall back to <img> */ }
    }
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Could not read the selected image.")); };
      img.src = url;
    });
  }

  async function compressPhoto(file) {
    if (!file) throw new Error("Please attach a photo of your ID card.");
    if (file.type && !file.type.startsWith("image/")) throw new Error("Please choose an image file.");
    if (file.size > CONFIG.maxPhotoInputBytes) throw new Error("Photo is too large. Choose one under 15 MB.");

    const img = await loadBitmap(file);
    const w0 = img.width, h0 = img.height;
    if (!w0 || !h0) { if (img.close) img.close(); throw new Error("The selected image is invalid."); }

    let scale = Math.min(1, CONFIG.photoMaxSide / Math.max(w0, h0));
    let quality = 0.85;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) { if (img.close) img.close(); throw new Error("Image processing is not supported here."); }

    for (let i = 0; i < 10; i++) {
      canvas.width = Math.max(1, Math.round(w0 * scale));
      canvas.height = Math.max(1, Math.round(h0 * scale));
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", quality));
      if (blob && blob.size <= CONFIG.photoMaxBytes) { if (img.close) img.close(); return blob; }
      if (quality > 0.5) quality -= 0.1; else { scale *= 0.8; quality = 0.75; }
    }
    if (img.close) img.close();
    throw new Error("Photo is still too large. Please choose a smaller one.");
  }

  /* ============================================================
     5. Telegram: send ID photo + details to the admin group
     ============================================================ */
  function telegramConfigured() {
    const t = CONFIG.telegram;
    return !!(t.adminChatId && (t.endpoint || t.botToken));
  }

  function buildCaption(req) {
    // Telegram caption limit = 1024 chars, parse_mode HTML → everything user-supplied is escaped.
    const tu = tgUser();
    const tgLine = tu
      ? `${tu.username ? "@" + esc(tu.username) : "(no username)"} · id <code>${esc(tu.id)}</code>`
      : "not opened inside Telegram";
    const lines = [
      "🆕 <b>Delivery runner verification</b>",
      `🔖 Request ID: <code>${esc(req.requestId)}</code>`,
      `👤 Name: <b>${esc(req.name)}</b>`,
      `🎓 MTU ID: <code>${esc(req.id)}</code>`,
      `✈️ Telegram: ${tgLine}`,
      `📱 Device: <code>${esc(deviceId() || "n/a")}</code>`,
      `🕒 ${esc(new Date().toISOString().replace("T", " ").slice(0, 16))} UTC`,
      "",
      CONFIG.useFirestoreStatus
        ? `✅ To approve: Firestore → <code>${esc(CONFIG.statusCollection)}/${esc(req.requestId)}</code> → status = approved (or rejected)`
        : "Reply here to approve / reject."
    ];
    return lines.join("\n").slice(0, 1020);
  }

  async function sendToTelegram(req, photoBlob) {
    const t = CONFIG.telegram;
    if (!telegramConfigured()) {
      throw new Error("Verification is not configured yet. Please contact the admin.");
    }
    const url = t.endpoint || `https://api.telegram.org/bot${t.botToken}/sendPhoto`;

    const form = new FormData();
    form.append("chat_id", t.adminChatId);
    form.append("photo", photoBlob, `${req.requestId}.jpg`);
    form.append("caption", buildCaption(req));
    form.append("parse_mode", "HTML");

    const ctrl = typeof AbortController === "function" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), t.timeoutMs) : null;
    let resp;
    try {
      resp = await fetch(url, { method: "POST", body: form, signal: ctrl ? ctrl.signal : undefined });
    } catch (e) {
      throw new Error(e && e.name === "AbortError"
        ? "Request timed out. Check your connection and try again."
        : "Could not reach the server. Check your connection and try again.");
    } finally {
      if (timer) clearTimeout(timer);
    }

    let data = null;
    try { data = await resp.json(); } catch (e) { /* non-JSON */ }
    if (!resp.ok || (data && data.ok === false)) {
      console.error("[MTUAuth] Telegram error:", resp.status, data);
      throw new Error("Could not send your request. Please try again later.");
    }
    return data;
  }

  /* ============================================================
     6. Firestore status sync (optional, best-effort, never blocks)
     ============================================================ */
  let statusUnsub = null;

  async function createStatusDoc(rec) {
    const d = appDb();
    if (!CONFIG.useFirestoreStatus || !d) return;
    try {
      await d.collection(CONFIG.statusCollection).doc(rec.requestId).set({
        status: STATUS.PENDING,
        idHash: rec.idHash,
        name: rec.name,
        userId: String(tgUser()?.id || deviceId() || ""),
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    } catch (e) {
      console.warn("[MTUAuth] status doc not written (check Firestore rules):", e && e.code);
    }
  }

  function stopStatusListener() {
    if (statusUnsub) { try { statusUnsub(); } catch (e) { /* ignore */ } statusUnsub = null; }
  }

  function startStatusListener() {
    stopStatusListener();
    const rec = getRecord();
    const d = appDb();
    if (!CONFIG.useFirestoreStatus || !d || !rec || rec.status !== STATUS.PENDING) return;

    try {
      statusUnsub = d.collection(CONFIG.statusCollection).doc(rec.requestId).onSnapshot((snap) => {
        if (!snap.exists) return;
        const next = snap.data()?.status;
        const cur = getRecord();
        if (!cur || cur.requestId !== rec.requestId || next === cur.status) return;

        if (next === STATUS.APPROVED) {
          cur.status = STATUS.APPROVED;
          saveRecord(cur);
          stopStatusListener();
          toast("✅ You're verified! You can now accept requests.");
          refreshModalIfOpen();
        } else if (next === STATUS.REJECTED) {
          // Free the ID so the student can resubmit with correct details.
          registryRemove(cur.idHash);
          cur.status = STATUS.REJECTED;
          saveRecord(cur);
          stopStatusListener();
          toast("Your verification was rejected. Please resubmit.");
          refreshModalIfOpen();
        }
      }, (err) => console.warn("[MTUAuth] status listener error:", err && err.code));
    } catch (e) {
      console.warn("[MTUAuth] status listener failed:", e);
    }
  }

  /* ============================================================
     7. Submit pipeline: validate → send → persist pending
     ============================================================ */
  async function submitVerification(fullName, mtuId, photoFile) {
    const name = normName(fullName);
    const id = normId(mtuId);

    if (name.split(" ").filter(Boolean).length < CONFIG.minNameWords || name.length < 5) {
      return { ok: false, field: "name", error: "Enter your full name (first and last name)." };
    }
    if (!/^[\p{L}\p{M}'.\- ]+$/u.test(name)) {
      return { ok: false, field: "name", error: "Name contains invalid characters." };
    }
    if (!CONFIG.idPattern.test(id)) {
      return { ok: false, field: "id", error: "Enter a valid MTU ID number (e.g. MTU/1234/14)." };
    }
    if (!photoFile) {
      return { ok: false, field: "photo", error: "Please attach a clear photo of your ID card." };
    }

    const idHash = await hashId(id);
    const existing = getRecord();

    if (existing && existing.status !== STATUS.REJECTED) {
      return { ok: false, field: null, error: existing.status === STATUS.PENDING
        ? "You already have a request pending approval."
        : "This device is already verified." };
    }
    if (registryList().includes(idHash)) {
      return { ok: false, field: "id", error: "This MTU ID is already registered. One account per student." };
    }
    if (!telegramConfigured()) {
      return { ok: false, field: null, error: "Verification is not configured yet. Please contact the admin." };
    }

    let blob;
    try { blob = await compressPhoto(photoFile); }
    catch (e) { return { ok: false, field: "photo", error: e.message || "Could not process the photo." }; }

    const requestId = makeRequestId();
    try {
      await sendToTelegram({ requestId, name, id }, blob);
    } catch (e) {
      return { ok: false, field: null, error: e.message || "Could not send your request." };
    }

    // Sent successfully → remember locally. Only the HASH and a masked ID are stored.
    const rec = {
      name,
      idHash,
      idMasked: id.length > 4 ? "••••" + id.slice(-3) : "••••",
      requestId,
      status: STATUS.PENDING,
      createdAt: Date.now()
    };
    registryAdd(idHash);
    if (!saveRecord(rec)) {
      return { ok: false, field: null, error: "Request sent, but this browser could not save it (storage disabled)." };
    }

    createStatusDoc(rec);      // fire-and-forget
    startStatusListener();
    return { ok: true, record: rec };
  }

  /* ============================================================
     8. Styles (scoped to #mtuAuthModal — additive only)
     ============================================================ */
  function injectStyles() {
    if (document.getElementById("mtu-auth-style")) return;
    const css = `
      dialog#mtuAuthModal {
        margin: auto; padding: 0; width: calc(100% - 2.5rem); max-width: 400px; max-height: 92vh;
        border: 1px solid rgba(148,181,214,.16); border-radius: 26px;
        background: transparent; color: #F4F8FC; overflow: hidden;
        animation: mtuAuthIn 320ms cubic-bezier(.22,1,.36,1);
      }
      dialog#mtuAuthModal::backdrop { background: rgba(3,5,8,.7); backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); }
      @keyframes mtuAuthIn { from { opacity:0; transform:translateY(16px) scale(.96); } to { opacity:1; transform:none; } }
      #mtuAuthModal .mtu-auth-card {
        position: relative; padding: 22px 20px; overflow-y: auto; max-height: 92vh; overscroll-behavior: contain;
        background: linear-gradient(145deg, rgba(16,29,49,.96), rgba(6,16,29,.95));
        backdrop-filter: blur(22px) saturate(160%); -webkit-backdrop-filter: blur(22px) saturate(160%);
        box-shadow: inset 0 1px 0 rgba(255,255,255,.05), 0 20px 55px rgba(0,0,0,.4);
      }
      #mtuAuthModal .mtu-auth-glow { position:absolute; width:170px; height:170px; border-radius:50%; filter:blur(46px); pointer-events:none; }
      #mtuAuthModal .mtu-auth-glow.a { top:-60px; right:-60px; background:rgba(109,94,245,.30); }
      #mtuAuthModal .mtu-auth-glow.b { bottom:-64px; left:-64px; background:rgba(24,182,217,.24); }
      #mtuAuthModal .mtu-auth-inner { position:relative; z-index:1; }
      #mtuAuthModal .mtu-auth-head { display:flex; align-items:center; gap:12px; margin-bottom:14px; }
      #mtuAuthModal .mtu-auth-icon { width:44px; height:44px; flex:0 0 44px; display:grid; place-items:center; border-radius:15px; background:linear-gradient(135deg,#6D5EF5,#18B6D9); box-shadow:0 8px 24px -6px rgba(99,102,241,.45); }
      #mtuAuthModal .mtu-auth-icon svg { width:22px; height:22px; color:#fff; }
      #mtuAuthModal .mtu-auth-icon.amber { background:linear-gradient(135deg,#F59E0B,#F5C451); }
      #mtuAuthModal .mtu-auth-icon.green { background:linear-gradient(135deg,#10B981,#18B6D9); }
      #mtuAuthModal .mtu-auth-title { font-family:'Space Grotesk',sans-serif; font-weight:700; font-size:17px; letter-spacing:-.02em; }
      #mtuAuthModal .mtu-auth-sub { margin-top:2px; font-size:11px; color:#91A4BA; line-height:1.45; }
      #mtuAuthModal .mtu-auth-close { margin-left:auto; width:32px; height:32px; flex:0 0 32px; display:grid; place-items:center; border-radius:999px; background:#1C304A; color:#CBD5E1; font-size:16px; line-height:1; }
      #mtuAuthModal label.mtu-lbl { display:block; margin:12px 0 5px; font-size:11px; font-weight:600; color:#B8C9DA; }
      #mtuAuthModal input[type="text"] {
        width:100%; padding:12px 14px; font-size:16px; color:#F4F8FC; outline:none;
        background:rgba(20,36,58,.72); border:1px solid rgba(148,181,214,.16); border-radius:12px;
        transition:border-color .15s ease, box-shadow .15s ease;
      }
      #mtuAuthModal input[type="text"]::placeholder { color:#667C95; }
      #mtuAuthModal input[type="text"]:focus { border-color:rgba(88,215,239,.5); box-shadow:0 0 0 3px rgba(24,182,217,.1); }
      #mtuAuthModal .invalid { border-color:#ef4444 !important; }
      #mtuAuthModal .mtu-drop {
        position:relative; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:6px;
        min-height:112px; overflow:hidden; cursor:pointer; text-align:center; font-size:11px; color:#91A4BA;
        background:radial-gradient(circle at 50% 20%, rgba(24,182,217,.08), transparent 45%), rgba(20,36,58,.46);
        border:2px dashed rgba(88,215,239,.22); border-radius:14px; transition:border-color .15s ease;
      }
      #mtuAuthModal .mtu-drop:hover { border-color:rgba(88,215,239,.5); }
      #mtuAuthModal .mtu-drop svg { width:22px; height:22px; color:#58D7EF; }
      #mtuAuthModal .mtu-drop img { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; }
      #mtuAuthModal .mtu-drop img.hidden { display:none; }
      #mtuAuthModal .mtu-drop input[type="file"] { position:absolute; width:1px; height:1px; opacity:0; pointer-events:none; }
      #mtuAuthModal .mtu-auth-error { min-height:16px; margin-top:8px; font-size:11px; color:#fca5a5; }
      #mtuAuthModal .mtu-auth-note { display:flex; gap:8px; margin-top:10px; padding:9px 11px; font-size:10.5px; line-height:1.5; color:#fcd34d; background:rgba(245,158,11,.1); border:1px solid rgba(245,158,11,.3); border-radius:12px; }
      #mtuAuthModal .mtu-auth-submit { width:100%; margin-top:14px; padding:13px; border-radius:12px; font-size:13px; font-weight:700; color:#fff; background:linear-gradient(90deg,#6D5EF5,#18B6D9); box-shadow:0 12px 28px rgba(109,94,245,.22); transition:transform .15s ease, filter .15s ease; }
      #mtuAuthModal .mtu-auth-submit:active { transform:scale(.97); filter:brightness(.95); }
      #mtuAuthModal .mtu-auth-submit:disabled { opacity:.65; }
      #mtuAuthModal .mtu-auth-submit.ghost { background:rgba(28,48,74,.9); box-shadow:none; color:#E2EAF3; }
      #mtuAuthModal .mtu-req { margin-top:12px; padding:11px 12px; border-radius:12px; background:rgba(20,36,58,.72); border:1px solid rgba(148,181,214,.16); font-size:11px; color:#B8C9DA; }
      #mtuAuthModal .mtu-req code { display:block; margin-top:4px; font-size:13px; font-weight:700; letter-spacing:.04em; color:#8DEBFA; user-select:all; }
      #mtuAuthModal .mtu-view[hidden] { display:none; }
    `;
    const style = document.createElement("style");
    style.id = "mtu-auth-style";
    style.textContent = css;
    document.head.appendChild(style);
  }

  /* ============================================================
     9. Modal (three views: form / pending / rejected)
     ============================================================ */
  let dialog = null;

  function buildModal() {
    if (dialog) return dialog;
    injectStyles();

    dialog = document.createElement("dialog");
    dialog.id = "mtuAuthModal";
    dialog.innerHTML = `
      <div class="mtu-auth-card">
        <div class="mtu-auth-glow a"></div><div class="mtu-auth-glow b"></div>
        <div class="mtu-auth-inner">

          <!-- VIEW: registration form -->
          <form class="mtu-view" data-view="form" id="mtuAuthForm" novalidate autocomplete="off">
            <div class="mtu-auth-head">
              <div class="mtu-auth-icon"><i data-lucide="shield-check"></i></div>
              <div>
                <p class="mtu-auth-title">Verify your student account</p>
                <p class="mtu-auth-sub">One-time check before you can accept requests.</p>
              </div>
              <button type="button" class="mtu-auth-close" data-mtu-close aria-label="Close">✕</button>
            </div>

            <label class="mtu-lbl" for="mtuAuthName">Full name</label>
            <input id="mtuAuthName" type="text" placeholder="e.g. Abebe Kebede Tadesse" maxlength="60" autocomplete="name" />

            <label class="mtu-lbl" for="mtuAuthId">MTU ID number</label>
            <input id="mtuAuthId" type="text" placeholder="e.g. MTU/1234/14" maxlength="20" autocapitalize="characters" />

            <label class="mtu-lbl" for="mtuAuthPhoto">ID card photo</label>
            <label class="mtu-drop" id="mtuAuthDrop" for="mtuAuthPhoto">
              <input id="mtuAuthPhoto" type="file" accept="image/*" />
              <span id="mtuAuthDropHint" style="display:flex;flex-direction:column;align-items:center;gap:6px">
                <i data-lucide="image-plus"></i>
                <span>Tap to upload a clear photo of your student ID</span>
              </span>
              <img id="mtuAuthPreview" class="hidden" alt="ID preview" />
            </label>

            <p class="mtu-auth-error" id="mtuAuthError" role="alert"></p>

            <div class="mtu-auth-note">
              <i data-lucide="info" style="width:14px;height:14px;flex:0 0 14px;margin-top:1px"></i>
              <span>Your ID photo is sent only to the campus admins for verification. One account per student.</span>
            </div>

            <button type="submit" class="mtu-auth-submit" id="mtuAuthSubmit">Submit for verification</button>
          </form>

          <!-- VIEW: pending approval -->
          <div class="mtu-view" data-view="pending" hidden>
            <div class="mtu-auth-head">
              <div class="mtu-auth-icon amber"><i data-lucide="hourglass"></i></div>
              <div>
                <p class="mtu-auth-title">Pending admin approval</p>
                <p class="mtu-auth-sub">Your registration was sent to the admin group on Telegram.</p>
              </div>
              <button type="button" class="mtu-auth-close" data-mtu-close aria-label="Close">✕</button>
            </div>
            <p style="font-size:12px;line-height:1.6;color:#B8C9DA">
              An admin will review your ID photo. Delivery actions stay locked until you are approved.
              You'll get a notification here as soon as that happens.
            </p>
            <div class="mtu-req">Your request ID<code id="mtuAuthReqId">—</code></div>
            <button type="button" class="mtu-auth-submit ghost" data-mtu-close>Got it</button>
          </div>

          <!-- VIEW: rejected -->
          <div class="mtu-view" data-view="rejected" hidden>
            <div class="mtu-auth-head">
              <div class="mtu-auth-icon amber"><i data-lucide="shield-alert"></i></div>
              <div>
                <p class="mtu-auth-title">Verification not approved</p>
                <p class="mtu-auth-sub">Please check your details and try again.</p>
              </div>
              <button type="button" class="mtu-auth-close" data-mtu-close aria-label="Close">✕</button>
            </div>
            <button type="button" class="mtu-auth-submit" id="mtuAuthRetry">Resubmit</button>
          </div>

        </div>
      </div>`;
    document.body.appendChild(dialog);
    wireModal();
    return dialog;
  }

  const $ = (sel) => dialog.querySelector(sel);

  function showView(name) {
    dialog.querySelectorAll(".mtu-view").forEach((v) => { v.hidden = v.dataset.view !== name; });
    if (name === "pending") $("#mtuAuthReqId").textContent = getRecord()?.requestId || "—";
    if (window.lucide) window.lucide.createIcons();
  }

  function viewForState() {
    const s = getStatus();
    if (s === STATUS.PENDING) return "pending";
    if (s === STATUS.REJECTED) return "rejected";
    return "form";
  }

  function refreshModalIfOpen() {
    if (dialog && dialog.open) showView(viewForState());
  }

  function wireModal() {
    const form = $("#mtuAuthForm");
    const nameEl = $("#mtuAuthName");
    const idEl = $("#mtuAuthId");
    const photoEl = $("#mtuAuthPhoto");
    const dropEl = $("#mtuAuthDrop");
    const hintEl = $("#mtuAuthDropHint");
    const prevEl = $("#mtuAuthPreview");
    const errEl = $("#mtuAuthError");
    const submit = $("#mtuAuthSubmit");

    const clearErr = () => {
      errEl.textContent = "";
      [nameEl, idEl, dropEl].forEach((el) => el.classList.remove("invalid"));
    };
    nameEl.addEventListener("input", clearErr);
    idEl.addEventListener("input", clearErr);

    // Photo preview
    let previewUrl = null;
    photoEl.addEventListener("change", () => {
      clearErr();
      if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
      const f = photoEl.files && photoEl.files[0];
      if (!f) { prevEl.classList.add("hidden"); hintEl.style.display = "flex"; return; }
      previewUrl = URL.createObjectURL(f);
      prevEl.src = previewUrl;
      prevEl.classList.remove("hidden");
      hintEl.style.display = "none";
    });

    dialog.querySelectorAll("[data-mtu-close]").forEach((b) => b.addEventListener("click", () => dialog.close()));
    dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close(); });

    $("#mtuAuthRetry").addEventListener("click", () => {
      // Clear the rejected record so the form can be used again (registry was already freed).
      store.set(CONFIG.keys.user, "");
      showView("form");
    });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (submit.disabled) return;
      clearErr();
      submit.disabled = true;
      const label = submit.innerHTML;
      submit.textContent = "Sending…";

      try {
        const res = await submitVerification(nameEl.value, idEl.value, photoEl.files && photoEl.files[0]);
        if (!res.ok) {
          errEl.textContent = res.error;
          if (res.field === "name") nameEl.classList.add("invalid");
          if (res.field === "id") idEl.classList.add("invalid");
          if (res.field === "photo") dropEl.classList.add("invalid");
          return;
        }
        form.reset();
        prevEl.classList.add("hidden");
        hintEl.style.display = "flex";
        showView("pending");
        toast("Request sent — pending admin approval");
      } catch (err) {
        console.error("[MTUAuth] submit failed:", err);
        errEl.textContent = "Something went wrong. Please try again.";
      } finally {
        submit.disabled = false;
        submit.innerHTML = label;
      }
    });
  }

  function openAuthModal() {
    const d = buildModal();
    const view = viewForState();

    if (view === "form") {
      const nameEl = $("#mtuAuthName");
      const fn = (tgUser()?.first_name || "").trim();
      if (nameEl && !nameEl.value && fn) nameEl.value = fn + " ";
    }
    showView(view);
    if (!d.open) d.showModal();
    if (view === "form") setTimeout(() => { try { $("#mtuAuthName").focus({ preventScroll: true }); } catch (e) { /* ignore */ } }, 250);
  }

  /* ============================================================
     10. Gate — capture-phase click interception
         approved  → click passes through to app.js untouched
         otherwise → click is swallowed, modal opens
     ============================================================ */
  function gatedSelectorList() { return CONFIG.gatedSelectors.join(","); }

  document.addEventListener("click", (ev) => {
    const btn = ev.target.closest && ev.target.closest(gatedSelectorList());
    if (!btn) return;
    if (isApproved()) return;

    ev.preventDefault();
    ev.stopImmediatePropagation();
    if (isPending()) toast("Your registration is pending admin approval");
    openAuthModal();
  }, true); // capture phase = runs before app.js's bubbling listeners

  /* ============================================================
     11. Public API + boot
     ============================================================ */
  window.MTUAuth = Object.freeze({
    isRegistered: isApproved,          // kept for v1 compatibility (true only when approved)
    isApproved,
    isPending,
    getStatus,                         // "approved" | "pending" | "rejected" | null
    getUser: () => {
      const r = getRecord();
      return r ? { name: r.name, idMasked: r.idMasked, requestId: r.requestId, status: r.status, registeredAt: r.createdAt } : null;
    },
    // Run cb only for approved users; otherwise show the right modal view.
    require(cb) { if (isApproved()) { cb && cb(); } else { openAuthModal(); } },
    open: openAuthModal,
    config: CONFIG
  });

  // Resume live status sync after a page reload (Firestore may not be ready instantly).
  if (isPending()) setTimeout(startStatusListener, 1500);

  console.log("[MTUAuth] v2 ready — status:", getStatus() || "none", "| telegram configured:", telegramConfigured());
})();
