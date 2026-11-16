const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem("comic-reader:" + key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem("comic-reader:" + key, JSON.stringify(value));
    } catch {}
  },
};

const stage = $("stage");
const canvas = $("canvas");
const scrubber = $("scrubber");
const MAX_ZOOM = 5;

let pages = [];
let firstPageAlone = true;
let mode = "single"; // "single" | "double"
let spreads = []; // array of arrays of page indexes
let spreadIdx = 0;
let renderToken = 0;
let currentEl = null;

init();

async function init() {
  let manifest;
  try {
    manifest = await (await fetch("manifest.json", { cache: "no-cache" })).json();
  } catch {
    manifest = { pages: [] };
  }
  pages = manifest.pages || [];
  firstPageAlone = manifest.firstPageAlone !== false;
  if (manifest.title) {
    document.title = manifest.title;
    $("title").textContent = manifest.title;
  }
  if (!pages.length) {
    $("empty").hidden = false;
    document.querySelector(".bar.bottom").hidden = true;
    return;
  }

  // Double spread by default on wide landscape screens, unless the reader chose otherwise.
  mode = store.get("mode", null) || (innerWidth >= 900 && innerWidth > innerHeight ? "double" : "single");
  spreads = buildSpreads();

  const fromHash = parseInt(location.hash.slice(1), 10);
  const saved = store.get("page", 0);
  const startPage = clamp(Number.isFinite(fromHash) ? fromHash - 1 : saved, 0, pages.length - 1);
  spreadIdx = spreadOf(startPage);

  measureBars();
  buildThumbs();
  bindEvents();
  syncChrome();
  show(spreadIdx, 0);
  if (!Number.isFinite(fromHash) && startPage > 0) toast(`Continuing from page ${startPage + 1}`);
}

/* ---------- Spreads ---------- */

function buildSpreads() {
  if (mode === "single") return pages.map((_, i) => [i]);
  const wide = (p) => p.w > p.h; // a landscape page is already a spread
  const out = [];
  let i = 0;
  if (firstPageAlone) out.push([i++]);
  while (i < pages.length) {
    if (i + 1 >= pages.length || wide(pages[i]) || wide(pages[i + 1])) out.push([i++]);
    else out.push([i++, i++]);
  }
  return out;
}

const spreadOf = (page) => Math.max(0, spreads.findIndex((s) => s.includes(page)));
const currentPage = () => spreads[spreadIdx][0];

function labelFor(spread) {
  const a = spread[0] + 1;
  return spread.length > 1 ? `${a}–${a + 1}` : `${a}`;
}

/* ---------- Rendering ---------- */

async function show(idx, dir) {
  idx = clamp(idx, 0, spreads.length - 1);
  spreadIdx = idx;
  const token = ++renderToken;
  syncChrome();
  store.set("page", currentPage());
  history.replaceState(null, "", "#" + (currentPage() + 1));

  const el = document.createElement("div");
  el.className = "spread" + (spreads[idx].length > 1 ? " double" : "");
  const imgs = spreads[idx].map((p) => {
    const img = new Image();
    img.width = pages[p].w;
    img.height = pages[p].h;
    img.alt = `Page ${p + 1}`;
    img.draggable = false;
    img.src = pages[p].src;
    el.append(img);
    return img;
  });

  const spinnerTimer = setTimeout(() => ($("spinner").hidden = false), 180);
  await Promise.all(imgs.map((img) => img.decode().catch(() => {})));
  clearTimeout(spinnerTimer);
  if (token !== renderToken) return; // a newer navigation superseded this one
  $("spinner").hidden = true;

  resetZoom(false);
  const old = currentEl;
  currentEl = el;
  if (dir) el.classList.add(dir > 0 ? "enter-next" : "enter-prev");
  canvas.append(el);
  if (dir) {
    el.getBoundingClientRect(); // commit the starting style so the transition runs
    el.classList.remove("enter-next", "enter-prev");
  }
  if (old) {
    if (dir) old.classList.add(dir > 0 ? "leave-next" : "leave-prev");
    setTimeout(() => old.remove(), dir ? 280 : 0);
  }
  // Drop anything left over from rapid navigation.
  for (const stale of canvas.querySelectorAll(".spread")) {
    if (stale !== el && stale !== old) stale.remove();
  }
  preload(idx + 1);
  preload(idx - 1);
}

function preload(idx) {
  for (const p of spreads[idx] || []) new Image().src = pages[p].src;
}

function go(delta) {
  const target = spreadIdx + delta;
  if (target < 0) return;
  if (target >= spreads.length) return toast("You've reached the end");
  show(target, delta);
}

function goToPage(page) {
  const target = spreadOf(page);
  if (target !== spreadIdx) show(target, target > spreadIdx ? 1 : -1);
}

