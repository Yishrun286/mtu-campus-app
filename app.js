/* ============================================================
   MTU Campus — Firebase Production Logic & Real-time Sync
   Tabs: Marketplace · Campus Express & Emergency · Lost & Found
   Includes: real-time chat, inbox, notifications & unread badges
   ============================================================ */

// ---------------- Firebase Configuration & Init ----------------
const firebaseConfig = {
  apiKey: "AIzaSyD8jDygdJuOvRc2enSsF2Sw3MLEymTSA9c",
  authDomain: "campus-app-fda0d.firebaseapp.com",
  projectId: "campus-app-fda0d",
  storageBucket: "campus-app-fda0d.firebasestorage.app",
  messagingSenderId: "729669684373",
  appId: "1:729669684373:web:ca9cb8d562b789ed1b1f9c",
  measurementId: "G-5MX45YW60L"
};

// If the SDK is blocked / fails to load, the app must still boot (so we can show errors)
let db = null;
try {
  if (typeof firebase === "undefined") throw new Error("Firebase SDK did not load");
  if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
  db = firebase.firestore();
} catch (e) {
  console.error("[MTU] Firebase init failed:", e);
}

// ---------------- Config flags ----------------
// tg.sendData() CLOSES the Mini App and only works for keyboard-button launches.
// Keep false unless your bot really needs the data.
const SEND_DATA_TO_BOT = false;
const WRITE_TIMEOUT_MS = 20000;

// ---------------- Safe localStorage (can throw in some WebViews) ----------------
const safeStorage = {
  get(key) { try { return localStorage.getItem(key); } catch (e) { return null; } },
  set(key, val) { try { localStorage.setItem(key, val); } catch (e) { /* ignore */ } }
};

// ---------------- Admin Setup & Telegram WebApp ----------------
const ADMIN_USERNAME = "yishrun"; // Admin Telegram Username (without @)

const tg = window.Telegram?.WebApp;
if (tg) {
  try { tg.ready(); tg.expand(); } catch (e) { console.warn(e); }
}

function getOrCreateDeviceId() {
  let deviceId = safeStorage.get("mtu_device_id");
  if (!deviceId) {
    deviceId = "dev_" + Math.random().toString(36).substring(2, 9) + "_" + Date.now();
    safeStorage.set("mtu_device_id", deviceId);
  }
  return deviceId;
}

const currentUserId = tg?.initDataUnsafe?.user?.id
  ? String(tg.initDataUnsafe.user.id)
  : getOrCreateDeviceId();

const currentUsername = tg?.initDataUnsafe?.user?.username?.toLowerCase() || "";
const isAdmin = currentUsername === ADMIN_USERNAME.toLowerCase();

/* ---------------- Telegram Profile (for auto-fill & chat) ---------------- */

function getTelegramUser() {
  return window.Telegram?.WebApp?.initDataUnsafe?.user || null;
}
function getTelegramFirstName() {
  return (getTelegramUser()?.first_name || "").trim();
}
function getTelegramHandle() {
  const u = getTelegramUser()?.username;
  return u ? "@" + u : "";
}
function cleanHandle(value) {
  return String(value || "").trim().replace(/^@+/, "");
}
function escapeHTML(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

/* ---------------- Real-time State & Local Data ---------------- */

let PRODUCTS = [];
let ERRANDS = [];
let LOSTFOUND = [];
let ANNOUNCEMENTS = [];

function loadNotifications() {
  try {
    const raw = JSON.parse(safeStorage.get("mtu_notifications") || "[]");
    if (!Array.isArray(raw)) return [];
    return raw.map((n) => ({ ...n, isRead: typeof n.isRead === "boolean" ? n.isRead : true }));
  } catch (e) {
    return [];
  }
}
let notifications = loadNotifications();

let isLoadingProducts = true;
let unreadChatCount = 0;
let hasShownPopup = false;

const CATEGORIES = ["All", "Electronics", "Books", "Clothing", "Other"];
const COLOR_GRADIENTS = [
  "from-indigo to-indigo-soft",
  "from-emerald to-emerald-soft",
  "from-indigo-soft to-emerald",
  "from-emerald-dim to-indigo"
];

let state = {
  tab: "marketplace",
  category: "All",
  search: "",
  lf: "all",
  reportStatus: "lost"
};

/* ============================================================
   Automatic Pop-up Announcement
   ============================================================ */

function formatAnnouncementDate(a) {
  try {
    const raw = a?.createdAt;
    const d = raw?.toDate ? raw.toDate() : (a?.date ? new Date(a.date) : null);
    if (!d || isNaN(d.getTime())) return "";
    return d.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
  } catch (e) {
    return "";
  }
}

function checkAndShowPopup(announcementsList) {
  if (hasShownPopup) return;
  if (!Array.isArray(announcementsList) || announcementsList.length === 0) return;

  const latest = announcementsList[0];
  if (!latest) return;

  const dialog = document.getElementById("popupAnnouncementModal");
  if (!dialog || typeof dialog.showModal !== "function") return;

  const titleEl = document.getElementById("popupAnnTitle");
  const bodyEl = document.getElementById("popupAnnBody");
  const dateEl = document.getElementById("popupAnnDate");

  if (titleEl) titleEl.textContent = latest.title || "Announcement";
  if (bodyEl) bodyEl.textContent = latest.body || latest.message || latest.text || "";
  if (dateEl) dateEl.textContent = formatAnnouncementDate(latest);

  hasShownPopup = true;
  if (!dialog.open) dialog.showModal();
  refreshIcons();
}

// ---------------- Real-time Firestore Listeners ----------------

function listenToFirestore() {
  if (!db) return;

  const fourteenDaysAgo = firebase.firestore.Timestamp.fromDate(
    new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)
  );

  renderSkeletonLoaders();

  // Auto-delete items older than 14 days
  ["products", "errands", "lostfound"].forEach(async (col) => {
    try {
      const snapshot = await db.collection(col).where("createdAt", "<", fourteenDaysAgo).get();
      snapshot.forEach((doc) => doc.ref.delete());
    } catch (e) { /* silent */ }
  });

  // 0. Announcements → auto pop-up
  db.collection("announcements")
    .orderBy("createdAt", "desc")
    .limit(10)
    .onSnapshot((snapshot) => {
      ANNOUNCEMENTS = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data({ serverTimestamps: "estimate" }) }));
      checkAndShowPopup(ANNOUNCEMENTS);
    }, (err) => console.error("Announcements listener error:", err));

  // 1. Products
  db.collection("products")
    .where("createdAt", ">=", fourteenDaysAgo)
    .onSnapshot((snapshot) => {
      isLoadingProducts = false;
      PRODUCTS = snapshot.docs.map((doc) => ({ id: doc.id, views: 0, ...doc.data() }));
      renderProductGrid();
    }, (err) => {
      console.error("Products listener error:", err);
      isLoadingProducts = false;
      renderProductGrid();
    });

  // 2. Errands
  db.collection("errands")
    .where("createdAt", ">=", fourteenDaysAgo)
    .onSnapshot((snapshot) => {
      ERRANDS = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      renderErrandFeed();
    }, (err) => console.error("Errands listener error:", err));

  // 3. Lost & Found
  db.collection("lostfound")
    .where("createdAt", ">=", fourteenDaysAgo)
    .onSnapshot((snapshot) => {
      LOSTFOUND = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      renderLostFound();
    }, (err) => console.error("LostFound listener error:", err));
}

/* ---------------- Form Helper & Utilities ---------------- */

function extractInputValue(form, selectors, fallback = "") {
  for (const selector of selectors) {
    const el = form.querySelector(selector);
    if (el && el.value && el.value.trim() !== "") return el.value.trim();
  }
  return fallback;
}

function etb(n) {
  return `${Number(n || 0).toLocaleString()} ETB`;
}

/**
 * <dialog>.showModal() puts the dialog in the browser "top layer", which is drawn
 * ABOVE every z-index. A toast living in <body> would be hidden behind an open modal,
 * so we re-parent the toast into the open dialog.
 */
function showToast(message) {
  const toast = document.getElementById("toast");
  if (!toast) { console.log("[MTU toast]", message); return; }

  const openDialogs = document.querySelectorAll("dialog[open]");
  const host = openDialogs.length ? openDialogs[openDialogs.length - 1] : document.body;
  if (toast.parentElement !== host) host.appendChild(toast);

  const msgEl = document.getElementById("toastMsg");
  if (msgEl) msgEl.textContent = message;
  toast.classList.remove("translate-y-24", "opacity-0");
  toast.classList.add("translate-y-0", "opacity-100");
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => {
    toast.classList.add("translate-y-24", "opacity-0");
    toast.classList.remove("translate-y-0", "opacity-100");
  }, 3200);
}

