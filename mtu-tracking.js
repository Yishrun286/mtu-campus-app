/* ============================================================
   MTU Campus — Live Delivery Tracking (Leaflet + Firebase Realtime DB)
   v2 — roles: courier | customer | receiver
   ------------------------------------------------------------
   Self-contained & additive: it does NOT touch app.js / auth.js.
   Load it AFTER the other scripts:  <script src="mtu-tracking.js"></script>

   ROLES
     courier   -> shares live GPS (writes to RTDB). Also sees the drop-off pin.
     customer  -> the person who ordered. Watches the courier. NO GPS permission needed.
                  May drop a pin on the map to say where the delivery should go.
     receiver  -> anyone with the link/ID (e.g. the person at the delivery address).
                  Watch-only. NO GPS permission needed.

   DATABASE STRUCTURE (Realtime Database)
     /tracking/{deliveryId}/location    { lat, lng, heading, speed, accuracy, timestamp(server) }
     /tracking/{deliveryId}/status      "active" | "offline" | "stopped"
     /tracking/{deliveryId}/destination { lat, lng, timestamp(server) }   (optional drop-off pin)

   PUBLIC API  (window.MTUTracking)
     openTrackingView(deliveryId, { role, destination })   generic entry point
     openCourierView(deliveryId)
     openCustomerView(deliveryId, { destination }?)
     openReceiverView(deliveryId, { destination }?)
     stopCourierTracking()   stopWatching()
     buildShareLink(deliveryId)
   ============================================================ */
