// One page, three modes by path: / browses, /submit#token uploads scans, /admin#token reviews and edits.
const $ = (q, el = document) => el.querySelector(q);
const $$ = (q, el = document) => [...el.querySelectorAll(q)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const h = (html) => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const SIZES = [256, 512, 1024, 2048];
const src = (m, px) => `/i/${m.id}/${SIZES.find((s) => s >= px) ?? 2048}.webp?v=${m.v}`;
const pngUrl = (m) => `${location.origin}/i/${m.id}.png?v=${m.v}`;
const norm = (a) => Math.round(((((a % 360) + 540) % 360) - 180) * 10) / 10;
const mode = { "/submit": "submit", "/admin": "admin" }[location.pathname.replace(/\/$/, "")] ?? "public";
const token = decodeURIComponent(location.hash.slice(1));
const params = new URLSearchParams(location.search);
const filter = { q: params.get("q") ?? "", tags: new Set(params.getAll("tag")) };
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const store = (k, v) => { try { return v === undefined ? localStorage.getItem(k) : localStorage.setItem(k, v); } catch { return null; } };

async function api(path, { body, method = body ? "POST" : "GET" } = {}) {
  const headers = { "X-Token": token };
  if (body && !(body instanceof FormData)) { headers["Content-Type"] = "application/json"; body = JSON.stringify(body); }
  const r = await fetch(path, { method, headers, body });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof data.detail === "string" ? data.detail : `${r.status} ${r.statusText}`);
  return data;
}

function toast(msg, ms = 2600) {
  const t = $(".toast");
  ($("dialog[open]") ?? document.body).append(t);   // a modal dialog covers everything outside it
  t.textContent = msg;
  t.classList.add("on");
  clearTimeout(t.timer);
  t.timer = setTimeout(() => t.classList.remove("on"), ms);
}

function setParams(fn) {
  fn(params);
  const qs = params.toString();
  history.replaceState(null, "", `${location.pathname}${qs ? `?${qs}` : ""}${location.hash}`);
}

// ---- browsing: search, tag chips, justified rows ---------------------------------------------

let active = null;   // { root, items, open, empty }

function show(root, items, open, empty) {
  for (const m of items) m.hay ??= [m.title, m.comment, m.creator, ...m.tags].join(" ").toLowerCase();
  if (active?.root !== root) {
    root.replaceChildren(h(`<div class="filters"><div class="chips" role="group" aria-label="Filter by tag"></div>
        <button class="more" aria-expanded="false">All tags</button></div>`), h(`<div class="grid"></div>`));
    resize.disconnect();
    resize.observe($(".grid", root));
  }
  active = { root, items, open, empty };
  $("#q").placeholder = `Search ${plural(items.length, "sticker")}`;
  render();
}

function matches() {
  const words = filter.q.toLowerCase().split(/\s+/).filter(Boolean);
  return active.items.filter((m) => [...filter.tags].every((t) => m.tags.includes(t)) && words.every((w) => m.hay.includes(w)));
}

