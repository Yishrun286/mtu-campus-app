/* ============================================================
   MTU Campus — Firebase Production Logic & Real-time Sync
   Tabs: Marketplace · Campus Express & Emergency · Lost & Found
   Features Included:
     - Real-time Sync & Image File Readers
     - Mark as Sold / Available & Admin Deletion
     - Safety Tip Banner
     - Firestore Views / Analytics Counter
     - Telegram Native Share Link Button
     - Skeleton Loading Animations
     - Telegram user auto-fill (name + @username) in all forms
     - Real-time in-app chat (Firestore) + Messages inbox
     - [NEW] Automatic pop-up announcement (once per session)
     - [NEW] Owners no longer see "Contact & Chat" on their own listings
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

// Initialize Firebase & Firestore
if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}
const db = firebase.firestore();

// ---------------- Admin Setup & Telegram WebApp ----------------
const ADMIN_USERNAME = "yishrun"; // Admin Telegram Username (ያለ @)

const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
}

// Telegram ID ከሌለ በብራውዘር ደረጃ ቋሚ Device ID መፍጠር
function getOrCreateDeviceId() {
  let deviceId = localStorage.getItem("mtu_device_id");
  if (!deviceId) {
    deviceId = "dev_" + Math.random().toString(36).substring(2, 9) + "_" + Date.now();
    localStorage.setItem("mtu_device_id", deviceId);
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
  // Read fresh each time: initDataUnsafe is only guaranteed after the SDK is ready
  return window.Telegram?.WebApp?.initDataUnsafe?.user || null;
}

function getTelegramFirstName() {
  return (getTelegramUser()?.first_name || "").trim();
}

function getTelegramHandle() {
  const u = getTelegramUser()?.username;
  return u ? "@" + u : "";
}

// Remove leading @ and whitespace so we always store a clean handle
function cleanHandle(value) {
  return String(value || "").trim().replace(/^@+/, "");
}

// Small helper to safely print user-generated text inside innerHTML
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
let notifications = (JSON.parse(localStorage.getItem("mtu_notifications")) || [])
  .map(n => ({
    ...n,
    isRead: typeof n.isRead === "boolean" ? n.isRead : true
  }));
let isLoadingProducts = true;
let unreadChatCount = 0;


// [NEW] Pop-up announcement: show only once per app session
let hasShownPopup = false;

const CATEGORIES = ["All", "Electronics", "Books", "Clothing"];
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
   [NEW] Automatic Pop-up Announcement
   Firestore collection: announcements/{id}
     { title: string, body: string, createdAt: Timestamp }
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

/**
 * Grabs the latest announcement (announcementsList[0], list is sorted newest-first)
 * and opens the pop-up modal automatically the first time per session.
 */
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

  hasShownPopup = true; // set before opening so later snapshots never re-open it
  if (!dialog.open) dialog.showModal();
  refreshIcons();
}

// ---------------- Real-time Firestore Listeners (With Expiration Filter) ----------------

function listenToFirestore() {
  const fourteenDaysAgo = firebase.firestore.Timestamp.fromDate(
    new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)
  );

  // Show Skeletons initially
  renderSkeletonLoaders();

  // (አዲስ የተጨመረው) አፑ ሲከፈት ከ14 ቀን በላይ የሆናቸውን በራሱ የሚያጠፋው ኮድ
  const collections = ["products", "errands", "lostfound"];
  collections.forEach(async (col) => {
    try {
      const snapshot = await db.collection(col).where("createdAt", "<", fourteenDaysAgo).get();
      snapshot.forEach(doc => doc.ref.delete());
    } catch (e) { /* silent catch */ }
  });

  // 0. [NEW] Real-time Announcements Sync → auto pop-up
  db.collection("announcements")
    .orderBy("createdAt", "desc")
    .limit(10)
    .onSnapshot((snapshot) => {
      ANNOUNCEMENTS = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data({ serverTimestamps: "estimate" }) }));
      checkAndShowPopup(ANNOUNCEMENTS);
    }, (err) => console.error("Announcements listener error:", err));

  // 1. Real-time Products Sync
  db.collection("products")
    .where("createdAt", ">=", fourteenDaysAgo)
    .onSnapshot((snapshot) => {
      isLoadingProducts = false;
      PRODUCTS = snapshot.docs.map(doc => ({ id: doc.id, views: 0, ...doc.data() }));
      renderProductGrid();
    }, (err) => {
      console.error("Products listener error:", err);
      isLoadingProducts = false;
      renderProductGrid();
    });

  // 2. Real-time Errands Sync
  db.collection("errands")
    .where("createdAt", ">=", fourteenDaysAgo)
    .onSnapshot((snapshot) => {
      ERRANDS = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      renderErrandFeed();
    }, (err) => console.error("Errands listener error:", err));

  // 3. Real-time Lost & Found Sync
  db.collection("lostfound")
    .where("createdAt", ">=", fourteenDaysAgo)
    .onSnapshot((snapshot) => {
      LOSTFOUND = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      renderLostFound();
    }, (err) => console.error("LostFound listener error:", err));
}

/* ---------------- Form Helper & Utilities ---------------- */

function extractInputValue(form, selectors, fallback = "") {
  for (const selector of selectors) {
    const el = form.querySelector(selector);
    if (el && el.value && el.value.trim() !== "") {
      return el.value.trim();
    }
  }
  return fallback;
}

