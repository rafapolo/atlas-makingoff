/* Atlas do Acervo MakingOff — parede de capas num retângulo de cinema, com câmera (zoom contínuo + arrasto) e filtros à direita.
 * Todas as capas ficam SEMPRE na parede; os filtros só deixam as demais transparentes (a posição de cada filme não muda).
 * Dados: atlas-data.json (colunas; índice do filme = posição da miniatura), mini.webp (todas as capas em 16×24, usado de longe)
 * e pages/p<N>.webp (3072², miniaturas 64×96, usadas de perto). Funciona com mouse e com toque (arrastar, pinça, toque duplo). */
(() => {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const fmt = (n) => n.toLocaleString("pt-BR");
  const norm = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const V = (() => { try { return new URL(document.currentScript.src).searchParams.get("v") || ""; } catch { return ""; } })();   // versão = data de modificação (o servidor injeta em app.js?v=)
  const COARSE = matchMedia("(pointer: coarse)").matches;      // celular/tablet: menos páginas decodificadas na memória

  const gridEl = $("#grid"), cv = $("#cv"), ctx = cv.getContext("2d"), tip = $("#tip");
  let D, N = 0, C, PC;                   // dados, nº de filmes, colunas de dados, colunas da grade de sprites
  const GROUPS = { c: "Países", g: "Gêneros", d: "Diretores", l: "Idiomas", u: "Quem postou" };
  const SEED = ["verde", "amarelo", "laranja", "vermelho", "sem"];
  const SEEDLAB = { verde: "5 ou mais seeders", amarelo: "2 a 4 seeders", laranja: "1 seeder", vermelho: "0 seeders", sem: "sem dados de seeders" };
  const SEEDNAME = { verde: "verde", amarelo: "amarelo", laranja: "laranja", vermelho: "vermelho", sem: "sem dados" };
  const SIZES = [["<700 MB", 0, 700], ["0,7–2 GB", 700, 2048], ["2–6 GB", 2048, 6144], [">6 GB", 6144, 1e12]];
  const FLAGS = [["cover", 1, "Tem capa"], ["magnet", 2, "Tem magnet"], ["sub", 4, "Tem legenda"], ["co", 8, "Co-produção (2+ países)"], ["legacy", 16, "Só no legado de 2014"]];
  const ASPECTS = { cinema: 2.39, wide: 16 / 9, classic: 4 / 3 };
  const colors = {}; const readColors = () => { const cs = getComputedStyle(document.documentElement); for (const k of [...SEED, "bg", "fg", "muted", "line", "accent", "panel"]) colors[k] = cs.getPropertyValue("--" + k).trim(); };

  // ---------- estado dos filtros ----------
  const S = { q: "", sort: "year_desc", aspect: "cinema", sel: { c: new Set(), g: new Set(), d: new Set(), l: new Set(), u: new Set() }, all: false,
    seed: new Set(), size: new Set(), flags: new Set(), y0: null, y1: null, search: { c: "", g: "", d: "", l: "", u: "" }, more: {} };
  let match, nMatch = 0, seedClass, normText, normTitle, sortedBy = {}, counts = {}, fail;

  // ---------- parede (layout fixo) ----------
  const PW = 64, PH = 96;                                  // tamanho da capa no "mundo" = px da miniatura grande
  let wall = { cols: 1, rows: 1, w: PW, h: PH }, layoutOrder = [], posOf;
  function computeWall() {
    const cols = Math.max(1, Math.round(Math.sqrt(N * ASPECTS[S.aspect] * PH / PW)));
    wall = { cols, rows: Math.ceil(N / cols), w: cols * PW, h: Math.ceil(N / cols) * PH };
    layoutOrder = sortedIdx(S.sort); posOf = new Int32Array(N); layoutOrder.forEach((i, k) => (posOf[i] = k));
  }
  function sortedIdx(mode) {
    if (sortedBy[mode]) return sortedBy[mode];
    const idx = Array.from({ length: N }, (_, i) => i); let r;
    if (mode === "year_desc") r = idx;                                   // ordem natural do atlas
    else if (mode === "year_asc") r = idx.slice().sort((a, b) => (C.y[a] || 9999) - (C.y[b] || 9999) || a - b);
    else if (mode === "title") { const t = (normTitle ??= C.t.map(norm)), col = new Intl.Collator("pt"); r = idx.slice().sort((a, b) => col.compare(t[a], t[b])); }
    else if (mode === "seeds") r = idx.slice().sort((a, b) => (C.s[b] ?? -1) - (C.s[a] ?? -1) || a - b);
    else if (mode === "size") r = idx.slice().sort((a, b) => (C.z[b] ?? -1) - (C.z[a] ?? -1));
    else if (mode === "recent") r = idx.slice().sort((a, b) => C.id[b] - C.id[a]);
    else { r = idx.slice(); for (let i = N - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; } }
    return (sortedBy[mode] = r);
  }

  // ---------- imagens: atlas minúsculo + páginas grandes (LRU) ----------
  let miniBmp = null, wallC = null;
  const pages = new Map(); const MAXP = COARSE ? 4 : 10; let frame = 0, inflight = 0;
  function page(p) {
    let e = pages.get(p);
    if (!e) {
      if (pages.size >= MAXP) { // só carrega se der para descartar uma página que não foi usada há ~1 s
        let old = null; for (const [k, v] of pages) if (v.used < frame - 60 && (!old || v.used < old[1].used)) old = [k, v];
        if (!old) return null; old[1].bmp?.close(); pages.delete(old[0]);
      }
      if (inflight >= 2) return null;                          // no máx. 2 páginas baixando/decodificando ao mesmo tempo (as demais usam a miniatura)
      e = { bmp: null, state: "loading", used: frame }; pages.set(p, e); inflight++;
      fetch(`pages/p${p}.webp?v=${D.generated}`).then((r) => r.blob()).then((b) => createImageBitmap(b, { colorSpaceConversion: "none", premultiplyAlpha: "none" }))
        .then((bmp) => { e.bmp = bmp; e.state = "ok"; }).catch(() => { e.state = "err"; }).finally(() => { inflight--; kick(); });
    }
    e.used = frame; return e;
  }

  // composição da parede em miniatura (nível "de longe"): refeita só quando muda a ordem, o formato ou o tema (o filtro é uma máscara por cima)
  let wallDirty = true;
  // pixels do atlas minúsculo em memória (Uint32 RGBA): copiar blocos 16×24 aqui é ~10× mais rápido que 33 mil drawImage
  let miniPx = null, miniW = 0;
  const abgr = (c) => { const [r, g, b] = rgb(c); return (255 << 24) | (b << 16) | (g << 8) | r; };
  function composeWall() {
    if (!miniBmp) { wallDirty = true; return; }
    if (!miniPx) { const c = document.createElement("canvas"); c.width = miniW = miniBmp.width; c.height = miniBmp.height; const cx = c.getContext("2d", { willReadFrequently: true }); cx.drawImage(miniBmp, 0, 0); miniPx = new Uint32Array(cx.getImageData(0, 0, c.width, c.height).data.buffer); }
    const [mw, mh] = D.mini.tile, mc = D.mini.cols, WW = wall.cols * mw, WH = wall.rows * mh, out = new Uint32Array(WW * WH);
    out.fill(abgr(colors.bg));
    const panel = abgr(colors.panel), seedC = {}; for (const k of SEED) seedC[k] = abgr(colors[k]);
    for (let k = 0; k < N; k++) {
      const i = layoutOrder[k], dx = (k % wall.cols) * mw, dy = ((k / wall.cols) | 0) * mh;
      if (C.f[i] & 1) {
        const sx = (i % mc) * mw, sy = ((i / mc) | 0) * mh;
        for (let r = 0; r < mh; r++) { const so = (sy + r) * miniW + sx, d0 = (dy + r) * WW + dx; for (let c = 0; c < mw; c++) out[d0 + c] = miniPx[so + c]; }
      } else for (let r = 0; r < mh; r++) { const d0 = (dy + r) * WW + dx; for (let c = 0; c < mw; c++) out[d0 + c] = panel; }
      const sc = seedC[seedClass[i]]; for (let r = mh - 2; r < mh; r++) { const d0 = (dy + r) * WW + dx; for (let c = 0; c < mw; c++) out[d0 + c] = sc; }   // traço de saúde
    }
    wallC ??= document.createElement("canvas"); wallC.width = WW; wallC.height = WH;
    wallC.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(out.buffer), WW, WH), 0, 0);
    wallDirty = false; buildMinimap(); updateMask();
  }

  // máscara do filtro: 1 pixel por capa (cols × rows). Capas que NÃO casam recebem a cor do fundo quase opaca; desenhada por cima da parede com UM drawImage.
  let maskC = null;
  const rgb = (c) => { const m = /^#?([0-9a-f]{6})$/i.exec(c.trim()); if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)); const r = /(\d+)[ ,]+(\d+)[ ,]+(\d+)/.exec(c); return r ? [+r[1], +r[2], +r[3]] : [15, 18, 22]; };
  function updateMask() {
    if (!wall || !match) return; maskC ??= document.createElement("canvas");
    if (maskC.width !== wall.cols || maskC.height !== wall.rows) { maskC.width = wall.cols; maskC.height = wall.rows; }
    const x = maskC.getContext("2d"), img = x.createImageData(wall.cols, wall.rows), d = img.data, [br, bgc, bb] = rgb(colors.bg);
    for (let k = 0; k < N; k++) if (!match[layoutOrder[k]]) { const o = k * 4; d[o] = br; d[o + 1] = bgc; d[o + 2] = bb; d[o + 3] = 232; }
    x.putImageData(img, 0, 0);
  }

  // minimapa: a parede inteira miniaturizada com o retângulo da área visível (clique/arraste para navegar)
  const mm = $("#mm"), mmWrap = $("#minimap"), mmv = $("#mmv"); let mmW = 180;
  function buildMinimap() {
    if (!wallC || !mm) return; mmW = W < 500 ? 110 : 180; const h = Math.round(mmW * wall.h / wall.w);
    mm.width = mmW * 2; mm.height = h * 2; mm.style.width = mmW + "px"; mm.style.height = h + "px"; const x = mm.getContext("2d"); x.imageSmoothingQuality = "high"; x.drawImage(wallC, 0, 0, mm.width, mm.height);
  }
  function updateMinimap() {
    if (!mmWrap || !wallC) return; const show = view.k > fitK * 1.12; mmWrap.hidden = !show; if (!show) return;
    const sw = mmW / wall.w, k = view.k, x0 = Math.max(0, (view.x - W / (2 * k)) * sw), y0 = Math.max(0, (view.y - H / (2 * k)) * sw);
    const x1 = Math.min(mmW, (view.x + W / (2 * k)) * sw), y1 = Math.min(mmW * wall.h / wall.w, (view.y + H / (2 * k)) * sw);
    mmv.style.cssText = `left:${x0}px;top:${y0}px;width:${Math.max(3, x1 - x0)}px;height:${Math.max(3, y1 - y0)}px`;
  }
  let mmDrag = false;
  const mmGo = (e) => { const r = mm.getBoundingClientRect(); goal.x = clamp((e.clientX - r.left) / r.width * wall.w, 0, wall.w); goal.y = clamp((e.clientY - r.top) / r.height * wall.h, 0, wall.h); kick(); };
  mmWrap?.addEventListener("pointerdown", (e) => { mmDrag = true; mmWrap.setPointerCapture(e.pointerId); mmGo(e); e.stopPropagation(); });
  mmWrap?.addEventListener("pointermove", (e) => { if (mmDrag) mmGo(e); });
  mmWrap?.addEventListener("pointerup", () => { mmDrag = false; });

  // ---------- câmera ----------
  let W = 0, H = 0, dpr = 1, fitK = 1;
  const view = { x: 0, y: 0, k: 1 }, goal = { x: 0, y: 0, k: 1 };
  const K_MAX = COARSE ? 2.6 : 3.2, LOD_PX = 42;            // acima de LOD_PX px de altura por capa, usa as páginas grandes
  const margin = () => (W < 500 ? 16 : 40);
  function resize() {
    W = gridEl.clientWidth; H = gridEl.clientHeight; if (!W || !H) return; dpr = Math.min(2, devicePixelRatio || 1);
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    const before = fitK; fitK = Math.min((W - margin()) / wall.w, (H - margin()) / wall.h);
    if (selI < 0 && (!before || Math.abs(view.k - before) < 1e-6)) { goal.x = wall.w / 2; goal.y = wall.h / 2; goal.k = fitK; Object.assign(view, goal); }
    kick();
  }
  function clampGoal() { goal.k = clamp(goal.k, fitK * 0.7, K_MAX); goal.x = clamp(goal.x, 0, wall.w); goal.y = clamp(goal.y, 0, wall.h); }
  function zoomAt(px, py, factor) {
    const k0 = goal.k, wx = goal.x + (px - W / 2) / k0, wy = goal.y + (py - H / 2) / k0, k1 = clamp(k0 * factor, fitK * 0.7, K_MAX);
    goal.k = k1; goal.x = wx - (px - W / 2) / k1; goal.y = wy - (py - H / 2) / k1; clampGoal(); kick();
  }
  function fit() { goal.x = wall.w / 2; goal.y = wall.h / 2; goal.k = fitK; kick(); }
  function fitMatches() {
    if (!nMatch || nMatch === N) return fit();
    let c0 = 1e9, c1 = -1, r0 = 1e9, r1 = -1;
    for (let k = 0; k < N; k++) if (match[layoutOrder[k]]) { const c = k % wall.cols, r = (k / wall.cols) | 0; if (c < c0) c0 = c; if (c > c1) c1 = c; if (r < r0) r0 = r; if (r > r1) r1 = r; }
    const bw = (c1 - c0 + 1) * PW, bh = (r1 - r0 + 1) * PH;
    goal.k = clamp(Math.min((W - 60) / bw, (H - 60) / bh), fitK * 0.7, K_MAX); goal.x = (c0 + c1 + 1) * PW / 2; goal.y = (r0 + r1 + 1) * PH / 2; clampGoal(); kick();
  }
  let selI = -1, lift = 0, selImg = null;               // filme selecionado (índice), progresso 0→1 da animação, imagem nítida (200 px) da capa
  let raf = 0, last = 0;
  const kick = () => { if (!raf) raf = requestAnimationFrame(tick); };
  function tick(t) {
    raf = 0; const dt = Math.min(48, t - (last || t)); last = t; const a = 1 - Math.pow(0.0009, dt / 1000);   // suavização independente do fps
    const liftTarget = selI >= 0 ? 1 : 0, lifting = Math.abs(liftTarget - lift) > 0.004; if (lifting) lift += (liftTarget - lift) * (1 - Math.pow(0.0004, dt / 1000)); else lift = liftTarget;
    const moving = lifting || Math.abs(goal.x - view.x) * view.k > 0.2 || Math.abs(goal.y - view.y) * view.k > 0.2 || Math.abs(Math.log(goal.k / view.k)) > 0.002;
    if (moving) { view.x += (goal.x - view.x) * a; view.y += (goal.y - view.y) * a; view.k *= Math.pow(goal.k / view.k, a); } else Object.assign(view, goal);
    draw(); if (velocity.x || velocity.y) inertia(dt);
    if (moving || velocity.x || velocity.y) kick(); else last = 0;
  }

  // ---------- desenho ----------
  const wrapText = (t, maxW, maxLines) => { const words = t.split(" "), lines = []; let cur = "";
    for (const w of words) { const test = cur ? cur + " " + w : w; if (ctx.measureText(test).width > maxW && cur) { lines.push(cur); cur = w; if (lines.length === maxLines) return lines; } else cur = test; }
    if (cur && lines.length < maxLines) lines.push(cur); return lines; };
  let hoverK = -1; const FONT = getComputedStyle(document.body).fontFamily;

  function drawTile(i, x, y, w, h, alpha) {
    ctx.globalAlpha = alpha;
    if (C.f[i] & 1) {
      const e = page(Math.floor(i / D.per)), pos = i % D.per;
      if (e?.bmp) ctx.drawImage(e.bmp, (pos % PC) * D.tile[0], Math.floor(pos / PC) * D.tile[1], D.tile[0], D.tile[1], x, y, w, h);
      else if (miniBmp) ctx.drawImage(miniBmp, (i % D.mini.cols) * D.mini.tile[0], ((i / D.mini.cols) | 0) * D.mini.tile[1], D.mini.tile[0], D.mini.tile[1], x, y, w, h);   // enquanto a página carrega
      else { ctx.fillStyle = colors.line; ctx.fillRect(x, y, w, h); }
    } else { // sem capa: o título faz o papel da imagem
      const fs = Math.max(8, Math.round(w / 6.5)); ctx.font = `${fs}px ${FONT}`; ctx.textBaseline = "top";
      ctx.fillStyle = colors.panel; ctx.fillRect(x, y, w, h); ctx.strokeStyle = colors.line; ctx.strokeRect(x + .5, y + .5, w - 1, h - 1);
      ctx.fillStyle = colors.fg; wrapText(C.t[i], w - 8, Math.max(2, Math.floor(h / (fs + 2)) - 2)).forEach((ln, j) => ctx.fillText(ln, x + 4, y + 5 + j * (fs + 2)));
      ctx.fillStyle = colors.muted; if (C.y[i]) ctx.fillText(String(C.y[i]), x + 4, y + h - fs - 6);
    }
    ctx.fillStyle = colors[seedClass[i]]; ctx.fillRect(x, y + h - Math.max(2, h / 32), w, Math.max(2, h / 32));   // traço de saúde sob a capa
    ctx.globalAlpha = 1;
  }

  function draw() {
    if (!W || !wall) return; frame++;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = colors.bg; ctx.fillRect(0, 0, W, H);
    const k = view.k, wx0 = view.x - W / (2 * k), wx1 = view.x + W / (2 * k), wy0 = view.y - H / (2 * k), wy1 = view.y + H / (2 * k);
    // a "tela de cinema": retângulo da parede com moldura
    ctx.fillStyle = colors.panel; ctx.fillRect((0 - wx0) * k - 6, (0 - wy0) * k - 6, wall.w * k + 12, wall.h * k + 12);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
    if (PH * k < LOD_PX) { // de longe: a parede inteira já composta em miniatura (1 só drawImage, qualquer que seja o nº de capas)
      if (wallDirty) composeWall();
      if (wallC) {
        const cx0 = Math.max(0, wx0), cx1 = Math.min(wall.w, wx1), cy0 = Math.max(0, wy0), cy1 = Math.min(wall.h, wy1), s = D.mini.tile[0] / PW;
        if (cx1 > cx0 && cy1 > cy0) {
          ctx.drawImage(wallC, cx0 * s, cy0 * s, (cx1 - cx0) * s, (cy1 - cy0) * s, (cx0 - wx0) * k, (cy0 - wy0) * k, (cx1 - cx0) * k, (cy1 - cy0) * k);
          if (nMatch < N && maskC) { ctx.imageSmoothingEnabled = false; ctx.drawImage(maskC, cx0 / PW, cy0 / PH, (cx1 - cx0) / PW, (cy1 - cy0) / PH, (cx0 - wx0) * k, (cy0 - wy0) * k, (cx1 - cx0) * k, (cy1 - cy0) * k); ctx.imageSmoothingEnabled = true; }
        }
      }
    } else { // de perto: só as capas visíveis, nítidas, das páginas grandes
      const c0 = Math.max(0, Math.floor(wx0 / PW)), c1 = Math.min(wall.cols - 1, Math.floor(wx1 / PW)), r0 = Math.max(0, Math.floor(wy0 / PH)), r1 = Math.min(wall.rows - 1, Math.floor(wy1 / PH));
      const inset = Math.min(1.5, k * 1.2);
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
        const kk = r * wall.cols + c; if (kk >= N) break; const i = layoutOrder[kk];
        drawTile(i, (c * PW - wx0) * k + inset, (r * PH - wy0) * k + inset, PW * k - inset * 2, PH * k - inset * 2, match[i] ? 1 : 0.1);
      }
    }
    if (selI >= 0 && lift > 0.01) {
      const kk = posOf[selI], c = kk % wall.cols, r = (kk / wall.cols) | 0, e = lift * lift * (3 - 2 * lift);     // suavizado
      const baseW = PW * k, baseH = PH * k, grow = 1 + 0.5 * e, w = baseW * grow, h = baseH * grow, cx = (c * PW + PW / 2 - wx0) * k, cy = (r * PH + PH / 2 - wy0) * k - baseH * 0.08 * e;
      ctx.fillStyle = colors.bg; ctx.globalAlpha = 0.5 * e; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1;                 // o resto da parede recua
      ctx.save(); ctx.shadowColor = "rgba(0,0,0,.7)"; ctx.shadowBlur = 28 * e; ctx.shadowOffsetY = 14 * e;
      if (selImg?.complete && selImg.naturalWidth) ctx.drawImage(selImg, cx - w / 2, cy - h / 2, w, h); else drawTile(selI, cx - w / 2, cy - h / 2, w, h, 1);
      ctx.restore(); ctx.strokeStyle = colors.accent; ctx.lineWidth = 2; ctx.strokeRect(cx - w / 2, cy - h / 2, w, h);
    }
    if (hoverK >= 0 && hoverK < N && layoutOrder[hoverK] !== selI) { // realce: a capa "sai" da parede (sombra + leve ampliação) quando dá para ver; contorno quando está longe
      const i = layoutOrder[hoverK], c = hoverK % wall.cols, r = (hoverK / wall.cols) | 0, x = (c * PW - wx0) * k, y = (r * PH - wy0) * k, w = PW * k, h = PH * k;
      if (PH * k >= LOD_PX) { const g = Math.min(10, w * 0.12); ctx.save(); ctx.shadowColor = "rgba(0,0,0,.6)"; ctx.shadowBlur = 18; ctx.shadowOffsetY = 6; drawTile(i, x - g, y - g, w + 2 * g, h + 2 * g, 1); ctx.restore(); ctx.strokeStyle = colors.accent; ctx.lineWidth = 2; ctx.strokeRect(x - g, y - g, w + 2 * g, h + 2 * g); }
      else { ctx.strokeStyle = colors.accent; ctx.lineWidth = 2; ctx.strokeRect(x - 1, y - 1, Math.max(w, 5) + 2, Math.max(h, 8) + 2); }
    }
    const z = $("#zoomlab"); if (z) z.textContent = `${Math.round(view.k * 100)}%`; updateMinimap();
  }

  // ---------- filtros: máscara + contagens por faceta ----------
  const BIT = { c: 1, g: 2, d: 4, l: 8, u: 16, seed: 32, size: 64, flags: 128, year: 256, q: 512 };
  // colunas em arrays tipados (CSR para as listas) — percorrer 33 mil filmes sem alocar nada
  const FACETS = ["c", "g", "d", "l"];
  let csr = {}, uCol, fCol, yCol, zClass, seedIdx, nameLen = {};
  const SEEDI = { verde: 0, amarelo: 1, laranja: 2, vermelho: 3, sem: 4 };
  function classify() {
    seedClass = new Array(N); seedIdx = new Uint8Array(N);
    for (let i = 0; i < N; i++) { const s = C.s[i], k = s === null ? "sem" : s >= 5 ? "verde" : s >= 2 ? "amarelo" : s === 1 ? "laranja" : "vermelho"; seedClass[i] = k; seedIdx[i] = SEEDI[k]; }
    normText = C.t.map((t, i) => norm(t + " " + C.o[i] + " " + C.d[i].map((d) => D.dict.d[0][d]).join(" ")));
    for (const g of FACETS) {
      const off = new Int32Array(N + 1); let tot = 0; for (let i = 0; i < N; i++) { off[i] = tot; tot += C[g][i].length; } off[N] = tot;
      const val = new Int32Array(tot); let o = 0; for (let i = 0; i < N; i++) for (const x of C[g][i]) val[o++] = x;
      csr[g] = { off, val }; nameLen[g] = D.dict[g][0].length;
    }
    uCol = Int16Array.from(C.u); fCol = Uint8Array.from(C.f); yCol = Int16Array.from(C.y);
    zClass = new Int8Array(N); for (let i = 0; i < N; i++) zClass[i] = sizeClass(C.z[i]);
  }
  function sizeClass(z) { if (z === null) return -1; for (let i = 0; i < SIZES.length; i++) if (z >= SIZES[i][1] && z < SIZES[i][2]) return i; return -1; }

  let withSeedN = 0;
  function compute() {
    const sel = {}, nsel = {};
    for (const g of FACETS) { const m = new Uint8Array(nameLen[g]); for (const x of S.sel[g]) m[x] = 1; sel[g] = m; nsel[g] = S.sel[g].size; }
    const selU = new Uint8Array(D.dict.u[0].length + 1); for (const x of S.sel.u) selU[x] = 1; const nU = S.sel.u.size;
    const seedSel = new Uint8Array(5); for (const k of S.seed) seedSel[SEEDI[k]] = 1; const nSeed = S.seed.size;
    const sizeSel = new Uint8Array(SIZES.length); for (const k of S.size) sizeSel[k] = 1; const nSize = S.size.size;
    let flagMask = 0; for (const k of S.flags) flagMask |= FLAGS.find((x) => x[0] === k)[1];
    const y0 = S.y0, y1 = S.y1, yAny = y0 !== null || y1 !== null, qs = norm(S.q).split(/\s+/).filter(Boolean), allC = S.all;

    fail = fail && fail.length === N ? fail : new Uint16Array(N); match = match && match.length === N ? match : new Uint8Array(N); nMatch = 0;
    for (let i = 0; i < N; i++) {
      let f = 0;
      for (let gi = 0; gi < 4; gi++) {
        const g = FACETS[gi], ns = nsel[g]; if (!ns) continue; const { off, val } = csr[g], m = sel[g]; let hit = 0;
        for (let j = off[i], e = off[i + 1]; j < e; j++) if (m[val[j]]) hit++;
        if (g === "c" && allC ? hit < ns : hit === 0) f |= BIT[g];
      }
      if (nU && !selU[uCol[i]]) f |= BIT.u;
      if (nSeed && !seedSel[seedIdx[i]]) f |= BIT.seed;
      if (nSize && !(zClass[i] >= 0 && sizeSel[zClass[i]])) f |= BIT.size;
      if (flagMask && (fCol[i] & flagMask) !== flagMask) f |= BIT.flags;
      if (yAny && (!yCol[i] || (y0 !== null && yCol[i] < y0) || (y1 !== null && yCol[i] > y1))) f |= BIT.year;
      if (qs.length) { const t = normText[i]; for (let k = 0; k < qs.length; k++) if (!t.includes(qs[k])) { f |= BIT.q; break; } }
      fail[i] = f; if (f === 0) { match[i] = 1; nMatch++; } else match[i] = 0;
    }
    // contagens "disjuntivas" de cada faceta = filmes que passam em TODOS os outros filtros. Um filme só entra nas contagens se f === 0 (conta em todas)
    // ou se f é UM único bit (conta só na faceta daquele filtro): com filtros ativos, a imensa maioria sai no primeiro teste.
    counts = counts.c ? counts : { c: new Uint32Array(nameLen.c), g: new Uint32Array(nameLen.g), d: new Uint32Array(nameLen.d), l: new Uint32Array(nameLen.l), u: new Uint32Array(D.dict.u[0].length), seed: [0, 0, 0, 0, 0], size: [0, 0, 0, 0], flags: {}, years: new Map() };
    for (const g of [...FACETS, "u"]) counts[g].fill(0); counts.seed.fill(0); counts.size.fill(0); counts.years.clear(); for (const [k] of FLAGS) counts.flags[k] = 0;
    withSeedN = 0;
    const ONLY = { [BIT.c]: "c", [BIT.g]: "g", [BIT.d]: "d", [BIT.l]: "l", [BIT.u]: "u", [BIT.seed]: "seed", [BIT.size]: "size", [BIT.flags]: "flags", [BIT.year]: "year" };
    for (let i = 0; i < N; i++) {
      const f = fail[i]; if (f !== 0 && (f & (f - 1)) !== 0) continue;
      const only = f === 0 ? null : ONLY[f];
      if (f === 0 && (C.s[i] ?? 0) >= 1) withSeedN++;
      for (let gi = 0; gi < 4; gi++) { const g = FACETS[gi]; if (only && only !== g) continue; const { off, val } = csr[g], cg = counts[g]; for (let j = off[i], e = off[i + 1]; j < e; j++) cg[val[j]]++; }
      if ((!only || only === "u") && uCol[i] >= 0) counts.u[uCol[i]]++;
      if (!only || only === "seed") counts.seed[seedIdx[i]]++;
      if ((!only || only === "size") && zClass[i] >= 0) counts.size[zClass[i]]++;
      if (!only || only === "flags") { const fc = fCol[i]; for (let q = 0; q < FLAGS.length; q++) if (fc & FLAGS[q][1]) counts.flags[FLAGS[q][0]]++; }
      if ((!only || only === "year") && yCol[i]) { const dec = Math.floor(yCol[i] / 10) * 10; counts.years.set(dec, (counts.years.get(dec) ?? 0) + 1); }
    }
  }

  // ---------- painel de filtros ----------
  const filtersEl = $("#filters");
  const short = (n) => (n >= 10000 ? Math.round(n / 1000) + " mil" : fmt(n));
  function opt(label, n, on, attrs) { return `<button class="opt${n === 0 && !on ? " zero" : ""}" type="button" aria-pressed="${on}" ${attrs}><span class="box"></span><span class="n">${esc(label)}</span><span class="c">${fmt(n)}</span></button>`; }
  function facet(g) {
    if (!D.dict[g][0].length) return "";                                   // versão pública: sem dados desta faceta (ex.: quem postou)
    const names = D.dict[g][0], cnt = counts[g], sel = S.sel[g], q = norm(S.search[g]), more = S.more[g];
    let ids = []; for (let i = 0; i < names.length; i++) { if (q && !norm(names[i]).includes(q)) continue; if (cnt[i] > 0 || sel.has(i)) ids.push(i); }
    ids.sort((a, b) => (sel.has(b) - sel.has(a)) || cnt[b] - cnt[a]);
    const limit = more ? 80 : (g === "d" || g === "u" ? (q ? 30 : 10) : 12), total = ids.length; ids = ids.slice(0, limit);
    const mode = g === "c" ? `<span class="mode">combinar: <button type="button" data-all="0" ${S.all ? "" : 'style="color:var(--fg)"'}>qualquer</button>·<button type="button" data-all="1" ${S.all ? 'style="color:var(--fg)"' : ""}>todos</button></span>` : "";
    return `<section class="sec" data-g="${g}"><h2>${GROUPS[g]}<span>${mode}</span></h2>
      <input type="search" placeholder="Filtrar ${GROUPS[g].toLowerCase()}" value="${esc(S.search[g])}" data-search="${g}" aria-label="Filtrar ${GROUPS[g]}">
      <div class="opts">${ids.map((i) => opt(names[i], cnt[i], sel.has(i), `data-g="${g}" data-i="${i}"`)).join("")}${total > limit ? `<button class="opt" type="button" data-more="${g}"><span></span><span class="n">ver mais (${fmt(total - limit)})</span><span></span></button>` : ""}</div></section>`;
  }
  function renderFilters() {
    const keepScroll = filtersEl.parentElement.scrollTop, focus = document.activeElement?.dataset?.search;
    // seeders: as cinco cores numa linha só (nome curto + contagem; a descrição completa fica no title)
    const seed = `<section class="sec"><h2>Seeders</h2><div class="seedrow">${SEED.map((k) => `<button class="seedbtn" type="button" data-seed="${k}" aria-pressed="${S.seed.has(k)}" title="${SEEDLAB[k]} · ${fmt(counts.seed[SEEDI[k]])} filmes" aria-label="${SEEDLAB[k]}: ${fmt(counts.seed[SEEDI[k]])} filmes"><i style="background:${colors[k]}"></i><span>${SEEDNAME[k]}</span><small>${short(counts.seed[SEEDI[k]])}</small></button>`).join("")}</div></section>`;
    const decs = []; for (let d = Math.floor(D._ymin / 10) * 10; d <= Math.floor(D._ymax / 10) * 10; d += 10) decs.push(d);
    const mx = Math.max(1, ...decs.map((d) => counts.years.get(d) ?? 0));
    const year = `<section class="sec"><h2>Ano</h2><div class="hist">${decs.map((d) => `<button type="button" data-dec="${d}" title="${d}s · ${fmt(counts.years.get(d) ?? 0)} filmes" aria-label="Década de ${d}" aria-pressed="${S.y0 === d && S.y1 === d + 9}" style="height:${Math.max(4, Math.round(54 * (counts.years.get(d) ?? 0) / mx))}px"></button>`).join("")}</div>
      <div class="histlab"><span>${decs[0]}</span><span>${decs[decs.length - 1]}</span></div>
      <div class="yearrow"><input type="number" inputmode="numeric" id="y0" placeholder="de" value="${S.y0 ?? ""}" min="1880" max="2030" aria-label="Ano inicial"><input type="number" inputmode="numeric" id="y1" placeholder="até" value="${S.y1 ?? ""}" min="1880" max="2030" aria-label="Ano final"></div></section>`;
    const size = `<section class="sec"><h2>Tamanho do arquivo</h2><div class="opts">${SIZES.map(([l], i) => opt(l, counts.size[i], S.size.has(i), `data-size="${i}"`)).join("")}</div></section>`;
    const flags = `<section class="sec"><h2>Outros</h2><div class="opts">${FLAGS.map(([k, , l]) => opt(l, counts.flags[k], S.flags.has(k), `data-flag="${k}"`)).join("")}</div></section>`;
    filtersEl.innerHTML = facet("c") + seed + facet("d") + facet("g") + year + facet("l") + size + flags + facet("u");
    filtersEl.parentElement.scrollTop = keepScroll;
    if (focus) { const el = filtersEl.querySelector(`[data-search="${focus}"]`); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }
  }
  function renderActive() {
    const chips = [];
    for (const g of Object.keys(GROUPS)) for (const i of S.sel[g]) chips.push([`${GROUPS[g]}: ${D.dict[g][0][i]}`, () => { S.sel[g].delete(i); }]);
    for (const k of S.seed) chips.push([`Seeders: ${SEEDNAME[k]}`, () => S.seed.delete(k)]);
    for (const i of S.size) chips.push([`Tamanho: ${SIZES[i][0]}`, () => S.size.delete(i)]);
    for (const k of S.flags) chips.push([FLAGS.find((f) => f[0] === k)[2], () => S.flags.delete(k)]);
    if (S.y0 !== null || S.y1 !== null) chips.push([`Ano: ${S.y0 ?? "…"}–${S.y1 ?? "…"}`, () => { S.y0 = S.y1 = null; }]);
    if (S.q) chips.push([`Busca: ${S.q}`, () => { S.q = ""; $("#q").value = ""; }]);
    const el = $("#active"); $("#activesec").hidden = !chips.length; $("#nfilters").textContent = chips.length ? `(${chips.length})` : "";
    el.innerHTML = chips.map((_, i) => `<span class="chip">${esc(chips[i][0])}<button type="button" data-x="${i}" aria-label="Remover filtro">×</button></span>`).join("") + (chips.length ? `<button class="ghost" type="button" id="clear-all">Limpar tudo</button>` : "");
    el._chips = chips; $("#fit-matches").hidden = !chips.length;
  }
  function renderCount() {
    $("#count").innerHTML = `<b>${fmt(nMatch)}</b> de ${fmt(N)} filmes${nMatch ? `<span class="hide-narrow"> · ${Math.round((100 * withSeedN) / nMatch)}% com seeders</span>` : ""}`;
    $("#empty").hidden = nMatch > 0;
  }

  // ---------- detalhes ----------
  const detailEl = $("#detail"); let detailId = -1;
  const EXT = (i) => D.exts[C.cx[i]] || "webp";
  const detailShift = () => (matchMedia("(max-width: 860px)").matches ? 0 : 160);   // metade da largura do cartão (320 px)
  function focusFilm(i) { const kk = posOf[i]; goal.k = clamp(Math.max(goal.k, 150 / PH), fitK * 0.7, K_MAX); goal.x = (kk % wall.cols) * PW + PW / 2 - detailShift() / goal.k; goal.y = ((kk / wall.cols) | 0) * PH + PH / 2; velocity.x = velocity.y = 0; }
  /** capa do cartão quando não há arquivo grande (site público): a miniatura do atlas ampliada; refina quando a página de sprites carrega */
  function coverFromAtlas(i) {
    const cn = document.createElement("canvas"); cn.className = "cover"; cn.width = 200; cn.height = 300; cn.setAttribute("role", "img"); cn.setAttribute("aria-label", `Capa de ${C.t[i]}`);
    const paint = () => {
      const x = cn.getContext("2d"); x.imageSmoothingQuality = "high"; const p = Math.floor(i / D.per), pos = i % D.per, e = pages.get(p);
      if (e?.bmp) x.drawImage(e.bmp, (pos % PC) * D.tile[0], Math.floor(pos / PC) * D.tile[1], D.tile[0], D.tile[1], 0, 0, 200, 300);
      else if (miniBmp) x.drawImage(miniBmp, (i % D.mini.cols) * D.mini.tile[0], ((i / D.mini.cols) | 0) * D.mini.tile[1], D.mini.tile[0], D.mini.tile[1], 0, 0, 200, 300);
    };
    paint(); page(Math.floor(i / D.per)); let tries = 0; const t = setInterval(() => { paint(); if (pages.get(Math.floor(i / D.per))?.bmp || ++tries > 20 || detailId !== i) clearInterval(t); }, 400);
    return cn;
  }
  function selectFilm(i) {
    selI = i; selImg = null;
    if (C.f[i] & 1) { const im = new Image(); im.src = `files/capas/${C.id[i]}.${EXT(i)}`; im.onload = kick; selImg = im; }
    focusFilm(i);
    showDetail(i); saveHash(); kick();
  }
  function closeDetail() { selI = -1; detailId = -1; detailEl.hidden = true; document.body.classList.remove("has-detail"); saveHash(); kick(); }
  async function showDetail(i) {
    detailId = i; const sc = seedClass[i], lc = C.lc[i];
    const tags = (g) => C[g][i].map((x) => `<button class="tag" type="button" data-g="${g}" data-i="${x}">${esc(D.dict[g][0][x])}</button>`).join("") || "—";
    document.body.classList.add("has-detail"); detailEl.hidden = false; detailEl.scrollTop = 0;
    detailEl.innerHTML = `<button class="ghost x" type="button" id="close-detail" aria-label="Fechar">Fechar ×</button>
      <div class="head">${C.f[i] & 1 ? `<img class="cover" src="files/capas/${C.id[i]}.${EXT(i)}" alt="Capa de ${esc(C.t[i])}">` : ""}
        <div class="titles"><h3>${esc(C.t[i])}</h3>${C.o[i] ? `<p class="orig">${esc(C.o[i])}</p>` : ""}</div></div>
      <dl><dt>Ano</dt><dd>${C.y[i] || "—"}</dd><dt>Países</dt><dd>${tags("c")}</dd><dt>Direção</dt><dd>${tags("d")}</dd><dt>Gêneros</dt><dd>${tags("g")}</dd><dt>Idiomas</dt><dd>${tags("l")}</dd>
      <dt>Seeders</dt><dd><span class="health"><i style="background:${colors[sc]}"></i>${C.s[i] === null ? "sem dados" : `${C.s[i]} seeders${lc !== null ? ` · ${lc} leechers` : ""}`}</span></dd>
      <dt>Arquivo</dt><dd>${C.z[i] ? (C.z[i] >= 1024 ? (C.z[i] / 1024).toFixed(1) + " GB" : C.z[i] + " MB") : "—"}${C.n[i] > 1 ? ` · ${C.n[i]} arquivos` : ""}</dd>
      <dt>Postado por</dt><dd>${C.u[i] >= 0 ? `<button class="tag" type="button" data-g="u" data-i="${C.u[i]}">${esc(D.dict.u[0][C.u[i]])}</button>` : "—"}</dd></dl>
      <div class="links" id="dl-links"><a href="https://www.makingoff.org/topicos/${C.id[i]}/" target="_blank" rel="noopener">Tópico no fórum</a>${C.im[i] ? `<a href="https://www.imdb.com/title/${C.im[i]}/" target="_blank" rel="noopener">IMDb</a>` : ""}</div>
      <ul class="files" id="dl-files"></ul>`;
    const im = detailEl.querySelector("img.cover");
    if (im) { const fb = () => { if (detailId === i) im.replaceWith(coverFromAtlas(i)); }; im.addEventListener("error", fb, { once: true }); if (im.complete && !im.naturalWidth) fb(); }
    try { // magnet e anexos vêm do servidor sob demanda (não vão no atlas-data.json)
      const r = await fetch(`api/filme/${C.id[i]}`); if (!r.ok || detailId !== i) return; const d = await r.json(); if (detailId !== i) return;
      if (d.magnet_link) $("#dl-links").insertAdjacentHTML("afterbegin", `<a class="magnet" href="${esc(d.magnet_link)}">Magnet</a>`);
      $("#dl-files").innerHTML = (d.attachments || []).filter((a) => a.kind !== "torrent").slice(0, 12).map((a) => `<li><a href="${esc(a.url)}">${esc(a.filename)}</a> <span style="color:var(--muted)">${a.kind}</span></li>`).join("");
    } catch { /* atlas aberto como arquivo estático: sem magnet */ }
  }
  const openSheet = () => { document.body.classList.add("show-filters"); if (panelDirty) renderPanel(); }, closeSheet = () => document.body.classList.remove("show-filters");

  // ---------- interação: arrastar, zoom (roda/pinça), toque duplo, teclado ----------
  const pointers = new Map(); let drag = null, lastTap = { t: 0, x: 0, y: 0 }; const velocity = { x: 0, y: 0 };
  const rel = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const spread = () => { const p = [...pointers.values()]; return Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]) || 1; };
  function pick(px, py, slop = 0) {
    const wx = view.x + (px - W / 2) / view.k, wy = view.y + (py - H / 2) / view.k; if (wx < 0 || wy < 0) return -1;
    const c = Math.floor(wx / PW), r = Math.floor(wy / PH); if (c >= wall.cols || r >= wall.rows) return -1; const kk = r * wall.cols + c;
    return kk < N && match[layoutOrder[kk]] ? kk : -1;       // só as capas que casam com os filtros respondem
  }
  function inertia(dt) { goal.x -= velocity.x * dt / goal.k * 0.06; goal.y -= velocity.y * dt / goal.k * 0.06; clampGoal(); velocity.x *= 0.9; velocity.y *= 0.9; if (Math.abs(velocity.x) < 0.02) velocity.x = 0; if (Math.abs(velocity.y) < 0.02) velocity.y = 0; }

  cv.addEventListener("wheel", (e) => { e.preventDefault(); const [px, py] = rel(e); velocity.x = velocity.y = 0; zoomAt(px, py, Math.exp(-e.deltaY * (e.ctrlKey ? 0.012 : (e.deltaMode ? 0.05 : 0.0016)))); }, { passive: false });
  cv.addEventListener("pointerdown", (e) => {
    cv.setPointerCapture(e.pointerId); pointers.set(e.pointerId, rel(e)); velocity.x = velocity.y = 0;
    drag = { moved: 0, id: e.pointerId, spread: pointers.size > 1 ? spread() : 0, k0: goal.k, type: e.pointerType, multi: pointers.size > 1 }; if (pointers.size > 1) drag.multi = true; tip.hidden = true;
  });
  cv.addEventListener("pointermove", (e) => {
    const [px, py] = rel(e);
    if (pointers.has(e.pointerId)) {
      const prev = pointers.get(e.pointerId), dx = px - prev[0], dy = py - prev[1]; pointers.set(e.pointerId, [px, py]);
      if (drag) drag.moved += Math.abs(dx) + Math.abs(dy);
      if (pointers.size === 1) { goal.x -= dx / goal.k; goal.y -= dy / goal.k; view.x = goal.x; view.y = goal.y; velocity.x = dx; velocity.y = dy; clampGoal(); kick(); cv.style.cursor = "grabbing"; }
      else if (pointers.size === 2 && drag) { if (!drag.spread) { drag.spread = spread(); drag.k0 = goal.k; } drag.multi = true; const s = spread(), p = [...pointers.values()], mx = (p[0][0] + p[1][0]) / 2, my = (p[0][1] + p[1][1]) / 2; zoomAt(mx, my, (drag.k0 * s / drag.spread) / goal.k); }
      return;
    }
    if (e.pointerType === "touch") return;
    const k = pick(px, py); if (k !== hoverK) { hoverK = k; kick(); }
    cv.style.cursor = k >= 0 ? "pointer" : "grab";
    if (k < 0) { tip.hidden = true; return; } const i = layoutOrder[k];
    tip.innerHTML = `<b>${esc(C.t[i])}</b><span class="m">${C.y[i] || "s/ano"} · ${C.c[i].slice(0, 3).map((x) => esc(D.dict.c[0][x])).join(" × ") || "—"}</span><br><span class="m">${C.s[i] === null ? "sem dados de seeders" : C.s[i] + " seeders"}</span>`;
    tip.hidden = false; let tx = px + 16, ty = py + 16; if (tx + 290 > W) tx = px - 296; tip.style.left = tx + "px"; tip.style.top = ty + "px";
  });
  const up = (e) => {
    const [px, py] = rel(e), wasTap = drag && drag.id === e.pointerId && drag.moved < 8 && !drag.multi; pointers.delete(e.pointerId); cv.style.cursor = "grab";
    if (wasTap) {
      const now = performance.now();
      if (e.pointerType === "touch" && now - lastTap.t < 320 && Math.hypot(px - lastTap.x, py - lastTap.y) < 28) { // toque duplo: aproxima (ou volta a enquadrar)
        lastTap.t = 0; velocity.x = velocity.y = 0; if (goal.k > K_MAX * 0.8) fit(); else zoomAt(px, py, 2.6);
      } else {
        lastTap = { t: now, x: px, y: py };
        const k = pick(px, py); if (k >= 0) { if (e.pointerType === "touch") { hoverK = k; kick(); } selectFilm(layoutOrder[k]); } else if (selI >= 0 && e.pointerType !== "touch") closeDetail();
      }
    }
    if (pointers.size < 2 && drag) drag.spread = 0; if (!pointers.size) drag = null; kick();
  };
  cv.addEventListener("pointerup", up); cv.addEventListener("pointercancel", (e) => { pointers.delete(e.pointerId); if (!pointers.size) drag = null; });
  cv.addEventListener("pointerleave", (e) => { if (!pointers.size && e.pointerType !== "touch") { hoverK = -1; tip.hidden = true; kick(); } });
  cv.addEventListener("dblclick", (e) => { if (e.pointerType === "touch" || e.sourceCapabilities?.firesTouchEvents) return; const [px, py] = rel(e); velocity.x = velocity.y = 0; if (goal.k > K_MAX * 0.8) fit(); else zoomAt(px, py, 2.6); });
  cv.tabIndex = 0;
  cv.addEventListener("keydown", (e) => {
    const step = 90 / goal.k; velocity.x = velocity.y = 0;
    if (e.key === "+" || e.key === "=") zoomAt(W / 2, H / 2, 1.4); else if (e.key === "-" || e.key === "_") zoomAt(W / 2, H / 2, 1 / 1.4);
    else if (e.key === "0" || e.key === "f") fit(); else if (e.key === "ArrowLeft") { goal.x -= step; clampGoal(); kick(); } else if (e.key === "ArrowRight") { goal.x += step; clampGoal(); kick(); }
    else if (e.key === "ArrowUp") { goal.y -= step; clampGoal(); kick(); } else if (e.key === "ArrowDown") { goal.y += step; clampGoal(); kick(); } else return;
    e.preventDefault();
  });
  $("#z-in").addEventListener("click", () => zoomAt(W / 2, H / 2, 1.6)); $("#z-out").addEventListener("click", () => zoomAt(W / 2, H / 2, 1 / 1.6));
  $("#z-fit").addEventListener("click", fit); $("#fit-matches").addEventListener("click", () => { fitMatches(); closeSheet(); });
  new ResizeObserver(() => resize()).observe(gridEl);

  // ---------- atualização ----------
  let panelDirty = false, refreshJob = 0;
  const panelVisible = () => !matchMedia("(max-width: 860px)").matches || document.body.classList.contains("show-filters");
  function renderPanel() { panelDirty = false; renderActive(); renderFilters(); }
  const refresh = () => {
    compute(); updateMask(); renderCount(); kick();                         // 1) o que o usuário vê: parede e contagem, no mesmo quadro
    cancelAnimationFrame(refreshJob);
    refreshJob = requestAnimationFrame(() => { if (panelVisible()) renderPanel(); else { panelDirty = true; renderActive(); } saveHash(); });   // 2) painel logo depois (no celular, só se aberto)
  };
  const relayout = () => { computeWall(); resize(); fit(); if (selI >= 0) focusFilm(selI); wallDirty = true; composeWall(); updateMask(); kick(); };
  const toggle = (set, v) => (set.has(v) ? set.delete(v) : set.add(v));

  filtersEl.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.g && b.dataset.i !== undefined) toggle(S.sel[b.dataset.g], +b.dataset.i);
    else if (b.dataset.seed) toggle(S.seed, b.dataset.seed);
    else if (b.dataset.size !== undefined) toggle(S.size, +b.dataset.size);
    else if (b.dataset.flag) toggle(S.flags, b.dataset.flag);
    else if (b.dataset.dec) { const d = +b.dataset.dec; if (S.y0 === d && S.y1 === d + 9) S.y0 = S.y1 = null; else { S.y0 = d; S.y1 = d + 9; } }
    else if (b.dataset.more) S.more[b.dataset.more] = true;
    else if (b.dataset.all !== undefined) S.all = b.dataset.all === "1";
    else return;
    refresh();
  });
  detailEl.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.id === "close-detail") { closeDetail(); return; }
    if (b.dataset.g) { S.sel[b.dataset.g].add(+b.dataset.i); refresh(); }
  });
  filtersEl.addEventListener("input", (e) => {
    const t = e.target;
    if (t.dataset.search) { S.search[t.dataset.search] = t.value; renderFilters(); return; }
    if (t.id === "y0" || t.id === "y1") { clearTimeout(t._t); t._t = setTimeout(() => { S.y0 = $("#y0").value ? +$("#y0").value : null; S.y1 = $("#y1").value ? +$("#y1").value : null; refresh(); }, 150); }
  });
  $("#active").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; if (b.id === "clear-all") return clearAll(); if (b.dataset.x !== undefined) { $("#active")._chips[+b.dataset.x][1](); refresh(); } });
  function clearAll() { for (const g in S.sel) S.sel[g].clear(); S.seed.clear(); S.size.clear(); S.flags.clear(); S.y0 = S.y1 = null; S.q = ""; $("#q").value = ""; S.all = false; refresh(); }
  $("#clear-empty").addEventListener("click", clearAll);
  let qt; $("#q").addEventListener("input", (e) => { clearTimeout(qt); qt = setTimeout(() => { S.q = e.target.value.trim(); refresh(); }, 60); });
  $("#sort").addEventListener("change", (e) => { S.sort = e.target.value; saveHash(); relayout(); });
  $("#aspect").addEventListener("change", (e) => { S.aspect = e.target.value; saveHash(); relayout(); });
  $("#toggle-filters").addEventListener("click", () => { document.body.classList.toggle("show-filters"); if (panelDirty && document.body.classList.contains("show-filters")) renderPanel(); });
  $("#backdrop").addEventListener("click", closeSheet); $("#close-sheet").addEventListener("click", closeSheet);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeSheet(); closeDetail(); } });

  // estado na URL (#c=França,Itália&seed=verde&q=...) para compartilhar uma visão
  function saveHash() {
    const p = new URLSearchParams();
    for (const g of Object.keys(GROUPS)) if (S.sel[g].size) p.set(g, [...S.sel[g]].map((i) => D.dict[g][0][i]).join("|"));
    if (S.all) p.set("all", "1"); if (S.seed.size) p.set("seed", [...S.seed].join(",")); if (S.size.size) p.set("size", [...S.size].join(",")); if (S.flags.size) p.set("flags", [...S.flags].join(","));
    if (S.y0 !== null) p.set("y0", S.y0); if (S.y1 !== null) p.set("y1", S.y1); if (S.q) p.set("q", S.q); if (S.sort !== "year_desc") p.set("sort", S.sort); if (S.aspect !== "cinema") p.set("fmt", S.aspect); if (selI >= 0) p.set("film", C.id[selI]);
    history.replaceState(null, "", p.toString() ? "#" + p : location.pathname + location.search);
  }
  function loadHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    for (const g of Object.keys(GROUPS)) for (const n of (p.get(g) || "").split("|").filter(Boolean)) { const i = D.dict[g][0].indexOf(n); if (i >= 0) S.sel[g].add(i); }
    S.all = p.get("all") === "1"; for (const k of (p.get("seed") || "").split(",").filter(Boolean)) if (SEED.includes(k)) S.seed.add(k);
    for (const k of (p.get("size") || "").split(",").filter(Boolean)) S.size.add(+k); for (const k of (p.get("flags") || "").split(",").filter(Boolean)) if (FLAGS.some((f) => f[0] === k)) S.flags.add(k);
    S.y0 = p.get("y0") ? +p.get("y0") : null; S.y1 = p.get("y1") ? +p.get("y1") : null; S.q = p.get("q") || ""; $("#q").value = S.q;
    S.pendingFilm = p.get("film") ? +p.get("film") : null; S.sort = p.get("sort") || "year_desc"; $("#sort").value = S.sort; S.aspect = ASPECTS[p.get("fmt")] ? p.get("fmt") : "cinema"; $("#aspect").value = S.aspect;
  }

  // ---------- início ----------
  (async () => {
    readColors(); matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => { readColors(); wallDirty = true; kick(); });
    new MutationObserver(() => { readColors(); wallDirty = true; kick(); }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    D = await (await fetch(`atlas-data.json?v=${V}`)).json(); C = D.cols; N = C.id.length; PC = D.gridCols || D.page / D.tile[0];
    const ys = C.y.filter(Boolean); D._ymin = Math.min(...ys); D._ymax = Math.max(...ys);
    classify(); loadHash(); compute(); computeWall(); $("#loading").hidden = true; resize(); fit(); renderActive(); renderFilters(); renderCount(); kick();
    if (S.pendingFilm) { const i = C.id.indexOf(S.pendingFilm); if (i >= 0) selectFilm(i); }
    fetch(`mini.webp?v=${D.generated}`).then((r) => r.blob()).then((b) => createImageBitmap(b)).then((bmp) => { miniBmp = bmp; wallDirty = true; composeWall(); kick(); }).catch(() => {});
    if (document.fonts?.ready) document.fonts.ready.then(kick);
  })().catch((e) => { $("#loading").textContent = "Não foi possível carregar o atlas: " + e.message; });
})();
