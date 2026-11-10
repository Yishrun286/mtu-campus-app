/* ============================================================
   MTUShops — local-only "Featured Shops" directory
   ------------------------------------------------------------
   Self-contained class for a Telegram Mini App. No database, no
   network calls, no admin panel. Edit the two arrays below
   (DEFAULT_SHOPS / DEFAULT_ITEMS) or pass your own:

     MTUShops.init();                                   // defaults
     MTUShops.init({ shops: [...], items: [...] });     // custom data

   What it does
     • Replaces the .home-stats cards with a horizontal rail of shops
       (fallbacks: #mtuShopsMount, then top of #page-marketplace / body).
     • Shop profile modal: logo, bio, Telegram, phone, location, catalog
       with quantity steppers and discount badges.
     • Local ordering workflow: pick items -> fill a short prompt ->
       get a ready-to-send order message (send on Telegram, call, or copy).
       Nothing is stored or sent automatically.

   SHOP:  { id, name, tagline, bio, emoji, logo(https), telegram, phone,
            location, category, featured, order }
   ITEM:  { id, shopId, title, price, oldPrice, image(https), emoji,
            description, inStock, order }
   ============================================================ */

(function () {
"use strict";
if (window.MTUShops) return;

const DEFAULT_SHOPS = [
  {
    id: "abebe-clothes",
    name: "Abebe Clothes",
    tagline: "Everyday campus fits at student prices",
    bio: "Hoodies, jeans and basics picked for campus life.",
    emoji: "👕",
    logo: "",
    telegram: "",                 // e.g. "abebe_clothes"
    phone: "",                    // e.g. "0911223344"
    location: "Pickup point / dorm description",
    category: "Clothing",
    featured: true,
    order: 1
  },
  {
    id: "touched-by-angel",
    name: "Touched by Angel",
    tagline: "Gifts, accessories & little surprises",
    bio: "Handmade bracelets, gift boxes and small presents for every occasion.",
    emoji: "🎁",
    logo: "",
    telegram: "",
    phone: "",
    location: "Pickup point / dorm description",
    category: "Gifts",
    featured: true,
    order: 2
  },
  {
    id: "bella-closet",
    name: "Bella Closet",
    tagline: "Dresses & ladies' fashion",
    bio: "Light dresses, bags and accessories in a range of sizes.",
    emoji: "👗",
    logo: "",
    telegram: "",
    phone: "",
    location: "Pickup point / dorm description",
    category: "Clothing",
    featured: true,
    order: 3
  }
];

const DEFAULT_ITEMS = [
  { id: "hoodie", shopId: "abebe-clothes", title: "Campus Hoodie", price: 850, oldPrice: 1100, description: "Warm fleece hoodie, sizes M–XL.", emoji: "🧥", order: 1 },
  { id: "jeans", shopId: "abebe-clothes", title: "Slim Fit Jeans", price: 700, description: "Stretch denim, several sizes.", emoji: "👖", order: 2 },
  { id: "tshirt", shopId: "abebe-clothes", title: "Plain T-Shirt", price: 250, description: "100% cotton, many colours.", emoji: "👕", order: 3 },
  { id: "bracelet", shopId: "touched-by-angel", title: "Charm Bracelet", price: 180, description: "Handmade, adjustable.", emoji: "📿", order: 1 },
  { id: "giftbox", shopId: "touched-by-angel", title: "Mini Gift Box", price: 450, oldPrice: 550, description: "Ready-to-give box with card.", emoji: "🎁", order: 2 },
  { id: "dress", shopId: "bella-closet", title: "Summer Dress", price: 900, oldPrice: 1200, description: "Light fabric, sizes S–L.", emoji: "👗", order: 1 },
  { id: "handbag", shopId: "bella-closet", title: "Everyday Handbag", price: 600, description: "Fits a laptop and notebooks.", emoji: "👜", order: 2, inStock: false }
];

class MTUShops {
  /** Create (once) and start the directory. Returns the instance. */
  static init(opts = {}) {
    if (!MTUShops.instance) {
      MTUShops.instance = new MTUShops(opts);
      const start = () => MTUShops.instance.init();
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
      else start();
    }
    return MTUShops.instance;
  }

  constructor(opts = {}) {
    this.shops = (Array.isArray(opts.shops) ? opts.shops : DEFAULT_SHOPS).map((s) => this._normShop(s)).filter(Boolean);
    this.items = (Array.isArray(opts.items) ? opts.items : DEFAULT_ITEMS).map((i) => this._normItem(i)).filter(Boolean);
    this.hideStats = opts.hideStats !== false;
    this.cart = new Map();       // itemId -> qty
    this.activeShop = null;
    this.rail = null;
    this.profile = null;
    this.orderDlg = null;
    this.toastEl = null;
    this.toastTimer = null;
    this.ready = false;
  }

  /* ---------------- normalisation & helpers ---------------- */

  _esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  _str(v, max) { return String(v ?? "").trim().slice(0, max); }
  _num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
  _slug(v) { return String(v || "").trim().replace(/[^A-Za-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 60); }
  _etb(n) { return `${Number(n || 0).toLocaleString()} ETB`; }
  _url(u) {
    const s = String(u || "").trim();
    if (/^https:\/\//i.test(s)) return s;
    if (/^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(s)) return s;
    return "";
  }
  _handle(v) {
    const s = String(v || "").trim().replace(/^https?:\/\/t\.me\//i, "").replace(/^@+/, "").split(/[/?#]/)[0];
    return /^[A-Za-z0-9_]{3,32}$/.test(s) ? s : "";
  }
  _phone(v) {
    const s = String(v || "").trim();
    const digits = s.replace(/\D/g, "");
    return digits.length >= 7 ? (s.startsWith("+") ? "+" : "") + digits : "";
  }

  _normShop(r) {
    const id = this._slug(r && r.id);
    if (!id) return null;
    return {
      id,
      name: this._str(r.name, 60) || "Shop",
      tagline: this._str(r.tagline, 120),
      bio: this._str(r.bio, 400),
      emoji: this._str(r.emoji, 4) || "🛍️",
      logo: this._url(r.logo),
      telegram: this._handle(r.telegram),
      phone: this._phone(r.phone),
      location: this._str(r.location, 120),
      category: this._str(r.category, 30),
      featured: r.featured !== false,
      order: this._num(r.order, 999)
    };
  }

  _normItem(r) {
    const id = this._slug(r && r.id);
    const shopId = this._slug(r && r.shopId);
    const title = this._str(r && r.title, 80);
    if (!id || !shopId || !title) return null;
    return {
      id, shopId, title,
      price: Math.max(0, this._num(r.price, 0)),
      oldPrice: Math.max(0, this._num(r.oldPrice, 0)),
      image: this._url(r.image),
      emoji: this._str(r.emoji, 4) || "📦",
      description: this._str(r.description, 200),
      inStock: r.inStock !== false,
      order: this._num(r.order, 999)
    };
  }

  getShops() { return this.shops.filter((s) => s.featured).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)); }
  getShop(id) { return this.shops.find((s) => s.id === this._slug(id)) || null; }
  getItems(shopId) { return this.items.filter((i) => i.shopId === shopId).sort((a, b) => a.order - b.order || a.title.localeCompare(b.title)); }

  _discount(i) { return i.oldPrice > i.price ? Math.round((1 - i.price / i.oldPrice) * 100) : 0; }

  _avatar(shop) {
    return shop.logo
      ? `<img class="mts-img" src="${this._esc(shop.logo)}" alt="" loading="lazy" decoding="async" data-fallback="${this._esc(shop.emoji)}">`
      : `<span>${this._esc(shop.emoji)}</span>`;
  }

  _onImgError(e) {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !img.classList.contains("mts-img")) return;
    const span = document.createElement("span");
    span.textContent = img.dataset.fallback || "🛍️";
    img.replaceWith(span);
  }

  _toast(msg) {
    if (!this.toastEl) {
      this.toastEl = document.createElement("div");
      this.toastEl.className = "mts-toast";
      this.toastEl.setAttribute("role", "status");
      document.body.appendChild(this.toastEl);
    }
    this.toastEl.textContent = msg;
    this.toastEl.classList.add("on");
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toastEl.classList.remove("on"), 2400);
  }

  /* ---------------- lifecycle ---------------- */

  init() {
    if (this.ready) return this;
    this.ready = true;
    this._injectStyles();
    this._mountRail();
    this._buildDialogs();
    this.render();
    return this;
  }

  render() {
    if (!this.rail) return;
    const list = this.getShops();
    this.rail.hidden = list.length === 0;
    const stats = document.querySelector(".home-stats");
    if (stats && this.hideStats) stats.classList.toggle("mts-stats-hidden", list.length > 0);

    this.rail.querySelector(".mts-count").textContent = list.length === 1 ? "1 shop" : `${list.length} shops`;
    this.rail.querySelector(".mts-rail").innerHTML = list.map((s) => {
      const n = this.getItems(s.id).length;
      return `
        <button type="button" class="mts-card" role="listitem" data-shop="${this._esc(s.id)}">
          <span class="mts-av">${this._avatar(s)}</span>
          <b class="mts-name">${this._esc(s.name)}</b>
          <small class="mts-tag">${this._esc(s.tagline || s.category)}</small>
          <span class="mts-meta">${n} item${n === 1 ? "" : "s"}</span>
        </button>`;
    }).join("");
  }

  /* ---------------- styles ---------------- */

  _injectStyles() {
    if (document.getElementById("mts-style")) return;
    const st = document.createElement("style");
    st.id = "mts-style";
    st.textContent = `
      :root{--mts-accent:#18B6D9;--mts-accent2:#58D7EF;--mts-purple:#6D5EF5;--mts-text:#F4F8FC;--mts-muted:#91A4BA;
        --mts-border:rgba(148,181,214,.14);--mts-card:linear-gradient(150deg,rgba(20,36,58,.92),rgba(9,22,39,.94));--mts-bg:#08121F}
      .mts-stats-hidden{display:none!important}
      .mts-shops{margin:0 0 14px}
      .mts-shops[hidden]{display:none}
      .mts-head{display:flex;align-items:flex-end;justify-content:space-between;gap:10px;margin-bottom:10px}
      .mts-over{margin:0;font-size:9px;font-weight:800;letter-spacing:.14em;color:#6DDDEC}
      .mts-head h2{margin:3px 0 0;font:700 16px/1.2 system-ui,-apple-system,'Segoe UI',sans-serif;letter-spacing:-.02em;color:#EDF5FC}
      .mts-count{padding:5px 9px;border-radius:999px;border:1px solid rgba(88,215,239,.18);background:rgba(24,182,217,.08);color:#9DEBFA;font-size:9px;font-weight:700;white-space:nowrap}
      .mts-rail{display:flex;gap:10px;overflow-x:auto;scroll-snap-type:x proximity;padding:2px 2px 6px;margin:0 -2px;-webkit-overflow-scrolling:touch;scrollbar-width:none}
      .mts-rail::-webkit-scrollbar{display:none}
      .mts-card{flex:0 0 152px;scroll-snap-align:start;display:flex;flex-direction:column;align-items:flex-start;gap:4px;text-align:left;cursor:pointer;
        padding:12px;border-radius:18px;border:1px solid var(--mts-border);background:var(--mts-card);color:var(--mts-text);font:inherit;
        box-shadow:inset 0 1px 0 rgba(255,255,255,.035),0 10px 26px rgba(0,0,0,.18);transition:transform .2s ease,border-color .2s ease}
      .mts-card:hover{transform:translateY(-2px);border-color:rgba(88,215,239,.3)}
      .mts-card:active{transform:scale(.97)}
      .mts-av{width:46px;height:46px;flex:0 0 auto;border-radius:15px;display:grid;place-items:center;overflow:hidden;font-size:22px;margin-bottom:4px;
        background:linear-gradient(135deg,var(--mts-purple),var(--mts-accent));border:1px solid rgba(255,255,255,.14)}
      .mts-av img{width:100%;height:100%;object-fit:cover;display:block}
      .mts-name{width:100%;font-size:12.5px;font-weight:700;line-height:1.25;color:#F1F7FD;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .mts-tag{min-height:28px;font-size:10px;line-height:1.4;color:var(--mts-muted);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
      .mts-meta{margin-top:4px;padding:3px 8px;border-radius:999px;background:rgba(109,94,245,.16);color:#B0A5FF;font-size:9px;font-weight:700}

      dialog.mts-sheet{margin:auto auto 0;padding:0;width:100%;max-width:440px;border:1px solid var(--mts-border);border-bottom:0;border-radius:24px 24px 0 0;
        background:var(--mts-bg);color:var(--mts-text);overflow:hidden;font-family:system-ui,-apple-system,'Segoe UI',sans-serif}
      dialog.mts-sheet::backdrop{background:rgba(2,8,16,.62)}
      dialog.mts-sheet[open]{display:flex;flex-direction:column}
      #mtsProfile{height:min(92vh,800px)}
      #mtsOrder{max-height:92vh}
      .mts-form{display:flex;flex-direction:column;min-height:0;flex:1}
      .mts-sh-head{flex:0 0 auto;position:relative;display:flex;align-items:center;gap:10px;padding:14px 14px 8px}
      .mts-grab{position:absolute;left:50%;top:6px;width:40px;height:4px;border-radius:99px;background:#2A415E;transform:translateX(-50%)}
      .mts-sh-title{margin:6px 0 0;font:700 15px system-ui,sans-serif;letter-spacing:-.02em}
      .mts-x{margin:6px 0 0 auto;width:32px;height:32px;flex:0 0 32px;border:0;border-radius:999px;background:#1C304A;color:#CBD5E1;font-size:15px;cursor:pointer}
      .mts-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:4px 16px 16px}
      .mts-foot{flex:0 0 auto;display:flex;align-items:center;gap:12px;padding:12px 16px calc(14px + env(safe-area-inset-bottom,0px));border-top:1px solid var(--mts-border);background:rgba(6,16,29,.96)}
      .mts-foot-sum{flex:1;min-width:0}
      .mts-foot-sum b{display:block;font-size:12px;color:#EAF4FC}
      .mts-foot-sum small{display:block;margin-top:2px;font-size:10px;line-height:1.35;color:var(--mts-muted)}
      .mts-cta{flex:1 1 auto;padding:13px 14px;border:0;border-radius:13px;font:800 12.5px system-ui,sans-serif;color:#06101D;cursor:pointer;
        background:linear-gradient(100deg,var(--mts-accent),var(--mts-accent2));box-shadow:0 10px 24px rgba(24,182,217,.2);transition:transform .15s ease}
      .mts-cta:active{transform:scale(.97)}
      .mts-cta:disabled{opacity:.5}
      .mts-foot .mts-cta{flex:0 0 auto;max-width:58%}
      .mts-ghost{flex:1 1 auto;padding:13px 14px;border-radius:13px;font:700 12.5px system-ui,sans-serif;color:#CBD5E1;background:#1C304A;border:1px solid rgba(148,181,214,.2);cursor:pointer}

      .mts-hero{display:flex;align-items:center;gap:12px;padding:14px;border-radius:20px;border:1px solid rgba(88,215,239,.2);
        background:linear-gradient(122deg,rgba(17,49,70,.98),rgba(17,31,57,.98) 55%,rgba(40,31,85,.96))}
      .mts-hero .mts-av{width:62px;height:62px;border-radius:20px;font-size:30px;margin:0}
      .mts-hero h2{margin:0;font:700 18px/1.2 system-ui,sans-serif;letter-spacing:-.03em;color:#F7FBFF}
      .mts-ver{display:inline-block;margin-top:5px;padding:2px 7px;border-radius:999px;background:rgba(88,215,239,.12);border:1px solid rgba(88,215,239,.25);color:#9DEBFA;font-size:9px;font-weight:800}
      .mts-tagline{margin:5px 0 0;font-size:11px;line-height:1.5;color:#B8C9DA}
      .mts-bio{margin:10px 0 0;font-size:11.5px;line-height:1.6;color:#B8C9DA}
      .mts-facts{display:grid;gap:6px;margin:12px 0;padding:0;list-style:none}
      .mts-facts li{display:flex;gap:8px;align-items:flex-start;font-size:11.5px;line-height:1.45;color:#C9D8E6}
      .mts-facts span{flex:0 0 18px}
      .mts-contact{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-bottom:6px}
      .mts-contact a{display:flex;align-items:center;justify-content:center;gap:6px;padding:11px 8px;border-radius:12px;font-size:12px;font-weight:700;text-decoration:none;text-align:center}
      .mts-contact a.tg{background:rgba(24,182,217,.14);border:1px solid rgba(88,215,239,.35);color:#8DEBFA}
      .mts-contact a.call{background:rgba(109,94,245,.16);border:1px solid rgba(154,143,255,.4);color:#B0A5FF}
      .mts-contact a:only-child{grid-column:1/-1}
      .mts-nocontact{margin:0 0 6px;font-size:10.5px;color:var(--mts-muted)}
      .mts-cat-head{display:flex;align-items:center;justify-content:space-between;margin:16px 0 10px}
      .mts-cat-head h3{margin:0;font:700 15px system-ui,sans-serif;letter-spacing:-.02em;color:#EDF5FC}
      .mts-cat-head span{font-size:10px;font-weight:600;color:var(--mts-muted)}
      .mts-items{display:grid;gap:10px}
      .mts-empty{padding:26px 10px;text-align:center;font-size:12px;color:var(--mts-muted);border:1px dashed var(--mts-border);border-radius:16px}
      .mts-item{display:flex;gap:11px;padding:10px;border-radius:16px;border:1px solid var(--mts-border);background:var(--mts-card)}
      .mts-media{position:relative;flex:0 0 86px;width:86px;height:86px;border-radius:13px;overflow:hidden;display:grid;place-items:center;font-size:30px;
        background:linear-gradient(135deg,rgba(109,94,245,.5),rgba(24,182,217,.45))}
      .mts-media img{width:100%;height:100%;object-fit:cover;display:block}
      .mts-badge{position:absolute;top:5px;left:5px;padding:2px 6px;border-radius:999px;background:#EF4444;color:#fff;font-size:9px;font-weight:800}
      .mts-main{flex:1;min-width:0;display:flex;flex-direction:column}
      .mts-title{margin:0;font-size:12.5px;font-weight:700;line-height:1.3;color:#F1F7FD}
      .mts-desc{margin:3px 0 0;font-size:10.5px;line-height:1.45;color:var(--mts-muted);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
      .mts-row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:auto;padding-top:8px}
      .mts-price b{font:700 13px system-ui,sans-serif;color:#58D7EF}
      .mts-price s{margin-left:6px;font-size:10px;color:#6F849B}
      .mts-step{display:flex;align-items:center;gap:8px}
      .mts-add{padding:7px 12px;border:0;border-radius:10px;font:800 11px system-ui,sans-serif;color:#06101D;cursor:pointer;background:linear-gradient(100deg,var(--mts-accent),var(--mts-accent2))}
      .mts-q{width:28px;height:28px;border-radius:999px;font-size:16px;line-height:1;color:#E8F1FA;background:#1C304A;border:1px solid rgba(148,181,214,.2);cursor:pointer}
      .mts-qty{min-width:16px;text-align:center;font-size:12px;font-weight:700}
      .mts-sold{font-size:10px;font-weight:800;color:#FCA5A5}

      .mts-sum{padding:12px;border-radius:14px;border:1px solid var(--mts-border);background:rgba(20,36,58,.6);font-size:11.5px;line-height:1.6;color:#C9D8E6}
      .mts-sum strong{color:#F1F7FD}
      .mts-sum .line{display:flex;justify-content:space-between;gap:10px}
      .mts-sum .total{margin-top:6px;padding-top:6px;border-top:1px dashed rgba(148,181,214,.2);font-weight:700;color:#EAF4FC}
      .mts-lbl{display:block;margin:12px 0 5px;font-size:11px;font-weight:600;color:#B8C9DA}
      .mts-in{width:100%;box-sizing:border-box;padding:12px 13px;font:16px system-ui,sans-serif;color:#F4F8FC;outline:none;resize:none;
        background:rgba(20,36,58,.72);border:1px solid rgba(148,181,214,.16);border-radius:12px}
      .mts-in::placeholder{color:#667C95}
      .mts-in:focus{border-color:rgba(88,215,239,.5);box-shadow:0 0 0 3px rgba(24,182,217,.1)}
      .mts-in.bad{border-color:#ef4444}
      .mts-2col{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
      .mts-err{min-height:16px;margin:10px 0 0;font-size:11px;color:#fca5a5}
      .mts-note{margin:10px 0 0;font-size:10px;line-height:1.5;color:var(--mts-muted)}
      .mts-msg{margin:0;padding:12px;border-radius:14px;border:1px solid var(--mts-border);background:rgba(20,36,58,.6);font:11.5px/1.6 ui-monospace,Menlo,monospace;color:#DCE8F4;white-space:pre-wrap;word-break:break-word}
      .mts-done-actions{display:grid;gap:8px;margin-top:12px}
      .mts-done-actions a{display:block;padding:13px;border-radius:13px;font:700 12.5px system-ui,sans-serif;text-align:center;text-decoration:none}
      .mts-done-actions a.tg{color:#06101D;background:linear-gradient(100deg,var(--mts-accent),var(--mts-accent2))}
      .mts-done-actions a.call{color:#B0A5FF;background:rgba(109,94,245,.16);border:1px solid rgba(154,143,255,.4)}

      .mts-toast{position:fixed;left:50%;bottom:calc(24px + env(safe-area-inset-bottom,0px));z-index:2147483647;max-width:88vw;padding:10px 14px;border-radius:12px;
        background:#10243B;border:1px solid rgba(88,215,239,.3);color:#EAF4FC;font:600 12px system-ui,sans-serif;opacity:0;transform:translate(-50%,10px);pointer-events:none;transition:opacity .2s,transform .2s}
      .mts-toast.on{opacity:1;transform:translate(-50%,0)}
      @media (min-width:600px){dialog.mts-sheet{margin:auto;border-bottom:1px solid var(--mts-border);border-radius:24px}}
    `;
    document.head.appendChild(st);
  }

  /* ---------------- rail ---------------- */

  _mountRail() {
    const existing = document.getElementById("mtsRailContainer");
    if (existing) { this.rail = existing; return; }

    const sec = document.createElement("section");
    sec.id = "mtsRailContainer";
    sec.className = "mts-shops";
    sec.setAttribute("aria-label", "Featured shops");
    sec.hidden = true;
    sec.innerHTML = `
      <div class="mts-head">
        <div><p class="mts-over">CURATED VENDORS</p><h2>Featured Shops</h2></div>
        <span class="mts-count"></span>
      </div>
      <div class="mts-rail" role="list"></div>`;

    const stats = document.querySelector(".home-stats");
    const explicit = document.getElementById("mtuShopsMount");
    const page = document.getElementById("page-marketplace");
    if (stats && stats.parentNode) stats.parentNode.insertBefore(sec, stats);
    else if (explicit) explicit.appendChild(sec);
    else if (page) page.insertBefore(sec, page.firstChild);
    else document.body.insertBefore(sec, document.body.firstChild);

    sec.addEventListener("click", (e) => {
      const card = e.target.closest("[data-shop]");
      if (card) this.openShop(card.dataset.shop);
    });
    sec.addEventListener("error", (e) => this._onImgError(e), true);
    this.rail = sec;
  }

  /* ---------------- dialogs ---------------- */

  _buildDialogs() {
    this.profile = document.createElement("dialog");
    this.profile.id = "mtsProfile";
    this.profile.className = "mts-sheet";
    this.profile.innerHTML = `
      <span class="mts-grab"></span>
      <div class="mts-sh-head">
        <p class="mts-sh-title">Shop profile</p>
        <button type="button" class="mts-x" data-close aria-label="Close">✕</button>
      </div>
      <div class="mts-scroll" id="mtsBody"></div>
      <div class="mts-foot" id="mtsFoot"></div>`;
    document.body.appendChild(this.profile);

    this.profile.addEventListener("click", (e) => {
      if (e.target === this.profile || e.target.closest("[data-close]")) return this.closeShop();
      const step = e.target.closest("[data-step-act]");
      if (step) {
        const id = step.dataset.id;
        const cur = this.cart.get(id) || 0;
        return this._setQty(id, step.dataset.stepAct === "inc" ? Math.min(9, cur + 1) : Math.max(0, cur - 1));
      }
      if (e.target.closest("#mtsOrderBtn")) this._openOrder();
    });
    this.profile.addEventListener("error", (e) => this._onImgError(e), true);
    this.profile.addEventListener("close", () => { this.activeShop = null; this.cart = new Map(); });

    this.orderDlg = document.createElement("dialog");
    this.orderDlg.id = "mtsOrder";
    this.orderDlg.className = "mts-sheet";
    document.body.appendChild(this.orderDlg);
    this.orderDlg.addEventListener("click", (e) => {
      if (e.target === this.orderDlg || e.target.closest("[data-close-order]")) this.orderDlg.close();
      if (e.target.closest("[data-back-profile]")) { this.orderDlg.close(); }
      if (e.target.closest("[data-copy]")) this._copy(this._lastMessage || "");
      if (e.target.closest("[data-done]")) { this.orderDlg.close(); this.closeShop(); }
    });
  }

  /* ---------------- shop profile ---------------- */

  openShop(id) {
    const shop = this.getShop(id);
    if (!shop) { this._toast("Shop not found"); return false; }
    if (!this.ready) this.init();
    this.activeShop = shop;
    this.cart = new Map();
    this._renderProfile();
    if (!this.profile.open) this.profile.showModal();
    return true;
  }

  closeShop() {
    if (this.orderDlg && this.orderDlg.open) this.orderDlg.close();
    if (this.profile && this.profile.open) this.profile.close();
  }

  _stepper(item) {
    if (!item.inStock) return `<span class="mts-sold">Sold out</span>`;
    const q = this.cart.get(item.id) || 0;
    const id = this._esc(item.id);
    if (!q) return `<button type="button" class="mts-add" data-step-act="inc" data-id="${id}">+ Add</button>`;
    return `<button type="button" class="mts-q" data-step-act="dec" data-id="${id}" aria-label="Remove one">−</button>`
      + `<span class="mts-qty">${q}</span>`
      + `<button type="button" class="mts-q" data-step-act="inc" data-id="${id}" aria-label="Add one">+</button>`;
  }

  _itemHtml(i) {
    const pct = this._discount(i);
    const media = i.image
      ? `<img class="mts-img" src="${this._esc(i.image)}" alt="${this._esc(i.title)}" loading="lazy" decoding="async" data-fallback="${this._esc(i.emoji)}">`
      : `<span>${this._esc(i.emoji)}</span>`;
    return `
      <article class="mts-item">
        <div class="mts-media">${media}${pct > 0 ? `<span class="mts-badge">-${pct}%</span>` : ""}</div>
        <div class="mts-main">
          <p class="mts-title">${this._esc(i.title)}</p>
          ${i.description ? `<p class="mts-desc">${this._esc(i.description)}</p>` : ""}
          <div class="mts-row">
            <div class="mts-price"><b>${this._etb(i.price)}</b>${i.oldPrice > i.price ? `<s>${this._etb(i.oldPrice)}</s>` : ""}</div>
            <div class="mts-step" data-slot="${this._esc(i.id)}">${this._stepper(i)}</div>
          </div>
        </div>
      </article>`;
  }

  _renderProfile() {
    const s = this.activeShop;
    if (!s) return;
    const items = this.getItems(s.id);
    const facts = [
      s.location ? `<li><span>📍</span><div>${this._esc(s.location)}</div></li>` : "",
      s.telegram ? `<li><span>✈️</span><div>@${this._esc(s.telegram)}</div></li>` : "",
      s.phone ? `<li><span>📞</span><div>${this._esc(s.phone)}</div></li>` : ""
    ].join("");
    const contact = (s.telegram || s.phone)
      ? `<div class="mts-contact">
           ${s.telegram ? `<a class="tg" href="https://t.me/${this._esc(s.telegram)}" target="_blank" rel="noopener">✈️ Telegram</a>` : ""}
           ${s.phone ? `<a class="call" href="tel:${this._esc(s.phone)}">📞 Call</a>` : ""}
         </div>`
      : `<p class="mts-nocontact">No direct contact listed for this shop.</p>`;

    const body = document.getElementById("mtsBody");
    body.innerHTML = `
      <section class="mts-hero">
        <div class="mts-av">${this._avatar(s)}</div>
        <div style="min-width:0">
          <h2>${this._esc(s.name)}</h2>
          <span class="mts-ver">✔ Campus-approved shop</span>
          ${s.tagline ? `<p class="mts-tagline">${this._esc(s.tagline)}</p>` : ""}
        </div>
      </section>
      ${s.bio ? `<p class="mts-bio">${this._esc(s.bio)}</p>` : ""}
      ${facts ? `<ul class="mts-facts">${facts}</ul>` : ""}
      ${contact}
      <div class="mts-cat-head"><h3>Campus catalog</h3><span>${items.length} item${items.length === 1 ? "" : "s"}</span></div>
      <div class="mts-items">${items.length ? items.map((i) => this._itemHtml(i)).join("") : `<div class="mts-empty">No items listed yet. You can still describe what you want when ordering.</div>`}</div>`;
    body.scrollTop = 0;
    this._renderFoot();
  }

  _lines() {
    if (!this.activeShop) return [];
    return this.getItems(this.activeShop.id)
      .filter((i) => i.inStock && (this.cart.get(i.id) || 0) > 0)
      .map((i) => ({ id: i.id, title: i.title, qty: this.cart.get(i.id), price: i.price }));
  }
  _totals() {
    const lines = this._lines();
    return { lines, count: lines.reduce((a, l) => a + l.qty, 0), total: lines.reduce((a, l) => a + l.qty * l.price, 0) };
  }

  _renderFoot() {
    const foot = document.getElementById("mtsFoot");
    if (!foot) return;
    const { count, total } = this._totals();
    foot.innerHTML = `
      <div class="mts-foot-sum">
        <b>${count ? `${count} item${count === 1 ? "" : "s"} · ${this._etb(total)}` : "No items selected"}</b>
        <small>${count ? "Review and send in the next step" : "Pick items or describe your own order"}</small>
      </div>
      <button type="button" class="mts-cta" id="mtsOrderBtn">🛒 Place order</button>`;
  }

  _setQty(itemId, q) {
    const item = this.items.find((i) => i.id === itemId && i.shopId === (this.activeShop && this.activeShop.id));
    if (!item || !item.inStock) return;
    if (q > 0) this.cart.set(itemId, q); else this.cart.delete(itemId);
    const slot = this.profile.querySelector(`[data-slot="${CSS.escape(itemId)}"]`);
    if (slot) slot.innerHTML = this._stepper(item);
    this._renderFoot();
  }

  /* ---------------- local ordering workflow ---------------- */

  _openOrder() {
    const shop = this.activeShop;
    if (!shop) return;
    const { lines, total } = this._totals();

    this.orderDlg.innerHTML = `
      <span class="mts-grab"></span>
      <form class="mts-form" id="mtsOrderForm" novalidate autocomplete="off">
        <div class="mts-sh-head">
          <p class="mts-sh-title">Place your order</p>
          <button type="button" class="mts-x" data-close-order aria-label="Close">✕</button>
        </div>
        <div class="mts-scroll">
          <div class="mts-sum">
            <div><strong>${this._esc(shop.name)}</strong>${shop.location ? ` · Pickup: ${this._esc(shop.location)}` : ""}</div>
            ${lines.length
              ? lines.map((l) => `<div class="line"><span>${l.qty}× ${this._esc(l.title)}</span><span>${this._etb(l.qty * l.price)}</span></div>`).join("")
                + `<div class="line total"><span>Subtotal</span><span>${this._etb(total)}</span></div>`
              : `<div style="color:#91A4BA">No catalog items selected — describe your order below.</div>`}
          </div>

          <label class="mts-lbl" for="mtsNote">What do you want? ${lines.length ? "(optional notes)" : "(required)"}</label>
          <textarea class="mts-in" id="mtsNote" name="note" rows="2" maxlength="160" placeholder="Size, colour, anything the shop should know"></textarea>

          <div class="mts-2col">
            <div><label class="mts-lbl" for="mtsName">Your name</label>
              <input class="mts-in" id="mtsName" name="name" type="text" maxlength="40" placeholder="Name"></div>
            <div><label class="mts-lbl" for="mtsPhone">Your phone</label>
              <input class="mts-in" id="mtsPhone" name="phone" type="tel" placeholder="09…"></div>
          </div>
          <label class="mts-lbl" for="mtsWhere">Delivery / meet-up spot</label>
          <input class="mts-in" id="mtsWhere" name="where" type="text" maxlength="80" placeholder="Dorm block, room, or meeting point">

          <p class="mts-err" id="mtsErr" role="alert"></p>
          <p class="mts-note">Nothing is sent automatically. Next you'll get a ready-made message to send to the shop.</p>
        </div>
        <div class="mts-foot"><button type="submit" class="mts-cta" style="max-width:none;flex:1">Continue</button></div>
      </form>`;

    const form = this.orderDlg.querySelector("#mtsOrderForm");
    form.addEventListener("input", () => {
      form.querySelector("#mtsErr").textContent = "";
      form.querySelectorAll(".bad").forEach((el) => el.classList.remove("bad"));
    });
    form.addEventListener("submit", (e) => { e.preventDefault(); this._submitOrder(form); });
    if (!this.orderDlg.open) this.orderDlg.showModal();
  }

  _submitOrder(form) {
    const val = (n) => (form.elements[n].value || "").trim();
    const fail = (field, msg) => {
      form.elements[field].classList.add("bad");
      try { form.elements[field].focus(); } catch (e) {}
      form.querySelector("#mtsErr").textContent = msg;
    };

    const shop = this.activeShop;
    const { lines, total } = this._totals();
    const note = val("note");
    if (!lines.length && !note) return fail("note", "Select items or describe what you want.");
    if (!val("name")) return fail("name", "Please enter your name.");
    if (val("phone").replace(/\D/g, "").length < 9) return fail("phone", "Enter a valid phone number.");
    if (!val("where")) return fail("where", "Please say where to deliver or meet.");

    const msg = [
      `🛍 Order for ${shop.name}`,
      ...(lines.length ? lines.map((l) => `• ${l.qty}× ${l.title} — ${this._etb(l.qty * l.price)}`) : []),
      lines.length ? `Subtotal: ${this._etb(total)}` : "",
      note ? `Note: ${note}` : "",
      `Deliver/meet: ${val("where")}`,
      `Name: ${val("name")}`,
      `Phone: ${val("phone")}`
    ].filter(Boolean).join("\n");

    this._lastMessage = msg;
    this._renderOrderDone(msg);
  }

  _renderOrderDone(msg) {
    const shop = this.activeShop;
    const tgUrl = shop.telegram ? `https://t.me/${shop.telegram}?text=${encodeURIComponent(msg)}` : "";
    this.orderDlg.innerHTML = `
      <span class="mts-grab"></span>
      <div class="mts-sh-head">
        <p class="mts-sh-title">Order ready ✓</p>
        <button type="button" class="mts-x" data-close-order aria-label="Close">✕</button>
      </div>
      <div class="mts-scroll">
        <p class="mts-note" style="margin:0 0 10px">Send this message to ${this._esc(shop.name)} to complete your order.</p>
        <pre class="mts-msg">${this._esc(msg)}</pre>
        <div class="mts-done-actions">
          ${tgUrl ? `<a class="tg" href="${this._esc(tgUrl)}" data-tg>✈️ Send on Telegram</a>` : ""}
          ${shop.phone ? `<a class="call" href="tel:${this._esc(shop.phone)}">📞 Call ${this._esc(shop.name)}</a>` : ""}
        </div>
        ${!tgUrl && !shop.phone ? `<p class="mts-note">This shop has no contact listed. Copy the message and share it with them directly.</p>` : ""}
      </div>
      <div class="mts-foot">
        <button type="button" class="mts-ghost" data-copy>Copy message</button>
        <button type="button" class="mts-cta" data-done style="max-width:none">Done</button>
      </div>`;

    const tgLink = this.orderDlg.querySelector("[data-tg]");
    if (tgLink) {
      tgLink.addEventListener("click", (e) => {
        const wa = window.Telegram && window.Telegram.WebApp;
        if (wa && typeof wa.openTelegramLink === "function") {
          e.preventDefault();
          wa.openTelegramLink(tgLink.getAttribute("href"));
        } else {
          tgLink.target = "_blank";
          tgLink.rel = "noopener";
        }
      });
    }
  }

  async _copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      this._toast("Order message copied");
    } catch (e) {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.cssText = "position:fixed;opacity:0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
        this._toast("Order message copied");
      } catch (err) {
        this._toast("Couldn't copy — select the text manually");
      }
    }
  }
}

window.MTUShops = MTUShops;
})();