function etb(n) {
  return `${Number(n || 0).toLocaleString()} ETB`;
}

function showToast(message) {
  const toast = document.getElementById("toast");
  if (!toast) return;
  const msgEl = document.getElementById("toastMsg");
  if (msgEl) msgEl.textContent = message;
  toast.classList.remove("translate-y-24", "opacity-0");
  toast.classList.add("translate-y-0", "opacity-100");
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => {
    toast.classList.add("translate-y-24", "opacity-0");
    toast.classList.remove("translate-y-0", "opacity-100");
  }, 2200);
}

/* ---------------- Telegram Auto-Fill for Forms ---------------- */

// modal id -> form id
const FORM_MODALS = {
  postItemModal: "postItemForm",
  errandModal: "errandForm",
  reportModal: "reportForm"
};

function prefillTelegramFields(form) {
  if (!form) return;

  const handle = getTelegramHandle();
  const firstName = getTelegramFirstName();

  // @username → every Telegram input
  const tgField = form.querySelector('[name="telegram"]');
  if (tgField && handle && !tgField.value.trim()) {
    tgField.value = handle;
  }

  // First name → the "Your name" input
  const nameField = form.querySelector('[data-autofill="name"]');
  if (nameField && firstName && !nameField.value.trim()) {
    nameField.value = firstName;
  }
}

function prefillAllForms() {
  Object.values(FORM_MODALS).forEach((formId) => {
    prefillTelegramFields(document.getElementById(formId));
  });
}

function openModal(id) {
  // Always re-populate right before a form opens (form.reset() clears values after submit)
  if (FORM_MODALS[id]) {
    prefillTelegramFields(document.getElementById(FORM_MODALS[id]));
  }
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

  const skeletonHTML = Array(4).fill(0).map(() => `
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

  grid.innerHTML = skeletonHTML;
}

/* ---------------- View Counter Logic ---------------- */

async function incrementViews(productId) {
  if (!productId) return;
  try {
    const docRef = db.collection("products").doc(String(productId));
    await docRef.update({
      views: firebase.firestore.FieldValue.increment(1)
    });
  } catch (err) {
    console.warn("Could not increment views:", err);
  }
}

/* ---------------- Telegram Native Share Button ---------------- */

function shareToTelegram(title, price, location) {
  const shareText = `🔥 **MTU Campus Marketplace**\n\n📌 **Item:** ${title}\n💰 **Price:** ${etb(price)}\n📍 **Location:** ${location}\n\n👉 * Check it out on MTU Campus App!*`;

  if (tg && tg.openTelegramLink) {
    tg.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(window.location.href)}&text=${encodeURIComponent(shareText)}`);
  } else {
    window.open(`https://t.me/share/url?url=${encodeURIComponent(window.location.href)}&text=${encodeURIComponent(shareText)}`, '_blank');
  }
}

/* ---------------- Notification System ---------------- */

// ---------------- Notification System ----------------

function updateNotifBadge() {
  const badge = document.getElementById("notifBadge");
  if (!badge) return;

  const unreadCount = notifications.filter(n => !n.isRead).length;

  if (unreadCount === 0) {
    badge.textContent = "";
    badge.classList.add("hidden");
    return;
  }

  badge.textContent = unreadCount > 99 ? "99+" : String(unreadCount);
  badge.classList.remove("hidden");
}

function markNotificationsAsRead() {
  notifications = notifications.map(n => ({
    ...n,
    isRead: true
  }));

  localStorage.setItem("mtu_notifications", JSON.stringify(notifications));

  updateNotifUI();
}

function addNotification(title, message, iconName = "bell", iconColor = "emerald") {
  const newNotif = {
    id: Date.now(),
    title,
    message,
    time: "Just now",
    icon: iconName,
    color: iconColor,
    isRead: false
  };

  notifications.unshift(newNotif);

  localStorage.setItem("mtu_notifications", JSON.stringify(notifications));

  updateNotifUI();
}

function updateNotifUI() {
  updateNotifBadge();

  const container = document.getElementById("notifContainer");
  if (!container) return;

  if (notifications.length === 0) {
    container.innerHTML = `
      <div class="text-center py-8 text-slate-500 text-xs">
        No notifications yet.
      </div>`;
    return;
  }

  container.innerHTML = notifications.map(n => `
    <div class="p-3 rounded-2xl bg-base-800/60 border border-base-700 flex gap-3 items-start animate-fade-in">
      <div class="w-9 h-9 rounded-xl bg-${n.color}/10 text-${n.color}-soft flex items-center justify-center shrink-0 mt-0.5">
        <i data-lucide="${n.icon}" class="w-4 h-4"></i>
      </div>
      <div class="flex-1 min-w-0 text-xs">
        <p class="font-semibold text-slate-200">${n.title}</p>
        <p class="text-slate-400 mt-0.5">${n.message}</p>
        <span class="text-[10px] text-slate-500 mt-1 block">${n.time}</span>
      </div>
    </div>
  `).join("");

  refreshIcons();
}
/* ---------------- Firestore Status & Delete Functions ---------------- */