function render() {
  const { root, items, empty } = active;
  const shown = matches();
  const counts = new Map();
  for (const m of shown) for (const t of m.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  const chips = [...filter.tags].map((t) => [t, counts.get(t) ?? 0])
    .concat([...counts].filter(([t]) => !filter.tags.has(t)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
  $(".chips", root).replaceChildren(...chips.map(([t, n]) =>
    h(`<button class="chip" aria-pressed="${filter.tags.has(t)}" data-tag="${esc(t)}">#${esc(t)}<span class="n">${n}</span></button>`)));
  $(".filters", root).hidden = !chips.length;
  $(".more", root).hidden = $(".chips", root).scrollHeight <= $(".chips", root).clientHeight + 2 && !$(".filters.open", root);
  const grid = $(".grid", root);
  if (!shown.length) {
    grid.replaceChildren(items.length
      ? h(`<div class="empty"><p>No stickers match${filter.q ? ` “${esc(filter.q)}”` : ""}${filter.tags.size ? ` with ${[...filter.tags].map(esc).join(" and ")}` : ""}.</p><button class="btn" data-clear>Clear the search</button></div>`)
      : h(`<div class="empty"><p>${esc(empty)}</p></div>`));
    return;
  }
  layout(grid, shown);
}

// Rows of equal height that fill the width exactly (the Google Photos / Immich layout).
function layout(grid, items) {
  const W = grid.clientWidth, small = W < 640, gap = small ? 10 : 18, target = small ? 104 : 168;
  grid.dataset.w = W;
  const rows = [];
  let row = [], sum = 0;
  const flush = (last) => {
    const height = Math.min((W - gap * (row.length - 1)) / sum, last ? target : Infinity);
    rows.push(h(`<div class="row" style="height:${height.toFixed(1)}px;gap:${gap}px;margin-bottom:${gap}px"></div>`));
    for (const m of row) {
      const w = (height * m.w) / m.h, px = Math.max(w, height) * devicePixelRatio;
      rows.at(-1).append(h(`<button class="tile" style="width:${w.toFixed(1)}px" data-id="${m.id}" title="${esc(m.title)}">
        <img src="${src(m, px)}" alt="${esc(m.title || "Untitled sticker")}" width="${m.w}" height="${m.h}" loading="lazy" decoding="async"></button>`));
    }
    row = []; sum = 0;
  };
  for (const m of items) {
    row.push(m);
    sum += m.w / m.h;
    if (sum * target + gap * (row.length - 1) >= W) flush(false);
  }
  if (row.length) flush(true);
  grid.replaceChildren(...rows);
  grid.shown = items;
}

const resize = new ResizeObserver(([e]) => {
  const grid = e.target;
  if (grid.shown && +grid.dataset.w !== grid.clientWidth) layout(grid, grid.shown);
});

document.addEventListener("click", (e) => {
  const chip = e.target.closest(".chips .chip, .side .chip"), tile = e.target.closest(".tile");
  const more = e.target.closest(".more");
  if (more) return more.setAttribute("aria-expanded", more.parentElement.classList.toggle("open"));
  if (e.target.closest("[data-clear]")) {
    filter.q = $("#q").value = "";
    filter.tags.clear();
  } else if (chip) {
    const t = chip.dataset.tag;
    if (chip.closest("dialog")) { chip.closest("dialog").close(); filter.tags.add(t); }
    else filter.tags.has(t) ? filter.tags.delete(t) : filter.tags.add(t);
  } else if (tile) {
    const list = tile.closest(".grid").shown;
    return active.open(list, list.findIndex((m) => m.id === tile.dataset.id));
  } else return;
  syncFilter();
  render();
});

function syncFilter() {
  setParams((p) => {
    filter.q ? p.set("q", filter.q) : p.delete("q");
    p.delete("tag");
    for (const t of filter.tags) p.append("tag", t);
  });
}

$("#q").value = filter.q;
$("#q").addEventListener("input", (e) => {
  filter.q = e.target.value.trim();
  syncFilter();
  if (active) render();
});

// ---- overlays ---------------------------------------------------------------------------------

// Replace an overlay's content but keep the toast that may be showing in it.
const fill = (d, html) => { $(".layout", d)?.remove(); d.prepend(h(html)); };

function sheet() {
  const d = h(`<dialog class="sheet"></dialog>`);
  document.body.append(d);
  d.showModal();
  d.addEventListener("close", () => { document.body.append($(".toast")); d.remove(); setParams((p) => p.delete("s")); });
  d.addEventListener("click", (e) => e.target.closest(".close") && d.close());
  return d;
}

const ENGINES = {
  "Google Lens": (u) => `https://lens.google.com/uploadbyurl?url=${u}`,
  Bing: (u) => `https://www.bing.com/images/search?view=detailv2&iss=sbi&q=imgurl:${u}`,
  TinEye: (u) => `https://tineye.com/search?url=${u}`,
  Yandex: (u) => `https://yandex.com/images/search?rpt=imageview&url=${u}`,
};
const findOnline = (m) => `<div class="field"><span>Find this sticker online</span><div class="find">${Object.entries(ENGINES)
  .map(([name, url]) => `<a class="btn" target="_blank" rel="noopener noreferrer" href="${esc(url(encodeURIComponent(pngUrl(m))))}">${name}</a>`).join("")}</div></div>`;
const date = (s) => (s ? new Date(s).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }) : "");
const detail = (label, value) => (value ? `<div><dt>${label}</dt><dd>${esc(value)}</dd></div>` : "");
const viewPx = () => Math.max(innerWidth * 0.7, innerHeight) * devicePixelRatio;

function viewer(list, i) {
  const d = sheet();
  const go = (k) => {
    i = (k + list.length) % list.length;
    const m = list[i];
    setParams((p) => p.set("s", m.id));
    fill(d, `<div class="layout">
      <div class="view">
        <img src="${src(m, viewPx())}" alt="${esc(m.title || "Untitled sticker")}">
        ${list.length > 1 ? `<button class="nav prev" aria-label="Previous sticker">‹</button><button class="nav next" aria-label="Next sticker">›</button>` : ""}
      </div>
      <aside class="side">
        <div class="bar"><span class="hint grow">${i + 1} of ${list.length}</span><button class="close" aria-label="Close">×</button></div>
        <h1>${esc(m.title || "Untitled sticker")}</h1>
        <div class="size" title="Measured from the scan">${m.w_mm} × ${m.h_mm}<small>mm</small></div>
        ${m.tags.length ? `<div class="tags">${m.tags.map((t) => `<button class="chip" data-tag="${esc(t)}">#${esc(t)}</button>`).join("")}</div>` : ""}
        <dl>${detail("How it was acquired", m.comment)}${detail("Added by", m.creator)}${detail("Added", date(m.added))}</dl>
        <div class="find"><a class="btn" href="/i/${m.id}.png" download>Download PNG</a>
          ${store("admin") ? `<a class="btn" href="/admin?tab=approved&s=${m.id}#${encodeURIComponent(store("admin"))}">Edit</a>` : ""}</div>
        ${findOnline(m)}
      </aside></div>`);
    for (const k of [i - 1, i + 1]) if (list.length > 1) new Image().src = src(list[(k + list.length) % list.length], viewPx());
  };
  d.addEventListener("click", (e) => { if (e.target.closest(".nav")) go(i + (e.target.closest(".next") ? 1 : -1)); });
  d.addEventListener("keydown", (e) => { if (e.key === "ArrowLeft") go(i - 1); if (e.key === "ArrowRight") go(i + 1); });
  let x0 = null;   // swipe between stickers on touch screens
  d.addEventListener("pointerdown", (e) => { if (e.target.closest(".view")) x0 = e.clientX; });
  d.addEventListener("pointerup", (e) => {
    if (x0 !== null && Math.abs(e.clientX - x0) > 60) go(i + (e.clientX < x0 ? 1 : -1));
    x0 = null;
  });
  go(i);
}

// The editor: rotate by dragging (or two-finger twist), zoom with the wheel or a pinch,
// level by drawing along an edge, and white-balance. Rotation and colour are applied
// server-side once, on save; the colour preview comes from the same server code.
function editor(list, i, changed) {
  list = [...list];
  const d = sheet();
  let m, rot, zoom, pan, warmth, tint, tool = "rotate", busy = false, shade;
  const stage = () => $(".stage", d), img = () => $(".stage img", d);
  const fitter = new ResizeObserver(() => paint());

  function load(k) {
    if (!list.length) return d.close();
    i = Math.min(k, list.length - 1);
    m = list[i];
    rot = 0; zoom = 1; pan = [0, 0]; warmth = 0; tint = 0;
    setParams((p) => p.set("s", m.id));
    const [label, state] = m.state === "approved" ? ["Save changes", null] : ["Publish", "approved"];
    fill(d, `<form class="layout">
      <div class="edit">
        <div class="stage" data-tool="${tool}">
          <img src="${src(m, 2048)}" alt="" draggable="false">
          <div class="guides"></div><svg aria-hidden="true"><line></line></svg>
          <output class="readout"></output>
        </div>
        <div class="tools">
          ${["rotate", "pan", "level"].map((t) => `<button type="button" class="btn" data-tool="${t}" aria-pressed="${t === tool}"
            ${t === "level" ? 'title="Drag along an edge that should be level or upright"' : ""}>${{ rotate: "Rotate", pan: "Move", level: "Level" }[t]}</button>`).join("")}
          <span class="gap"></span>
          <button type="button" class="btn" data-turn="-90" aria-label="Turn 90° anticlockwise">↺ 90°</button>
          <button type="button" class="btn" data-turn="-1">−1°</button>
          <button type="button" class="btn" data-turn="1">+1°</button>
          <button type="button" class="btn" data-turn="90" aria-label="Turn 90° clockwise">↻ 90°</button>
          <button type="button" class="btn" data-act="symmetry" title="Level a design that is symmetric left to right">Symmetry</button>
          <span class="gap"></span>
          <button type="button" class="btn" data-zoom="0.8" aria-label="Zoom out">−</button>
          <button type="button" class="btn" data-zoom="1.25" aria-label="Zoom in">+</button>
          <button type="button" class="btn" data-act="fit">Fit</button>
        </div>
      </div>
      <aside class="side">
        <div class="bar"><span class="hint grow">${i + 1} of ${list.length}, ${m.w_mm} × ${m.h_mm} mm</span><button type="button" class="close" aria-label="Close">×</button></div>
        <label class="field"><span>Title</span><input name="title" value="${esc(m.title)}"></label>
        <label class="field"><span>Tags, separated by commas</span><input name="tags" value="${esc(m.tags.join(", "))}" autocapitalize="none"></label>
        <label class="field"><span>How it was acquired</span><textarea name="comment" rows="2">${esc(m.comment)}</textarea></label>
        <label class="field"><span>Added by</span><input name="creator" value="${esc(m.creator)}" autocomplete="name"></label>
        <div class="field colour"><span>Colour, for holo foil that scanned too blue</span>
          <label>Warmth <input type="range" name="warmth" min="-1" max="1" step="0.05" value="0"></label>
          <label>Tint <input type="range" name="tint" min="-1" max="1" step="0.05" value="0"></label>
          <div class="find"><button type="button" class="btn" data-act="auto">Auto</button><button type="button" class="btn" data-act="neutral">Reset</button></div></div>
        <div class="field dupes" hidden><span>Possible duplicates</span><ul></ul></div>
        ${findOnline(m)}
        <div class="actions">
          <button class="btn primary" data-state="${state ?? ""}">${label}</button>
          ${state ? `<button type="button" class="btn" data-act="save">Save changes</button>` : `<button type="button" class="btn" data-act="unpublish">Unpublish</button>`}
          <button type="button" class="btn danger" data-act="delete">${{ pending: "Reject", approved: "Delete" }[m.state]}</button>
        </div>
        <p class="hint">Drag the sticker to rotate it, or twist with two fingers. Scroll or pinch to zoom.
          Keys: <kbd>←</kbd> <kbd>→</kbd> 1°, with <kbd>Shift</kbd> 15°; <kbd>Q</kbd> <kbd>E</kbd> 90°; <kbd>Enter</kbd> ${label.toLowerCase()}.</p>
      </aside></form>`);
    img().onload = paint;
    fitter.disconnect();
    fitter.observe(stage());
    gestures(stage());
    const id = m.id;
    api(`/api/stickers/${id}/similar`).then((found) => {
      if (id !== m.id || !found.length) return;
      $(".dupes", d).hidden = false;
      $(".dupes ul", d).replaceChildren(...found.slice(0, 4).map((o) => h(`<li><a href="${o.state === "approved" ? `/?s=${o.id}` : `/i/${o.id}.png`}" target="_blank" rel="noopener">
        <img src="${src(o, 256)}" alt=""><span><b>${o.kind === "duplicate" ? "Same sticker?" : "Similar design"}</b>
        ${esc(o.title || "Untitled")}<small>${o.state === "approved" ? "Published" : "To review"}, ${o.w_mm} × ${o.h_mm} mm</small></span></a></li>`)));
    }, () => {});
  }

  function recolour() {   // debounced: each change asks the server for a preview
    $("[name=warmth]", d).value = warmth;
    $("[name=tint]", d).value = tint;
    clearTimeout(shade);
    shade = setTimeout(() => (img().src = warmth || tint ? `/i/${m.id}/preview.webp?warmth=${warmth}&tint=${tint}&v=${m.v}` : src(m, 2048)), 120);
  }

  function paint() {
    const s = stage(), im = img();
    if (!im?.naturalWidth) return;
    const [W, H, w, hh] = [s.clientWidth, s.clientHeight, im.naturalWidth, im.naturalHeight];
    const t = (rot * Math.PI) / 180, c = Math.abs(Math.cos(t)), sn = Math.abs(Math.sin(t));
    const k = 0.88 * Math.min(W / (w * c + hh * sn), H / (w * sn + hh * c)) * zoom;
    im.style.transform = `translate(${pan[0]}px,${pan[1]}px) rotate(${rot}deg) scale(${k}) translate(${-w / 2}px,${-hh / 2}px)`;
    $(".readout", d).textContent = `${norm(rot)}°${zoom === 1 ? "" : `, ${Math.round(zoom * 100)}%`}`;
  }

  const turn = (deg) => { rot = Math.round((rot + deg) * 10) / 10; paint(); };
  function zoomAt([x, y], f) {   // keep the point under the cursor where it is
    const r = stage().getBoundingClientRect(), cx = x - r.left - r.width / 2, cy = y - r.top - r.height / 2;
    const z = Math.min(16, Math.max(0.5, zoom * f));
    pan = [cx - ((cx - pan[0]) * z) / zoom, cy - ((cy - pan[1]) * z) / zoom];
    zoom = z;
    paint();
  }

  function gestures(s) {
    const pts = new Map();
    let g = null;
    const centre = () => { const r = s.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
    const deg = ([x, y], [cx, cy]) => (Math.atan2(y - cy, x - cx) * 180) / Math.PI;
    const begin = () => {
      const p = [...pts.values()];
      g = { n: p.length, rot, zoom, pan: [...pan], p0: p[0], a0: deg(p[0] ?? [0, 0], centre()) };
      if (p.length === 2) Object.assign(g, { dist: Math.hypot(p[1][0] - p[0][0], p[1][1] - p[0][1]), twist: deg(p[1], p[0]), mid: [(p[0][0] + p[1][0]) / 2, (p[0][1] + p[1][1]) / 2] });
    };
    s.onpointerdown = (e) => {
      pts.set(e.pointerId, [e.clientX, e.clientY]);
      begin();
      try { s.setPointerCapture(e.pointerId); } catch {}   // keeps the drag when the pointer leaves the stage
    };
    s.onpointermove = (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, [e.clientX, e.clientY]);
      const p = [...pts.values()];
      if (g.n >= 2 && p.length >= 2) {   // pinch to zoom, twist to rotate, both fingers to move
        const mid = [(p[0][0] + p[1][0]) / 2, (p[0][1] + p[1][1]) / 2];
        zoom = g.zoom; pan = [g.pan[0] + mid[0] - g.mid[0], g.pan[1] + mid[1] - g.mid[1]];
        rot = Math.round((g.rot + deg(p[1], p[0]) - g.twist) * 10) / 10;
        zoomAt(mid, Math.hypot(p[1][0] - p[0][0], p[1][1] - p[0][1]) / g.dist);
      } else if (tool === "rotate") {
        let r = g.rot + deg(p[0], centre()) - g.a0;
        if (e.shiftKey) r = Math.round(r / 15) * 15;
        rot = Math.round(r * 10) / 10; paint();
      } else if (tool === "pan") {
        pan = [g.pan[0] + p[0][0] - g.p0[0], g.pan[1] + p[0][1] - g.p0[1]]; paint();
      } else {
        const r = s.getBoundingClientRect(), line = $("line", s);
        [["x1", g.p0[0] - r.left], ["y1", g.p0[1] - r.top], ["x2", p[0][0] - r.left], ["y2", p[0][1] - r.top]].forEach(([a, v]) => line.setAttribute(a, v));
      }
    };
    s.onpointerup = s.onpointercancel = (e) => {
      const end = pts.get(e.pointerId);
      if (!pts.delete(e.pointerId)) return;
      if (tool === "level" && g.n === 1) {
        ["x1", "y1", "x2", "y2"].forEach((a) => $("line", s).removeAttribute(a));
        const [dx, dy] = [end[0] - g.p0[0], end[1] - g.p0[1]];
        if (Math.hypot(dx, dy) > 24) {
          const a = (Math.atan2(dy, dx) * 180) / Math.PI, fix = Math.round(a / 90) * 90 - a;
          turn(fix);
          toast(`Levelled by ${norm(fix)}°`);
        }
      }
      if (pts.size) begin();
    };
    s.onwheel = (e) => { e.preventDefault(); zoomAt([e.clientX, e.clientY], Math.exp(-e.deltaY * 0.0015)); };
    s.ondblclick = () => { rot = 0; paint(); };
  }

  async function save(state) {
    if (busy) return;
    busy = true;
    $$(".actions .btn", d).forEach((b) => (b.disabled = true));
    const f = new FormData($("form", d));
    try {
      const updated = await api(`/api/stickers/${m.id}`, { body: {
        title: f.get("title"), tags: f.get("tags").split(","), comment: f.get("comment"),
        creator: f.get("creator"), rotate: norm(rot), warmth, tint, state: state || null } });
      toast({ approved: "Published", pending: "Unpublished" }[state] ?? "Saved");
      if (state) list.splice(i, 1); else list[i] = updated;
      changed();
      load(i);
    } catch (e) {
      toast(e.message, 6000);
      $$(".actions .btn", d).forEach((b) => (b.disabled = false));
    } finally { busy = false; }
  }

  d.addEventListener("submit", (e) => { e.preventDefault(); save(e.submitter?.dataset.state ?? $(".primary", d).dataset.state); });
  d.addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.tool) {
      tool = b.dataset.tool;
      stage().dataset.tool = tool;
      $$("[data-tool]", d).forEach((x) => x.tagName === "BUTTON" && x.setAttribute("aria-pressed", x === b));
    } else if (b.dataset.turn) turn(+b.dataset.turn);
    else if (b.dataset.zoom) { const r = stage().getBoundingClientRect(); zoomAt([r.left + r.width / 2, r.top + r.height / 2], +b.dataset.zoom); }
    else if (b.dataset.act === "fit") { zoom = 1; pan = [0, 0]; paint(); }
    else if (b.dataset.act === "save") save(null);
    else if (b.dataset.act === "neutral") { warmth = tint = 0; recolour(); }
    else if (b.dataset.act === "auto") {
      const c = await api(`/api/stickers/${m.id}/balance`);
      if (!c.warmth && !c.tint) toast("No blue cast found in the bright parts");
      else { ({ warmth, tint } = c); recolour(); }
    }
    else if (b.dataset.act === "unpublish") save("pending");
    else if (b.dataset.act === "symmetry") {
      b.disabled = true;
      try {
        const s = await api(`/api/stickers/${m.id}/symmetry`);
        if (s.score - s.score0 < 0.01) toast("Its outline is already as symmetric as it gets");
        else { rot = s.angle; paint(); toast(`Levelled by symmetry: ${s.angle}°`); }
      } finally { b.disabled = false; }
    } else if (b.dataset.act === "delete") {
      if (!b.classList.contains("armed")) {   // two clicks, so a slip doesn't lose a sticker
        const label = b.textContent;
        b.classList.add("armed"); b.textContent = `${label}: click again`;
        return setTimeout(() => { b.classList.remove("armed"); b.textContent = label; }, 3000);
      }
      try {
        await api(`/api/stickers/${m.id}`, { method: "DELETE" });
        toast(`${{ pending: "Rejected", approved: "Deleted" }[m.state]} “${m.title || "untitled"}”`);
        list.splice(i, 1); changed(); load(i);
      } catch (err) { toast(err.message, 6000); }
    }
  });
  d.addEventListener("input", (e) => {
    if (e.target.type !== "range") return;
    if (e.target.name === "warmth") warmth = +e.target.value; else tint = +e.target.value;
    recolour();
  });
  d.addEventListener("keydown", (e) => {
    const el = document.activeElement;
    if ((/INPUT|TEXTAREA/.test(el.tagName) && el.type !== "range") || (e.key === "Enter" && el.closest(".side a, .side button"))) return;
    const k = e.key.toLowerCase();
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") turn((e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 15 : 1));
    else if (k === "q" || k === "e") turn(k === "q" ? -90 : 90);
    else if (k === "+" || k === "=" || k === "-") $(`[data-zoom="${k === "-" ? 0.8 : 1.25}"]`, d).click();
    else if (k === "0") $(`[data-act="fit"]`, d).click();
    else if (e.key === "Enter") { e.preventDefault(); $(".primary", d).click(); }
    else return;
    e.preventDefault();
  });
  load(i);
}