(function () {
  "use strict";
  if (window.MTUTracking) return;

  /* ============================================================
     1. FIREBASE CONFIG
     ============================================================ */
  const TRACKING_FIREBASE_CONFIG = {
    apiKey: "AIzaSyD8jDygdJuOvRc2enSsF2Sw3MLEymTSA9c",
    authDomain: "campus-app-fda0d.firebaseapp.com",
    databaseURL: "https://campus-app-fda0d-default-rtdb.firebaseio.com",
    projectId: "campus-app-fda0d",
    appId: "1:729669684373:web:ca9cb8d562b789ed1b1f9c"
  };

  /* ============================================================
     2. SETTINGS
     ============================================================ */
  const SETTINGS = {
    dbRoot: "tracking",             // tracking/{deliveryId}/...
    minWriteIntervalMs: 3000,       // heartbeat: write at least this often
    minMoveMeters: 5,               // ...or sooner if moved this far
    staleAfterMs: 45000,            // "signal may be lost" warning after this
    animateMs: 1200,                // smooth marker glide between updates
    defaultCenter: [7.6728, 36.8344],
    defaultZoom: 16,
    // Your Mini App direct link, used for "Share link" (receiver opens it inside Telegram).
    // Example: "https://t.me/YourBot/app"  — leave "" to share the delivery ID only.
    miniAppLink: "",
    leaflet: {
      css: "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
      js: "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
    },
    tileUrl: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    tileAttribution: "&copy; <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a> contributors"
  };

  const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
  const ROLES = ["courier", "customer", "receiver"];

  /* ============================================================
     3. Helpers
     ============================================================ */
  const $ = (id) => document.getElementById(id);
  const toast = (m) => (typeof window.showToast === "function" ? window.showToast(m) : console.log("[MTUTracking]", m));
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const reducedMotion = () => window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const isNum = (n) => typeof n === "number" && Number.isFinite(n);

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

  function distMeters(a, b) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  /* ---------- Lazy deps: Leaflet + Firebase RTDB ---------- */
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
  let serverOffset = 0; // serverTime - clientTime, so "x seconds ago" is right even if the phone clock is off
  function getRtdb() {
    if (rtdb) return rtdb;
    const NAME = "mtuTracking";
    let app = firebase.apps.find((a) => a.name === NAME);
    if (!app) app = firebase.initializeApp(TRACKING_FIREBASE_CONFIG, NAME);
    rtdb = app.database();
    rtdb.ref(".info/serverTimeOffset").on("value", (s) => { serverOffset = Number(s.val()) || 0; });
    return rtdb;
  }
  const serverNow = () => Date.now() + serverOffset;

  /* ============================================================
     4. UI — reusable bottom-sheet <dialog> with a map
     ============================================================ */
  let dialog = null;
  let map = null;
  let mode = null;            // "courier" | "customer" | "receiver"
  let currentId = null;
  let sessionToken = 0;

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
      #mtuTrackMap{width:100%;height:56vh;background:#101D31}
      #mtuTrackModal .tk-bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:10px 14px 16px}
      #mtuTrackStatus{flex:1 1 100%;font-size:11px;color:#B8C9DA;line-height:1.4}
      #mtuTrackStatus.err{color:#fca5a5}
      #mtuTrackModal .tk-btn{padding:9px 12px;border-radius:10px;font-size:11px;font-weight:700;color:#06101D;background:linear-gradient(100deg,#18B6D9,#58D7EF)}
      #mtuTrackModal .tk-btn.ghost{color:#8DEBFA;background:rgba(24,182,217,.12);border:1px solid rgba(88,215,239,.3)}
      #mtuTrackModal .tk-btn.stop{color:#fff;background:#DC4545}
      #mtuTrackModal .tk-btn[hidden]{display:none}
      .mtu-pin{display:grid;place-items:center;font-size:22px;filter:drop-shadow(0 3px 4px rgba(0,0,0,.5))}
      .mtu-pin .pin-bg{width:38px;height:38px;border-radius:50%;display:grid;place-items:center;border:2px solid #fff}
      .mtu-pin.courier .pin-bg{background:linear-gradient(135deg,#6D5EF5,#18B6D9)}
      .mtu-pin.dest .pin-bg{background:linear-gradient(135deg,#F59E0B,#F5C451)}
      #mtuTrackMap.picking{cursor:crosshair}
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
        <p id="mtuTrackStatus" aria-live="polite">Starting…</p>
        <button type="button" class="tk-btn" id="mtuTrackFit">Recenter</button>
        <button type="button" class="tk-btn ghost" id="mtuTrackPin" hidden>📍 Set drop-off pin</button>
        <button type="button" class="tk-btn ghost" id="mtuTrackShare" hidden>🔗 Share</button>
        <button type="button" class="tk-btn stop" id="mtuTrackStop" hidden>Stop sharing</button>
      </div>`;
    document.body.appendChild(dialog);

    $("mtuTrackClose").addEventListener("click", () => dialog.close());
    dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close(); });
    // Closing the sheet always stops GPS / listeners (guard: ignore if it was re-opened meanwhile)
    dialog.addEventListener("close", () => { if (!dialog.open) cleanupAll(); });
    $("mtuTrackStop").addEventListener("click", () => dialog.close());
    $("mtuTrackFit").addEventListener("click", () => { autoFit = true; fitToMarkers(); });
    $("mtuTrackPin").addEventListener("click", startPinPick);
    $("mtuTrackShare").addEventListener("click", shareTracking);
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
  let programmatic = false;
  let progTimer = null;
  let anim = null;

  function pinIcon(kind, emoji) {
    return L.divIcon({
      className: `mtu-pin ${kind}`,
      html: `<div class="pin-bg"><span>${emoji}</span></div>`,
      iconSize: [38, 38],
      iconAnchor: [19, 19]
    });
  }

  function initMap() {
    if (anim) { cancelAnimationFrame(anim.id); anim = null; }
    if (map) { try { map.remove(); } catch (e) {} map = null; }
    courierMarker = destMarker = null;
    autoFit = true;
    map = L.map("mtuTrackMap", { zoomControl: true, attributionControl: true })
      .setView(SETTINGS.defaultCenter, SETTINGS.defaultZoom);
    L.tileLayer(SETTINGS.tileUrl, { maxZoom: 19, attribution: SETTINGS.tileAttribution }).addTo(map);

    // Only genuine user gestures turn auto-follow off (not our own fitBounds/panTo)
    map.on("dragstart", () => { autoFit = false; });
    map.on("zoomstart", () => { if (!programmatic) autoFit = false; });
    map.on("moveend", () => { programmatic = false; });

    // The dialog is animated / just shown → Leaflet must re-measure its container
    setTimeout(() => map && map.invalidateSize(), 150);
    setTimeout(() => map && map.invalidateSize(), 500);
  }

  function markProgrammatic() {
    programmatic = true;
    clearTimeout(progTimer);
    progTimer = setTimeout(() => { programmatic = false; }, 1500);
  }

  // Smoothly glide a marker to a new position (ease in-out) instead of jumping
  function moveMarker(marker, to) {
    const from = marker.getLatLng();
    if (anim && anim.marker === marker) { cancelAnimationFrame(anim.id); anim = null; }
    const d = distMeters({ lat: from.lat, lng: from.lng }, { lat: to[0], lng: to[1] });
    if (d < 1 || d > 800 || reducedMotion()) { marker.setLatLng(to); return; }
    const t0 = performance.now(), ms = SETTINGS.animateMs;
    const step = (t) => {
      const k = Math.min(1, (t - t0) / ms);
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      marker.setLatLng([from.lat + (to[0] - from.lat) * e, from.lng + (to[1] - from.lng) * e]);
      if (k < 1) anim.id = requestAnimationFrame(step); else anim = null;
    };
    anim = { marker, id: requestAnimationFrame(step) };
  }

  function setCourierMarker(lat, lng, label) {
    if (!map) return;
    const ll = [lat, lng];
    if (!courierMarker) {
      courierMarker = L.marker(ll, { icon: pinIcon("courier", "🛵"), title: label || "Delivery" }).addTo(map);
      courierMarker.bindTooltip(label || "Delivery Guy", { direction: "top", offset: [0, -18] });
    } else {
      moveMarker(courierMarker, ll);
    }
  }

  function setDestMarker(lat, lng) {
    if (!map) return;
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
    markProgrammatic();
    if (pts.length === 1) { map.setView(pts[0], Math.max(map.getZoom(), SETTINGS.defaultZoom), { animate: true }); return; }
    map.fitBounds(L.latLngBounds(pts), { padding: [50, 50], maxZoom: 18, animate: true });
  }

  /* ============================================================
     5. Destination pin (shared by all roles to READ; customer may WRITE)
     ============================================================ */
  let watchRef = null;       // ref of tracking/{id} we are listening on
  let locHandler = null;
  let destHandler = null;
  let statusHandler = null;
  let staleTimer = null;
  let lastCourierTs = 0;
  let courierStatus = null;  // "active" | "offline" | "stopped" | null

  function listenDestination(ref, opts) {
    watchRef = ref;
    if (opts && opts.destination && isNum(opts.destination.lat) && isNum(opts.destination.lng)) {
      setDestMarker(opts.destination.lat, opts.destination.lng);
    }
    destHandler = ref.child("destination").on("value", (s) => {
      const d = s.val();
      if (d && isNum(d.lat) && isNum(d.lng)) {
        setDestMarker(d.lat, d.lng);
        if (autoFit) fitToMarkers();
      }
    });
  }

  function startPinPick() {
    if (!map || mode !== "customer" || !currentId) return;
    setStatus("Tap the map where the courier should deliver…");
    $("mtuTrackMap").classList.add("picking");
    autoFit = false;
    map.once("click", (e) => {
      $("mtuTrackMap").classList.remove("picking");
      const { lat, lng } = e.latlng;
      setDestMarker(lat, lng);
      rtdb.ref(`${SETTINGS.dbRoot}/${currentId}/destination`).set({
        lat, lng, timestamp: firebase.database.ServerValue.TIMESTAMP
      }).then(() => { setStatus("Drop-off pin saved. The courier can see it."); })
        .catch((err) => { console.error(err); setStatus("Could not save the pin (check database rules).", true); });
    });
  }

  /* ---------- Share (receiver link) ---------- */
  function buildShareLink(deliveryId) {
    const base = SETTINGS.miniAppLink;
    return base ? `${base}${base.includes("?") ? "&" : "?"}startapp=track_${deliveryId}` : "";
  }

  function shareTracking() {
    if (!currentId) return;
    const link = buildShareLink(currentId);
    const text = "Track my delivery live 🛵";
    const tg = window.Telegram && window.Telegram.WebApp;
    if (link && tg && typeof tg.openTelegramLink === "function") {
      tg.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`);
      return;
    }
    const payload = link || currentId;
    if (navigator.share && link) { navigator.share({ title: "MTU Campus", text, url: link }).catch(() => {}); return; }
    if (navigator.clipboard) {
      navigator.clipboard.writeText(payload).then(
        () => setStatus(link ? "Tracking link copied." : "Delivery ID copied: " + payload),
        () => setStatus("Delivery ID: " + payload)
      );
    } else setStatus("Delivery ID: " + payload);
  }

  /* ============================================================
     6. COURIER — watchPosition → Realtime Database
     ============================================================ */
  let watchId = null;
  let courierRef = null;
  let connRef = null;
  let connHandler = null;
  let lastWrite = { t: 0, lat: null, lng: null };
  let usedLowAccuracyFallback = false;
  let wakeLock = null;

  function geoErrorMessage(err) {
    switch (err && err.code) {
      case 1: return "Location permission denied. Enable location for Telegram/your browser in phone Settings, then reopen.";
      case 2: return "Your position is unavailable. Check that GPS/Location is turned on.";
      case 3: return "Getting your location timed out. Move to an open area and try again.";
      default: return "Could not read your location.";
    }
  }

  function pushLocation(pos) {
    if (!courierRef) return;
    const c = pos.coords;
    const here = { lat: c.latitude, lng: c.longitude };

    setCourierMarker(here.lat, here.lng, "You");
    if (autoFit) fitToMarkers();

    // Throttle DB writes (saves battery + quota), but keep a heartbeat
    const now = Date.now();
    const moved = lastWrite.lat == null ? Infinity : distMeters(here, { lat: lastWrite.lat, lng: lastWrite.lng });
    if (now - lastWrite.t < SETTINGS.minWriteIntervalMs && moved < SETTINGS.minMoveMeters) return;
    lastWrite = { t: now, lat: here.lat, lng: here.lng };

    // One atomic multi-path update: new location + status:"active"
    courierRef.update({
      location: {
        lat: here.lat,
        lng: here.lng,
        heading: Number.isFinite(c.heading) ? c.heading : null,
        speed: Number.isFinite(c.speed) ? c.speed : null,
        accuracy: Number.isFinite(c.accuracy) ? Math.round(c.accuracy) : null,
        timestamp: firebase.database.ServerValue.TIMESTAMP
      },
      status: "active"
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

  async function requestWakeLock() {
    try { if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen"); } catch (e) { wakeLock = null; }
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && mode === "courier" && courierRef) requestWakeLock();
  });

  function stopCourierTracking() {
    if (watchId != null) { try { navigator.geolocation.clearWatch(watchId); } catch (e) {} watchId = null; }
    if (connRef && connHandler) { try { connRef.off("value", connHandler); } catch (e) {} }
    connRef = connHandler = null;
    if (courierRef) {
      try { courierRef.child("status").onDisconnect().cancel(); } catch (e) {}
      courierRef.child("status").set("stopped").catch(() => {});
      courierRef = null;
    }
    if (wakeLock) { try { wakeLock.release(); } catch (e) {} wakeLock = null; }
  }

  async function startCourier(deliveryId) {
    if (!("geolocation" in navigator)) return toast("This device does not support GPS location");

    $("mtuTrackTitle").textContent = "Sharing your live location";
    $("mtuTrackStop").hidden = false;
    setStatus("Waiting for GPS permission…");

    courierRef = rtdb.ref(`${SETTINGS.dbRoot}/${deliveryId}`);
    lastWrite = { t: 0, lat: null, lng: null };
    usedLowAccuracyFallback = false;

    // Re-arm "offline on disconnect" and re-assert "active" on EVERY (re)connect
    connRef = rtdb.ref(".info/connected");
    connHandler = connRef.on("value", (s) => {
      if (s.val() === true && courierRef) {
        courierRef.child("status").onDisconnect().set("offline").catch(() => {});
        courierRef.child("status").set("active").catch(() => {});
      }
    });

    listenDestination(courierRef);   // courier sees the drop-off pin if one exists
    requestWakeLock();               // keep the screen on so GPS keeps flowing
    startWatch(true);
  }

  /* ============================================================
     7. CUSTOMER / RECEIVER — read-only listeners (NO GPS needed)
     ============================================================ */
  function updateStaleLabel() {
    if (mode !== "customer" && mode !== "receiver") return;
    if (courierStatus === "stopped") return setStatus("The delivery person stopped sharing their location.", true);
    if (!lastCourierTs) return setStatus("Waiting for the delivery person to start sharing…");
    const age = Math.max(0, serverNow() - lastCourierTs);
    const secs = Math.round(age / 1000);
    if (courierStatus === "offline" || age > SETTINGS.staleAfterMs) {
      setStatus(`Last update ${secs < 120 ? secs + "s" : Math.round(secs / 60) + " min"} ago — signal may be lost`, true);
    } else {
      setStatus("Live • updated " + (secs < 5 ? "just now" : secs + "s ago"));
    }
  }

  function startViewer(deliveryId, opts) {
    $("mtuTrackTitle").textContent = mode === "receiver" ? "Delivery on the way" : "Track your delivery";
    $("mtuTrackStop").hidden = true;
    $("mtuTrackPin").hidden = mode !== "customer";
    $("mtuTrackShare").hidden = mode !== "customer";
    setStatus("Connecting…");

    lastCourierTs = 0;
    courierStatus = null;
    const ref = rtdb.ref(`${SETTINGS.dbRoot}/${deliveryId}`);
    listenDestination(ref, opts);

    locHandler = ref.child("location").on("value", (snap) => {
      const v = snap.val();
      if (!v || !isNum(v.lat) || !isNum(v.lng)) { updateStaleLabel(); return; }
      lastCourierTs = Number(v.timestamp) || serverNow();
      setCourierMarker(v.lat, v.lng, "Delivery Guy");
      if (autoFit) fitToMarkers();
      updateStaleLabel();
    }, (err) => {
      console.error("[MTUTracking] listen failed:", err);
      setStatus(/permission/i.test((err && err.message) || "")
        ? "Database rules blocked reading this delivery."
        : "Could not connect to live tracking.", true);
    });

    statusHandler = ref.child("status").on("value", (s) => {
      courierStatus = s.val();
      updateStaleLabel();
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
     8. Entry points
     ============================================================ */
  async function openTrackingView(deliveryId, opts = {}) {
    const role = ROLES.includes(opts.role) ? opts.role : "customer";
    if (!ID_RE.test(String(deliveryId || ""))) return toast("Invalid delivery ID");

    try { await ensureDeps(); getRtdb(); }
    catch (e) { console.error(e); return toast(e.message || "Tracking could not start"); }

    cleanupAll();
    sessionToken++;
    mode = role;
    currentId = deliveryId;

    buildDialog();
    $("mtuTrackSub").textContent = "Delivery " + deliveryId;
    $("mtuTrackPin").hidden = true;
    $("mtuTrackShare").hidden = true;
    $("mtuTrackStop").hidden = true;
    if (!dialog.open) dialog.showModal();
    initMap();

    if (role === "courier") await startCourier(deliveryId);
    else startViewer(deliveryId, opts);
  }

  const openCourierView = (id) => openTrackingView(id, { role: "courier" });
  const openCustomerView = (id, opts = {}) => openTrackingView(id, { ...opts, role: "customer" });
  const openReceiverView = (id, opts = {}) => openTrackingView(id, { ...opts, role: "receiver" });

  function cleanupAll() {
    stopCourierTracking();
    stopWatching();
    if (anim) { cancelAnimationFrame(anim.id); anim = null; }
    if (map) { try { map.remove(); } catch (e) {} map = null; }
    courierMarker = destMarker = null;
    mode = null;
    currentId = null;
  }

  /* ============================================================
     9. Errand-card integration (automatic)
        errand owner → "track" (customer)   ·   everyone else → "start delivery" (courier)
        Both derive the SAME deliveryId from the errand's Firestore id.
     ============================================================ */
  const trackDeliveryId = (errandId) => "E_" + String(errandId).replace(/[^A-Za-z0-9_-]/g, "");

  const BTN_STYLE = "width:100%;padding:9px 12px;border-radius:10px;font-size:11px;font-weight:700;";
  const COURIER_STYLE = BTN_STYLE + "background:rgba(24,182,217,.15);border:1px solid rgba(88,215,239,.35);color:#8DEBFA;";
  const CUSTOMER_STYLE = BTN_STYLE + "background:rgba(109,94,245,.18);border:1px solid rgba(154,143,255,.4);color:#B0A5FF;";

  function injectErrandButtons() {
    const feed = $("errandFeed");
    if (!feed) return;
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

  document.addEventListener("click", (ev) => {
    const b = ev.target.closest && ev.target.closest("[data-mtu-track]");
    if (!b) return;
    ev.preventDefault();
    const deliveryId = trackDeliveryId(b.dataset.eid);

    if (b.dataset.mtuTrack === "courier") {
      if (window.MTUAuth && !window.MTUAuth.isApproved()) { window.MTUAuth.open(); return; }
      openCourierView(deliveryId);
    } else {
      openCustomerView(deliveryId);
    }
  });

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
     10. Deep link: receiver opens   t.me/YourBot/app?startapp=track_<deliveryId>
         (or ?track=<deliveryId> in a normal browser) → read-only live map
     ============================================================ */
  (function handleDeepLink() {
    let id = null;
    try {
      const tg = window.Telegram && window.Telegram.WebApp;
      const sp = tg && tg.initDataUnsafe && tg.initDataUnsafe.start_param;
      if (sp && /^track_/.test(sp)) id = sp.slice(6);
      if (!id) id = new URLSearchParams(location.search).get("track");
    } catch (e) {}
    if (id && ID_RE.test(id)) setTimeout(() => openReceiverView(id), 500);
  })();

  /* ============================================================
     11. Public API
     ============================================================ */
  window.MTUTracking = Object.freeze({
    openTrackingView,
    openCourierView,
    openCustomerView,
    openReceiverView,
    stopCourierTracking,
    stopWatching,
    buildShareLink,
    config: SETTINGS
  });
})();