async function toggleProductStatus(id, currentStatus) {
  const newStatus = currentStatus === "sold" ? "available" : "sold";
  try {
    await db.collection("products").doc(String(id)).update({ status: newStatus });
    showToast(newStatus === "sold" ? "Item marked as Sold!" : "Item marked as Available");
  } catch (err) {
    showToast("Error updating status");
  }
}

async function deleteProduct(id) {
  if (confirm("Are you sure you want to remove this item?")) {
    try {
      await db.collection("products").doc(String(id)).delete();
      showToast("Item deleted!");
    } catch (err) {
      showToast("Error deleting item");
    }
  }
}

async function deleteErrand(id) {
  if (confirm("Mark this errand as completed / remove?")) {
    try {
      await db.collection("errands").doc(String(id)).delete();
      showToast("Errand removed!");
    } catch (err) {
      showToast("Error removing errand");
    }
  }
}

async function deleteLostFound(id) {
  if (confirm("Remove this report from Lost & Found?")) {
    try {
      await db.collection("lostfound").doc(String(id)).delete();
      showToast("Report removed!");
    } catch (err) {
      showToast("Error removing report");
    }
  }
}

/* ============================================================
   Real-time In-App Chat (Firestore)
   Data model:
     chats/{roomId}                    → room metadata (participants, names, title, lastMessage, updatedAt)
     chats/{roomId}/messages/{msgId}   → { text, senderId, senderName, createdAt }
   roomId = {kind}_{listingId}_{buyerId}   (one private room per buyer per listing)
   ============================================================ */

let chatCtx = null;        // current room context
let chatUnsub = null;      // active messages listener
let chatLoadTimer = null;  // "stuck loading" watchdog
let chatSession = 0;       // token to ignore stale snapshots
let inboxUnsub = null;     // inbox listener

function buildRoomId(kind, listingId, buyerId) {
  return `${kind}_${listingId}_${buyerId}`.replace(/[\/\s]/g, "_");
}

function teardownChat() {
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

  if (nearBottom || docs.length <= 1) {
    box.scrollTop = box.scrollHeight;
  }
}

function startChatListener() {
  if (!chatCtx) return;

  // Cancel any previous listener & watchdog before starting again (prevents duplicates)
  if (chatUnsub) { try { chatUnsub(); } catch (e) { /* ignore */ } chatUnsub = null; }
  clearTimeout(chatLoadTimer);

  const session = ++chatSession;
  const roomId = chatCtx.roomId;
  let loaded = false;

  showChatState("loading", "Opening chat…");

  // Watchdog: never show an infinite spinner
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
        if (session !== chatSession) return; // stale
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

/**
 * Opens the chat room.
 * ctx: { kind, listingId, title, ownerId, ownerName, buyerId?, buyerName? }
 * Buyer opens from a listing (buyerId defaults to me). Owner opens from the inbox (buyerId = other person).
 */
function openChat(ctx) {
  const ownerId = ctx.ownerId ? String(ctx.ownerId) : "";
  const buyerId = String(ctx.buyerId || currentUserId);

  if (!ownerId) {
    showToast("Chat unavailable for this older listing");
    return;
  }
  if (buyerId === ownerId) {
    showToast("This is your own listing");
    return;
  }

  // Close whatever modal we came from, then open chat
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

  setTimeout(() => { if (input) input.focus({ preventScroll: true }); }, 350);
}

function sendChatMessage(text) {
  if (!chatCtx) return;
  const clean = String(text || "").trim();
  if (!clean) return;

  const ctx = chatCtx;
  const senderName = getTelegramFirstName() || (String(currentUserId) === ctx.ownerId ? ctx.ownerName : ctx.buyerName) || "Student";
  const ts = firebase.firestore.FieldValue.serverTimestamp();

  const roomRef = db.collection("chats").doc(ctx.roomId);
  const msgRef = roomRef.collection("messages").doc();

  const batch = db.batch();
  // Room metadata (created on first message, updated on every message)
  batch.set(roomRef, {
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

  // Don't await: the local snapshot already shows the message instantly (latency compensation)
  batch.commit().catch((err) => {
    console.error("Send failed:", err);
    showToast(err && err.code === "permission-denied" ? "Not allowed to send messages" : "Message failed to send");
  });
}

/* ---------- Messages Inbox (so sellers can find buyers' chats) ---------- */

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
        <p class="text-xs text-slate-500">Tap "Contact & Chat" on any listing to start one.</p>
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


function updateInboxBadge() {
  const inboxBtn = document.getElementById("inboxBtn");
  if (!inboxBtn) return;

  // Remove any existing badge
  const oldBadge = document.getElementById("inboxBadge");
  if (oldBadge) oldBadge.remove();

  if (unreadChatCount <= 0) return;

  // Create new badge
  const badge = document.createElement("span");
  badge.id = "inboxBadge";
  badge.textContent = unreadChatCount > 9 ? "9+" : unreadChatCount;

  // Strong styling so it always shows
  badge.style.cssText = `
    position: absolute;
    top: -4px;
    right: -4px;
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    border-radius: 9999px;
    background: #ef4444;
    color: white;
    font-size: 10px;
    font-weight: 700;
    display: flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
    z-index: 50;
    box-shadow: 0 0 0 2px #07111F;
  `;

  // Make sure the button can contain absolute children
  inboxBtn.style.position = "relative";
  inboxBtn.style.overflow = "visible";

  inboxBtn.appendChild(badge);
}

function startGlobalChatListener() {
  if (globalChatUnsub) return;

  globalChatUnsub = db.collection("chats")
    .where("participants", "array-contains", String(currentUserId))
    .onSnapshot((snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type !== "modified") return;

        const data = change.doc.data();
        const lastSenderId = String(data.lastSenderId || "");

        // Ignore messages sent by me
        if (lastSenderId === String(currentUserId)) return;

        // Ignore if currently inside this chat
        if (chatCtx && chatCtx.roomId === change.doc.id) return;

        // Increase count + update badge
        unreadChatCount++;
        updateInboxBadge();

        // Toast
        const peerName = String(data.ownerId) === String(currentUserId)
          ? (data.buyerName || "Student")
          : (data.ownerName || "Seller");
        showToast(`አዲስ መልእክት ከ ${peerName}`);
      });
    }, (err) => {
      console.error("Global chat listener error:", err);
    });
}