// ---- pages ------------------------------------------------------------------------------------

const main = $("#main");
let refresh = async () => {};

// A new random order for each visit, kept while the tab is open, so a reload or the viewer's
// next/previous doesn't reshuffle. Ranking by a hash of (seed, id), not shuffling the list,
// keeps everyone else in place when a sticker is added or removed.
function shuffled(items) {
  let seed;
  try { seed = +sessionStorage.getItem("order") || 0; } catch {}
  if (!seed) {
    seed = 1 + Math.floor(Math.random() * 2 ** 31);
    try { sessionStorage.setItem("order", seed); } catch {}
  }
  const rank = (id) => {
    let x = seed;
    for (const c of id) x = Math.imul(x ^ c.charCodeAt(0), 2654435761);
    return (x ^ (x >>> 15)) >>> 0;
  };
  return items.map((m) => [rank(m.id), m]).sort((a, b) => a[0] - b[0]).map(([, m]) => m);
}

async function publicPage() {
  refresh = async () => show(main, shuffled(await api("/api/stickers")), viewer, "No stickers yet.");
  await refresh();
  const k = active.items.findIndex((m) => m.id === params.get("s"));
  if (k >= 0) viewer(active.items, k);
}

function uploadPanel(onProgress) {
  const p = h(`<section class="panel">
    <h2>Add a scan</h2>
    <p>Scan at 600 dpi on a black background, with about 3 mm between stickers and none touching the edge.
      Each sticker is cut out, straightened, titled and tagged, then reviewed before it appears in the collection.</p>
    <form class="upload">
      <label class="drop wide"><input type="file" name="file" accept="image/*,.tif,.tiff" required><span>Choose a scan, or drop it here</span></label>
      <label class="field"><span>Your name</span><input name="creator" autocomplete="name"></label>
      <label class="field"><span>How you got these, for every sticker in the scan</span><input name="comment" placeholder="BSides Perth 2026 swag table"></label>
      <div class="wide"><button class="btn primary">Upload scan</button></div>
    </form>
    <ul class="jobs"></ul></section>`);
  const form = $("form", p), drop = $(".drop", p), file = $("[type=file]", p), btn = $("button", form);
  try { form.creator.value = localStorage.getItem("creator") ?? ""; } catch {}
  file.onchange = () => ($(".drop span", p).textContent = file.files[0]?.name ?? "Choose a scan, or drop it here");
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove("over"); file.files = e.dataTransfer.files; file.onchange(); };
  form.onsubmit = (e) => {
    e.preventDefault();
    try { localStorage.setItem("creator", form.creator.value); } catch {}
    const xhr = new XMLHttpRequest();   // fetch has no upload progress
    xhr.open("POST", "/api/scans");
    xhr.setRequestHeader("X-Token", token);
    xhr.upload.onprogress = (ev) => (btn.textContent = `Uploading ${Math.round((100 * ev.loaded) / ev.total)}%`);
    xhr.onloadend = () => {
      btn.disabled = false; btn.textContent = "Upload scan";
      if (xhr.status === 200) {
        toast(mode === "admin" ? "Uploaded. Its stickers will appear in To review as they are found." : "Uploaded. Thanks!");
        mine.push(JSON.parse(xhr.responseText).id);
        store("scans", JSON.stringify(mine.slice(-20)));
        form.file.value = ""; file.onchange();
      }
      else toast(JSON.parse(xhr.responseText || "{}").detail ?? "Upload failed. Check your connection and try again.", 7000);
      poll();
    };
    btn.disabled = true;
    xhr.send(new FormData(form));
  };
  let timer, seen = "";
  const mine = JSON.parse(store("scans") ?? "[]");   // a submitter sees only the scans sent from this browser
  async function poll() {
    clearTimeout(timer);
    const jobs = mode === "admin" ? await api("/api/scans").catch(() => [])
      : (await Promise.all(mine.map((id) => api(`/api/scans/${id}`).catch(() => null)))).filter(Boolean);
    $(".jobs", p).replaceChildren(...jobs.slice().reverse().map((j) => h(`<li><span>${esc(j.name)}${j.creator ? `, from ${esc(j.creator)}` : ""}</span>
      <span class="st ${j.status.startsWith("failed") ? "failed" : ""}">${esc(j.status === "done" ? `done: ${plural(j.stickers, "sticker")}` : j.status)}</span></li>`)));
    const sig = jobs.map((j) => j.status + j.stickers).join();
    if (sig !== seen) { seen = sig; onProgress(); }
    if (jobs.some((j) => j.status !== "done" && !j.status.startsWith("failed"))) timer = setTimeout(poll, 2000);
  }
  poll();
  return p;
}