function setMode(next) {
  const page = currentPage();
  mode = next;
  store.set("mode", mode);
  spreads = buildSpreads();
  show(spreadOf(page), 0);
  toast(mode === "double" ? "Double-page spread" : "Single page");
}

function syncChrome() {
  scrubber.max = spreads.length;
  scrubber.value = spreadIdx + 1;
  scrubber.style.setProperty("--fill", spreads.length > 1 ? `${(spreadIdx / (spreads.length - 1)) * 100}%` : "100%");
  $("counter").textContent = `${labelFor(spreads[spreadIdx])} / ${pages.length}`;
  $("prev").disabled = spreadIdx === 0;
  $("next").disabled = spreadIdx === spreads.length - 1;
  $("mode").classList.toggle("double", mode === "double");
  document.querySelectorAll(".thumb").forEach((t, i) => t.classList.toggle("current", spreads[spreadIdx].includes(i)));
}

/* ---------- Zoom & pan ---------- */

const zoom = { s: 1, x: 0, y: 0 };

function applyZoom(animate) {
  canvas.classList.toggle("anim", !!animate);
  // Keep the page inside the viewport while panning.
  if (zoom.s > 1) {
    zoom.x = clamp(zoom.x, stage.clientWidth * (1 - zoom.s), 0);
    zoom.y = clamp(zoom.y, stage.clientHeight * (1 - zoom.s), 0);
  }
  canvas.style.transform = `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.s})`;
  stage.classList.toggle("zoomed", zoom.s > 1);
  $("zoom-reset").hidden = zoom.s <= 1;
  $("zoom-reset").textContent = Math.round(zoom.s * 100) + "%";
}

// px/py are viewport (client) coordinates.
function zoomAt(px, py, scale, animate) {
  const rect = stage.getBoundingClientRect();
  px -= rect.left;
  py -= rect.top;
  scale = clamp(scale, 1, MAX_ZOOM);
  if (scale === 1) {
    zoom.x = zoom.y = 0;
  } else {
    zoom.x = px - (px - zoom.x) * (scale / zoom.s);
    zoom.y = py - (py - zoom.y) * (scale / zoom.s);
  }
  zoom.s = scale;
  applyZoom(animate);
}

function resetZoom(animate = true) {
  zoom.s = 1;
  zoom.x = zoom.y = 0;
  applyZoom(animate);
}

/* ---------- Pointer gestures: tap, swipe, drag-pan, pinch ---------- */

const pointers = new Map();
let gesture = null; // { x, y, t, zx, zy, moved, pinched }
let pinch = null; // { dist, scale }
let lastTap = null;
let tapTimer = 0;

function onPointerDown(e) {
  if (e.pointerType === "mouse" && e.button !== 0) return;
  stage.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) {
    gesture = { x: e.clientX, y: e.clientY, t: performance.now(), zx: zoom.x, zy: zoom.y, moved: false, pinched: false };
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), scale: zoom.s };
    if (gesture) gesture.pinched = true;
  }
}

function onPointerMove(e) {
  if (!pointers.has(e.pointerId) || !gesture) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (pointers.size === 2 && pinch) {
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, pinch.scale * (dist / pinch.dist), false);
    return;
  }
  if (gesture.pinched) return;

  const dx = e.clientX - gesture.x;
  const dy = e.clientY - gesture.y;
  if (Math.abs(dx) + Math.abs(dy) > 8) gesture.moved = true;
  if (!gesture.moved) return;

  if (zoom.s > 1) {
    stage.classList.add("dragging");
    zoom.x = gesture.zx + dx;
    zoom.y = gesture.zy + dy;
    applyZoom(false);
  } else {
    // The page follows the finger a little so a swipe feels connected.
    canvas.classList.remove("anim");
    canvas.style.transform = `translate(${dx * 0.35}px, 0)`;
  }
}

function onPointerUp(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  if (pointers.size > 0 || !gesture) return;

  const g = gesture;
  gesture = null;
  pinch = null;
  stage.classList.remove("dragging");
  const dx = e.clientX - g.x;
  const dy = e.clientY - g.y;

  if (g.pinched) {
    if (zoom.s < 1.05) resetZoom();
    return;
  }
  if (zoom.s > 1) {
    if (!g.moved) handleTap(e.clientX, e.clientY);
    return;
  }
  applyZoom(true); // settle the page back to centre
  if (g.moved) {
    if (e.type !== "pointercancel" && Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.3) go(dx < 0 ? 1 : -1);
  } else if (performance.now() - g.t < 500) {
    handleTap(e.clientX, e.clientY);
  }
}