function openInbox() {
    unreadChatCount = 0;
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
    // Single array-contains filter → no composite index needed; sorted client-side
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
   ============================================================ */

let globalChatUnsub = null;

function startGlobalChatListener() {
  // Already listening? don't start again
  if (globalChatUnsub) return;

  globalChatUnsub = db.collection("chats")
    .where("participants", "array-contains", String(currentUserId))
    .onSnapshot((snapshot) => {
      snapshot.docChanges().forEach((change) => {
        // Only care about modified rooms (new message)
        if (change.type !== "modified") return;

        const data = change.doc.data();
        const lastSenderId = String(data.lastSenderId || "");

        // Ignore if the message is from myself
        if (lastSenderId === String(currentUserId)) return;

        // Ignore if we are currently inside this chat
        if (chatCtx && chatCtx.roomId === change.doc.id) return;

        // Show notification
        const peerName = String(data.ownerId) === String(currentUserId)
          ? (data.buyerName || "Student")
          : (data.ownerName || "Seller");

        const title = data.title || "Listing";
        const preview = data.lastMessage || "New message";

        // 1. Toast
        showToast(`አዲስ መልእክት ከ ${peerName}`);

        // 2. Add to notifications list
        addNotification(
          `አዲስ መልእክት • ${peerName}`,
          `${title}: ${preview}`,
          "message-circle",
          "indigo"
        );

        // 3. Make sure badge is visible
        const badge = document.getElementById("notifBadge");
        if (badge) badge.classList.remove("hidden");
      });
    }, (err) => {
      console.error("Global chat listener error:", err);
    });
}

/* ---------------- Contact Modal Wireup ---------------- */

function openContactModal({ id, name, title, location, phone, telegram, kind, listingId, ownerId }) {
  // Increment View Count when contact modal is triggered (products only)
  if (id) {
    incrementViews(id);
  }

  const nameEl = document.getElementById("contactName");
  const metaEl = document.getElementById("contactMeta");
  const avatarEl = document.getElementById("contactAvatar");

  if (nameEl) nameEl.textContent = name || "Contact Person";
  if (metaEl) metaEl.textContent = `${title || ""} ${location ? "• " + location : ""}`;
  if (avatarEl) avatarEl.textContent = (name || "A").trim().charAt(0).toUpperCase() || "A";

  const isOwnListing = ownerId && String(ownerId) === String(currentUserId);

  const modalContainer = document.querySelector("#contactModal .grid");
  if (modalContainer) {
    const cleanPhone = phone || "";
    const cleanTg = (telegram || "").replace("@", "");
    const phoneHref = cleanPhone ? `tel:${cleanPhone}` : "#";
    const tgHref = cleanTg ? `https://t.me/${cleanTg}` : "#";

    modalContainer.innerHTML = `
      <!-- Safety Tip Banner -->
      <div class="col-span-2 p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-[11px] text-amber-300 flex items-center gap-2 mb-1">
        <i data-lucide="shield-alert" class="w-4 h-4 shrink-0 text-amber-400"></i>
        <span>እቃውን ሳያዩ እና በአካል ሳይገናኙ ምንም አይነት ክፍያ እንዳይፈጽሙ!</span>
      </div>

      <a href="${phoneHref}" ${!cleanPhone ? 'onclick="alert(\'No phone number provided\'); return false;"' : ''} class="tap flex items-center justify-center gap-2 bg-emerald text-base-950 font-semibold text-sm py-3 rounded-xl text-center">
        <i data-lucide="phone" class="w-4 h-4"></i> Call (${cleanPhone || 'N/A'})
      </a>
      <a href="${tgHref}" target="_blank" ${!cleanTg ? 'onclick="alert(\'No Telegram handle provided\'); return false;"' : ''} class="tap flex items-center justify-center gap-2 glass text-slate-100 font-semibold text-sm py-3 rounded-xl text-center">
        <i data-lucide="message-circle" class="w-4 h-4"></i> Telegram
      </a>

      <!-- In-App Chat -->
      <button type="button" id="contactChatBtn" class="tap col-span-2 flex items-center justify-center gap-2 bg-gradient-to-r from-indigo to-emerald text-white font-semibold text-sm py-3 rounded-xl shadow-glow-in">
        <i data-lucide="messages-square" class="w-4 h-4"></i> ${isOwnListing ? "My Messages" : "In-App Chat"}
      </button>
    `;

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

  const fabM = document.getElementById("fabMarketplace");
  const fabE = document.getElementById("fabExpress");
  const fabL = document.getElementById("fabLostFound");
  if (fabM) fabM.classList.toggle("hidden", tab !== "marketplace");
  if (fabE) fabE.classList.toggle("hidden", tab !== "express");
  if (fabL) fabL.classList.toggle("hidden", tab !== "lostfound");
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

  grid.innerHTML = filtered
    .map((p) => {
      const isSold = p.status === "sold";

      const mediaHTML = p.image
        ? `<img src="${p.image}" alt="${p.title}" class="w-full h-full object-cover ${isSold ? 'opacity-40 grayscale' : ''}">`
        : `<div class="w-full h-full bg-gradient-to-br ${p.color || "from-indigo to-emerald"} flex items-center justify-center text-3xl ${isSold ? 'opacity-40' : ''}">
            <span>${p.emoji || "📦"}</span>
           </div>`;

      // [UPDATED] Ownership check: p.userId === currentUserId
      const isOwner = !!p.userId && String(p.userId) === String(currentUserId);
      const canManage = isAdmin || isOwner;

      // Management buttons (Toggle Sold/Available + Delete) — owner / admin only
      const ownerActionsHTML = canManage ? `
        <div class="absolute top-2 right-2 z-10 flex gap-1">
          <button onclick="toggleProductStatus('${p.id}', '${p.status || 'available'}')" class="px-2 py-1 rounded-lg text-[10px] font-bold ${isSold ? 'bg-emerald text-base-950' : 'bg-amber-500 text-slate-950'} shadow-lg">
            ${isSold ? 'Available' : 'Sold'}
          </button>
          <button onclick="deleteProduct('${p.id}')" class="w-7 h-7 rounded-lg bg-red-500/80 text-white flex items-center justify-center shadow-lg hover:bg-red-600 transition-all">
            <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
          </button>
        </div>
      ` : '';

      // Sold Out Badge Overlay
      const soldBadgeHTML = isSold ? `
        <span class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-10 bg-red-600 text-white font-bold text-xs uppercase tracking-widest px-3 py-1 rounded-full shadow-lg border border-white/20">
          SOLD OUT
        </span>
      ` : '';

      // Safe Strings for Share Link
      const safeTitle = (p.title || "").replace(/'/g, "\\'");
      const safeLoc = (p.location || "").replace(/'/g, "\\'");

      // [UPDATED] Bottom action area:
      //   - Owner  → no "Contact & Chat" button (they use the management buttons above)
      //   - Buyer  → "Contact & Chat" button (or a disabled "Sold Out" button)
      let bottomActionHTML = "";
      if (!isOwner) {
        bottomActionHTML = isSold
          ? `<button disabled class="mt-2 w-full bg-base-800 text-slate-500 text-[11px] font-semibold py-2 rounded-lg cursor-not-allowed">Item Sold Out</button>`
          : `<button data-contact="product-${p.id}" class="tap mt-2 w-full bg-indigo/20 border border-indigo/40 text-indigo-soft hover:bg-indigo/30 text-[11px] font-semibold py-2 rounded-lg transition-all flex items-center justify-center gap-1.5">
               <i data-lucide="messages-square" class="w-3.5 h-3.5"></i> Contact &amp; Chat
             </button>`;
      }

      return `
    <div class="group rounded-2xl overflow-hidden glass shadow-glow flex flex-col relative ${isSold ? 'border-red-500/30' : ''}">
      ${ownerActionsHTML}
      <div class="h-28 relative overflow-hidden bg-base-800">
        ${soldBadgeHTML}
        ${mediaHTML}
        <span class="absolute top-2 left-2 text-[9px] font-semibold uppercase tracking-wide bg-black/60 text-white px-2 py-0.5 rounded-md backdrop-blur-md">
          ${p.category}
        </span>
        <!-- Telegram Share Button Overlay -->
        <button onclick="shareToTelegram('${safeTitle}', ${p.price}, '${safeLoc}')" class="absolute bottom-2 right-2 z-10 w-7 h-7 rounded-full bg-black/60 text-slate-200 hover:text-white backdrop-blur-md flex items-center justify-center">
          <i data-lucide="share-2" class="w-3.5 h-3.5"></i>
        </button>
      </div>
      <div class="p-3 flex flex-col gap-1 flex-1">
        <p class="text-xs font-semibold leading-snug line-clamp-2 min-h-[2rem] text-slate-100">${p.title}</p>

        <div class="flex items-center justify-between mt-0.5">
          <p class="font-display font-bold text-sm text-emerald-soft">${etb(p.price)}</p>
          <!-- View Counter Display -->
          <span class="text-[10px] text-slate-400 flex items-center gap-1 bg-base-800/80 px-1.5 py-0.5 rounded-md">
            <i data-lucide="eye" class="w-3 h-3 text-slate-500"></i> ${p.views || 0}
          </span>
        </div>

        <div class="text-[10.5px] text-slate-400 flex flex-col gap-0.5 mt-1">
          <span class="flex items-center gap-1">
            <i data-lucide="map-pin" class="w-3 h-3 text-slate-500"></i> ${p.location}
          </span>
          <span class="flex items-center gap-1">
            <i data-lucide="user" class="w-3 h-3 text-slate-500"></i> Seller: <strong class="text-slate-300 font-normal">${p.seller}</strong>
          </span>
        </div>
        ${bottomActionHTML}
      </div>
    </div>`;
    })
    .join("");

  grid.querySelectorAll("[data-contact]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.contact.replace("product-", "");
      const p = PRODUCTS.find((x) => String(x.id) === id);
      if (p) {
        openContactModal({
          id: p.id,
          kind: "product",
          listingId: p.id,
          ownerId: p.userId,
          name: p.seller,
          title: p.title,
          location: p.location,
          phone: p.phone,
          telegram: p.telegram
        });
      }
    });
  });

  refreshIcons();
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

  wrap.innerHTML = ERRANDS.map(
    (e) => {
      const isOwner = e.userId && String(e.userId) === String(currentUserId);
      const canDelete = isAdmin || isOwner;

      const deleteBtnHTML = canDelete ? `
        <button onclick="deleteErrand('${e.id}')" class="absolute top-3 right-3 text-red-400 hover:text-red-300 p-1">
          <i data-lucide="trash-2" class="w-4 h-4"></i>
        </button>
      ` : '';

      return `
    <div class="glass rounded-2xl p-4 shadow-glow flex items-start gap-3 relative">
      <div class="w-10 h-10 rounded-xl bg-emerald/15 border border-emerald/25 flex items-center justify-center shrink-0">
        <i data-lucide="package" class="w-4 h-4 text-emerald-soft"></i>
      </div>
      <div class="flex-1 min-w-0 pr-8">
        <div class="flex items-start justify-between gap-2">
          <p class="text-sm font-semibold leading-snug text-slate-100">${e.item}</p>
          ${e.urgent ? '<span class="shrink-0 text-[9px] font-bold uppercase tracking-wide text-amber-300 bg-amber-500/10 border border-amber-400/30 px-1.5 py-0.5 rounded-md">Urgent</span>' : ""}
        </div>
        <p class="text-[11px] text-slate-400 mt-1 flex items-center gap-1">
          <i data-lucide="map-pin" class="w-3 h-3 text-slate-500"></i> ${e.dorm} <span class="mx-1 text-slate-700">•</span> ${e.time || "Just now"}
        </p>
        <div class="flex items-center justify-between mt-3">
          <span class="text-xs font-display font-bold text-emerald-soft">${etb(e.tip)} tip</span>
          <button data-errand="${e.id}" class="tap bg-emerald text-base-950 text-[11px] font-bold px-3.5 py-2 rounded-lg flex items-center gap-1.5 shadow-glow-em">
            <i data-lucide="check" class="w-3 h-3"></i> Accept &amp; Contact
          </button>
        </div>
      </div>
      ${deleteBtnHTML}
    </div>`;
    }
  ).join("");

  wrap.querySelectorAll("[data-errand]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.errand;
      const e = ERRANDS.find((x) => String(x.id) === id);
      if (e) {
        openContactModal({
          kind: "errand",
          listingId: e.id,
          ownerId: e.userId,
          name: e.requester || "Requester",
          title: e.item,
          location: e.dorm,
          phone: e.phone,
          telegram: e.telegram
        });
      }
    });
  });

  refreshIcons();
}