function submitPage() {
  $("#q").closest(".search").hidden = true;
  main.append(uploadPanel(() => {}));
}

async function adminPage() {
  const tabs = $(".tabs"), body = h(`<div></div>`);
  const lists = { pending: "To review", approved: "Published" };
  const empty = { pending: "Nothing to review. Stickers from uploaded scans appear here.", approved: "Nothing published yet." };
  const extra = { upload: "Add scans", import: "Import" };
  const counts = {};
  store("admin", token);   // lets the public viewer offer an Edit link on this browser
  tabs.hidden = false;
  main.append(body);
  const tab = () => (params.get("tab") in { ...lists, ...extra } ? params.get("tab") : "pending");
  const nav = () => tabs.replaceChildren(...Object.entries({ ...lists, ...extra }).map(([k, label]) =>
    h(`<a href="?tab=${k}${location.hash}" data-tab="${k}" ${k === tab() ? 'aria-current="page"' : ""}>${label}${k in counts ? `<span class="n">${counts[k]}</span>` : ""}</a>`)));
  tabs.onclick = (e) => {
    const a = e.target.closest("a");
    if (!a) return;
    e.preventDefault();
    setParams((p) => p.set("tab", a.dataset.tab));
    open();
  };
  refresh = async () => {
    const all = await Promise.all(Object.keys(lists).map((s) => api(`/api/stickers?state=${s}`)));
    Object.keys(lists).forEach((s, k) => (counts[s] = all[k].length));
    nav();
    const t = tab();
    $("#q").closest(".search").hidden = !(t in lists);
    if (t in lists) show(body, all[Object.keys(lists).indexOf(t)], (l, i) => editor(l, i, refresh), empty[t]);
  };
  function open() {
    active = null;
    body.replaceChildren();
    const t = tab();
    if (t === "upload") body.append(uploadPanel(refresh));
    if (t === "import") body.append(importPanel());
    return refresh();
  }
  await open();
  const k = active?.items.findIndex((m) => m.id === params.get("s")) ?? -1;   // a link to one sticker opens it
  if (k >= 0) editor(active.items, k, refresh);
}