// When any dialog closes, move the toast back to <body> so it never disappears with it
document.addEventListener("close", (e) => {
  if (e.target && e.target.tagName === "DIALOG") {
    const toast = document.getElementById("toast");
    if (toast && toast.parentElement !== document.body) document.body.appendChild(toast);
  }
}, true);

/* ---------------- Telegram Auto-Fill for Forms ---------------- */

const FORM_MODALS = {
  postItemModal: "postItemForm",
  errandModal: "errandForm",
  reportModal: "reportForm"
};

function prefillTelegramFields(form) {
  if (!form) return;
  const handle = getTelegramHandle();
  const firstName = getTelegramFirstName();

  const tgField = form.querySelector('[name="telegram"]');
  if (tgField && handle && !tgField.value.trim()) tgField.value = handle;

  const nameField = form.querySelector('[data-autofill="name"]');
  if (nameField && firstName && !nameField.value.trim()) nameField.value = firstName;
}

function prefillAllForms() {
  Object.values(FORM_MODALS).forEach((formId) => prefillTelegramFields(document.getElementById(formId)));
}

function openModal(id) {
  if (FORM_MODALS[id]) prefillTelegramFields(document.getElementById(FORM_MODALS[id]));
  const dialog = document.getElementById(id);
  if (dialog && typeof dialog.showModal === "function" && !dialog.open) dialog.showModal();
}

function closeModal(id) {
  const dialog = document.getElementById(id);
  if (dialog && dialog.open) dialog.close();
}

function refreshIcons() {
  if (window.lucide) window.lucide.createIcons();
}

/* ---------------- Skeleton Loading Placeholders ---------------- */

function renderSkeletonLoaders() {
  const grid = document.getElementById("productGrid");
  if (!grid) return;

  grid.innerHTML = Array(4).fill(0).map(() => `
    <div class="rounded-2xl overflow-hidden glass shadow-glow flex flex-col animate-pulse">
      <div class="h-28 bg-base-700/60 w-full"></div>
      <div class="p-3 flex flex-col gap-2 flex-1">
        <div class="h-3.5 bg-base-700/70 rounded w-3/4"></div>
        <div class="h-3 bg-base-700/40 rounded w-1/2"></div>
        <div class="h-4 bg-emerald/20 rounded w-1/3 mt-1"></div>
        <div class="h-8 bg-base-700/60 rounded-lg w-full mt-2"></div>
      </div>
    </div>
  `).join("");
}

/* ---------------- View Counter Logic ---------------- */

async function incrementViews(productId) {
  if (!productId || !db) return;
  try {
    await db.collection("products").doc(String(productId)).update({
      views: firebase.firestore.FieldValue.increment(1)
    });
  } catch (err) {
    console.warn("Could not increment views:", err);
  }
}

/* ---------------- Telegram Native Share Button ---------------- */

function shareToTelegram(title, price, location) {
  const shareText = `🔥 MTU Campus Marketplace\n\n📌 Item: ${title}\n💰 Price: ${etb(price)}\n📍 Location: ${location}\n\n👉 Check it out on MTU Campus App!`;
  const url = `https://t.me/share/url?url=${encodeURIComponent(window.location.href)}&text=${encodeURIComponent(shareText)}`;

  if (tg && tg.openTelegramLink) tg.openTelegramLink(url);
  else window.open(url, "_blank");
}

/* ============================================================
   Badge Helper (shared by the bell + the inbox button)
   ============================================================ */

function applyBadge(host, id, count) {
  if (!host) return;
  let badge = document.getElementById(id);

  if (!badge) {
    if (count <= 0) return;
    badge = document.createElement("span");
    badge.id = id;
    host.appendChild(badge);
  }

  // 0 → hide completely
  if (count <= 0) {
    badge.textContent = "";
    badge.style.display = "none";
    return;
  }

  const text = count > 9 ? "9+" : String(count);
  const changed = badge.textContent !== text;

  badge.classList.remove("hidden");
  badge.textContent = text;
  badge.setAttribute("aria-label", `${count} unread`);
  badge.style.cssText = `
    position:absolute; top:-6px; right:-6px; min-width:18px; height:18px;
    padding:0 5px; border-radius:9999px; background:#ef4444; color:#fff;
    font-size:10px; font-weight:800; display:flex; align-items:center;
    justify-content:center; line-height:1; z-index:50; pointer-events:none;
    box-shadow:0 0 0 2px #07111F, 0 0 10px rgba(239,68,68,.45);
  `;
  host.style.position = "relative";
  host.style.overflow = "visible";

  // small "pop" whenever the number changes
  if (changed && badge.animate) {
    badge.animate(
      [{ transform: "scale(.6)" }, { transform: "scale(1.25)" }, { transform: "scale(1)" }],
      { duration: 260, easing: "ease-out" }
    );
  }
}

/* ---------------- Notification System ---------------- */

function updateNotifBadge() {
  const unread = notifications.filter((n) => !n.isRead).length;
  applyBadge(document.getElementById("notifBtn"), "notifBadge", unread);
}

function updateInboxBadge() {
  applyBadge(document.getElementById("inboxBtn"), "inboxBadge", unreadChatCount);
}

function formatRelativeTime(ts, fallback = "") {
  if (!ts) return fallback;
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "Just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function markNotificationsAsRead() {
  notifications = notifications.map((n) => ({ ...n, isRead: true }));
  safeStorage.set("mtu_notifications", JSON.stringify(notifications));
  updateNotifUI();
}

function addNotification(title, message, iconName = "bell", iconColor = "emerald") {
  const color = ["emerald", "indigo"].includes(iconColor) ? iconColor : "emerald";
  notifications.unshift({
    id: Date.now() + Math.random(),
    title,
    message,
    ts: Date.now(),
    time: "Just now",
    icon: iconName,
    color,
    isRead: false
  });
  notifications = notifications.slice(0, 50); // keep storage small
  safeStorage.set("mtu_notifications", JSON.stringify(notifications));
  updateNotifUI();
}

function updateNotifUI() {
  updateNotifBadge();

  const container = document.getElementById("notifContainer");
  if (!container) return;

  if (notifications.length === 0) {
    container.innerHTML = `<div class="text-center py-8 text-slate-500 text-xs">No notifications yet.</div>`;
    return;
  }

  container.innerHTML = notifications.map((n) => `
    <div class="p-3 rounded-2xl bg-base-800/60 border border-base-700 flex gap-3 items-start animate-fade-in">
      <div class="w-9 h-9 rounded-xl bg-${escapeHTML(n.color)}/10 text-${escapeHTML(n.color)}-soft flex items-center justify-center shrink-0 mt-0.5">
        <i data-lucide="${escapeHTML(n.icon)}" class="w-4 h-4"></i>
      </div>
      <div class="flex-1 min-w-0 text-xs">
        <p class="font-semibold text-slate-200">${escapeHTML(n.title)}</p>
        <p class="text-slate-400 mt-0.5">${escapeHTML(n.message)}</p>
        <span class="text-[10px] text-slate-500 mt-1 block">${escapeHTML(formatRelativeTime(n.ts, n.time))}</span>
      </div>
    </div>
  `).join("");

  refreshIcons();
}

/* ---------------- Per-room unread tracking ---------------- */

const ROOM_SEEN_KEY = "mtu_room_seen";
const roomSeen = (() => {
  try {
    const o = JSON.parse(safeStorage.get(ROOM_SEEN_KEY) || "{}");
    return o && typeof o === "object" && !Array.isArray(o) ? o : {};
  } catch (e) { return {}; }
})();
const roomLastUpdated = {}; // roomId -> latest known updatedAt (ms, server clock)
const unreadByRoom = {};    // roomId -> unread message count

function recomputeUnread() {
  unreadChatCount = Object.values(unreadByRoom).reduce((a, b) => a + b, 0);
  updateInboxBadge();
}

function markRoomRead(roomId) {
  if (!roomId) return;
  const stamp = roomLastUpdated[roomId] || Date.now();
  roomSeen[roomId] = Math.max(Number(roomSeen[roomId]) || 0, stamp);
  safeStorage.set(ROOM_SEEN_KEY, JSON.stringify(roomSeen));
  delete unreadByRoom[roomId];
  recomputeUnread();
}

/* ---------------- Firestore Status & Delete Functions ---------------- */

async function toggleProductStatus(id, currentStatus) {
  const newStatus = currentStatus === "sold" ? "available" : "sold";
  try {
    await db.collection("products").doc(String(id)).update({ status: newStatus });
    showToast(newStatus === "sold" ? "Item marked as Sold!" : "Item marked as Available");
  } catch (err) {
    console.error(err);
    showToast(firestoreErrorMessage(err));
  }
}

async function deleteProduct(id) {
  if (!confirm("Are you sure you want to remove this item?")) return;
  try {
    await db.collection("products").doc(String(id)).delete();
    showToast("Item deleted!");
  } catch (err) {
    console.error(err);
    showToast(firestoreErrorMessage(err));
  }
}