/* ---------------- Lost & Found Render & Filter ---------------- */

function renderLostFound() {
  const wrap = document.getElementById("lostFoundList");
  if (!wrap) return;

  const filtered = LOSTFOUND.filter((i) => state.lf === "all" || i.status === state.lf);

  if (filtered.length === 0) {
    wrap.innerHTML = `<div class="flex flex-col items-center justify-center py-14 text-center gap-2"><p class="text-sm font-semibold text-slate-300">No ${state.lf === 'all' ? '' : state.lf} items reported</p></div>`;
    refreshIcons();
    return;
  }

  wrap.innerHTML = filtered
    .map((i) => {
      const mediaHTML = i.image
        ? `<img src="${i.image}" class="w-12 h-12 rounded-xl object-cover">`
        : `<div class="w-12 h-12 rounded-2xl bg-base-700 flex items-center justify-center text-xl shrink-0">${i.emoji || "📦"}</div>`;

      const isOwner = i.userId && String(i.userId) === String(currentUserId);
      const canDelete = isAdmin || isOwner;

      const deleteBtnHTML = canDelete ? `
        <button onclick="deleteLostFound('${i.id}')" class="absolute top-3 right-3 text-red-400 hover:text-red-300 p-1">
          <i data-lucide="trash-2" class="w-4 h-4"></i>
        </button>
      ` : '';

      return `
    <div class="glass rounded-2xl p-4 shadow-glow flex items-center gap-3 relative">
      ${mediaHTML}
      <div class="flex-1 min-w-0 pr-8">
        <div class="flex items-center gap-2">
          <p class="text-sm font-semibold leading-snug truncate text-slate-100">${i.item}</p>
          <span class="shrink-0 text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-md ${
            i.status === "lost"
              ? "text-amber-300 bg-amber-500/10 border border-amber-400/30"
              : "text-emerald-soft bg-emerald/10 border border-emerald/30"
          }">${i.status}</span>
        </div>
        <p class="text-[11px] text-slate-400 mt-1 flex items-center gap-1">
          <i data-lucide="map-pin" class="w-3 h-3 text-slate-500"></i> ${i.location} <span class="mx-1 text-slate-700">•</span> ${i.date}
        </p>
      </div>
      <button data-claim="${i.id}" class="tap shrink-0 bg-indigo/15 border border-indigo/30 text-indigo-soft text-[11px] font-semibold px-3 py-2 rounded-lg">
        Claim / Contact
      </button>
      ${deleteBtnHTML}
    </div>`;
    })
    .join("");

  wrap.querySelectorAll("[data-claim]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.claim;
      const i = LOSTFOUND.find((x) => String(x.id) === id);
      if (i) {
        openContactModal({
          kind: "lostfound",
          listingId: i.id,
          ownerId: i.userId,
          name: i.reporter || "Owner / Finder",
          title: `${i.item} (${i.status.toUpperCase()})`,
          location: i.location,
          phone: i.phone,
          telegram: i.telegram
        });
      }
    });
  });

  refreshIcons();
}