// One-off PhotoPrism import; delete with migrate.py.
function importPanel() {
  const p = h(`<section class="panel"><h2>Import from PhotoPrism</h2>
    <p>Copies every photo from a PhotoPrism site in public mode straight into Published, with its title and its manual labels as tags.
      Running it again skips stickers already imported.</p>
    <form class="upload">
      <label class="field wide"><span>PhotoPrism address</span><input name="url" type="url" value="https://stickers.tplant.com.au" required></label>
      <label class="field"><span>Added by</span><input name="creator" autocomplete="name"></label>
      <div class="wide"><button class="btn primary">Import</button></div>
    </form><p class="status" role="status"></p><ul class="jobs"></ul></section>`);
  const form = $("form", p);
  const draw = (s) => {
    $(".status", p).textContent = s.source ? `${s.running ? "Importing" : "Finished"}: ${s.imported} imported, ${s.skipped} already here, ${s.errors.length} failed, of ${s.total || "?"}.` : "";
    $(".jobs", p).replaceChildren(...(s.errors ?? []).map((e) => h(`<li><span class="st failed">${esc(e)}</span></li>`)));
    $("button", form).disabled = s.running;
    if (s.running) setTimeout(() => api("/api/migrate").then(draw), 1500);
    else if (s.source) refresh();
  };
  form.onsubmit = (e) => { e.preventDefault(); api("/api/migrate", { body: { url: form.url.value, creator: form.creator.value } }).then(draw, (err) => toast(err.message, 6000)); };
  api("/api/migrate").then(draw);
  return p;
}

(async () => {
  try {
    if (mode !== "public") {
      const { role } = await api("/api/me");
      if (!role || (mode === "admin" && role !== "admin")) throw new Error("This link has expired or is wrong. Ask for a new one.");
      document.title = mode === "admin" ? "Stickers: admin" : "Stickers: add a scan";
    }
    await { public: publicPage, submit: submitPage, admin: adminPage }[mode]();
  } catch (e) {
    main.replaceChildren(h(`<div class="empty"><p>${esc(e.message)}</p></div>`));
  }
})();