async function deleteErrand(id) {
  if (!confirm("Mark this errand as completed / remove?")) return;
  try {
    await db.collection("errands").doc(String(id)).delete();
    showToast("Errand removed!");
  } catch (err) {
    console.error(err);
    showToast(firestoreErrorMessage(err));
  }
}

async function deleteLostFound(id) {
  if (!confirm("Remove this report from Lost & Found?")) return;
  try {
    await db.collection("lostfound").doc(String(id)).delete();
    showToast("Report removed!");
  } catch (err) {
    console.error(err);
    showToast(firestoreErrorMessage(err));
  }
}

/* ============================================================
   Real-time In-App Chat (Firestore)
   chats/{roomId}                    → room metadata
   chats/{roomId}/messages/{msgId}   → { text, senderId, senderName, createdAt }
   roomId = {kind}_{listingId}_{buyerId}
   ============================================================ */

let chatCtx = null;
let chatUnsub = null;
let chatLoadTimer = null;
let chatSession = 0;
let inboxUnsub = null;

function buildRoomId(kind, listingId, buyerId) {
  return `${kind}_${listingId}_${buyerId}`.replace(/[\/\s]/g, "_");
}

function teardownChat() {
  MTUTrust.onChatClosed();
  chatSession++;
  clearTimeout(chatLoadTimer);
  chatLoadTimer = null;
  if (chatUnsub) {
    try { chatUnsub(); } catch (e) { /* ignore */ }
    chatUnsub = null;
  }
  chatCtx = null;
}

function teardownInbox() {
  if (inboxUnsub) {
    try { inboxUnsub(); } catch (e) { /* ignore */ }
    inboxUnsub = null;
  }
}

function showChatState(type, text) {
  const box = document.getElementById("chatMessages");
  if (!box) return;

  if (type === "loading") {
    box.innerHTML = `
      <div class="h-full flex flex-col items-center justify-center gap-3 text-slate-400">
        <div class="w-6 h-6 border-2 border-emerald-soft border-t-transparent rounded-full animate-spin"></div>
        <p class="text-xs">${escapeHTML(text || "Connecting…")}</p>
      </div>`;
  } else if (type === "error") {
    box.innerHTML = `
      <div class="h-full flex flex-col items-center justify-center gap-3 text-center px-6">
        <div class="w-11 h-11 rounded-2xl bg-red-500/15 border border-red-400/30 flex items-center justify-center">
          <i data-lucide="wifi-off" class="w-5 h-5 text-red-300"></i>
        </div>
        <p class="text-xs text-slate-300">${escapeHTML(text || "Could not load messages.")}</p>
        <button type="button" id="chatRetryBtn" class="tap bg-emerald text-base-950 text-xs font-semibold px-4 py-2 rounded-lg">Retry</button>
      </div>`;
    const retry = document.getElementById("chatRetryBtn");
    if (retry) retry.addEventListener("click", () => startChatListener());
    refreshIcons();
  } else if (type === "empty") {
    box.innerHTML = `
      <div class="h-full flex flex-col items-center justify-center gap-2 text-center px-6">
        <div class="w-11 h-11 rounded-2xl bg-base-800 flex items-center justify-center">
          <i data-lucide="message-circle" class="w-5 h-5 text-slate-500"></i>
        </div>
        <p class="text-sm font-semibold text-slate-300">No messages yet</p>
        <p class="text-xs text-slate-500">Say hello 👋 — your message is delivered instantly.</p>
      </div>`;
    refreshIcons();
  }
}

function formatMsgTime(ts) {
  try {
    const d = ts?.toDate ? ts.toDate() : null;
    if (!d) return "";
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch (e) {
    return "";
  }
}

function renderChatMessages(docs) {
  const box = document.getElementById("chatMessages");
  if (!box) return;

  if (docs.length === 0) {
    showChatState("empty");
    return;
  }

  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;

  box.innerHTML = docs.map((d) => {
    const m = d.data({ serverTimestamps: "estimate" });
    const mine = String(m.senderId) === String(currentUserId);
    return `
      <div class="flex ${mine ? "justify-end" : "justify-start"}">
        <div class="max-w-[78%] px-3 py-2 rounded-2xl text-sm leading-snug break-words ${
          mine
            ? "bg-gradient-to-br from-indigo to-emerald text-white rounded-br-md"
            : "bg-base-700/80 text-slate-100 border border-white/5 rounded-bl-md"
        }">
          ${!mine ? `<p class="text-[10px] font-semibold text-emerald-soft mb-0.5">${escapeHTML(m.senderName || "User")}</p>` : ""}
          <p class="whitespace-pre-wrap">${escapeHTML(m.text)}</p>
          <p class="text-[9px] mt-1 text-right ${mine ? "text-white/70" : "text-slate-400"}">${formatMsgTime(m.createdAt)}</p>
        </div>
      </div>`;
  }).join("");

  if (nearBottom || docs.length <= 1) box.scrollTop = box.scrollHeight;
}

function startChatListener() {
  if (!chatCtx || !db) return;

  if (chatUnsub) { try { chatUnsub(); } catch (e) { /* ignore */ } chatUnsub = null; }
  clearTimeout(chatLoadTimer);

  const session = ++chatSession;
  const roomId = chatCtx.roomId;
  let loaded = false;

  showChatState("loading", "Opening chat…");

  chatLoadTimer = setTimeout(() => {
    if (!loaded && session === chatSession) {
      showChatState("error", "Connection is slow. Check your internet and tap Retry.");
    }
  }, 10000);

  try {
    chatUnsub = db.collection("chats").doc(roomId).collection("messages")
      .orderBy("createdAt", "asc")
      .limitToLast(200)
      .onSnapshot((snap) => {
        if (session !== chatSession) return;
        loaded = true;
        clearTimeout(chatLoadTimer);
        renderChatMessages(snap.docs);
      }, (err) => {
        if (session !== chatSession) return;
        console.error("Chat listener error:", err);
        clearTimeout(chatLoadTimer);
        const denied = err && err.code === "permission-denied";
        showChatState("error", denied
          ? "Chat is not permitted by database rules. Please contact the admin."
          : "Could not load messages. Tap Retry.");
      });
  } catch (err) {
    console.error("Chat start failed:", err);
    clearTimeout(chatLoadTimer);
    showChatState("error", "Could not start chat. Tap Retry.");
  }
}

function openChat(ctx) {
  const ownerId = ctx.ownerId ? String(ctx.ownerId) : "";
  const buyerId = String(ctx.buyerId || currentUserId);

  if (!ownerId) { showToast("Chat unavailable for this older listing"); return; }
  if (buyerId === ownerId) { showToast("This is your own listing"); return; }

  closeModal("contactModal");
  closeModal("inboxModal");
  teardownChat();

  const iAmOwner = String(currentUserId) === ownerId;

  chatCtx = {
    roomId: buildRoomId(ctx.kind || "item", ctx.listingId || "x", buyerId),
    kind: ctx.kind || "item",
    listingId: String(ctx.listingId || ""),
    title: ctx.title || "Listing",
    ownerId,
    ownerName: ctx.ownerName || "Seller",
    buyerId,
    buyerName: ctx.buyerName || (iAmOwner ? "Student" : (getTelegramFirstName() || "Student"))
  };

  // Entering a room clears its unread count + updates the inbox badge
  markRoomRead(chatCtx.roomId);

  const peerName = iAmOwner ? chatCtx.buyerName : chatCtx.ownerName;

  const nameEl = document.getElementById("chatPeerName");
  const titleEl = document.getElementById("chatListingTitle");
  const avatarEl = document.getElementById("chatAvatar");
  if (nameEl) nameEl.textContent = peerName;
  if (titleEl) titleEl.textContent = chatCtx.title;
  if (avatarEl) avatarEl.textContent = (peerName || "?").trim().charAt(0).toUpperCase() || "?";

  const input = document.getElementById("chatInput");
  if (input) input.value = "";

  openModal("chatModal");
  refreshIcons();
  startChatListener();
  MTUTrust.onChatOpened(chatCtx);

  setTimeout(() => { if (input) input.focus({ preventScroll: true }); }, 350);
}

function sendChatMessage(text) {
  if (!chatCtx || !db) return;
  const clean = String(text || "").trim();
  if (!clean) return;

  const ctx = chatCtx;
  const senderName = getTelegramFirstName() || (String(currentUserId) === ctx.ownerId ? ctx.ownerName : ctx.buyerName) || "Student";
  const ts = firebase.firestore.FieldValue.serverTimestamp();

  const roomRef = db.collection("chats").doc(ctx.roomId);
  const msgRef = roomRef.collection("messages").doc();
 
   const iAmOwner = String(currentUserId) === ctx.ownerId;
  const batch = db.batch();
  batch.set(roomRef, {

   
// ...inside batch.set(roomRef, { ... })
    [iAmOwner ? "ownerSent" : "buyerSent"]: true,

    participants: [ctx.buyerId, ctx.ownerId],
    kind: ctx.kind,
    listingId: ctx.listingId,
    title: ctx.title,
    ownerId: ctx.ownerId,
    ownerName: ctx.ownerName,
    buyerId: ctx.buyerId,
    buyerName: ctx.buyerName,
    lastMessage: clean.slice(0, 120),
    lastSenderId: String(currentUserId),
    updatedAt: ts
  }, { merge: true });
  batch.set(msgRef, {
    text: clean,
    senderId: String(currentUserId),
    senderName,
    createdAt: ts
  });

  batch.commit().catch((err) => {
    console.error("Send failed:", err);
    showToast(err && err.code === "permission-denied" ? "Not allowed to send messages" : "Message failed to send");
  });
}

/* ---------- Messages Inbox ---------- */

function renderInbox(rooms) {
  const list = document.getElementById("inboxList");
  if (!list) return;

  if (rooms.length === 0) {
    list.innerHTML = `
      <div class="flex flex-col items-center justify-center py-12 text-center gap-2">
        <div class="w-11 h-11 rounded-2xl bg-base-800 flex items-center justify-center">
          <i data-lucide="inbox" class="w-5 h-5 text-slate-500"></i>
        </div>
        <p class="text-sm font-semibold text-slate-300">No conversations yet</p>
        <p class="text-xs text-slate-500">Tap "Contact &amp; Chat" on any listing to start one.</p>
      </div>`;
    refreshIcons();
    return;
  }

  list.innerHTML = rooms.map((r, idx) => {
    const iAmOwner = String(r.ownerId) === String(currentUserId);
    const peer = iAmOwner ? (r.buyerName || "Student") : (r.ownerName || "Seller");
    return `
      <button type="button" data-room-idx="${idx}" class="tap w-full text-left p-3 rounded-2xl bg-base-800/60 border border-base-700 flex items-center gap-3">
        <div class="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo to-emerald flex items-center justify-center font-display font-bold text-base-950 shrink-0">${escapeHTML(peer.charAt(0).toUpperCase())}</div>
        <div class="flex-1 min-w-0">
          <p class="text-sm font-semibold text-slate-100 truncate">${escapeHTML(peer)}</p>
          <p class="text-[11px] text-emerald-soft truncate">${escapeHTML(r.title || "")}</p>
          <p class="text-xs text-slate-400 truncate">${escapeHTML(r.lastMessage || "")}</p>
        </div>
        <i data-lucide="chevron-right" class="w-4 h-4 text-slate-500 shrink-0"></i>
      </button>`;
  }).join("");

  list.querySelectorAll("[data-room-idx]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const r = rooms[Number(btn.dataset.roomIdx)];
      if (!r) return;
      openChat({
        kind: r.kind,
        listingId: r.listingId,
        title: r.title,
        ownerId: r.ownerId,
        ownerName: r.ownerName,
        buyerId: r.buyerId,
        buyerName: r.buyerName
      });
    });
  });

  refreshIcons();
}