function setupLostFoundFilterListeners() {
  const filterBtns = document.querySelectorAll('[data-lf-filter]');
  if (filterBtns.length === 0) {
    const buttons = document.querySelectorAll('#page-lostfound button');
    buttons.forEach((btn) => {
      const txt = btn.textContent.trim().toLowerCase();
      if (['all', 'lost', 'found'].includes(txt)) {
        btn.addEventListener('click', () => {
          state.lf = txt;
          updateLFFilterUI(buttons, btn);
          renderLostFound();
        });
      }
    });
  } else {
    filterBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        state.lf = btn.dataset.lfFilter;
        updateLFFilterUI(filterBtns, btn);
        renderLostFound();
      });
    });
  }
}

function updateLFFilterUI(allBtns, activeBtn) {
  allBtns.forEach((b) => {
    b.classList.remove('bg-emerald', 'text-base-950', 'bg-indigo/20', 'text-indigo-soft');
    b.classList.add('bg-base-800', 'text-slate-400');
  });
  activeBtn.classList.remove('bg-base-800', 'text-slate-400');
  activeBtn.classList.add('bg-indigo/20', 'text-indigo-soft');
}

/* ---------------- Image Helper ---------------- */

const dropzone = document.getElementById("photoDropzone");
const imageInput = document.getElementById("itemImageInput");
const previewImg = document.getElementById("photoPreview");
const placeholder = document.getElementById("photoPlaceholder");