function handleTap(x, y) {
  const now = performance.now();
  if (lastTap && now - lastTap.t < 300 && Math.hypot(x - lastTap.x, y - lastTap.y) < 40) {
    // Double tap / double click: zoom in on that spot, or back out.
    clearTimeout(tapTimer);
    lastTap = null;
    zoom.s > 1 ? resetZoom() : zoomAt(x, y, 2.5, true);
    return;
  }
  const edge = x / stage.clientWidth;
  if (zoom.s === 1 && edge < 0.28) return go(-1);
  if (zoom.s === 1 && edge > 0.72) return go(1);
  lastTap = { x, y, t: now };
  clearTimeout(tapTimer);
  tapTimer = setTimeout(toggleChrome, 260);
}

function onWheel(e) {
  e.preventDefault();
  const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.012 : 0.0018));
  zoomAt(e.clientX, e.clientY, zoom.s * factor, false);
}

/* ---------- Chrome visibility ---------- */

// The bars sit above and below the page and never cover it. Tapping the middle
// of the page hides them (the page grows into the freed space) or brings them back.
function toggleChrome() {
  document.body.classList.toggle("ui-hidden");
}

function measureBars() {
  const root = document.documentElement.style;
  root.setProperty("--top-h", document.querySelector(".bar.top").offsetHeight + "px");
  root.setProperty("--bottom-h", document.querySelector(".bar.bottom").offsetHeight + "px");
}

/* ---------- Thumbnails ---------- */

function buildThumbs() {
  const grid = $("thumb-grid");
  pages.forEach((p, i) => {
    const btn = document.createElement("button");
    btn.className = "thumb";
    btn.innerHTML = `<img loading="lazy" width="${p.w}" height="${p.h}" src="${p.thumb}" alt=""><span>${i + 1}</span>`;
    btn.setAttribute("aria-label", `Go to page ${i + 1}`);
    btn.addEventListener("click", () => {
      closeThumbs();
      goToPage(i);
    });
    grid.append(btn);
  });
}

function openThumbs() {
  const el = $("thumbs");
  el.hidden = false;
  el.getBoundingClientRect();
  el.classList.add("open");
  document.querySelector(".thumb.current")?.scrollIntoView({ block: "center" });
}

function closeThumbs() {
  const el = $("thumbs");
  if (el.hidden) return;
  el.classList.remove("open");
  setTimeout(() => (el.hidden = true), 300);
}

/* ---------- Misc ---------- */

let toastTimer = 0;
function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 1800);
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}

function bindEvents() {
  stage.addEventListener("pointerdown", onPointerDown);
  stage.addEventListener("pointermove", onPointerMove);
  stage.addEventListener("pointerup", onPointerUp);
  stage.addEventListener("pointercancel", onPointerUp);
  stage.addEventListener("wheel", onWheel, { passive: false });
  stage.addEventListener("contextmenu", (e) => e.preventDefault());

  $("prev").addEventListener("click", () => go(-1));
  $("next").addEventListener("click", () => go(1));
  $("mode").addEventListener("click", () => setMode(mode === "double" ? "single" : "double"));
  $("zoom-reset").addEventListener("click", () => resetZoom());
  $("thumbs-btn").addEventListener("click", openThumbs);
  $("thumbs-close").addEventListener("click", closeThumbs);
  $("thumbs").addEventListener("click", (e) => e.target === $("thumbs") && closeThumbs());

  if (document.documentElement.requestFullscreen) $("fullscreen").addEventListener("click", toggleFullscreen);
  else $("fullscreen").hidden = true;

  scrubber.addEventListener("input", () => {
    const target = scrubber.value - 1;
    if (target !== spreadIdx) show(target, target > spreadIdx ? 1 : -1);
  });

  addEventListener("resize", () => {
    measureBars();
    if (zoom.s > 1) applyZoom(false);
  });

  addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const thumbsOpen = !$("thumbs").hidden;
    if (e.key === "Escape") {
      if (thumbsOpen) closeThumbs();
      else if (zoom.s > 1) resetZoom();
      return;
    }
    if (thumbsOpen) return;
    const onScrubber = e.target === scrubber;
    const rect = stage.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const actions = {
      ArrowRight: () => !onScrubber && go(1),
      ArrowLeft: () => !onScrubber && go(-1),
      PageDown: () => go(1),
      PageUp: () => go(-1),
      " ": () => e.target.tagName !== "BUTTON" && go(e.shiftKey ? -1 : 1),
      Home: () => !onScrubber && show(0, -1),
      End: () => !onScrubber && show(spreads.length - 1, 1),
      f: toggleFullscreen,
      d: () => setMode(mode === "double" ? "single" : "double"),
      t: openThumbs,
      "+": () => zoomAt(cx, cy, zoom.s * 1.4, true),
      "=": () => zoomAt(cx, cy, zoom.s * 1.4, true),
      "-": () => zoomAt(cx, cy, zoom.s / 1.4, true),
      0: () => resetZoom(),
    };
    const action = actions[e.key.length === 1 ? e.key.toLowerCase() : e.key];
    if (action && action() !== false && e.key === " ") e.preventDefault();
  });
}