function openInbox() {
  // Opening the list does NOT clear everything — each room clears when you open it
  updateInboxBadge();
  teardownInbox();

  const list = document.getElementById("inboxList");
  if (list) {
    list.innerHTML = `
      <div class="flex flex-col items-center justify-center py-12 gap-3 text-slate-400">
        <div class="w-6 h-6 border-2 border-emerald-soft border-t-transparent rounded-full animate-spin"></div>
        <p class="text-xs">Loading conversations…</p>
      </div>`;
  }
  openModal("inboxModal");

  try {
    inboxUnsub = db.collection("chats")
      .where("participants", "array-contains", String(currentUserId))
      .onSnapshot((snap) => {
        const rooms = snap.docs.map((d) => d.data({ serverTimestamps: "estimate" }));
        rooms.sort((a, b) => (b.updatedAt?.toMillis?.() || 0) - (a.updatedAt?.toMillis?.() || 0));
        renderInbox(rooms);
      }, (err) => {
        console.error("Inbox listener error:", err);
        if (list) list.innerHTML = `<div class="text-center py-10 text-xs text-slate-400">Could not load conversations.</div>`;
      });
  } catch (err) {
    console.error("Inbox start failed:", err);
    if (list) list.innerHTML = `<div class="text-center py-10 text-xs text-slate-400">Could not load conversations.</div>`;
  }
}

/* ============================================================
   New Message Notification Listener
   - listens to chats where I'm a participant
   - first snapshot only seeds unread state (no toasts)
   - afterwards: new message from someone else, while I'm not in
     that room → toast + notification + inbox badge
   ============================================================ */

let globalChatUnsub = null;
let globalChatRetry = null;

function startGlobalChatListener() {
  if (globalChatUnsub || !db) return;

  let initialLoad = true;
  const handled = new Map(); // roomId -> signature, guards against duplicate events

  try {
    globalChatUnsub = db.collection("chats")
      .where("participants", "array-contains", String(currentUserId))
      .onSnapshot((snapshot) => {
        snapshot.docChanges().forEach((change) => {
          if (change.type === "removed") return;

          const roomId = change.doc.id;
          const data = change.doc.data({ serverTimestamps: "estimate" });
          const updatedMs = data.updatedAt?.toMillis?.() || 0;
          if (updatedMs) roomLastUpdated[roomId] = Math.max(roomLastUpdated[roomId] || 0, updatedMs);

          const fromMe = String(data.lastSenderId || "") === String(currentUserId);
          const inThisChat = !!chatCtx && chatCtx.roomId === roomId;

          // First load: seed unread state from messages missed while away, no toasts
          if (initialLoad) {
            if (!fromMe && !inThisChat && updatedMs > (Number(roomSeen[roomId]) || 0)) {
              unreadByRoom[roomId] = 1;
            }
            return;
          }

          if (fromMe) return;                                // my own message
          if (inThisChat) { markRoomRead(roomId); return; }  // I'm looking at it right now

          const sig = `${updatedMs}|${data.lastMessage || ""}`;
          if (handled.get(roomId) === sig) return;
          handled.set(roomId, sig);

          const peerName = String(data.ownerId) === String(currentUserId)
            ? (data.buyerName || "Student")
            : (data.ownerName || "Seller");
          const title = data.title || "Listing";
          const preview = data.lastMessage || "New message";

          unreadByRoom[roomId] = (unreadByRoom[roomId] || 0) + 1;

          showToast(`አዲስ መልእክት ከ ${peerName}`);
          addNotification(`አዲስ መልእክት • ${peerName}`, `${title}: ${preview}`, "message-circle", "indigo");
          try { tg?.HapticFeedback?.notificationOccurred?.("success"); } catch (e) { /* ignore */ }
        });

        recomputeUnread();
        if (initialLoad && !snapshot.metadata.fromCache) initialLoad = false;
      }, (err) => {
        console.error("Global chat listener error:", err);
        globalChatUnsub = null;
        clearTimeout(globalChatRetry);
        globalChatRetry = setTimeout(startGlobalChatListener, 30000);
      });
  } catch (err) {
    console.error("Global chat listener start failed:", err);
    globalChatUnsub = null;
  }
}

/* ---------------- Contact Modal Wireup ---------------- */

