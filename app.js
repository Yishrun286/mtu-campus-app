/* ============================================================
   MTU Campus — Production Logic with GitHub Sync & Telegram SDK
   Tabs: Marketplace · Campus Express & Emergency · Lost & Found
   ============================================================ */

// ---------------- Telegram WebApp Initialization ----------------
const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
}

/* ---------------- Sample & GitHub Data Storage ---------------- */

const GITHUB_RAW_URL = "https://raw.githubusercontent.com/yishrun286/mtu-campus-app/main/listings.json";

const INITIAL_PRODUCTS = [
  { id: 1, title: "TI-84 Plus Calculator", price: 1450, category: "Electronics", location: "Block 6", seller: "Hana T.", phone: "0911223344", telegram: "hana_t", image: null, emoji: "🧮", color: "from-indigo to-indigo-soft" },
  { id: 2, title: "Intro to Thermodynamics (4th Ed)", price: 350, category: "Books", location: "Girls' Dorm 2", seller: "Selam A.", phone: "0922334455", telegram: "selam_a", image: null, emoji: "📘", color: "from-emerald to-emerald-soft" }
];

const INITIAL_ERRANDS = [
  { id: 101, item: "Lunch pickup from Cafeteria 2", dorm: "Block 7, Room 214", tip: 25, requester: "Liya M.", phone: "0911223344", telegram: "liya_m", time: "5 min ago", urgent: false }
];

const INITIAL_LOSTFOUND = [
  { id: 201, status: "lost", item: "Black North Face Backpack", location: "Near Library Entrance", date: "Aug 15", reporter: "Abebe B.", phone: "0933445566", telegram: "abe_b", emoji: "🎒", image: null }
];

// Local Storage Fallbacks
let PRODUCTS = JSON.parse(localStorage.getItem("mtu_products")) || INITIAL_PRODUCTS;
let ERRANDS = JSON.parse(localStorage.getItem("mtu_errands")) || INITIAL_ERRANDS;
let LOSTFOUND = JSON.parse(localStorage.getItem("mtu_lostfound")) || INITIAL_LOSTFOUND;
let notifications = JSON.parse(localStorage.getItem("mtu_notifications")) || [];

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

/* ---------------- GitHub Data Sync (Buyer Side) ---------------- */

