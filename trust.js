/* ============================================================
   MTU Campus — Presence (online counter) + Ratings (trust badges)
   Load this file BEFORE app.js, then call MTUTrust.start() from init().
   Uses globals defined in app.js: db, currentUserId, getTelegramFirstName,
   escapeHTML, showToast, openModal, closeModal,
   renderProductGrid, renderErrandFeed, renderLostFound.
   ============================================================ */

const MTUTrust = (() => {
  "use strict";

  // ---------- Config ----------
  const ONLINE_WINDOW_MS = 2 * 60 * 1000;   // "online" = heartbeat within 2 min
  const HEARTBEAT_MS = 45 * 1000;           // write lastSeen every 45s
  const LISTEN_WINDOW_MS = 10 * 60 * 1000;  // only subscribe to docs seen in last 10 min
  const STALE_PRESENCE_MS = 24 * 60 * 60 * 1000;
  const TRUSTED_MIN_COUNT = 5;              // "Trusted" badge thresholds
  const TRUSTED_MIN_AVG = 4.5;

  const $ = (id) => document.getElementById(id);
  const myId = () => String(currentUserId);
  const serverTs = () => firebase.firestore.FieldValue.serverTimestamp();
  const safeName = () =>
    (typeof getTelegramFirstName === "function" && getTelegramFirstName()) || "Student";

  /* ============================================================
     1. PRESENCE — presence/{userId} = { lastSeen, name }
     ============================================================ */

  let presence = {};          // userId -> lastSeen (ms)
  let hbTimer = null;

  function beat() {
    if (!db || document.hidden) return;
    db.collection("presence").doc(myId())
      .set({ lastSeen: serverTs(), name: safeName() }, { merge: true })
      .catch(() => { /* offline / rules — ignore */ });
  }

  function renderOnline() {
    const el = $("onlineCount");
    if (!el) return;
    const now = Date.now();
    let n = Object.values(presence).filter((t) => now - t <= ONLINE_WINDOW_MS).length;
    if (!document.hidden) n = Math.max(n, 1); // you are online yourself
    el.textContent = `${n} online`;
  }

  function startPresence() {
    if (!db) return;
    beat();
    hbTimer = setInterval(beat, HEARTBEAT_MS);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) beat(); renderOnline(); });
    window.addEventListener("online", beat);

    const since = firebase.firestore.Timestamp.fromDate(new Date(Date.now() - LISTEN_WINDOW_MS));
    db.collection("presence").where("lastSeen", ">=", since).onSnapshot((snap) => {
      const next = {};
      snap.forEach((d) => {
        const t = d.data({ serverTimestamps: "estimate" }).lastSeen;
        next[d.id] = t && t.toMillis ? t.toMillis() : Date.now();
      });
      presence = next;
      renderOnline();
    }, (err) => console.error("[MTU] presence listener:", err));

    // Users who closed the app stop sending heartbeats (so no snapshot fires) → re-evaluate by clock
    setInterval(renderOnline, 15000);

    // Best-effort housekeeping of very old presence docs
    const old = firebase.firestore.Timestamp.fromDate(new Date(Date.now() - STALE_PRESENCE_MS));
    db.collection("presence").where("lastSeen", "<", old).limit(50).get()
      .then((s) => s.forEach((d) => d.ref.delete()))
      .catch(() => {});
  }

  /* ============================================================
     2. RATINGS
     ratings/{roomId}__{raterId} = { roomId, raterId, raterName, targetId, targetName,
                                     stars, comment, kind, listingId, title, createdAt }
     users/{userId}              = { name, ratingSum, ratingCount, updatedAt }
     A user may rate the OTHER chat participant, once per chat room,
     and only after BOTH sides have sent at least one message
     (flags buyerSent / ownerSent on chats/{roomId}).
     ============================================================ */

  const stats = {}; // userId -> { sum, count }

  function badge(uid) {
    if (!uid) return "";
    const key = String(uid);
    const s = stats[key];
    if (!s || !s.count) {
      return `<span class="inline-flex items-center text-[9px] font-semibold text-slate-400 bg-base-800/80 border border-white/5 px-1.5 py-0.5 rounded-md align-middle">New</span>`;
    }
    const avg = (s.sum / s.count).toFixed(1);
    const trusted = s.count >= TRUSTED_MIN_COUNT && s.sum / s.count >= TRUSTED_MIN_AVG;
    return `<span role="button" data-trust-user="${escapeHTML(key)}" class="inline-flex items-center gap-0.5 text-[10px] font-bold text-amber-300 bg-amber-500/10 border border-amber-400/30 px-1.5 py-0.5 rounded-md align-middle cursor-pointer">⭐ ${avg} (${s.count})</span>`
      + (trusted
        ? ` <span class="inline-flex items-center text-[9px] font-bold text-emerald-soft bg-emerald/10 border border-emerald/30 px-1.5 py-0.5 rounded-md align-middle">✔ Trusted</span>`
        : "");
  }

  function rerenderLists() {
    try { renderProductGrid(); } catch (e) { /* ignore */ }
    try { renderErrandFeed(); } catch (e) { /* ignore */ }
    try { renderLostFound(); } catch (e) { /* ignore */ }
  }

  function listenUserStats() {
    if (!db) return;
    db.collection("users").where("ratingCount", ">", 0).onSnapshot((snap) => {
      Object.keys(stats).forEach((k) => delete stats[k]);
      snap.forEach((d) => {
        const u = d.data();
        stats[d.id] = { sum: Number(u.ratingSum) || 0, count: Number(u.ratingCount) || 0 };
      });
      rerenderLists();
      refreshChatHeader();
    }, (err) => console.error("[MTU] users listener:", err));
  }

  /* ---------- UI injection (rating sheet, reviews sheet, chat header button) ---------- */

  function ensureUI() {
    if (!$("rateModal")) {
      const d = document.createElement("dialog");
      d.id = "rateModal";
      d.className = "sheet w-full max-w-[440px] m-0 mx-auto mb-0 mt-auto rounded-t-3xl bg-base-850 border-t border-white/10 p-0 backdrop:bg-black/60 max-h-[88vh] overflow-y-auto";
      d.innerHTML = `
        <form id="rateForm" class="p-5 pb-8" autocomplete="off">
          <div class="w-10 h-1 bg-base-600 rounded-full mx-auto mb-5"></div>
          <div class="flex items-center justify-between mb-4">
            <div class="min-w-0">
              <p class="font-display font-bold text-base">Rate <span id="rateTarget">user</span></p>
              <p id="rateListing" class="text-[11px] text-emerald-soft truncate"></p>
            </div>
            <button type="button" data-rate-close class="tap w-8 h-8 rounded-full bg-base-700 flex items-center justify-center text-slate-300">✕</button>
          </div>
          <div id="rateStars" class="flex justify-center gap-2 mb-4"></div>
          <textarea id="rateComment" maxlength="300" rows="3" placeholder="How was the deal? (optional)"
            class="w-full bg-base-800 border border-base-600 rounded-xl px-4 py-3 text-sm placeholder:text-slate-500 outline-none focus:border-indigo-soft resize-none"></textarea>
          <button type="submit" class="tap w-full mt-4 bg-gradient-to-r from-indigo to-emerald text-white font-semibold text-sm py-3.5 rounded-xl shadow-glow-in">Submit Rating</button>
        </form>`;
      document.body.appendChild(d);
      d.querySelector("[data-rate-close]").addEventListener("click", () => closeModal("rateModal"));
      $("rateForm").addEventListener("submit", submitRating);
      $("rateStars").addEventListener("click", (e) => {
        const b = e.target.closest("[data-star]");
        if (b) { pick = Number(b.dataset.star); paintStars(); }
      });
    }

    if (!$("reviewsModal")) {
      const d = document.createElement("dialog");
      d.id = "reviewsModal";
      d.className = "sheet w-full max-w-[440px] m-0 mx-auto mb-0 mt-auto rounded-t-3xl bg-base-850 border-t border-white/10 p-0 backdrop:bg-black/60 max-h-[80vh] overflow-y-auto";
      d.innerHTML = `
        <div class="p-5 pb-8">
          <div class="w-10 h-1 bg-base-600 rounded-full mx-auto mb-5"></div>
          <div class="flex items-center justify-between mb-4">
            <p class="font-display font-bold text-base">Reviews</p>
            <button type="button" data-reviews-close class="tap w-8 h-8 rounded-full bg-base-700 flex items-center justify-center text-slate-300">✕</button>
          </div>
          <div id="reviewsList" class="space-y-2"></div>
        </div>`;
      document.body.appendChild(d);
      d.querySelector("[data-reviews-close]").addEventListener("click", () => closeModal("reviewsModal"));
    }

    if (!$("chatRateBtn")) {
      const closeBtn = document.querySelector('#chatModal [data-close-modal="chatModal"]');
      if (closeBtn && closeBtn.parentElement) {
        const b = document.createElement("button");
        b.id = "chatRateBtn";
        b.type = "button";
        b.addEventListener("click", onRateClick);
        closeBtn.parentElement.insertBefore(b, closeBtn);
      }
    }
  }

  /* ---------- Chat integration ---------- */

  let ctx = null;
  let roomUnsub = null;
  let ratedUnsub = null;
  let flags = { buyerSent: false, ownerSent: false };
  let alreadyRated = false;
  let pick = 0;

  function peerOf(c) {
    const iAmOwner = myId() === String(c.ownerId);
    return iAmOwner
      ? { id: String(c.buyerId), name: c.buyerName || "Student" }
      : { id: String(c.ownerId), name: c.ownerName || "Seller" };
  }
  const ratingDocId = (c) => `${c.roomId}__${myId()}`;

  function refreshChatHeader() {
    if (!ctx) return;
    const el = $("chatPeerName");
    if (el) { const p = peerOf(ctx); el.innerHTML = `${escapeHTML(p.name)} ${badge(p.id)}`; }
  }

  function updateRateBtn() {
    const btn = $("chatRateBtn");
    if (!btn) return;
    const ready = flags.buyerSent && flags.ownerSent;
    const state = alreadyRated ? "done" : ready ? "ready" : "locked";
    btn.dataset.state = state;
    btn.textContent = state === "done" ? "Rated ✓" : "⭐ Rate";
    btn.className = "tap shrink-0 text-[11px] font-bold px-3 py-2 rounded-lg border " + (
      state === "ready" ? "bg-amber-500/15 border-amber-400/40 text-amber-300"
      : state === "done" ? "bg-emerald/10 border-emerald/30 text-emerald-soft"
      : "bg-base-800 border-base-600 text-slate-500");
    btn.classList.remove("hidden");
  }

  function onChatOpened(chatCtx) {
    onChatClosed();
    if (!db || !chatCtx) return;
    ctx = chatCtx;
    ensureUI();
    refreshChatHeader();
    flags = { buyerSent: false, ownerSent: false };
    alreadyRated = false;
    updateRateBtn();

    roomUnsub = db.collection("chats").doc(ctx.roomId).onSnapshot((s) => {
      const d = s.data() || {};
      flags = { buyerSent: !!d.buyerSent, ownerSent: !!d.ownerSent };
      updateRateBtn();
    }, () => {});

    ratedUnsub = db.collection("ratings").doc(ratingDocId(ctx)).onSnapshot((s) => {
      alreadyRated = s.exists;
      updateRateBtn();
    }, () => {});
  }

  function onChatClosed() {
    if (roomUnsub) { try { roomUnsub(); } catch (e) {} roomUnsub = null; }
    if (ratedUnsub) { try { ratedUnsub(); } catch (e) {} ratedUnsub = null; }
    ctx = null;
  }

  function onRateClick() {
    const state = $("chatRateBtn")?.dataset.state;
    if (state === "locked") return showToast("Rating unlocks after you've both sent messages in this chat");
    if (state === "done") return showToast("You already rated this deal");
    openRate();
  }

  /* ---------- Rating sheet ---------- */

  function paintStars() {
    const box = $("rateStars");
    if (!box) return;
    box.innerHTML = [1, 2, 3, 4, 5].map((n) =>
      `<button type="button" data-star="${n}" aria-label="${n} star${n > 1 ? "s" : ""}" class="tap text-3xl leading-none ${n <= pick ? "text-amber-300" : "text-slate-600"}">★</button>`
    ).join("");
  }

  function openRate() {
    if (!ctx) return;
    pick = 0;
    paintStars();
    $("rateComment").value = "";
    $("rateTarget").textContent = peerOf(ctx).name;
    $("rateListing").textContent = ctx.title || "";
    openModal("rateModal");
  }

  async function submitRating(e) {
    e.preventDefault();
    if (!ctx || !db) return;
    if (pick < 1) return showToast("Tap a star to rate");

    const c = ctx;
    const peer = peerOf(c);
    const form = $("rateForm");
    const btn = form.querySelector('button[type="submit"]');
    if (form.dataset.busy === "1") return;
    form.dataset.busy = "1";
    btn.disabled = true; btn.textContent = "Submitting…";

    const ratingRef = db.collection("ratings").doc(ratingDocId(c));
    const roomRef = db.collection("chats").doc(c.roomId);
    const userRef = db.collection("users").doc(peer.id);
    const comment = $("rateComment").value.trim().slice(0, 300);
    const stars = pick;

    try {
      await db.runTransaction(async (tx) => {
        const [room, existing] = await Promise.all([tx.get(roomRef), tx.get(ratingRef)]);
        if (!room.exists) throw new Error("no-chat");
        const r = room.data();
        if (!(r.buyerSent && r.ownerSent)) throw new Error("not-yet");
        if (existing.exists) throw new Error("already");

        tx.set(ratingRef, {
          roomId: c.roomId,
          kind: c.kind || "product",
          listingId: String(c.listingId || ""),
          title: c.title || "",
          raterId: myId(),
          raterName: safeName(),
          targetId: peer.id,
          targetName: peer.name,
          stars,
          comment,
          createdAt: serverTs()
        });
        tx.set(userRef, {
          name: peer.name,
          ratingSum: firebase.firestore.FieldValue.increment(stars),
          ratingCount: firebase.firestore.FieldValue.increment(1),
          updatedAt: serverTs()
        }, { merge: true });
      });
      closeModal("rateModal");
      showToast("Thanks! Your rating was submitted");
    } catch (err) {
      console.error("[MTU] rating failed:", err);
      const m = String(err && err.message);
      showToast(
        m.includes("not-yet") ? "Both of you must message first" :
        m.includes("already") ? "You already rated this deal" :
        m.includes("no-chat") ? "Start an in-app chat first" :
        err && err.code === "permission-denied" ? "Not allowed by database rules" :
        "Could not submit rating"
      );
    } finally {
      form.dataset.busy = "0";
      btn.disabled = false; btn.textContent = "Submit Rating";
    }
  }

  /* ---------- Reviews list (tap a badge) ---------- */

  async function showReviews(uid) {
    if (!db) return;
    ensureUI();
    const list = $("reviewsList");
    list.innerHTML = `<div class="text-center py-8 text-xs text-slate-400">Loading…</div>`;
    openModal("reviewsModal");
    try {
      // needs a composite index: ratings → targetId (asc) + createdAt (desc)
      const snap = await db.collection("ratings")
        .where("targetId", "==", String(uid))
        .orderBy("createdAt", "desc").limit(15).get();
      if (snap.empty) {
        list.innerHTML = `<div class="text-center py-8 text-xs text-slate-500">No reviews yet.</div>`;
        return;
      }
      list.innerHTML = snap.docs.map((d) => {
        const r = d.data();
        const n = Math.max(1, Math.min(5, Number(r.stars) || 1));
        return `
          <div class="p-3 rounded-2xl bg-base-800/60 border border-base-700 text-xs">
            <div class="flex items-center justify-between">
              <span class="font-semibold text-slate-200">${escapeHTML(r.raterName || "Student")}</span>
              <span class="text-amber-300">${"★".repeat(n)}<span class="text-slate-600">${"★".repeat(5 - n)}</span></span>
            </div>
            ${r.comment ? `<p class="text-slate-300 mt-1 whitespace-pre-wrap break-words">${escapeHTML(r.comment)}</p>` : ""}
            <p class="text-[10px] text-slate-500 mt-1 truncate">${escapeHTML(r.title || "")}</p>
          </div>`;
      }).join("");
    } catch (err) {
      console.error("[MTU] reviews failed:", err);
      list.innerHTML = `<div class="text-center py-8 text-xs text-slate-400">Could not load reviews.</div>`;
    }
  }

  document.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest("[data-trust-user]");
    if (b) { e.stopPropagation(); showReviews(b.dataset.trustUser); }
  }, true);

  /* ---------- Public API ---------- */

  let started = false;
  function start() {
    if (started) return;
    started = true;
    ensureUI();
    startPresence();
    listenUserStats();
  }

  return { start, badge, onChatOpened, onChatClosed };
})();