function openContactModal({ id, name, title, location, phone, telegram, kind, listingId, ownerId }) {
  if (id) incrementViews(id);

  const nameEl = document.getElementById("contactName");
  const metaEl = document.getElementById("contactMeta");
  const avatarEl = document.getElementById("contactAvatar");

  // [FIX] Using innerHTML so MTUTrust.badge can render properly next to the contact name
  if (nameEl) nameEl.innerHTML = `${escapeHTML(name || "Contact Person")} ${MTUTrust.badge(ownerId)}`;
  if (metaEl) metaEl.textContent = `${title || ""} ${location ? "• " + location : ""}`;
  if (avatarEl) avatarEl.textContent = (name || "A").trim().charAt(0).toUpperCase() || "A";

  const isOwnListing = ownerId && String(ownerId) === String(currentUserId);

  const modalContainer = document.querySelector("#contactModal .grid");
  if (modalContainer) {
    const cleanPhone = String(phone || "").trim();
    const dialPhone = cleanPhone.replace(/[^\d+]/g, "");
    const cleanTg = cleanHandle(telegram);
    const validTg = /^[A-Za-z0-9_]{3,}$/.test(cleanTg);

    const phoneHref = dialPhone ? `tel:${dialPhone}` : "#";
    const tgHref = validTg ? `https://t.me/${encodeURIComponent(cleanTg)}` : "#";

    modalContainer.innerHTML = `
      <div class="col-span-2 p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-[11px] text-amber-300 flex items-center gap-2 mb-1">
        <i data-lucide="shield-alert" class="w-4 h-4 shrink-0 text-amber-400"></i>
        <span>እቃውን ሳያዩ እና በአካል ሳይገናኙ ምንም አይነት ክፍያ እንዳይፈጽሙ!</span>
      </div>

      <a href="${escapeHTML(phoneHref)}" ${!dialPhone ? 'data-missing="phone"' : ""} class="tap flex items-center justify-center gap-2 bg-emerald text-base-950 font-semibold text-sm py-3 rounded-xl text-center">
        <i data-lucide="phone" class="w-4 h-4"></i> Call (${escapeHTML(cleanPhone || "N/A")})
      </a>
      <a href="${escapeHTML(tgHref)}" target="_blank" ${!validTg ? 'data-missing="telegram"' : ""} class="tap flex items-center justify-center gap-2 glass text-slate-100 font-semibold text-sm py-3 rounded-xl text-center">
        <i data-lucide="message-circle" class="w-4 h-4"></i> Telegram
      </a>

      <button type="button" id="contactChatBtn" class="tap col-span-2 flex items-center justify-center gap-2 bg-gradient-to-r from-indigo to-emerald text-white font-semibold text-sm py-3 rounded-xl shadow-glow-in">
        <i data-lucide="messages-square" class="w-4 h-4"></i> ${isOwnListing ? "My Messages" : "In-App Chat"}
      </button>
    `;

    modalContainer.querySelectorAll("[data-missing]").forEach((a) => {
      a.addEventListener("click", (ev) => {
        ev.preventDefault();
        showToast(a.dataset.missing === "phone" ? "No phone number provided" : "No Telegram handle provided");
      });
    });

    const chatBtn = document.getElementById("contactChatBtn");
    if (chatBtn) {
      chatBtn.addEventListener("click", () => {
        if (isOwnListing) {
          closeModal("contactModal");
          openInbox();
          return;
        }
        openChat({
          kind: kind || "item",
          listingId: listingId || id,
          title,
          ownerId,
          ownerName: name
        });
      });
    }
  }

  refreshIcons();
  openModal("contactModal");
}
/* ---------------- Tab Navigation ---------------- */

const TAB_META = {
  marketplace: { title: "Marketplace", subtitle: "Buy & sell around campus", index: 0 },
  express: { title: "Campus Express", subtitle: "Delivery, errands & emergency help", index: 1 },
  lostfound: { title: "Lost & Found", subtitle: "Reunite items with their owners", index: 2 },
};

function setTab(tab) {
  state.tab = tab;

  document.querySelectorAll(".page").forEach((el) => el.classList.add("hidden"));
  const activePage = document.getElementById(`page-${tab}`);
  if (activePage) activePage.classList.remove("hidden");

  const titleEl = document.getElementById("pageTitle");
  const subEl = document.getElementById("pageSubtitle");
  if (titleEl) titleEl.textContent = TAB_META[tab].title;
  if (subEl) subEl.textContent = TAB_META[tab].subtitle;

  document.querySelectorAll(".navBtn").forEach((btn) => {
    const active = btn.dataset.tab === tab;
    btn.classList.toggle("text-slate-100", active);
    btn.classList.toggle("text-slate-500", !active);
  });

  const pill = document.getElementById("navPill");
  if (pill) pill.style.transform = `translateX(${TAB_META[tab].index * 100}%)`;

  const fabMk = document.getElementById("fabMarketplace");
  const fabEx = document.getElementById("fabExpress");
  const fabLf = document.getElementById("fabLostFound");
  if (fabMk) fabMk.classList.toggle("hidden", tab !== "marketplace");
  if (fabEx) fabEx.classList.toggle("hidden", tab !== "express");
  if (fabLf) fabLf.classList.toggle("hidden", tab !== "lostfound");
}

document.querySelectorAll(".navBtn").forEach((btn) => {
  btn.addEventListener("click", () => setTab(btn.dataset.tab));
});

/* ---------------- Marketplace Render & Search ---------------- */

function renderCategoryChips() {
  const wrap = document.getElementById("categoryChips");
  if (!wrap) return;

  wrap.innerHTML = CATEGORIES.map((cat) => {
    const active = state.category === cat;
    return `
      <button data-cat="${cat}" class="chip shrink-0 text-xs font-semibold px-4 py-2 rounded-full border ${
        active
          ? "bg-gradient-to-r from-emerald to-indigo text-white border-transparent shadow-glow-em"
          : "bg-base-800 text-slate-400 border-base-600"
      }">${cat}</button>`;
  }).join("");

  wrap.querySelectorAll("[data-cat]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.category = btn.dataset.cat;
      renderCategoryChips();
      renderProductGrid();
    });
  });
}

function renderProductGrid() {
  const grid = document.getElementById("productGrid");
  if (!grid) return;

  if (isLoadingProducts) {
    renderSkeletonLoaders();
    return;
  }

  const q = state.search.trim().toLowerCase();

  const filtered = PRODUCTS.filter((p) => {
    const matchesCat = state.category === "All" || p.category === state.category;
    const matchesSearch =
      !q ||
      (p.title && p.title.toLowerCase().includes(q)) ||
      (p.seller && p.seller.toLowerCase().includes(q)) ||
      (p.location && p.location.toLowerCase().includes(q));
    return matchesCat && matchesSearch;
  });

  if (filtered.length === 0) {
    grid.innerHTML = `
      <div class="col-span-2 flex flex-col items-center justify-center py-14 text-center gap-2">
        <div class="w-12 h-12 rounded-2xl bg-base-800 flex items-center justify-center mb-1">
          <i data-lucide="search-x" class="w-5 h-5 text-slate-500"></i>
        </div>
        <p class="text-sm font-semibold text-slate-300">No items found</p>
        <p class="text-xs text-slate-500">Try posting a new item or change search</p>
      </div>`;
    refreshIcons();
    return;
  }

  grid.innerHTML = filtered.map((p) => {
    const isSold = p.status === "sold";
    const id = escapeHTML(p.id);

    const mediaHTML = p.image
      ? `<img src="${escapeHTML(p.image)}" alt="${escapeHTML(p.title)}" class="w-full h-full object-cover ${isSold ? "opacity-40 grayscale" : ""}">`
      : `<div class="w-full h-full bg-gradient-to-br ${escapeHTML(p.color || "from-indigo to-emerald")} flex items-center justify-center text-3xl ${isSold ? "opacity-40" : ""}">
           <span>${escapeHTML(p.emoji || "📦")}</span>
         </div>`;

    const isOwner = !!p.userId && String(p.userId) === String(currentUserId);
    const canManage = isAdmin || isOwner;

    const ownerActionsHTML = canManage ? `
      <div class="absolute top-2 right-2 z-10 flex gap-1">
        <button data-action="toggle-status" data-id="${id}" data-status="${escapeHTML(p.status || "available")}" class="px-2 py-1 rounded-lg text-[10px] font-bold ${isSold ? "bg-emerald text-base-950" : "bg-amber-500 text-slate-950"} shadow-lg">
          ${isSold ? "Available" : "Sold"}
        </button>
        <button data-action="delete-product" data-id="${id}" class="w-7 h-7 rounded-lg bg-red-500/80 text-white flex items-center justify-center shadow-lg hover:bg-red-600 transition-all">
          <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
        </button>
      </div>` : "";

    const soldBadgeHTML = isSold ? `
      <span class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-10 bg-red-600 text-white font-bold text-xs uppercase tracking-widest px-3 py-1 rounded-full shadow-lg border border-white/20">SOLD OUT</span>` : "";

    let bottomActionHTML = "";
    if (!isOwner) {
      bottomActionHTML = isSold
        ? `<button disabled class="mt-2 w-full bg-base-800 text-slate-500 text-[11px] font-semibold py-2 rounded-lg cursor-not-allowed">Item Sold Out</button>`
        : `<button data-action="contact" data-id="${id}" class="tap mt-2 w-full bg-indigo/20 border border-indigo/40 text-indigo-soft hover:bg-indigo/30 text-[11px] font-semibold py-2 rounded-lg transition-all flex items-center justify-center gap-1.5">
             <i data-lucide="messages-square" class="w-3.5 h-3.5"></i> Contact &amp; Chat
           </button>`;
    }

    return `
    <div class="group rounded-2xl overflow-hidden glass shadow-glow flex flex-col relative ${isSold ? "border-red-500/30" : ""}">
      ${ownerActionsHTML}
      <div class="h-28 relative overflow-hidden bg-base-800">
        ${soldBadgeHTML}
        ${mediaHTML}
        <span class="absolute top-2 left-2 text-[9px] font-semibold uppercase tracking-wide bg-black/60 text-white px-2 py-0.5 rounded-md backdrop-blur-md">${escapeHTML(p.category)}</span>
        <button data-action="share" data-id="${id}" class="absolute bottom-2 right-2 z-10 w-7 h-7 rounded-full bg-black/60 text-slate-200 hover:text-white backdrop-blur-md flex items-center justify-center">
          <i data-lucide="share-2" class="w-3.5 h-3.5"></i>
        </button>
      </div>
      <div class="p-3 flex flex-col gap-1 flex-1">
        <p class="text-xs font-semibold leading-snug line-clamp-2 min-h-[2rem] text-slate-100">${escapeHTML(p.title)}</p>
        <div class="flex items-center justify-between mt-0.5">
          <p class="font-display font-bold text-sm text-emerald-soft">${etb(p.price)}</p>
          <span class="text-[10px] text-slate-400 flex items-center gap-1 bg-base-800/80 px-1.5 py-0.5 rounded-md">
            <i data-lucide="eye" class="w-3 h-3 text-slate-500"></i> ${Number(p.views) || 0}
          </span>
        </div>
        <div class="text-[10.5px] text-slate-400 flex flex-col gap-0.5 mt-1">
          <span class="flex items-center gap-1">
            <i data-lucide="map-pin" class="w-3 h-3 text-slate-500"></i> ${escapeHTML(p.location)}
          </span>
          <span class="flex items-center gap-1.5 flex-wrap">
            <i data-lucide="user" class="w-3 h-3 text-slate-500"></i> 
            <span>Seller: <strong class="text-slate-300 font-normal">${escapeHTML(p.seller)}</strong></span>
            ${MTUTrust.badge(p.userId)}
          </span>
        </div>
        ${bottomActionHTML}
      </div>
    </div>`;
  }).join("");

  refreshIcons();
}