async function syncWithGitHub() {
  try {
    const response = await fetch(GITHUB_RAW_URL);
    if (response.ok) {
      const cloudProducts = await response.json();
      if (Array.isArray(cloudProducts) && cloudProducts.length > 0) {
        PRODUCTS = cloudProducts;
        localStorage.setItem("mtu_products", JSON.stringify(PRODUCTS));
        renderProductGrid();
      }
    }
  } catch (err) {
    console.log("GitHub data fetch failed, using cached LocalStorage data.", err);
  }
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

function openModal(id) {
  const dialog = document.getElementById(id);
  if (dialog && typeof dialog.showModal === "function") dialog.showModal();
}

function closeModal(id) {
  const dialog = document.getElementById(id);
  if (dialog) dialog.close();
}

function refreshIcons() {
  if (window.lucide) window.lucide.createIcons();
}

/* ---------------- Notification System ---------------- */

function addNotification(title, message, iconName = 'bell', iconColor = 'emerald') {
  const newNotif = {
    id: Date.now(),
    title,
    message,
    time: 'Just now',
    icon: iconName,
    color: iconColor
  };

  notifications.unshift(newNotif);
  localStorage.setItem("mtu_notifications", JSON.stringify(notifications));
  updateNotifUI();

  const badge = document.getElementById("notifBadge");
  if (badge) badge.classList.remove("hidden");
}

function updateNotifUI() {
  const container = document.getElementById("notifContainer");
  if (!container) return;

  if (notifications.length === 0) {
    container.innerHTML = `<div class="text-center py-8 text-slate-500 text-xs">No notifications yet.</div>`;
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
  `).join('');

  refreshIcons();
}

/* ---------------- Delete Functions ---------------- */

function deleteProduct(id) {
  if (confirm("Are you sure you want to remove this item?")) {
    PRODUCTS = PRODUCTS.filter((p) => p.id !== id);
    localStorage.setItem("mtu_products", JSON.stringify(PRODUCTS));
    renderProductGrid();
    showToast("Item deleted!");
  }
}

function deleteErrand(id) {
  if (confirm("Mark this errand as completed / remove?")) {
    ERRANDS = ERRANDS.filter((e) => e.id !== id);
    localStorage.setItem("mtu_errands", JSON.stringify(ERRANDS));
    renderErrandFeed();
    showToast("Errand removed!");
  }
}

function deleteLostFound(id) {
  if (confirm("Remove this report from Lost & Found?")) {
    LOSTFOUND = LOSTFOUND.filter((i) => i.id !== id);
    localStorage.setItem("mtu_lostfound", JSON.stringify(LOSTFOUND));
    renderLostFound();
    showToast("Report removed!");
  }
}

/* ---------------- Contact Modal Wireup ---------------- */

function openContactModal({ name, title, location, phone, telegram }) {
  const nameEl = document.getElementById("contactName");
  const metaEl = document.getElementById("contactMeta");

  if (nameEl) nameEl.textContent = name || "Contact Person";
  if (metaEl) metaEl.textContent = `${title || ""} ${location ? "• " + location : ""}`;

  const modalContainer = document.querySelector("#contactModal .grid");
  if (modalContainer) {
    const cleanPhone = phone || "";
    const cleanTg = (telegram || "").replace("@", "");
    const phoneHref = cleanPhone ? `tel:${cleanPhone}` : "#";
    const tgHref = cleanTg ? `https://t.me/${cleanTg}` : "#";

    modalContainer.innerHTML = `
      <a href="${phoneHref}" ${!cleanPhone ? 'onclick="alert(\'No phone number provided\'); return false;"' : ''} class="tap flex items-center justify-center gap-2 bg-emerald text-base-950 font-semibold text-sm py-3 rounded-xl text-center">
        <i data-lucide="phone" class="w-4 h-4"></i> Call (${cleanPhone || 'N/A'})
      </a>
      <a href="${tgHref}" target="_blank" ${!cleanTg ? 'onclick="alert(\'No Telegram handle provided\'); return false;"' : ''} class="tap flex items-center justify-center gap-2 glass text-slate-100 font-semibold text-sm py-3 rounded-xl text-center">
        <i data-lucide="message-circle" class="w-4 h-4"></i> Telegram
      </a>
    `;
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

  const q = state.search.trim().toLowerCase();

  const filtered = PRODUCTS.filter((p) => {
    const matchesCat = state.category === "All" || p.category === state.category;
    const matchesSearch =
      !q ||
      p.title.toLowerCase().includes(q) ||
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
      const mediaHTML = p.image
        ? `<img src="${p.image}" alt="${p.title}" class="w-full h-full object-cover">`
        : `<div class="w-full h-full bg-gradient-to-br ${p.color || "from-indigo to-emerald"} flex items-center justify-center text-3xl">
            <span>${p.emoji || "📦"}</span>
           </div>`;

      return `
    <div class="group rounded-2xl overflow-hidden glass shadow-glow flex flex-col relative">
      <button onclick="deleteProduct(${p.id})" class="absolute top-2 right-2 z-10 w-6 h-6 rounded-full bg-black/60 text-slate-300 flex items-center justify-center hover:bg-red-500 hover:text-white transition-all">
        <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
      </button>
      <div class="h-28 relative overflow-hidden bg-base-800">
        ${mediaHTML}
        <span class="absolute top-2 left-2 text-[9px] font-semibold uppercase tracking-wide bg-black/60 text-white px-2 py-0.5 rounded-md backdrop-blur-md">
          ${p.category}
        </span>
      </div>
      <div class="p-3 flex flex-col gap-1 flex-1">
        <p class="text-xs font-semibold leading-snug line-clamp-2 min-h-[2rem] text-slate-100">${p.title}</p>
        <p class="font-display font-bold text-sm text-emerald-soft">${etb(p.price)}</p>
        <div class="text-[10.5px] text-slate-400 flex flex-col gap-0.5 mt-1">
          <span class="flex items-center gap-1">
            <i data-lucide="map-pin" class="w-3 h-3 text-slate-500"></i> ${p.location}
          </span>
          <span class="flex items-center gap-1">
            <i data-lucide="user" class="w-3 h-3 text-slate-500"></i> Seller: <strong class="text-slate-300 font-normal">${p.seller}</strong>
          </span>
        </div>
        <button data-contact="product-${p.id}" class="tap mt-2 w-full bg-indigo/20 border border-indigo/40 text-indigo-soft hover:bg-indigo/30 text-[11px] font-semibold py-2 rounded-lg transition-all">
          Contact Seller
        </button>
      </div>
    </div>`;
    })
    .join("");

  grid.querySelectorAll("[data-contact]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = Number(btn.dataset.contact.split("-")[1]);
      const p = PRODUCTS.find((x) => x.id === id);
      if (p) {
        openContactModal({
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
    (e) => `
    <div class="glass rounded-2xl p-4 shadow-glow flex items-start gap-3 relative">
      <div class="w-10 h-10 rounded-xl bg-emerald/15 border border-emerald/25 flex items-center justify-center shrink-0">
        <i data-lucide="package" class="w-4 h-4 text-emerald-soft"></i>
      </div>
      <div class="flex-1 min-w-0 pr-6">
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
      <button onclick="deleteErrand(${e.id})" class="absolute top-3 right-3 text-slate-500 hover:text-red-400">
        <i data-lucide="x" class="w-4 h-4"></i>
      </button>
    </div>`
  ).join("");

  wrap.querySelectorAll("[data-errand]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = Number(btn.dataset.errand);
      const e = ERRANDS.find((x) => x.id === id);
      if (e) {
        openContactModal({
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

      return `
    <div class="glass rounded-2xl p-4 shadow-glow flex items-center gap-3 relative">
      ${mediaHTML}
      <div class="flex-1 min-w-0 pr-6">
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
      <button onclick="deleteLostFound(${i.id})" class="absolute top-3 right-3 text-slate-500 hover:text-red-400">
        <i data-lucide="x" class="w-4 h-4"></i>
      </button>
    </div>`;
    })
    .join("");

  wrap.querySelectorAll("[data-claim]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = Number(btn.dataset.claim);
      const i = LOSTFOUND.find((x) => x.id === id);
      if (i) {
        openContactModal({
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

function readImageFile(file) {
  return new Promise((resolve) => {
    if (!file) resolve(null);
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

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
          previewImg.src = uploadedBase64Image;
          previewImg.classList.remove("hidden");
        }
        if (placeholder) {
          placeholder.classList.add("hidden");
        }
      };
      reader.readAsDataURL(file);
    }
  });
}

/* ---------------- Form Submissions + Telegram WebApp SDK Data Send ---------------- */

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
    const seller = tg?.initDataUnsafe?.user?.first_name || extractInputValue(form, ['[name="seller"]', '#itemSeller', 'input[placeholder*="Name" i]'], "Campus Student");
    const phone = extractInputValue(form, ['[name="phone"]', '#itemPhone', 'input[type="tel"]'], "");
    const telegram = tg?.initDataUnsafe?.user?.username || extractInputValue(form, ['[name="telegram"]', '#itemTelegram'], "");

    const newItem = {
      id: Date.now(),
      title,
      price,
      category,
      location,
      seller,
      phone,
      telegram,
      image: uploadedBase64Image,
      emoji: category === "Books" ? "📘" : category === "Clothing" ? "👕" : "📱",
      color: COLOR_GRADIENTS[Math.floor(Math.random() * COLOR_GRADIENTS.length)]
    };

    // በስልኩ Local Storage ላይ ማስቀመጥ
    PRODUCTS.unshift(newItem);
    localStorage.setItem("mtu_products", JSON.stringify(PRODUCTS));

    // Telegram Bot ካለ መረጃውን በ Telegram SDK መላክ
    if (tg && tg.sendData) {
      tg.sendData(JSON.stringify({ type: "NEW_LISTING", data: newItem }));
    }

    addNotification("New Listing Created", `Your item "${title}" has been published.`, "shopping-bag", "emerald");

    form.reset();
    uploadedBase64Image = null;
    if (previewImg) previewImg.classList.add("hidden");
    if (placeholder) placeholder.classList.remove("hidden");

    closeModal("postItemModal");
    renderProductGrid();
    showToast("Item posted successfully!");
  });
}

// 2. Errand Request Form
const errandForm = document.getElementById("errandForm");
if (errandForm) {
  errandForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const form = e.target;

    const item = extractInputValue(form, ['[name="item"]', '[name="title"]', 'input[placeholder*="need" i]'], "Campus Delivery");
    const dorm = extractInputValue(form, ['[name="dorm"]', '[name="location"]', 'input[placeholder*="location" i]'], "MTU Dorm");
    const tip = Number(extractInputValue(form, ['[name="tip"]', 'input[type="number"]'], "20"));
    const phone = extractInputValue(form, ['[name="phone"]', 'input[type="tel"]'], "");
    const telegram = tg?.initDataUnsafe?.user?.username || extractInputValue(form, ['[name="telegram"]'], "");

    const newErrand = {
      id: Date.now(),
      item,
      dorm,
      tip,
      phone,
      telegram,
      requester: tg?.initDataUnsafe?.user?.first_name || "Campus Student",
      time: "Just now",
      urgent: false
    };

    ERRANDS.unshift(newErrand);
    localStorage.setItem("mtu_errands", JSON.stringify(ERRANDS));

    if (tg && tg.sendData) {
      tg.sendData(JSON.stringify({ type: "NEW_ERRAND", data: newErrand }));
    }

    addNotification("Errand Request Posted", `Delivery request for "${item}" is live.`, "truck", "indigo");

    form.reset();
    closeModal("errandModal");
    renderErrandFeed();
    showToast("Errand request posted!");
  });
}

// 3. Report Status Button Click
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

// 4. Lost & Found Form Submission
const reportForm = document.getElementById("reportForm");
if (reportForm) {
  reportForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;

    const item = extractInputValue(form, ['[name="item"]', '[name="title"]', 'input[placeholder*="Item" i]'], "Reported Item");
    const location = extractInputValue(form, ['[name="location"]', '[placeholder*="Location" i]'], "Campus Grounds");
    const phone = extractInputValue(form, ['[name="phone"]', 'input[type="tel"]'], "");
    const telegram = tg?.initDataUnsafe?.user?.username || extractInputValue(form, ['[name="telegram"]'], "");

    const currentStatus = state.reportStatus || "lost";

    const newReport = {
      id: Date.now(),
      status: currentStatus,
      item,
      location,
      phone,
      telegram,
      reporter: tg?.initDataUnsafe?.user?.first_name || "Campus Student",
      date: "Today",
      emoji: currentStatus === "found" ? "📦" : "🔍"
    };

    LOSTFOUND.unshift(newReport);
    localStorage.setItem("mtu_lostfound", JSON.stringify(LOSTFOUND));

    if (tg && tg.sendData) {
      tg.sendData(JSON.stringify({ type: "NEW_REPORT", data: newReport }));
    }

    addNotification("Lost & Found Report Submitted", `Report for "${item}" has been logged.`, "search-check", "emerald");

    form.reset();
    closeModal("reportModal");
    renderLostFound();
    showToast(`Report submitted as ${currentStatus.toUpperCase()}`);
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

/* ---------------- Init ---------------- */

function init() {
  renderCategoryChips();
  renderProductGrid();
  renderErrandFeed();
  renderLostFound();
  updateNotifUI();
  setupSearchListener();
  setupLostFoundFilterListeners();
  setTab("marketplace");
  refreshIcons();
  
  // አፑ ሲከፈት ከ GitHub ላይ የቅርብ ጊዜ መረጃዎችን ስቦ ያሳያል
  syncWithGitHub();
}

init();