let uploadedBase64Image = null;

if (dropzone && imageInput) {
  dropzone.addEventListener("click", () => imageInput.click());

  imageInput.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        uploadedBase64Image = event.target.result;
        if (previewImg) {
          previewImg.classList.remove("hidden");
          previewImg.src = uploadedBase64Image;
        }
        if (placeholder) {
          placeholder.classList.add("hidden");
        }
      };
      reader.readAsDataURL(file);
    }
  });
}

/* ---------------- Firestore Submissions & Real-time Writes ---------------- */

// 1. Post Marketplace Item Form
const postItemForm = document.getElementById("postItemForm");
if (postItemForm) {
  postItemForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;

    const title = extractInputValue(form, ['[name="title"]', '#itemTitle', 'input[placeholder*="title" i]'], "Campus Item");
    const price = Number(extractInputValue(form, ['[name="price"]', '#itemPrice', 'input[type="number"]'], "0"));
    const category = extractInputValue(form, ['[name="category"]', '#itemCategory', 'select'], "Electronics");
    const location = extractInputValue(form, ['[name="location"]', '#itemLocation', 'input[placeholder*="Dorm" i]'], "MTU Main Campus");
    const seller = extractInputValue(form, ['[name="seller"]', '#itemSeller'], getTelegramFirstName() || "Campus Student");
    const phone = extractInputValue(form, ['[name="phone"]', '#itemPhone', 'input[type="tel"]'], "");
    const telegram = cleanHandle(extractInputValue(form, ['[name="telegram"]', '#itemTelegram'], getTelegramHandle()));

    const newItem = {
      title,
      price,
      category,
      location,
      seller,
      phone,
      telegram,
      views: 0, // Initial views
      status: "available",
      userId: String(currentUserId),
      image: uploadedBase64Image,
      emoji: category === "Books" ? "📘" : category === "Clothing" ? "👕" : "📱",
      color: COLOR_GRADIENTS[Math.floor(Math.random() * COLOR_GRADIENTS.length)],
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    };

    try {
      await db.collection("products").add(newItem);

      if (tg && tg.sendData) {
        tg.sendData(JSON.stringify({ type: "NEW_LISTING", data: newItem }));
      }

      addNotification("New Listing Created", `Your item "${title}" has been published.`, "shopping-bag", "emerald");

      form.reset();
      uploadedBase64Image = null;
      if (previewImg) previewImg.classList.add("hidden");
      if (placeholder) placeholder.classList.remove("hidden");

      closeModal("postItemModal");
      showToast("Item posted successfully!");
    } catch (err) {
      console.error(err);
      showToast("Error posting item to cloud");
    }
  });
}

