/*
 * chain_motion.js — animated walkthrough of one real rolling-GRAT chain.
 * Drives an SVG timeline from an actual simulateChain() run on the real
 * snapshot (seed 2017-01-01, $5M): one seed's derivation paths fanning out
 * into vaults, annuities spawning child GRATs, remainders flowing to the
 * children's trust. Play / pause / scrub; respects prefers-reduced-motion.
 */
"use strict";
(function () {
  const G = window.GRAT, D = window.NH_DATA;
  const host = document.getElementById("motion-chart");
  if (!G || !D || !host) return;
  const $ = id => document.getElementById(id);
  const MS_DAY = G.MS_DAY;

  /* ----------------------------------------------------- chain to show -- */
  const pairs = D.series.price;
  const prices = { t: pairs.map(p => p[0]), v: pairs.map(p => p[1]) };
  const SEED_MS = Date.UTC(2017, 0, 1), FUND = 5e6;
  const res = G.simulateChain(prices, SEED_MS, FUND, {});
  const grats = [...res.grats].sort((a, b) => a.fundMs - b.fundMs || a.id - b.id);
  const byId = new Map(grats.map(g => [g.id, g]));

  /* ------------------------------------------------------------ layout -- */
  const T0 = SEED_MS - 120 * MS_DAY;
  const T1 = res.horizonMs + 60 * MS_DAY;
  const W = 980, LX = 120, RX = 150, TOPY = 46;
  const x = ms => LX + (ms - T0) / (T1 - T0) * (W - LX - RX);

  // lane packing per generation (greedy interval coloring)
  const gens = [...new Set(grats.map(g => g.generation))].sort((a, b) => a - b);
  const LANE_H = 17, GEN_GAP = 14;
  let yCursor = TOPY;
  const genTop = {}, laneOf = new Map();
  for (const gen of gens) {
    genTop[gen] = yCursor;
    const lanes = [];   // lane -> last end ms
    for (const g of grats.filter(q => q.generation === gen)) {
      let L = lanes.findIndex(end => g.fundMs > end + 20 * MS_DAY);
      if (L === -1) { L = lanes.length; lanes.push(0); }
      lanes[L] = g.endMs ?? res.horizonMs;
      laneOf.set(g.id, L);
    }
    yCursor += lanes.length * LANE_H + GEN_GAP;
  }
  const H = yCursor + 36;
  const y = g => genTop[g.generation] + laneOf.get(g.id) * LANE_H + LANE_H / 2;

  const SC = { completed: "var(--green)", failed: "var(--red)",
               active_at_horizon: "var(--gray)" };
  const fmtD = ms => new Date(ms).toISOString().slice(0, 10);
  const usd = v => v >= 1e6 ? "$" + (v / 1e6).toFixed(2) + "M"
                 : "$" + Math.round(v / 1e3) + "K";

  /* ----------------------------------------------------- static layers -- */
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Animated rolling GRAT chain, 2017 to 2026");
  host.appendChild(svg);
  const layer = () => svg.appendChild(document.createElementNS(NS, "g"));
  const elFor = new Map();   // id -> {bar, label, edge, pathLbl}
  const mk = (tag, attrs, parent) => {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    (parent || svg).appendChild(e);
    return e;
  };
  const txt = (s, attrs, parent) => { const e = mk("text", attrs, parent); e.textContent = s; return e; };

  const base = layer();
  // year gridlines
  for (let yr = 2017; yr <= 2026; yr++) {
    const ms = Date.UTC(yr, 0, 1);
    mk("line", { x1: x(ms), x2: x(ms), y1: TOPY - 14, y2: H - 26,
                 stroke: "var(--line)", "stroke-width": 0.5, opacity: 0.55 }, base);
    txt(String(yr), { x: x(ms), y: H - 10, fill: "var(--muted)", "font-size": 10,
                      "text-anchor": "middle", "font-family": "var(--mono)" }, base);
  }
  // generation labels
  for (const gen of gens) {
    txt(gen === 0 ? "seed" : "gen " + gen,
        { x: LX - 56, y: genTop[gen] + 11, fill: "var(--muted)", "font-size": 9.5,
          "font-family": "var(--mono)" }, base);
  }
  // the one seed (left)
  mk("rect", { x: 8, y: TOPY - 6, width: 96, height: 44, rx: 8,
               fill: "var(--panel-2)", stroke: "var(--accent)", "stroke-width": 1.2 }, base);
  txt("ONE SEED", { x: 56, y: TOPY + 11, fill: "var(--text)", "font-size": 10,
                    "text-anchor": "middle", "font-weight": 600 }, base);
  txt("3 devices · 2-of-3", { x: 56, y: TOPY + 26, fill: "var(--muted)",
                              "font-size": 8.5, "text-anchor": "middle" }, base);
  // children's trust (right)
  mk("rect", { x: W - 132, y: TOPY - 6, width: 124, height: 56, rx: 8,
               fill: "var(--panel-2)", stroke: "var(--green)", "stroke-width": 1.2 }, base);
  txt("CHILDREN'S TRUST", { x: W - 70, y: TOPY + 10, fill: "var(--green)",
                            "font-size": 9, "text-anchor": "middle", "font-weight": 600 }, base);
  const trustTotal = txt("$0", { x: W - 70, y: TOPY + 30, fill: "var(--text)",
                                 "font-size": 13, "text-anchor": "middle",
                                 "font-family": "var(--mono)", "font-weight": 600 }, base);
  const trustN = txt("0 remainders", { x: W - 70, y: TOPY + 43, fill: "var(--muted)",
                                       "font-size": 8.5, "text-anchor": "middle" }, base);

  const edges = layer(), bars = layer(), dots = layer(), labels = layer();

  // per-GRAT elements (hidden until funded)
  for (const g of grats) {
    const gx = x(g.fundMs), gy = y(g), gx2 = x(g.endMs ?? res.horizonMs);
    let grp = mk("g", { opacity: 0 }, bars);
    const title = document.createElementNS(NS, "title");
    title.textContent = `GRAT №${g.id} · path m/48'/0'/${g.id - 1}'\n` +
      `funded ${fmtD(g.fundMs)} · ${usd(g.fundValueUsd)} at §7520 ${g.ratePct}%\n` +
      `annuity ${usd(g.firstYearAnnuityUsd)}/yr · ` +
      (g.status === "completed" ? `remainder ${usd(g.remainderUsd)} → children's trust`
       : g.status === "failed" ? "exhausted — corpus re-seeds the chain"
       : "still in term at end of data");
    grp.appendChild(title);
    mk("line", { x1: gx, x2: gx2, y1: gy, y2: gy, stroke: "var(--accent)",
                 "stroke-width": 5, "stroke-linecap": "round", opacity: 0.9 }, grp);
    mk("circle", { cx: gx, cy: gy, r: 3.4, fill: "var(--accent)" }, grp);
    const lbl = txt(`№${g.id}`, { x: gx + 4, y: gy - 5, fill: "var(--muted)",
                                  "font-size": 8, "font-family": "var(--mono)" }, grp);
    // derivation flash (shown briefly at funding)
    const pl = txt(`m/48'/0'/${g.id - 1}'`,
                   { x: gx + 4, y: gy - 15, fill: "var(--accent)", "font-size": 8.5,
                     "font-family": "var(--mono)", opacity: 0 }, labels);
    // edge from parent payment point (or seed box for the root)
    let ed = null;
    const px0 = g.parentId ? x(g.fundMs) : 104;
    const py0 = g.parentId ? y(byId.get(g.parentId)) : TOPY + 16;
    ed = mk("path", { d: `M ${px0} ${py0} C ${px0 - 18} ${(py0 + gy) / 2}, ${gx - 16} ${(py0 + gy) / 2}, ${gx} ${gy}`,
                      fill: "none", stroke: "var(--accent-dim)", "stroke-width": 1,
                      opacity: 0 }, edges);
    elFor.set(g.id, { grp, ed, pl, line: grp.children[1], lbl });
  }

  /* --------------------------------------------------------- timeline --- */
  // event list: fund (per grat), settle (status color at endMs), remainder dot
  const evts = [];
  for (const g of grats) {
    evts.push({ t: g.fundMs, k: "fund", g });
    evts.push({ t: g.endMs ?? res.horizonMs, k: "settle", g });
    if (g.status === "completed" && g.remainderUsd > 0) {
      evts.push({ t: g.endMs, k: "remainder", g });
    }
  }
  evts.sort((a, b) => a.t - b.t);

  const BASE_SECS = 32;
  let speed = 1, playing = false, clock = T0, lastFrame = 0, applied = 0;
  let trustUsd = 0, trustCount = 0;
  const transients = [];   // {el, born, life, from:[x,y], to:[x,y]}

  function applyEvent(e) {
    const el = elFor.get(e.g.id);
    if (e.k === "fund") {
      el.grp.setAttribute("opacity", 1);
      if (el.ed) el.ed.setAttribute("opacity", 0.7);
      el.pl.setAttribute("opacity", 1);
      el.pl.dataset.fade = String(e.t + 200 * MS_DAY);   // fade the path label later
      if (playing) spawnDot(el.ed, "var(--accent)");
    } else if (e.k === "settle") {
      el.line.setAttribute("stroke", SC[e.g.status] || "var(--gray)");
      el.grp.children[2].setAttribute("fill", SC[e.g.status] || "var(--gray)");
    } else if (e.k === "remainder") {
      trustUsd += e.g.remainderUsd; trustCount++;
      trustTotal.textContent = usd(trustUsd);
      trustN.textContent = trustCount + " remainder" + (trustCount === 1 ? "" : "s");
      if (playing) {
        const d = mk("circle", { r: 4, fill: "var(--green)" }, dots);
        transients.push({ el: d, born: performance.now(), life: 900,
                          from: [x(e.g.endMs), y(e.g)], to: [W - 132, TOPY + 22] });
      }
    }
  }
  function spawnDot(edge, color) {
    if (!edge) return;
    const d = mk("circle", { r: 3, fill: color }, dots);
    transients.push({ el: d, born: performance.now(), life: 650, path: edge });
  }
  function setClock(t, scrubbing) {
    t = Math.max(T0, Math.min(t, T1));
    if (t < clock) {   // rewind: reset and fast-apply
      applied = 0; trustUsd = 0; trustCount = 0;
      trustTotal.textContent = "$0"; trustN.textContent = "0 remainders";
      for (const g of grats) {
        const el = elFor.get(g.id);
        el.grp.setAttribute("opacity", 0);
        if (el.ed) el.ed.setAttribute("opacity", 0);
        el.pl.setAttribute("opacity", 0);
        el.line.setAttribute("stroke", "var(--accent)");
        el.grp.children[2].setAttribute("fill", "var(--accent)");
      }
    }
    clock = t;
    const wasPlaying = playing;
    if (scrubbing) playing = false;       // no transient dots on scrub
    while (applied < evts.length && evts[applied].t <= clock) applyEvent(evts[applied++]);
    playing = wasPlaying;
    // fade derivation labels after a while
    for (const g of grats) {
      const el = elFor.get(g.id);
      if (el.pl.dataset.fade && clock > +el.pl.dataset.fade) el.pl.setAttribute("opacity", 0);
    }
    $("motion-date").textContent = fmtD(clock);
    $("motion-scrub").value = String(Math.round((clock - T0) / (T1 - T0) * 1000));
    const active = grats.filter(g => g.fundMs <= clock && (g.endMs ?? T1) > clock).length;
    $("motion-live").textContent = `${Math.min(applied, evts.length) ? grats.filter(g => g.fundMs <= clock).length : 0} GRATs created · ${active} in term`;
  }

  function frame(now) {
    if (playing) {
      const dt = (now - lastFrame) / 1000;
      lastFrame = now;
      setClock(clock + dt * speed * (T1 - T0) / BASE_SECS);
      if (clock >= T1) { playing = false; $("motion-play").textContent = "↺ Replay"; }
    }
    // animate transient dots
    for (let i = transients.length - 1; i >= 0; i--) {
      const tr = transients[i];
      const p = (now - tr.born) / tr.life;
      if (p >= 1) { tr.el.remove(); transients.splice(i, 1); continue; }
      if (tr.path) {
        const len = tr.path.getTotalLength();
        const pt = tr.path.getPointAtLength(len * p);
        tr.el.setAttribute("cx", pt.x); tr.el.setAttribute("cy", pt.y);
      } else {
        tr.el.setAttribute("cx", tr.from[0] + (tr.to[0] - tr.from[0]) * p);
        tr.el.setAttribute("cy", tr.from[1] + (tr.to[1] - tr.from[1]) * p - Math.sin(p * Math.PI) * 26);
      }
    }
    requestAnimationFrame(frame);
  }

  /* ---------------------------------------------------------- controls -- */
  $("motion-play").addEventListener("click", () => {
    if (clock >= T1) setClock(T0, true);
    playing = !playing;
    lastFrame = performance.now();
    $("motion-play").textContent = playing ? "⏸ Pause" : (clock >= T1 ? "↺ Replay" : "▶ Play");
  });
  $("motion-scrub").addEventListener("input", () => {
    setClock(T0 + (+$("motion-scrub").value / 1000) * (T1 - T0), true);
  });
  document.querySelectorAll("#motion-speed button").forEach(b =>
    b.addEventListener("click", () => {
      speed = +b.dataset.s;
      document.querySelectorAll("#motion-speed button").forEach(q =>
        q.classList.toggle("on", q === b));
    }));

  /* -------------------------------------------------------------- boot -- */
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced) { setClock(T1, true); $("motion-play").textContent = "↺ Replay"; }
  else setClock(T0, true);
  $("motion-summary").textContent =
    `This is a real run: ${usd(FUND)} seeded ${fmtD(SEED_MS)} grows into ` +
    `${res.nGrats} GRATs across ${Math.max(...gens)} generations and delivers ` +
    `${usd(res.dynastyUsd)} to the children's trust by ${fmtD(res.horizonMs)} — ` +
    `every number recomputed from the market snapshot on load.`;
  requestAnimationFrame(frame);
})();