// Delegated clicks (attached once) — replaces fragile inline onclick="...('${title}')"
function setupDelegatedActions() {
  const grid = document.getElementById("productGrid");
  if (grid) {
    grid.addEventListener("click", (ev) => {
      const btn = ev.target.closest("[data-action]");
      if (!btn) return;
      const id = btn.dataset.id;
      const p = PRODUCTS.find((x) => String(x.id) === String(id));

      switch (btn.dataset.action) {
        case "toggle-status": toggleProductStatus(id, btn.dataset.status); break;
        case "delete-product": deleteProduct(id); break;
        case "share": if (p) shareToTelegram(p.title, p.price, p.location); break;
        case "contact":
          if (p) {
            openContactModal({
              id: p.id, kind: "product", listingId: p.id, ownerId: p.userId,
              name: p.seller, title: p.title, location: p.location,
              phone: p.phone, telegram: p.telegram
            });
          }
          break;
      }
    });
  }

  const errandFeed = document.getElementById("errandFeed");
  if (errandFeed) {
    errandFeed.addEventListener("click", (ev) => {
      const btn = ev.target.closest("[data-action]");
      if (!btn) return;
      const e = ERRANDS.find((x) => String(x.id) === String(btn.dataset.id));
      if (btn.dataset.action === "delete-errand") deleteErrand(btn.dataset.id);
      if (btn.dataset.action === "contact-errand" && e) {
        openContactModal({
          kind: "errand", listingId: e.id, ownerId: e.userId,
          name: e.requester || "Requester", title: e.item, location: e.dorm,
          phone: e.phone, telegram: e.telegram
        });
      }
    });
  }

  const lfList = document.getElementById("lostFoundList");
  if (lfList) {
    lfList.addEventListener("click", (ev) => {
      const btn = ev.target.closest("[data-action]");
      if (!btn) return;
      const i = LOSTFOUND.find((x) => String(x.id) === String(btn.dataset.id));
      if (btn.dataset.action === "delete-lf") deleteLostFound(btn.dataset.id);
      if (btn.dataset.action === "claim" && i) {
        openContactModal({
          kind: "lostfound", listingId: i.id, ownerId: i.userId,
          name: i.reporter || "Owner / Finder",
          title: `${i.item} (${String(i.status || "").toUpperCase()})`,
          location: i.location, phone: i.phone, telegram: i.telegram
        });
      }
    });
  }
}

function setupSearchListener() {
  const searchInputs = document.querySelectorAll('#searchInput, input[placeholder*="Search" i]');
  searchInputs.forEach((input) => {
    input.addEventListener("input", (e) => {
      state.search = e.target.value;
      renderProductGrid();
    });
  });
}

/* ---------------- Campus Express Render ---------------- */

function renderErrandFeed() {
  const wrap = document.getElementById("errandFeed");
  if (!wrap) return;

  if (ERRANDS.length === 0) {
    wrap.innerHTML = `<div class="flex flex-col items-center justify-center py-14 text-center gap-2"><p class="text-sm font-semibold text-slate-300">No errand requests active</p></div>`;
    refreshIcons();
    return;
  }

  wrap.innerHTML = ERRANDS.map((e) => {
    const isOwner = e.userId && String(e.userId) === String(currentUserId);
    const canDelete = isAdmin || isOwner;
    const id = escapeHTML(e.id);

    const deleteBtnHTML = canDelete ? `
      <button data-action="delete-errand" data-id="${id}" class="absolute top-3 right-3 text-red-400 hover:text-red-300 p-1">
        <i data-lucide="trash-2" class="w-4 h-4"></i>
      </button>` : "";

    return `
    <div class="glass rounded-2xl p-4 shadow-glow flex items-start gap-3 relative">
      <div class="w-10 h-10 rounded-xl bg-emerald/15 border border-emerald/25 flex items-center justify-center shrink-0">
        <i data-lucide="package" class="w-4 h-4 text-emerald-soft"></i>
      </div>
      <div class="flex-1 min-w-0 pr-8">
        <div class="flex items-start justify-between gap-2">
          <p class="text-sm font-semibold leading-snug text-slate-100">${escapeHTML(e.item)}</p>
          ${e.urgent ? '<span class="shrink-0 text-[9px] font-bold uppercase tracking-wide text-amber-300 bg-amber-500/10 border border-amber-400/30 px-1.5 py-0.5 rounded-md">Urgent</span>' : ""}
        </div>
        <p class="text-[11px] text-slate-400 mt-1 flex items-center gap-1">
          <i data-lucide="map-pin" class="w-3 h-3 text-slate-500"></i> ${escapeHTML(e.dorm)} <span class="mx-1 text-slate-700">•</span> ${escapeHTML(e.time || "Just now")}
        </p>
        <p class="text-[11px] text-slate-400 mt-1">${escapeHTML(e.requester || "Student")} ${MTUTrust.badge(e.userId)}</p>
        <div class="flex items-center justify-between mt-3">
          <span class="text-xs font-display font-bold text-emerald-soft">${etb(e.tip)} tip</span>
          <button data-action="contact-errand" data-id="${id}" class="tap bg-emerald text-base-950 text-[11px] font-bold px-3.5 py-2 rounded-lg flex items-center gap-1.5 shadow-glow-em">
            <i data-lucide="check" class="w-3 h-3"></i> Accept &amp; Contact
          </button>
        </div>
      </div>
      ${deleteBtnHTML}
    </div>`;
  }).join("");

  refreshIcons();
}

/* ---------------- Lost & Found Render & Filter ---------------- */

function renderLostFound() {
  const wrap = document.getElementById("lostFoundList");
  if (!wrap) return;

  const filtered = LOSTFOUND.filter((i) => state.lf === "all" || i.status === state.lf);

  if (filtered.length === 0) {
    wrap.innerHTML = `<div class="flex flex-col items-center justify-center py-14 text-center gap-2"><p class="text-sm font-semibold text-slate-300">No ${state.lf === "all" ? "" : escapeHTML(state.lf)} items reported</p></div>`;
    refreshIcons();
    return;
  }

  wrap.innerHTML = filtered.map((i) => {
    const id = escapeHTML(i.id);
    const mediaHTML = i.image
      ? `<img src="${escapeHTML(i.image)}" class="w-12 h-12 rounded-xl object-cover">`
      : `<div class="w-12 h-12 rounded-2xl bg-base-700 flex items-center justify-center text-xl shrink-0">${escapeHTML(i.emoji || "📦")}</div>`;

    const isOwner = i.userId && String(i.userId) === String(currentUserId);
    const canDelete = isAdmin || isOwner;

    const deleteBtnHTML = canDelete ? `
      <button data-action="delete-lf" data-id="${id}" class="absolute top-3 right-3 text-red-400 hover:text-red-300 p-1">
        <i data-lucide="trash-2" class="w-4 h-4"></i>
      </button>` : "";

    return `
    <div class="glass rounded-2xl p-4 shadow-glow flex items-center gap-3 relative">
      ${mediaHTML}
      <div class="flex-1 min-w-0 pr-8">
        <div class="flex items-center gap-2">
          <p class="text-sm font-semibold leading-snug truncate text-slate-100">${escapeHTML(i.item)}</p>
          <span class="shrink-0 text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-md ${
            i.status === "lost"
              ? "text-amber-300 bg-amber-500/10 border border-amber-400/30"
              : "text-emerald-soft bg-emerald/10 border border-emerald/30"
          }">${escapeHTML(i.status)}</span>
        </div>
        <p class="text-[11px] text-slate-400 mt-1 flex items-center gap-1">
          <i data-lucide="map-pin" class="w-3 h-3 text-slate-500"></i> ${escapeHTML(i.location)} <span class="mx-1 text-slate-700">•</span> ${escapeHTML(i.date)}
        </p>
        
      </div>
      <button data-action="claim" data-id="${id}" class="tap shrink-0 bg-indigo/15 border border-indigo/30 text-indigo-soft text-[11px] font-semibold px-3 py-2 rounded-lg">
        Claim / Contact
      </button>
      ${deleteBtnHTML}
    </div>`;
  }).join("");

  refreshIcons();
}