// 2. Errand Request Form
const errandForm = document.getElementById("errandForm");
if (errandForm) {
  errandForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;

    const item = extractInputValue(form, ['[name="item"]', '[name="title"]', 'input[placeholder*="need" i]'], "Campus Delivery");
    const dorm = extractInputValue(form, ['[name="dorm"]', '[name="location"]', 'input[placeholder*="location" i]'], "MTU Dorm");
    const tip = Number(extractInputValue(form, ['[name="tip"]', 'input[type="number"]'], "20"));
    const phone = extractInputValue(form, ['[name="phone"]', 'input[type="tel"]'], "");
    const telegram = cleanHandle(extractInputValue(form, ['[name="telegram"]'], getTelegramHandle()));
    const requester = extractInputValue(form, ['[name="requester"]'], getTelegramFirstName() || "Campus Student");

    const newErrand = {
      item,
      dorm,
      tip,
      phone,
      telegram,
      userId: String(currentUserId),
      requester,
      time: "Just now",
      urgent: false,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    };

    try {
      await db.collection("errands").add(newErrand);

      if (tg && tg.sendData) {
        tg.sendData(JSON.stringify({ type: "NEW_ERRAND", data: newErrand }));
      }

      addNotification("Errand Request Posted", `Delivery request for "${item}" is live.`, "truck", "indigo");

      form.reset();
      closeModal("errandModal");
      showToast("Errand request posted!");
    } catch (err) {
      console.error(err);
      showToast("Error posting errand");
    }
  });
}

// 3. Report Status Selection
document.querySelectorAll(".report-status-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".report-status-btn").forEach((b) => {
      b.className = "report-status-btn tap py-3 rounded-xl text-sm font-semibold border border-base-600 bg-base-800 text-slate-300";
    });
    btn.className = "report-status-btn tap py-3 rounded-xl text-sm font-semibold border border-emerald bg-emerald/20 text-emerald-soft";

    const statusVal = btn.dataset.status || (btn.textContent.includes("Found") ? "found" : "lost");
    state.reportStatus = statusVal;
  });
});

// 4. Lost & Found Form
const reportForm = document.getElementById("reportForm");
if (reportForm) {
  reportForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;

    const item = extractInputValue(form, ['[name="item"]', '[name="title"]', 'input[placeholder*="Item" i]'], "Reported Item");
    const location = extractInputValue(form, ['[name="location"]', '[placeholder*="Location" i]'], "Campus Grounds");
    const phone = extractInputValue(form, ['[name="phone"]', 'input[type="tel"]'], "");
    const telegram = cleanHandle(extractInputValue(form, ['[name="telegram"]'], getTelegramHandle()));
    const reporter = extractInputValue(form, ['[name="reporter"]'], getTelegramFirstName() || "Campus Student");
    const date = extractInputValue(form, ['[name="date"]'], "Today");

    const currentStatus = state.reportStatus || "lost";

    const newReport = {
      status: currentStatus,
      item,
      location,
      phone,
      telegram,
      userId: String(currentUserId),
      reporter,
      date,
      emoji: currentStatus === "found" ? "📦" : "🔍",
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    };

    try {
      await db.collection("lostfound").add(newReport);

      if (tg && tg.sendData) {
        tg.sendData(JSON.stringify({ type: "NEW_REPORT", data: newReport }));
      }

      addNotification("Lost & Found Report Submitted", `Report for "${item}" has been logged.`, "search-check", "emerald");

      form.reset();
      closeModal("reportModal");
      showToast(`Report submitted as ${currentStatus.toUpperCase()}`);
    } catch (err) {
      console.error(err);
      showToast("Error submitting report");
    }
  });
}

/* ---------------- Modal & Notification Wiring ---------------- */

const fabM = document.getElementById("fabMarketplace");
const fabE = document.getElementById("fabExpress");
const fabL = document.getElementById("fabLostFound");

if (fabM) fabM.addEventListener("click", () => openModal("postItemModal"));
if (fabE) fabE.addEventListener("click", () => openModal("errandModal"));
if (fabL) fabL.addEventListener("click", () => openModal("reportModal"));

const notifBtn = document.getElementById("notifBtn");

if (notifBtn) {
  notifBtn.addEventListener("click", () => {
    markNotificationsAsRead();
    openModal("notifModal");
  });
}
const notifBadge = document.getElementById("notifBadge");

if (notifBtn) {
  notifBtn.addEventListener("click", () => {
    if (notifBadge) notifBadge.classList.add("hidden");
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

// Clean up listeners whenever the dialogs close (X button, backdrop, or Esc key)
const chatModalEl = document.getElementById("chatModal");
if (chatModalEl) chatModalEl.addEventListener("close", teardownChat);

const inboxModalEl = document.getElementById("inboxModal");
if (inboxModalEl) inboxModalEl.addEventListener("close", teardownInbox);

// Tap on the dimmed backdrop closes the chat sheet
if (chatModalEl) {
  chatModalEl.addEventListener("click", (e) => {
    if (e.target === chatModalEl) closeModal("chatModal");
  });
}

// [NEW] Tap on the dimmed backdrop closes the announcement pop-up
const popupAnnEl = document.getElementById("popupAnnouncementModal");
if (popupAnnEl) {
  popupAnnEl.addEventListener("click", (e) => {
    if (e.target === popupAnnEl) closeModal("popupAnnouncementModal");
  });
}

/* ---------------- Initialization ---------------- */

function init() {
  renderCategoryChips();
  updateNotifUI();
  setupSearchListener();
  setupLostFoundFilterListeners();
  setTab("marketplace");
  prefillAllForms();
  refreshIcons();

  listenToFirestore();
  startGlobalChatListener();
 
}

init();