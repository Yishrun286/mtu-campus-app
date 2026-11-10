/* ============================================================
   MTU Campus — Live Delivery Tracking (Leaflet + Firebase Realtime DB)
   ------------------------------------------------------------
   Self-contained & additive: it does NOT touch app.js / auth.js.
   Load it AFTER the other scripts:  <script src="mtu-tracking.js"></script>

   PUBLIC API  (window.MTUTracking)
     MTUTracking.openCourierView(deliveryId)    -> courier: asks GPS permission, starts sharing, shows map
     MTUTracking.openCustomerView(deliveryId, {destination:{lat,lng}}?) -> customer: live map
     MTUTracking.stopCourierTracking()          -> stop sharing (also called when the sheet closes)
     MTUTracking.stopWatching()                 -> stop listening (customer)
   ============================================================ */
(function () {
  "use strict";
  if (window.MTUTracking) return;

  /* ============================================================
     1. FIREBASE CONFIG — PASTE YOUR OWN VALUES HERE
        Realtime Database needs `databaseURL` (Firebase console →
        Build → Realtime Database → copy the URL).
        A separate named app is used so your existing Firestore
        config/init in app.js is never modified.
     ============================================================ */
  const TRACKING_FIREBASE_CONFIG = {
    apiKey: "AIzaSyD8jDygdJuOvRc2enSsF2Sw3MLEymTSA9c",
    authDomain: "campus-app-fda0d.firebaseapp.com",
    databaseURL: "https://campus-app-fda0d-default-rtdb.firebaseio.com", // <-- REQUIRED for Realtime DB
    projectId: "campus-app-fda0d",
    appId: "1:729669684373:web:ca9cb8d562b789ed1b1f9c"
  };

  /* ============================================================
     2. SETTINGS
     ============================================================ */
  const SETTINGS = {
    dbRoot: "deliveries",          // deliveries/{deliveryId}/location
    minWriteIntervalMs: 3000,      // don't write to the DB more often than this
    minMoveMeters: 5,              // ...unless moved at least this far
    staleAfterMs: 45000,           // customer sees "last seen Xs ago" warning after this
    defaultCenter: [7.6728, 36.8344], // fallback map centre (Mizan-Tepi area) — change if needed
    defaultZoom: 15,
    leaflet: {
      css: "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
      js: "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
    },
    tileUrl: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    tileAttribution: "&copy; <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a> contributors"
  };

  // deliveryId must be unguessable-ish and path-safe (no . # $ [ ] /)
  const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

  /* ============================================================
     3. Small helpers
     ============================================================ */
  const $ = (id) => document.getElementById(id);
  const toast = (m) => (typeof window.showToast === "function" ? window.showToast(m) : console.log("[MTUTracking]", m));
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function loadScriptOnce(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) return resolve();
      const s = document.createElement("script");
      s.src = src; s.async = true;
      s.onload = resolve;
      s.onerror = () => reject(new Error("Failed to load " + src));
      document.head.appendChild(s);
    });
  }
  function loadCssOnce(href) {
    if (document.querySelector(`link[href="${href}"]`)) return;
    const l = document.createElement("link");
    l.rel = "stylesheet"; l.href = href;
    document.head.appendChild(l);
  }

  function distMeters(a, b) { // haversine
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  /* ---------- Lazy dependencies: Leaflet + Firebase RTDB ---------- */
  let depsPromise = null;
  function ensureDeps() {
    if (depsPromise) return depsPromise;
    depsPromise = (async () => {
      loadCssOnce(SETTINGS.leaflet.css);
      if (!window.L) await loadScriptOnce(SETTINGS.leaflet.js);
      if (typeof firebase === "undefined") throw new Error("Firebase SDK is not loaded");
      if (!firebase.database) {
        await loadScriptOnce("https://www.gstatic.com/firebasejs/10.8.0/firebase-database-compat.js");
      }
    })().catch((e) => { depsPromise = null; throw e; });
    return depsPromise;
  }

  /* ---------- Realtime DB handle (separate named app) ---------- */
  let rtdb = null;
  function getRtdb() {
    if (rtdb) return rtdb;
    if (/YOUR_/.test(TRACKING_FIREBASE_CONFIG.apiKey) || /YOUR_/.test(TRACKING_FIREBASE_CONFIG.databaseURL)) {
      throw new Error("Tracking is not configured: fill TRACKING_FIREBASE_CONFIG in mtu-tracking.js");
    }
    const NAME = "mtuTracking";
    let app = firebase.apps.find((a) => a.name === NAME);
    if (!app) app = firebase.initializeApp(TRACKING_FIREBASE_CONFIG, NAME);
    rtdb = app.database();
    return rtdb;
  }

  /* ============================================================
     4. UI — one reusable bottom-sheet <dialog> with a map
        Injected on demand; uses its own scoped CSS (#mtuTrackModal).
     ============================================================ */
  let dialog = null;
  let map = null;
  let tileLayer = null;
  let mode = null; // "courier" | "customer"

  function injectStyles() {
    if ($("mtu-track-style")) return;
    const st = document.createElement("style");
    st.id = "mtu-track-style";
    st.textContent = `
      dialog#mtuTrackModal{margin:auto 0 0;padding:0;width:100%;max-width:440px;left:50%;transform:translateX(-50%);
        border:1px solid rgba(148,181,214,.16);border-radius:24px 24px 0 0;background:#0B1728;color:#F4F8FC;overflow:hidden}
      dialog#mtuTrackModal::backdrop{background:rgba(3,5,8,.65);backdrop-filter:blur(3px)}
      #mtuTrackModal .tk-head{display:flex;align-items:center;gap:10px;padding:14px 16px}
      #mtuTrackModal .tk-title{font:700 15px 'Space Grotesk',sans-serif}
      #mtuTrackModal .tk-sub{font-size:11px;color:#91A4BA;margin-top:2px}
      #mtuTrackModal .tk-close{margin-left:auto;width:32px;height:32px;border-radius:999px;background:#1C304A;color:#CBD5E1;font-size:15px}
      #mtuTrackMap{width:100%;height:58vh;background:#101D31}
      #mtuTrackModal .tk-bar{display:flex;align-items:center;gap:8px;padding:10px 14px 16px}
      #mtuTrackStatus{flex:1;font-size:11px;color:#B8C9DA;line-height:1.4}
      #mtuTrackStatus.err{color:#fca5a5}
      #mtuTrackModal .tk-btn{padding:9px 12px;border-radius:10px;font-size:11px;font-weight:700;color:#06101D;background:linear-gradient(100deg,#18B6D9,#58D7EF)}
      #mtuTrackModal .tk-btn.stop{color:#fff;background:#DC4545}
      .mtu-pin{display:grid;place-items:center;font-size:22px;filter:drop-shadow(0 3px 4px rgba(0,0,0,.5))}
      .mtu-pin .pin-rot{transition:transform .4s ease}
      .mtu-pin .pin-bg{width:38px;height:38px;border-radius:50%;display:grid;place-items:center;border:2px solid #fff}
      .mtu-pin.courier .pin-bg{background:linear-gradient(135deg,#6D5EF5,#18B6D9)}
      .mtu-pin.dest .pin-bg{background:linear-gradient(135deg,#F59E0B,#F5C451)}
    `;
    document.head.appendChild(st);
  }

  function buildDialog() {
    if (dialog) return dialog;
    injectStyles();
    dialog = document.createElement("dialog");
    dialog.id = "mtuTrackModal";
    dialog.innerHTML = `
      <div class="tk-head">
        <div>
          <p class="tk-title" id="mtuTrackTitle">Live tracking</p>
          <p class="tk-sub" id="mtuTrackSub"></p>
        </div>
        <button type="button" class="tk-close" id="mtuTrackClose" aria-label="Close">✕</button>
      </div>
      <div id="mtuTrackMap"></div>
      <div class="tk-bar">
        <p id="mtuTrackStatus">Starting…</p>
        <button type="button" class="tk-btn" id="mtuTrackFit">Recenter</button>
        <button type="button" class="tk-btn stop" id="mtuTrackStop" hidden>Stop sharing</button>
      </div>`;
    document.body.appendChild(dialog);

    $("mtuTrackClose").addEventListener("click", () => dialog.close());
    dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close(); });
    dialog.addEventListener("close", cleanupAll); // closing the sheet always stops GPS / listeners
    $("mtuTrackStop").addEventListener("click", () => dialog.close());
    $("mtuTrackFit").addEventListener("click", () => { autoFit = true; fitToMarkers(); });
    return dialog;
  }

  function setStatus(text, isError = false) {
    const el = $("mtuTrackStatus");
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("err", !!isError);
  }

  /* ---------- Map + markers ---------- */
  let courierMarker = null;
  let destMarker = null;
  let autoFit = true;

  function pinIcon(kind, emoji, heading) {
    const rot = Number.isFinite(heading) ? `style="transform:rotate(${0}deg)"` : "";
    return L.divIcon({
      className: `mtu-pin ${kind}`,
      html: `<div class="pin-bg"><span ${rot}>${emoji}</span></div>`,
      iconSize: [38, 38],
      iconAnchor: [19, 19]
    });
  }

  function initMap() {
    if (map) { map.remove(); map = null; }
    courierMarker = destMarker = null;
    autoFit = true;
    map = L.map("mtuTrackMap", { zoomControl: true, attributionControl: true })
      .setView(SETTINGS.defaultCenter, SETTINGS.defaultZoom);
    tileLayer = L.tileLayer(SETTINGS.tileUrl, { maxZoom: 19, attribution: SETTINGS.tileAttribution }).addTo(map);
    map.on("dragstart zoomstart", (e) => { if (e && e.originalEvent !== undefined || e.type === "dragstart") autoFit = false; });
    // Dialog is animated/just shown → Leaflet must re-measure its container
    setTimeout(() => map && map.invalidateSize(), 150);
    setTimeout(() => map && map.invalidateSize(), 500);
  }

  function setCourierMarker(lat, lng, label) {
    const ll = [lat, lng];
    if (!courierMarker) {
      courierMarker = L.marker(ll, { icon: pinIcon("courier", "🛵"), title: label || "Delivery" }).addTo(map);
      courierMarker.bindTooltip(label || "Delivery Guy", { direction: "top", offset: [0, -18] });
    } else {
      courierMarker.setLatLng(ll); // smooth enough for 3s updates; swap for an animation lib if desired
    }
  }

  function setDestMarker(lat, lng) {
    const ll = [lat, lng];
    if (!destMarker) {
      destMarker = L.marker(ll, { icon: pinIcon("dest", "📍"), title: "Destination" }).addTo(map);
      destMarker.bindTooltip("Delivery location", { direction: "top", offset: [0, -18] });
    } else {
      destMarker.setLatLng(ll);
    }
  }

  function fitToMarkers() {
    if (!map) return;
    const pts = [courierMarker, destMarker].filter(Boolean).map((m) => m.getLatLng());
    if (pts.length === 0) return;
    if (pts.length === 1) { map.setView(pts[0], Math.max(map.getZoom(), SETTINGS.defaultZoom)); return; }
    map.fitBounds(L.latLngBounds(pts), { padding: [50, 50], maxZoom: 18 });
  }

  /* ============================================================
     5. COURIER  — watchPosition → Realtime Database
     ============================================================ */
  let watchId = null;
  let courierRef = null;
  let lastWrite = { t: 0, lat: null, lng: null };
  let usedLowAccuracyFallback = false;

  function geoErrorMessage(err) {
    switch (err && err.code) {
      case 1: return "Location permission denied. Enable location for Telegram/your browser in phone Settings, then reopen.";
      case 2: return "Your position is unavailable. Check that GPS/Location is turned on.";
      case 3: return "Getting your location timed out. Move to an open area and try again.";
      default: return "Could not read your location.";
    }
  }

  function pushLocation(pos) {
    if (!courierRef) return; // sheet was closed while a fix was in flight
    const c = pos.coords;
    const here = { lat: c.latitude, lng: c.longitude };

    // Always show own position locally
    setCourierMarker(here.lat, here.lng, "You");
    if (autoFit) fitToMarkers();

    // Throttle DB writes (saves battery + quota)
    const now = Date.now();
    const moved = lastWrite.lat == null ? Infinity : distMeters(here, { lat: lastWrite.lat, lng: lastWrite.lng });
    if (now - lastWrite.t < SETTINGS.minWriteIntervalMs && moved < SETTINGS.minMoveMeters) return;
    lastWrite = { t: now, lat: here.lat, lng: here.lng };

    courierRef.child("location").set({
      lat: here.lat,
      lng: here.lng,
      heading: Number.isFinite(c.heading) ? c.heading : null, // null when stationary / unsupported
      speed: Number.isFinite(c.speed) ? c.speed : null,
      accuracy: Number.isFinite(c.accuracy) ? Math.round(c.accuracy) : null,
      timestamp: firebase.database.ServerValue.TIMESTAMP
    }).then(() => {
      setStatus(`Sharing live location • accuracy ±${Math.round(c.accuracy || 0)} m`);
    }).catch((err) => {
      console.error("[MTUTracking] write failed:", err);
      setStatus(err && /permission/i.test(err.message || "")
        ? "Database rules blocked the update. Check your Realtime Database rules."
        : "Could not upload location. Retrying…", true);
    });
  }

  function startWatch(highAccuracy) {
    watchId = navigator.geolocation.watchPosition(
      pushLocation,
      (err) => {
        console.warn("[MTUTracking] geolocation error:", err);
        // Timeout/unavailable with high accuracy → retry once with low accuracy (network location)
        if (highAccuracy && !usedLowAccuracyFallback && err.code !== 1) {
          usedLowAccuracyFallback = true;
          if (watchId != null) navigator.geolocation.clearWatch(watchId);
          setStatus("GPS signal weak — switching to approximate location…", true);
          startWatch(false);
          return;
        }
        setStatus(geoErrorMessage(err), true);
      },
      { enableHighAccuracy: highAccuracy, maximumAge: 2000, timeout: highAccuracy ? 15000 : 20000 }
    );
  }

  async function openCourierView(deliveryId) {
    if (!ID_RE.test(String(deliveryId || ""))) return toast("Invalid delivery ID");
    if (!("geolocation" in navigator)) return toast("This device does not support GPS location");

    try { await ensureDeps(); getRtdb(); }
    catch (e) { console.error(e); return toast(e.message || "Tracking could not start"); }

    cleanupAll();
    mode = "courier";
    buildDialog();
    $("mtuTrackTitle").textContent = "Sharing your live location";
    $("mtuTrackSub").textContent = "Delivery " + deliveryId;
    $("mtuTrackStop").hidden = false;
    setStatus("Waiting for GPS permission…");
    if (!dialog.open) dialog.showModal();
    initMap();

    courierRef = rtdb.ref(`${SETTINGS.dbRoot}/${deliveryId}`);
    lastWrite = { t: 0, lat: null, lng: null };
    usedLowAccuracyFallback = false;

    // Mark active; flip to offline automatically if the courier's connection drops
    courierRef.child("status").set("active").catch(() => {});
    courierRef.child("status").onDisconnect().set("offline").catch(() => {});

    startWatch(true);
  }

  function stopCourierTracking() {
    if (watchId != null) { try { navigator.geolocation.clearWatch(watchId); } catch (e) {} watchId = null; }
    if (courierRef) {
      try { courierRef.child("status").onDisconnect().cancel(); } catch (e) {}
      courierRef.child("status").set("stopped").catch(() => {});
      courierRef = null;
    }
  }

  /* ============================================================
     6. CUSTOMER  — listen to Realtime Database
     ============================================================ */
  let watchRef = null;
  let locHandler = null;
  let destHandler = null;
  let statusHandler = null;
  let staleTimer = null;
  let lastCourierTs = 0;
  let customerGeoDone = false;

  function updateStaleLabel() {
    if (mode !== "customer") return;
    if (!lastCourierTs) return setStatus("Waiting for the delivery person to start sharing…");
    const age = Date.now() - lastCourierTs;
    const secs = Math.round(age / 1000);
    if (age > SETTINGS.staleAfterMs) setStatus(`Last update ${secs < 120 ? secs + "s" : Math.round(secs / 60) + " min"} ago — signal may be lost`, true);
    else setStatus("Live • updated " + (secs < 5 ? "just now" : secs + "s ago"));
  }

  async function openCustomerView(deliveryId, opts = {}) {
    if (!ID_RE.test(String(deliveryId || ""))) return toast("Invalid delivery ID");

    try { await ensureDeps(); getRtdb(); }
    catch (e) { console.error(e); return toast(e.message || "Tracking could not start"); }

    cleanupAll();
    mode = "customer";
    buildDialog();
    $("mtuTrackTitle").textContent = "Track your delivery";
    $("mtuTrackSub").textContent = "Delivery " + deliveryId;
    $("mtuTrackStop").hidden = true;
    setStatus("Connecting…");
    if (!dialog.open) dialog.showModal();
    initMap();

    lastCourierTs = 0;
    customerGeoDone = false;
    watchRef = rtdb.ref(`${SETTINGS.dbRoot}/${deliveryId}`);

    // --- Destination: explicit option → customer's own GPS → deliveries/{id}/destination in DB
    if (opts.destination && Number.isFinite(opts.destination.lat) && Number.isFinite(opts.destination.lng)) {
      setDestMarker(opts.destination.lat, opts.destination.lng);
      customerGeoDone = true;
    } else if ("geolocation" in navigator) {
      navigator.geolocation.getCurrentPosition(
        (p) => { customerGeoDone = true; setDestMarker(p.coords.latitude, p.coords.longitude); if (autoFit) fitToMarkers(); },
        (err) => { console.warn("[MTUTracking] customer location:", err); toast(geoErrorMessage(err)); },
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }
      );
    }
    destHandler = watchRef.child("destination").on("value", (s) => {
      const d = s.val();
      if (d && !customerGeoDone && Number.isFinite(d.lat) && Number.isFinite(d.lng)) {
        setDestMarker(d.lat, d.lng);
        if (autoFit) fitToMarkers();
      }
    });

    // --- Courier location stream
    locHandler = watchRef.child("location").on("value", (snap) => {
      const v = snap.val();
      if (!v || !Number.isFinite(v.lat) || !Number.isFinite(v.lng)) { updateStaleLabel(); return; }
      lastCourierTs = Number(v.timestamp) || Date.now();
      setCourierMarker(v.lat, v.lng, "Delivery Guy");
      if (autoFit) fitToMarkers();
      updateStaleLabel();
    }, (err) => {
      console.error("[MTUTracking] listen failed:", err);
      setStatus(/permission/i.test(err && err.message || "")
        ? "Database rules blocked reading this delivery."
        : "Could not connect to live tracking.", true);
    });

    // --- Courier status (active / offline / stopped)
    statusHandler = watchRef.child("status").on("value", (s) => {
      if (s.val() === "stopped") setStatus("The delivery person stopped sharing their location.", true);
    });

    staleTimer = setInterval(updateStaleLabel, 5000);
  }

  function stopWatching() {
    if (watchRef) {
      try { if (locHandler) watchRef.child("location").off("value", locHandler); } catch (e) {}
      try { if (destHandler) watchRef.child("destination").off("value", destHandler); } catch (e) {}
      try { if (statusHandler) watchRef.child("status").off("value", statusHandler); } catch (e) {}
    }
    watchRef = locHandler = destHandler = statusHandler = null;
    clearInterval(staleTimer); staleTimer = null;
  }

  /* ============================================================
     7. Cleanup (runs on sheet close and before every new session)
     ============================================================ */
  function cleanupAll() {
    stopCourierTracking();
    stopWatching();
    if (map) { try { map.remove(); } catch (e) {} map = null; }
    courierMarker = destMarker = null;
    mode = null;
  }

  /* ============================================================
     8. ERRAND-CARD INTEGRATION (automatic — no app.js / index.html edits)
        Adds a button under every card in the Express "Delivery requests" feed:
          • errand's owner  → "📍 ዴሊቨሪውን ተከታተል"  (customer view)
          • everyone else   → "🛵 ዴሊቨሪ ጀምር"        (courier view, needs approved ID)
        Both sides derive the SAME deliveryId from the errand's Firestore id.
     ============================================================ */
  const trackDeliveryId = (errandId) => "E_" + String(errandId).replace(/[^A-Za-z0-9_-]/g, "");

  const BTN_STYLE = "width:100%;padding:9px 12px;border-radius:10px;font-size:11px;font-weight:700;";
  const COURIER_STYLE = BTN_STYLE + "background:rgba(24,182,217,.15);border:1px solid rgba(88,215,239,.35);color:#8DEBFA;";
  const CUSTOMER_STYLE = BTN_STYLE + "background:rgba(109,94,245,.18);border:1px solid rgba(154,143,255,.4);color:#B0A5FF;";

  function injectErrandButtons() {
    const feed = $("errandFeed");
    if (!feed) return;
    // ERRANDS / currentUserId are top-level globals from app.js
    const list = typeof ERRANDS !== "undefined" && Array.isArray(ERRANDS) ? ERRANDS : [];
    const myId = typeof currentUserId !== "undefined" ? String(currentUserId) : "";

    feed.querySelectorAll('[data-action="contact-errand"]').forEach((contactBtn) => {
      const host = contactBtn.closest(".flex-1");
      if (!host || host.querySelector(".mtu-track-row")) return;

      const eid = contactBtn.dataset.id;
      const errand = list.find((x) => String(x.id) === String(eid));
      if (!errand) return;

      const isRequester = !!errand.userId && String(errand.userId) === myId;
      const row = document.createElement("div");
      row.className = "mtu-track-row";
      row.style.marginTop = "8px";
      row.innerHTML = isRequester
        ? `<button type="button" data-mtu-track="customer" data-eid="${esc(eid)}" style="${CUSTOMER_STYLE}">📍 ዴሊቨሪውን ተከታተል</button>`
        : `<button type="button" data-mtu-track="courier" data-eid="${esc(eid)}" style="${COURIER_STYLE}">🛵 ዴሊቨሪ ጀምር (ቦታዬን አጋራ)</button>`;
      host.appendChild(row);
    });
  }

  // Click handling (delegated, so it survives the feed re-rendering)
  document.addEventListener("click", (ev) => {
    const b = ev.target.closest && ev.target.closest("[data-mtu-track]");
    if (!b) return;
    ev.preventDefault();
    const deliveryId = trackDeliveryId(b.dataset.eid);

    if (b.dataset.mtuTrack === "courier") {
      // Respect the existing ID verification (auth.js), if present
      if (window.MTUAuth && !window.MTUAuth.isApproved()) { window.MTUAuth.open(); return; }
      openCourierView(deliveryId);
    } else {
      openCustomerView(deliveryId);
    }
  });

  // Re-inject whenever app.js re-renders the errand feed
  (function watchErrandFeed() {
    const feed = $("errandFeed");
    if (!feed) return;
    let scheduled = false;
    new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => { scheduled = false; injectErrandButtons(); });
    }).observe(feed, { childList: true, subtree: true });
    injectErrandButtons();
  })();

  /* ============================================================
     9. Public API
     ============================================================ */
  window.MTUTracking = Object.freeze({
    openCourierView,
    openCustomerView,
    stopCourierTracking,
    stopWatching,
    config: SETTINGS
  });
})();