// HTML uses data-lf="all|lost|found"
function setupLostFoundFilterListeners() {
  const btns = document.querySelectorAll("[data-lf]");
  btns.forEach((btn) => {
    btn.addEventListener("click", () => {
      state.lf = btn.dataset.lf;
      updateLFFilterUI(btns, btn);
      renderLostFound();
    });
  });
}

function updateLFFilterUI(allBtns, activeBtn) {
  const order = ["all", "lost", "found"];
  allBtns.forEach((b) => {
    b.classList.toggle("text-white", b === activeBtn);
    b.classList.toggle("text-slate-400", b !== activeBtn);
  });
  const pill = document.getElementById("lfPill");
  if (pill) pill.style.transform = `translateX(${Math.max(0, order.indexOf(activeBtn.dataset.lf)) * 100}%)`;
}

/* ---------------- Image Compression & Preview ---------------- */

// Firestore's limit is 1 MiB per document and the image is stored as a base64 STRING,
// so we cap the string length (not the decoded bytes). ~600K chars leaves plenty of headroom.
const MAX_IMAGE_CHARS = 600 * 1000;

async function loadImageForCompression(file) {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file);
    } catch (e) {
      console.warn("[MTU] createImageBitmap failed, falling back to <img>:", e);
    }
  }
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(objectUrl); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error("Could not read the selected image.")); };
    img.src = objectUrl;
  });
}

async function compressImageFile(file) {
  if (!file) return null;
  // Some Android WebViews give an empty file.type — only reject when it's clearly not an image
  if (file.type && !file.type.startsWith("image/")) {
    throw new Error("Please choose a valid image file.");
  }

  const image = await loadImageForCompression(file);
  const originalWidth = image.width;
  const originalHeight = image.height;

  if (!originalWidth || !originalHeight) {
    if (image.close) image.close();
    throw new Error("The selected image is invalid.");
  }

  let scale = Math.min(1, 1280 / Math.max(originalWidth, originalHeight));
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");

  if (!context) {
    if (image.close) image.close();
    throw new Error("Image compression is not supported in this browser.");
  }

  let quality = 0.8;
  for (let attempt = 0; attempt < 14; attempt++) {
    canvas.width = Math.max(1, Math.round(originalWidth * scale));
    canvas.height = Math.max(1, Math.round(originalHeight * scale));

    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    const dataUrl = canvas.toDataURL("image/jpeg", quality);
    if (dataUrl.length <= MAX_IMAGE_CHARS) {
      if (image.close) image.close();
      return dataUrl;
    }

    if (quality > 0.45) {
      quality -= 0.1;
    } else {
      scale *= 0.78;
      quality = 0.7;
    }
  }

  if (image.close) image.close();
  throw new Error("Image is still too large. Please choose a smaller image.");
}

function validateFirestoreImage(imageDataUrl) {
  if (imageDataUrl && imageDataUrl.length > MAX_IMAGE_CHARS) {
    throw new Error("Image is too large for the database. Please select it again.");
  }
}

const dropzone = document.getElementById("photoDropzone");
const imageInput = document.getElementById("itemImageInput");
const previewImg = document.getElementById("photoPreview");
const placeholder = document.getElementById("photoPlaceholder");

let uploadedBase64Image = null;
let imageProcessingPromise = Promise.resolve(null);
let imageFailed = false;

function resetPhotoUI() {
  uploadedBase64Image = null;
  imageProcessingPromise = Promise.resolve(null);
  if (imageInput) imageInput.value = "";
  if (previewImg) { previewImg.classList.add("hidden"); previewImg.removeAttribute("src"); }
  if (placeholder) placeholder.classList.remove("hidden");
}

if (dropzone && imageInput) {
  dropzone.addEventListener("click", () => imageInput.click());

  imageInput.addEventListener("change", (event) => {
    const file = event.target.files && event.target.files[0];
    imageFailed = false;

    if (!file) {
      resetPhotoUI();
      return;
    }

    if (previewImg) previewImg.classList.add("hidden");
    if (placeholder) placeholder.classList.remove("hidden");
    showToast("Compressing image…");

    // This promise NEVER rejects: a failure resets the photo and sets imageFailed,
    // so one bad photo can no longer break every later submit.
    imageProcessingPromise = compressImageFile(file)
      .then((compressed) => {
        validateFirestoreImage(compressed);
        uploadedBase64Image = compressed;
        if (previewImg) { previewImg.src = compressed; previewImg.classList.remove("hidden"); }
        if (placeholder) placeholder.classList.add("hidden");
        showToast("Image ready!");
        return compressed;
      })
      .catch((error) => {
        console.error("[MTU] Image compression failed:", error);
        imageFailed = true;
        resetPhotoUI();
        showToast((error && error.message) || "Could not process image");
        return null;
      });
  });
}

/* ---------------- Firestore Submissions (hardened) ---------------- */

function firestoreErrorMessage(err) {
  const code = err && err.code;
  const msg = (err && err.message) || "";
  if (!db) return "Database not connected. Check your internet and reopen the app.";
  if (code === "permission-denied") return "Not allowed by database rules. Ask the admin to update Firestore rules.";
  if (code === "unavailable") return "Cannot reach the server. Check your internet.";
  if (code === "resource-exhausted") return "Database quota exceeded. Try again later.";
  if (code === "invalid-argument" || /exceeds the maximum|too large|longer than/i.test(msg)) {
    return "Data is too large or invalid. Try a smaller photo.";
  }
  return "Could not save: " + (msg || code || "unknown error");
}

/**
 * Firestore's add() promise never settles while the device can't reach the server.
 * That made the button look dead. We race it against a timeout. On timeout the write is
 * still queued by the SDK (and shows locally), so we report it as "queued".
 */
function addDocWithTimeout(collection, data, ms = WRITE_TIMEOUT_MS) {
  if (!db) return Promise.reject(new Error("Database not connected"));

  const writePromise = db.collection(collection).add(data);
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve("queued"), ms); });

  return Promise.race([writePromise.then(() => "saved"), timeout]).then((result) => {
    clearTimeout(timer);
    if (result === "queued") {
      writePromise.catch((err) => {
        console.error("[MTU] Queued write failed later:", err);
        showToast(firestoreErrorMessage(err));
      });
    }
    return result;
  });
}

// Marks a field red, focuses it, shows a toast, and returns false
function failField(form, selector, message) {
  const el = form.querySelector(selector);
  if (el) {
    el.style.setProperty("border-color", "#ef4444", "important");
    el.addEventListener("input", () => el.style.removeProperty("border-color"), { once: true });
    try { el.focus(); } catch (e) { /* ignore */ }
  }
  showToast(message);
  return false;
}

function validPhone(phone) {
  return String(phone || "").replace(/\D/g, "").length >= 9;
}

// Shared submit wrapper: noValidate, logging, busy state, double-tap guard, error toast
function attachSubmit(formId, busyLabel, handler) {
  const form = document.getElementById(formId);
  if (!form) {
    console.error(`[MTU] #${formId} not found in DOM — submit handler NOT attached`);
    return;
  }

  // Native "required" bubbles are invisible in many Telegram WebViews → we validate ourselves
  form.noValidate = true;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    console.log(`[MTU] ${formId} submit fired`);

    if (form.dataset.busy === "1") return;

    const btn = form.querySelector('button[type="submit"]');
    const originalHTML = btn ? btn.innerHTML : "";
    form.dataset.busy = "1";
    if (btn) { btn.disabled = true; btn.textContent = busyLabel; btn.classList.add("opacity-70"); }

    try {
      await handler(form);
    } catch (err) {
      console.error(`[MTU] ${formId} failed:`, err);
      showToast(firestoreErrorMessage(err));
    } finally {
      form.dataset.busy = "0";
      if (btn) { btn.disabled = false; btn.innerHTML = originalHTML; btn.classList.remove("opacity-70"); }
      refreshIcons();
    }
  });

  console.log(`[MTU] submit handler attached to #${formId}`);
}

function trySendToBot(type, data) {
  if (!SEND_DATA_TO_BOT || !tg || !tg.sendData) return;
  try {
    tg.sendData(JSON.stringify({ type, data }));
  } catch (err) {
    console.warn("[MTU] tg.sendData failed (ignored):", err);
  }
}

// 1. Post Marketplace Item
attachSubmit("postItemForm", "Publishing…", async (form) => {
  const val = (name) => (form.elements[name]?.value || "").trim();

  const title = val("title");
  const priceRaw = val("price");
  const price = Number(priceRaw);
  const phone = val("phone");

  if (!title) return failField(form, '[name="title"]', "Please enter an item title");
  if (priceRaw === "" || !Number.isFinite(price) || price < 0) {
    return failField(form, '[name="price"]', "Please enter a valid price");
  }
  if (!validPhone(phone)) return failField(form, '[name="phone"]', "Enter a valid phone number (09…)");
  if (!currentUserId) return showToast("User ID missing. Please reopen the app.");

  // Wait for photo compression to finish (never rejects)
  showToast("Publishing…");
  const image = await imageProcessingPromise;
  if (imageFailed) {
    imageFailed = false;
    return showToast("Photo failed. Pick another photo, or tap Publish again to post without one.");
  }
  validateFirestoreImage(image);

  const category = val("category") || "Other";

  const newItem = {
    title,
    price,
    category,
    location: val("location") || "MTU Main Campus",
    seller: val("seller") || getTelegramFirstName() || "Campus Student",
    phone,
    telegram: cleanHandle(val("telegram") || getTelegramHandle()),
    description: val("description").slice(0, 500),
    views: 0,
    status: "available",
    userId: String(currentUserId),
    image: image || null,
    emoji: category === "Books" ? "📘" : category === "Clothing" ? "👕" : "📱",
    color: COLOR_GRADIENTS[Math.floor(Math.random() * COLOR_GRADIENTS.length)],
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  };

  console.log("[MTU] Saving product…", { ...newItem, image: newItem.image ? `(${newItem.image.length} chars)` : null });
  const result = await addDocWithTimeout("products", newItem);
  console.log("[MTU] Product result:", result);

  trySendToBot("NEW_LISTING", newItem);
  addNotification("New Listing Created", `Your item "${title}" has been published.`, "shopping-bag", "emerald");

  form.reset();
  resetPhotoUI();
  prefillTelegramFields(form);
  closeModal("postItemModal");
  showToast(result === "queued"
    ? "Slow connection — saved, will upload when you're online"
    : "Item posted successfully!");
});

// 2. Errand Request
attachSubmit("errandForm", "Posting…", async (form) => {
  const val = (name) => (form.elements[name]?.value || "").trim();

  const item = val("title") || val("item");
  const dorm = val("location") || val("dorm");
  const tipRaw = val("tip");
  const tip = Number(tipRaw);
  const phone = val("phone");

  if (!item) return failField(form, '[name="title"]', "Please describe what you need");
  if (!dorm) return failField(form, '[name="location"]', "Please enter a delivery location");
  if (tipRaw === "" || !Number.isFinite(tip) || tip < 0) return failField(form, '[name="tip"]', "Please enter a valid tip");
  if (!validPhone(phone)) return failField(form, '[name="phone"]', "Enter a valid phone number (09…)");
  if (!currentUserId) return showToast("User ID missing. Please reopen the app.");

  const newErrand = {
    item,
    dorm,
    tip,
    phone,
    telegram: cleanHandle(val("telegram") || getTelegramHandle()),
    userId: String(currentUserId),
    requester: val("requester") || getTelegramFirstName() || "Campus Student",
    time: "Just now",
    urgent: false,
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  };

  console.log("[MTU] Saving errand…", newErrand);
  const result = await addDocWithTimeout("errands", newErrand);
  console.log("[MTU] Errand result:", result);

  trySendToBot("NEW_ERRAND", newErrand);
  addNotification("Errand Request Posted", `Delivery request for "${item}" is live.`, "truck", "indigo");

  form.reset();
  prefillTelegramFields(form);
  closeModal("errandModal");
  showToast(result === "queued"
    ? "Slow connection — saved, will upload when you're online"
    : "Errand request posted!");
});

// 3. Report status toggle (Lost / Found)
document.querySelectorAll(".report-status-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".report-status-btn").forEach((b) => {
      b.className = "report-status-btn tap py-3 rounded-xl text-sm font-semibold border border-base-600 bg-base-800 text-slate-300";
    });
    btn.className = "report-status-btn tap py-3 rounded-xl text-sm font-semibold border border-emerald bg-emerald/20 text-emerald-soft";
    state.reportStatus = btn.dataset.status || (btn.textContent.includes("Found") ? "found" : "lost");
  });
});

// 4. Lost & Found Report
attachSubmit("reportForm", "Submitting…", async (form) => {
  const val = (name) => (form.elements[name]?.value || "").trim();

  const item = val("title") || val("item");
  const location = val("location");
  const phone = val("phone");

  if (!item) return failField(form, '[name="title"]', "Please enter the item name");
  if (!location) return failField(form, '[name="location"]', "Please enter a location");
  if (!validPhone(phone)) return failField(form, '[name="phone"]', "Enter a valid phone number (09…)");
  if (!currentUserId) return showToast("User ID missing. Please reopen the app.");

  const status = state.reportStatus || "lost";

  const newReport = {
    status,
    item,
    location,
    phone,
    telegram: cleanHandle(val("telegram") || getTelegramHandle()),
    userId: String(currentUserId),
    reporter: val("reporter") || getTelegramFirstName() || "Campus Student",
    date: val("date") || new Date().toISOString().slice(0, 10),
    emoji: status === "found" ? "📦" : "🔍",
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  };

  console.log("[MTU] Saving report…", newReport);
  const result = await addDocWithTimeout("lostfound", newReport);
  console.log("[MTU] Report result:", result);

  trySendToBot("NEW_REPORT", newReport);
  addNotification("Lost & Found Report Submitted", `Report for "${item}" has been logged.`, "search-check", "emerald");

  form.reset();
  prefillTelegramFields(form);
  closeModal("reportModal");
  showToast(result === "queued"
    ? "Slow connection — saved, will upload when you're online"
    : `Report submitted as ${status.toUpperCase()}`);
});

/* ---------------- Modal & Notification Wiring ---------------- */

const fabM = document.getElementById("fabMarketplace");
const fabE = document.getElementById("fabExpress");
const fabL = document.getElementById("fabLostFound");

if (fabM) fabM.addEventListener("click", () => openModal("postItemModal"));
if (fabE) fabE.addEventListener("click", () => openModal("errandModal"));
if (fabL) fabL.addEventListener("click", () => openModal("reportModal"));

// The ONLY handler for the bell (remove the inline <script> from index.html)
const notifBtn = document.getElementById("notifBtn");
if (notifBtn) {
  notifBtn.addEventListener("click", () => {
    markNotificationsAsRead();
    openModal("notifModal");
  });
}

document.querySelectorAll("[data-close-modal]").forEach((btn) => {
  btn.addEventListener("click", () => closeModal(btn.dataset.closeModal));
});

/* ---------------- Chat & Inbox Wiring ---------------- */

const inboxBtn = document.getElementById("inboxBtn");
if (inboxBtn) inboxBtn.addEventListener("click", openInbox);

const chatForm = document.getElementById("chatForm");
if (chatForm) {
  chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const input = document.getElementById("chatInput");
    if (!input) return;
    const text = input.value;
    if (!text.trim()) return;
    input.value = "";
    sendChatMessage(text);
    input.focus({ preventScroll: true });
  });
}

const chatModalEl = document.getElementById("chatModal");
if (chatModalEl) chatModalEl.addEventListener("close", teardownChat);

const inboxModalEl = document.getElementById("inboxModal");
if (inboxModalEl) inboxModalEl.addEventListener("close", teardownInbox);

if (chatModalEl) {
  chatModalEl.addEventListener("click", (e) => {
    if (e.target === chatModalEl) closeModal("chatModal");
  });
}

const popupAnnEl = document.getElementById("popupAnnouncementModal");
if (popupAnnEl) {
  popupAnnEl.addEventListener("click", (e) => {
    if (e.target === popupAnnEl) closeModal("popupAnnouncementModal");
  });
}

/* ---------------- Initialization ---------------- */

function init() {
  renderCategoryChips();
  updateNotifUI();      // also refreshes the bell badge
  updateInboxBadge();   // inbox badge (hidden while count is 0)
  setupSearchListener();
  setupLostFoundFilterListeners();
  setupDelegatedActions();
  setTab("marketplace");
  prefillAllForms();
  refreshIcons();
  MTUTrust.start();

  if (db) {
    listenToFirestore();
    startGlobalChatListener();
  } else {
    isLoadingProducts = false;
    renderProductGrid();
    showToast("Cannot connect to the database. Check your internet.");
  }
}

// Global safety net: surface any uncaught error instead of failing silently
window.addEventListener("unhandledrejection", (e) => console.error("[MTU] Unhandled rejection:", e.reason));
window.addEventListener("error", (e) => console.error("[MTU] Uncaught error:", e.message));

init();