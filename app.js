/* app.js — interactive layer for the rolling-GRAT simulator. */
"use strict";
(function () {
  const G = window.GRAT;
  const D = window.NH_DATA;
  const $ = id => document.getElementById(id);
  const MS_DAY = G.MS_DAY;

  /* ------------------------------------------------------------ data --- */
  function toSeries(key) {
    const pairs = D.series[key];
    const t = new Array(pairs.length), v = new Array(pairs.length);
    for (let i = 0; i < pairs.length; i++) { t[i] = pairs[i][0]; v[i] = pairs[i][1]; }
    return { t, v };
  }
  const metrics = {
    price: toSeries("price"), drawdown: toSeries("drawdown"),
    mvrv_z: toSeries("mvrv_z"), mayer: toSeries("mayer"),
    realized: toSeries("realized"),
  };
  const prices = metrics.price;
  // context series (annotations + facts; not part of the composite signal)
  const ctx = {};
  for (const k of ["nupl", "pi_fast", "pi_slow", "lth_cost", "vol_1y", "cagr_2y"]) {
    if (D.series[k]) ctx[k] = toSeries(k);
  }

  // Pi-Cycle top crossings: 111DMA crossing above 2x350DMA (computed, not hand-picked)
  const piTops = (() => {
    if (!ctx.pi_fast || !ctx.pi_slow) return [];
    const out = [];
    const f = ctx.pi_fast;
    for (let i = 1; i < f.t.length; i++) {
      const s0 = G.interp(ctx.pi_slow, f.t[i - 1]), s1 = G.interp(ctx.pi_slow, f.t[i]);
      if (s0 === null || s1 === null) continue;
      if (f.v[i - 1] <= s0 && f.v[i] > s1) {
        if (!out.length || f.t[i] - out[out.length - 1] > 90 * G.MS_DAY) out.push(f.t[i]);
      }
    }
    return out;
  })();
  const firstMs = prices.t[0], lastMs = prices.t[prices.t.length - 1];
  const signalFn = G.makeSignalFn(metrics);

  /* --------------------------------------------------------- helpers --- */
  const fmtDate = ms => new Date(ms).toISOString().slice(0, 10);
  const usd = x => {
    const a = Math.abs(x);
    if (a >= 1e9) return "$" + (x / 1e9).toFixed(2) + "B";
    if (a >= 1e6) return "$" + (x / 1e6).toFixed(2) + "M";
    if (a >= 1e3) return "$" + (x / 1e3).toFixed(0) + "K";
    return "$" + x.toFixed(0);
  };
  const usdFull = x => "$" + Math.round(x).toLocaleString("en-US");
  const debounce = (fn, ms) => { let h; return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); }; };
  const STATUS_COLOR = { completed: "var(--green)", failed: "var(--red)",
                         active_at_horizon: "var(--gray)", died_during_term: "var(--purple)" };
  const STATUS_LABEL = { completed: "remainder", failed: "exhausted",
                         active_at_horizon: "open@end", died_during_term: "death" };

  /* ----------------------------------------------------------- state --- */
  // Analysis era: where statistics and selectable start dates begin. The
  // halving era is the default — the cycle regime the strategy harvests
  // begins at the first halving, and pre-2013 data fails the liquidity and
  // data-quality tests rigorous BTC research applies (most academic work
  // starts 2013+). Full history remains available, labeled for what it is.
  const ERAS = [
    { key: "full",    label: "Full history · 2010→",   ms: firstMs,
      note: "Includes 2010–2012: a sub-$1B market with unreliable early-exchange data, returns " +
            "unreachable at the position sizes modeled. Shown for completeness — it inflates every statistic." },
    { key: "halving", label: "Halving era · Nov 2012→", ms: Date.UTC(2012, 10, 28),
      note: "Default. The halving-cycle regime this strategy harvests begins at the first halving " +
            "(Nov 28, 2012); academic BTC backtests likewise typically exclude pre-2013 data on " +
            "liquidity and quality grounds." },
    { key: "custody", label: "Custody era · 2017→",     ms: Date.UTC(2017, 0, 1),
      note: "Starts when multisig collaborative custody fit for trusts was practically available — " +
            "the operationally honest window for this strategy." },
  ];
  const state = {
    era: "halving",
    startMs: Date.UTC(2017, 0, 1), fundUsd: 5e6, termYears: 2,
    escalationPct: 0, graceDays: 0, policy: "always", threshold: 0.5,
    death: false, deathMs: null, survProb: 0.85,
  };
  const eraStart = () => ERAS.find(e => e.key === state.era).ms;
  const lastPossible = () => lastMs - Math.trunc(365.25 * state.termYears) * MS_DAY;

  /* ------------------------------------------------------- datastamp --- */
  $("datastamp").textContent =
    `NewHedge snapshot · ${prices.t.length.toLocaleString()} daily closes · ` +
    `${fmtDate(firstMs)} → ${fmtDate(lastMs)} · BTC ${usdFull(prices.v[prices.v.length - 1])}`;

  /* -------------------------------------------------- current reading --- */
  function renderReading(comparable) {
    const sig = G.entrySignal(metrics, lastMs);
    const score = sig.score;
    // donut gauge
    const r = 54, c = 2 * Math.PI * r, off = c * (1 - score);
    $("gauge").innerHTML =
      `<svg viewBox="0 0 132 132">
        <circle cx="66" cy="66" r="${r}" fill="none" stroke="var(--panel-2)" stroke-width="11"/>
        <circle cx="66" cy="66" r="${r}" fill="none" stroke="var(--accent)" stroke-width="11"
          stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${off}"
          transform="rotate(-90 66 66)"/>
      </svg>
      <div class="score"><b>${score.toFixed(2)}</b><span>ENTRY SIGNAL</span></div>`;
    const px = prices.v[prices.v.length - 1];
    const dd = G.interp(metrics.drawdown, lastMs);
    const my = G.interp(metrics.mayer, lastMs);
    const z = G.interp(metrics.mvrv_z, lastMs);
    const facts = [
      ["BTC price", usdFull(px)],
      ["From ATH", dd.toFixed(1) + "%"],
      ["Mayer Multiple", my.toFixed(2)],
      ["MVRV Z-score", z.toFixed(2)],
      ["Since halving", sig.monthsSinceHalving.toFixed(1) + " mo"],
      ["§7520 this month", G.get7520Rate(lastMs).toFixed(1) + "%"],
    ];
    if (ctx.nupl) {
      const nupl = G.interp(ctx.nupl, lastMs);
      if (nupl !== null) facts.push(["NUPL (unrealized P/L)", nupl.toFixed(1) + "%"]);
    }
    if (ctx.lth_cost) {
      const floor = G.interp(ctx.lth_cost, lastMs);
      if (floor) facts.push(["LTH cost basis", usdFull(floor) +
        ` <small>price ${(px / floor).toFixed(2)}× the long-term-holder floor</small>`]);
    }
    if (ctx.vol_1y) {
      const vol = G.interp(ctx.vol_1y, lastMs);
      if (vol !== null) facts.push(["1-yr realized vol", vol.toFixed(1) + "%"]);
    }
    if (ctx.cagr_2y) {
      const cagr = G.interp(ctx.cagr_2y, lastMs);
      if (cagr !== null) facts.push(["Trailing 2-yr CAGR", cagr.toFixed(1) + "%"]);
    }
    if (comparable) facts.push(["Similar past entries", comparable]);
    $("reading-facts").innerHTML = facts.map(([k, v]) =>
      `<div class="fact"><div class="k">${k}</div><div class="v">${v}</div></div>`).join("");
    const names = { drawdown: "Drawdown", mvrv_z: "MVRV-Z", mayer: "Mayer", realized: "vs realized", cycle_phase: "Cycle phase" };
    $("reading-bars").innerHTML = Object.entries(sig.components).map(([k, v]) =>
      `<div class="brow"><span class="lbl">${names[k] || k}</span>
        <span class="track"><span class="fill" style="width:${(v * 100).toFixed(0)}%"></span></span>
        <span class="val">${v.toFixed(2)}</span></div>`).join("");
  }

  /* -------------------------------------------------------- controls --- */
  function sliderToMs(val) { return eraStart() + (val / 1000) * (lastPossible() - eraStart()); }
  function msToSlider(ms) { return Math.round((ms - eraStart()) / (lastPossible() - eraStart()) * 1000); }

  const startSlider = $("start-slider");
  startSlider.max = 1000;
  function syncStartUI() {
    state.startMs = Math.min(Math.max(state.startMs, eraStart()), lastPossible());
    startSlider.value = msToSlider(state.startMs);
    const sig = signalFn(prices.t[G.lowerBound(prices.t, state.startMs)] ?? lastMs);
    $("start-readout").textContent =
      `${fmtDate(state.startMs)} · BTC ${usd(G.priceAt(prices, state.startMs))} · signal ${sig.toFixed(2)}`;
  }
  startSlider.addEventListener("input", () => { state.startMs = sliderToMs(+startSlider.value); syncStartUI(); scheduleRun(); });

  const CHIP_DATES = [
    ["2011-06 first mania", Date.UTC(2011, 5, 8)],
    ["2013-11 top", Date.UTC(2013, 10, 29)],
    ["2015-01 bottom", Date.UTC(2015, 0, 14)],
    ["2017-12 top", Date.UTC(2017, 11, 17)],
    ["2018-12 bottom", Date.UTC(2018, 11, 15)],
    ["2020-03 covid", Date.UTC(2020, 2, 16)],
    ["2021-11 top", Date.UTC(2021, 10, 8)],
    ["2022-11 FTX bottom", Date.UTC(2022, 10, 21)],
    ["2024-04 halving", Date.UTC(2024, 3, 20)],
  ];
  function renderChips() {
    $("start-chips").innerHTML = CHIP_DATES
      .filter(([, ms]) => ms >= eraStart() && ms <= lastPossible())
      .map(([label, ms]) => `<button class="chip" data-ms="${ms}">${label}</button>`).join("");
  }
  renderChips();
  $("start-chips").addEventListener("click", e => {
    const ms = +e.target.dataset?.ms;
    if (ms) { state.startMs = ms; syncStartUI(); scheduleRun(); }
  });

  /* era control: one state, two synced UIs (simulator panel + article figure) */
  function renderEraUIs() {
    const seg = $("era-seg");
    if (seg) {
      seg.innerHTML = ERAS.map(e =>
        `<button data-era="${e.key}" class="${e.key === state.era ? "on" : ""}">${e.label}</button>`).join("");
      $("era-note").textContent = ERAS.find(e => e.key === state.era).note;
    }
    const fig = $("hurdle-eras");
    if (fig) {
      fig.innerHTML = ERAS.map(e =>
        `<button class="chip" data-era="${e.key}" style="${e.key === state.era ? "border-color:var(--accent);color:var(--accent)" : ""}">${e.label}</button>`).join("");
    }
  }
  function setEra(key) {
    if (!ERAS.some(e => e.key === key) || key === state.era) return;
    state.era = key;
    renderEraUIs(); renderChips(); renderHurdleFigure();
    syncStartUI(); scheduleRun(); scheduleSweep();
  }
  document.addEventListener("click", e => {
    const k = e.target.dataset?.era;
    if (k) setEra(k);
  });

  $("fund-input").addEventListener("input", () => {
    const v = parseFloat($("fund-input").value.replace(/[^0-9.]/g, ""));
    if (v > 0) { state.fundUsd = v; scheduleRun(); }
  });
  document.querySelectorAll("[data-fund]").forEach(b => b.addEventListener("click", () => {
    state.fundUsd = +b.dataset.fund;
    $("fund-input").value = state.fundUsd.toLocaleString("en-US");
    scheduleRun();
  }));

  $("term-select").addEventListener("change", () => {
    state.termYears = +$("term-select").value; syncStartUI(); scheduleRun(); scheduleSweep();
  });
  $("annuity-seg").addEventListener("click", e => {
    if (e.target.dataset?.esc === undefined) return;
    state.escalationPct = +e.target.dataset.esc;
    $("annuity-seg").querySelectorAll("button").forEach(b => b.classList.toggle("on", b === e.target));
    scheduleRun(); scheduleSweep();
  });
  $("grace-slider").addEventListener("input", () => {
    state.graceDays = +$("grace-slider").value;
    $("grace-readout").textContent = state.graceDays ? `${state.graceDays}-day window, pay at local high` : "pay on due date";
    scheduleRun(); scheduleSweep();
  });
  $("policy-seg").addEventListener("click", e => {
    const p = e.target.dataset?.policy;
    if (!p) return;
    state.policy = p;
    $("policy-seg").querySelectorAll("button").forEach(b => b.classList.toggle("on", b === e.target));
    $("threshold-ctl").classList.toggle("hidden", p === "always");
    scheduleRun();
  });
  $("threshold-ctl").classList.toggle("hidden", state.policy === "always");
  $("threshold-slider").addEventListener("input", () => {
    state.threshold = +$("threshold-slider").value;
    $("threshold-readout").innerHTML = `signal &ge; ${state.threshold.toFixed(2)}`;
    scheduleRun(); scheduleSweep();
  });
  $("death-toggle").addEventListener("change", () => {
    state.death = $("death-toggle").checked;
    $("death-ctls").classList.toggle("hidden", !state.death);
    if (state.death && !state.deathMs) {
      state.deathMs = state.startMs + 548 * MS_DAY;   // ~18 months in
      $("death-date").value = fmtDate(state.deathMs);
    }
    scheduleRun();
  });
  $("death-date").addEventListener("change", () => {
    const ms = Date.parse($("death-date").value + "T00:00:00Z");
    if (!isNaN(ms)) { state.deathMs = ms; scheduleRun(); }
  });
  $("surv-slider").addEventListener("input", () => {
    state.survProb = +$("surv-slider").value;
    $("surv-readout").textContent = `P(survive) ${state.survProb.toFixed(2)}`;
    scheduleRun();
  });

  /* ------------------------------------------------------- main run ---- */
  function runChain(deathMs) {
    return G.runPolicyChain(metrics, state.startMs, state.policy, {
      fundUsd: state.fundUsd, termYears: state.termYears,
      escalationPct: state.escalationPct, graceDays: state.graceDays,
      signalThreshold: state.threshold, minFundUsd: 0,
      deathMs: deathMs ?? null, signalFn,
    });
  }

  // dynasty transfer with the 105-day grace window vs without, same settings
  function graceLever() {
    const base = { fundUsd: state.fundUsd, termYears: state.termYears,
                   escalationPct: state.escalationPct, signalThreshold: state.threshold,
                   minFundUsd: 0, deathMs: state.death ? state.deathMs : null, signalFn };
    const r0 = G.runPolicyChain(metrics, state.startMs, state.policy, { ...base, graceDays: 0 });
    const r105 = G.runPolicyChain(metrics, state.startMs, state.policy, { ...base, graceDays: 105 });
    if (!r0 || !r105 || r0.dynastyUsd <= 0) return null;
    return r105.dynastyUsd / r0.dynastyUsd - 1;
  }

  let lastResult = null;
  function run() {
    const alive = runChain(null);
    const dead = state.death && state.deathMs ? runChain(state.deathMs) : null;
    const shown = state.death && dead !== undefined ? (dead ?? alive) : alive;
    lastResult = { alive, dead };
    renderSeedNote(alive);
    renderCards(alive, dead);
    renderPriceChart(state.death ? dead : alive);
    renderChainTable(state.death ? dead : alive);
    renderMortality(alive, dead);
    markHistogram();
  }
  const scheduleRun = debounce(run, 60);

  function renderSeedNote(res) {
    const el = $("seed-note");
    if (state.policy === "always") { el.style.display = "none"; return; }
    if (res === null) {
      el.style.display = "";
      el.innerHTML = `<strong style="color:var(--red)">Never deployed.</strong>
        The entry signal never reached ${state.threshold.toFixed(2)} between ${fmtDate(state.startMs)}
        and the last date a full ${state.termYears}-year term fits. Total transferred: $0 (0.00x).
        This outcome counts &mdash; waiting for a signal that never comes has a price.`;
      return;
    }
    const seed = res.grats.length ? res.grats[0].fundMs : null;
    if (seed && seed !== state.startMs) {
      el.style.display = "";
      el.innerHTML = `Signal first cleared <b>${state.threshold.toFixed(2)}</b> on
        <b style="font-family:var(--mono)">${fmtDate(seed)}</b> (BTC ${usd(G.priceAt(prices, seed))})
        &mdash; the chain seeds there, ${Math.round((seed - state.startMs) / MS_DAY)} days after your start date.`;
    } else el.style.display = "none";
  }

  function renderCards(alive, dead) {
    const r = state.death && dead ? dead : alive;
    const cards = [];
    if (r === null) {
      cards.push(["To children's trust", "$0", "accent", "never deployed"]);
      cards.push(["Multiple of funding", "0.00x", "", ""]);
    } else {
      cards.push(["To children's trust", usd(r.dynastyUsd), "accent",
                  r.dynastyBtc.toFixed(2) + " BTC, out of the estate"]);
      cards.push(["Multiple of funding", r.transferMultiple.toFixed(2) + "x",
                  r.transferMultiple >= 1 ? "green" : "red",
                  usd(state.fundUsd) + " → " + usd(r.dynastyUsd)]);
      cards.push(["GRATs in chain", String(r.nGrats), "",
                  `peak ${r.peakConcurrent} concurrent`]);
      cards.push(["Completed / failed", `${r.nCompleted} / ${r.nFailed}`, "",
                  `${(r.failureRate * 100).toFixed(0)}% failure rate — failures cost nothing`]);
      if (r.nActiveAtHorizon) cards.push(["Open at data end", String(r.nActiveAtHorizon), "",
                  usd(r.grats.filter(g => g.status === "active_at_horizon").reduce((a, g) => a + g.horizonValueUsd, 0)) + " marked, not transferred"]);
      if (state.death && dead) cards.push(["Into gross estate §2036(a)", usd(dead.estateInclusionUsd), "purple",
                  `${dead.nDied} GRAT${dead.nDied === 1 ? "" : "s"} open at death`]);
      // the article's "~11%" grace-window claim, tested live on THIS chain
      const lever = graceLever();
      if (lever !== null) {
        cards.push(["The 105-day lever", (lever >= 0 ? "+" : "") + (lever * 100).toFixed(1) + "%",
                    lever >= 0 ? "green" : "red",
                    "Reg. §25.2702-3(b)(4): pay at the window high vs the due date, this chain"]);
      }
      cards.push(["BTC conservation", r.conservationResidualBtc.toExponential(1), "",
                  "residual of " + r.rootFundBtc.toFixed(2) + " BTC funded"]);
    }
    $("cards").innerHTML = cards.map(([k, v, cls, sub]) =>
      `<div class="card"><div class="k">${k}</div><div class="v ${cls}">${v}</div>
       ${sub ? `<div class="sub">${sub}</div>` : ""}</div>`).join("");
  }

  /* ---------------------------------------------------- price chart ---- */
  function renderPriceChart(res) {
    const W = 1060, H = 430, L = 64, R = 16, T = 18, B = 34;
    const x = ms => L + (ms - firstMs) / (lastMs - firstMs) * (W - L - R);
    const lo = Math.max(0.04, Math.min(...prices.v)), hi = Math.max(...prices.v) * 1.6;
    const y = p => T + (1 - (Math.log10(p) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo))) * (H - T - B);

    let out = `<text x="${L}" y="11" fill="var(--muted)" font-size="10.5" font-family="var(--mono)">BTC price, log scale · each bar is one GRAT drawn at its funding price, from funding to termination</text>`;
    // y grid: powers of 10
    for (let e = Math.ceil(Math.log10(lo)); e <= Math.floor(Math.log10(hi)); e++) {
      const p = Math.pow(10, e);
      out += `<line x1="${L}" x2="${W - R}" y1="${y(p)}" y2="${y(p)}" stroke="var(--line)" stroke-width="0.6"/>
              <text x="${L - 7}" y="${y(p) + 4}" fill="var(--muted)" font-size="10.5" text-anchor="end" font-family="var(--mono)">${p >= 1000 ? "$" + p / 1000 + "k" : "$" + p}</text>`;
    }
    // x ticks: every 2 years
    for (let yr = 2011; yr <= 2026; yr += 2) {
      const ms = Date.UTC(yr, 0, 1);
      out += `<text x="${x(ms)}" y="${H - 12}" fill="var(--muted)" font-size="10.5" text-anchor="middle" font-family="var(--mono)">${yr}</text>`;
    }
    // halvings
    for (const h of G.HALVINGS) if (h >= firstMs && h <= lastMs) {
      out += `<line x1="${x(h)}" x2="${x(h)}" y1="${T}" y2="${H - B}" stroke="var(--muted)" stroke-width="0.7" stroke-dasharray="3 5" opacity="0.55"/>`;
    }
    // price path (downsampled)
    const step = Math.max(1, Math.floor(prices.t.length / 1200));
    let path = "";
    for (let i = 0; i < prices.t.length; i += step) {
      path += (path ? "L" : "M") + x(prices.t[i]).toFixed(1) + " " + y(Math.max(prices.v[i], lo)).toFixed(1);
    }
    out += `<path d="${path}" fill="none" stroke="var(--accent)" stroke-width="1.5" opacity="0.9"/>`;
    // Pi-Cycle top crossings — historically the worst seeding days
    for (const tms of piTops) {
      const yy = y(Math.max(G.priceAt(prices, tms), lo));
      out += `<g><title>Pi-Cycle top signal ${fmtDate(tms)} (111DMA crossed above 2×350DMA) — historically a cycle peak, the worst day to seed</title>
        <path d="M ${x(tms) - 5} ${yy - 12} L ${x(tms) + 5} ${yy - 12} L ${x(tms)} ${yy - 4} Z"
          fill="none" stroke="var(--red)" stroke-width="1.4"/></g>`;
    }
    // death line
    if (state.death && state.deathMs) {
      out += `<line x1="${x(state.deathMs)}" x2="${x(state.deathMs)}" y1="${T}" y2="${H - B}" stroke="var(--purple)" stroke-width="1.2" stroke-dasharray="5 4"/>
              <text x="${x(state.deathMs) + 4}" y="${T + 11}" fill="var(--purple)" font-size="10.5" font-family="var(--mono)">death</text>`;
    }
    // GRAT bars on the price line
    if (res) {
      for (const g of res.grats) {
        const x1 = x(g.fundMs), x2 = x(g.endMs ?? lastMs), yy = y(Math.max(g.fundPrice, lo));
        const col = STATUS_COLOR[g.status];
        out += `<g><title>GRAT #${g.id}${g.parentId ? " ← #" + g.parentId : g.pooled ? " (pooled)" : " (root)"}
funded ${fmtDate(g.fundMs)} · ${usd(g.fundValueUsd)} at §7520 ${g.ratePct}%
annuity ${usd(g.firstYearAnnuityUsd)}/yr · ${STATUS_LABEL[g.status]}${g.status === "completed" ? " " + usd(g.remainderUsd) : ""}</title>
<line x1="${x1}" x2="${x2}" y1="${yy}" y2="${yy}" stroke="${col}" stroke-width="3" opacity="0.8" stroke-linecap="round"/>
<circle cx="${x1}" cy="${yy}" r="2.6" fill="${col}"/></g>`;
        if (g.status === "completed" && g.remainderUsd > 0) {
          const ye = y(Math.max(G.priceAt(prices, g.endMs), lo));
          out += `<g><title>remainder ${usd(g.remainderUsd)} → children's trust (${fmtDate(g.endMs)})</title>
<path d="M ${x2} ${ye - 5.5} L ${x2 + 4.5} ${ye} L ${x2} ${ye + 5.5} L ${x2 - 4.5} ${ye} Z" fill="var(--green)" opacity="0.95"/></g>`;
        }
      }
      // start marker
      out += `<path d="M ${x(state.startMs) - 6} ${H - B + 2} L ${x(state.startMs) + 6} ${H - B + 2} L ${x(state.startMs)} ${H - B - 8} Z" fill="var(--accent)"/>`;
    }
    $("price-chart").innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="BTC price with GRAT chain overlay">${out}</svg>`;
  }

  /* ---------------------------------------------------- chain table ---- */
  let tableExpanded = false;
  $("more-rows").addEventListener("click", () => { tableExpanded = !tableExpanded; renderChainTable(state.death && lastResult.dead ? lastResult.dead : lastResult.alive); });
  function renderChainTable(res) {
    const tbl = $("chain-table");
    if (!res || !res.grats.length) { tbl.innerHTML = "<tr><td>No GRATs were funded.</td></tr>"; $("more-rows").classList.add("hidden"); return; }
    const rows = [...res.grats].sort((a, b) => a.fundMs - b.fundMs || a.id - b.id);
    const cut = 14;
    const shown = tableExpanded ? rows : rows.slice(0, cut);
    const cls = s => s === "failed" ? "failed" : s === "active_at_horizon" ? "open" : s === "died_during_term" ? "death" : "";
    tbl.innerHTML = `<thead><tr><th>#</th><th>parent</th><th>funded</th><th>$ funded</th>
      <th>§7520</th><th>$ annuity/yr</th><th>fate</th><th>$ to heirs</th></tr></thead><tbody>` +
      shown.map(g => `<tr class="${cls(g.status)}">
        <td>G${String(g.id).padStart(3, "0")}</td>
        <td>${g.parentId ? "G" + String(g.parentId).padStart(3, "0") : g.pooled ? "pool" : "—"}</td>
        <td>${fmtDate(g.fundMs)}</td><td>${usd(g.fundValueUsd)}</td>
        <td>${g.ratePct.toFixed(1)}%</td><td>${usd(g.firstYearAnnuityUsd)}</td>
        <td>${STATUS_LABEL[g.status]}</td>
        <td>${g.status === "completed" ? usd(g.remainderUsd)
             : g.status === "active_at_horizon" ? usd(g.horizonValueUsd) + "*"
             : g.status === "died_during_term" ? "$0 (estate)" : "$0"}</td></tr>`).join("") +
      `</tbody>`;
    const btn = $("more-rows");
    btn.classList.toggle("hidden", rows.length <= cut);
    btn.textContent = tableExpanded ? "Collapse" : `Show all ${rows.length} GRATs`;
  }

  /* ------------------------------------------------------ mortality ---- */
  function renderMortality(alive, dead) {
    const panel = $("mortality-panel");
    if (!state.death || !dead) { panel.classList.add("hidden"); return; }
    panel.classList.remove("hidden");
    const col = (title, r) => `<div class="mort-col"><h4>${title}</h4>
      <div class="kv"><span>GRATs funded</span><span>${r ? r.nGrats : 0}</span></div>
      <div class="kv"><span>completed / failed</span><span>${r ? r.nCompleted + " / " + r.nFailed : "—"}</span></div>
      <div class="kv"><span>killed by death (open)</span><span>${r ? r.nDied : 0}</span></div>
      <div class="kv"><span>to children's trust</span><span>${usd(r ? r.dynastyUsd : 0)}</span></div>
      <div class="kv"><span>multiple of funding</span><span>${(r ? r.transferMultiple : 0).toFixed(2)}x</span></div>
      <div class="kv"><span>into gross estate</span><span>${usd(r ? r.estateInclusionUsd : 0)}</span></div>`;
    $("mort-grid").innerHTML =
      col("Grantor survives", alive) + col(`Grantor dies ${fmtDate(state.deathMs)}`, dead);
    const a = alive ? alive.dynastyUsd : 0, d = dead ? dead.dynastyUsd : 0;
    const exp = state.survProb * a + (1 - state.survProb) * d;
    $("mort-expected").innerHTML =
      `Survival-weighted expected transfer: ${state.survProb.toFixed(2)} × ${usd(a)} +
       ${(1 - state.survProb).toFixed(2)} × ${usd(d)} = <b>${usd(exp)}</b>
       (${(exp / state.fundUsd).toFixed(2)}x). <span style="color:var(--muted)">P(survive) is your input
       (an actuarial table for the grantor's age over the chain horizon) &mdash; the model does not estimate mortality.</span>`;
  }

  /* ---------------------------------------------------------- sweep ---- */
  let sweepData = null, sweepRunning = false, sweepKey = "";
  const currentSweepKey = () => JSON.stringify([state.era, state.termYears, state.escalationPct, state.graceDays, state.threshold]);

  function scheduleSweepInner() {
    if (sweepRunning) { setTimeout(scheduleSweepInner, 300); return; }
    if (sweepKey === currentSweepKey()) return;
    runSweep();
  }
  const scheduleSweep = debounce(scheduleSweepInner, 500);

  function runSweep() {
    sweepRunning = true;
    const key = currentSweepKey();
    const stepDays = 30;
    const lp = lastPossible();
    const starts = [];
    for (let d = eraStart(); d <= lp; d += stepDays * MS_DAY) starts.push(d);
    const opts = { fundUsd: 1e6, termYears: state.termYears, escalationPct: state.escalationPct,
                   graceDays: state.graceDays, signalThreshold: state.threshold, minFundUsd: 0, signalFn };
    const byPolicy = { "always": [], "seed-gated": [], "fully-gated": [] };
    const jobs = [];
    for (const p of G.POLICIES) for (const s of starts) jobs.push([p, s]);
    let i = 0;
    const CHUNK = 12;
    $("sweep-status").textContent = "Running historical sweep…";
    function tick() {
      const end = Math.min(i + CHUNK, jobs.length);
      for (; i < end; i++) {
        const [p, s] = jobs[i];
        const r = G.runPolicyChain(metrics, s, p, opts);
        byPolicy[p].push({ startMs: s, multiple: r ? r.transferMultiple : 0, deployed: r !== null });
      }
      $("sweep-progress").style.width = (i / jobs.length * 100).toFixed(1) + "%";
      if (i < jobs.length) { setTimeout(tick, 0); return; }
      sweepData = { starts, byPolicy };
      sweepKey = key;
      sweepRunning = false;
      $("sweep-status").textContent =
        `${starts.length} start dates × 3 policies · ${fmtDate(starts[0])} → ${fmtDate(starts[starts.length - 1])} ` +
        `(${ERAS.find(e => e.key === state.era).label}) · distributions below are history, not forecasts`;
      renderSweep();
      updateComparable();
      if (sweepKey !== currentSweepKey()) scheduleSweep();
    }
    tick();
  }

  // log2 bins: 0 | (0,1] | (1,2] | (2,4] ... | >2^max
  function binIndex(m, nBins) {
    if (m <= 0) return 0;
    if (m <= 1) return 1;
    return Math.min(nBins - 1, 2 + Math.floor(Math.log2(m)));
  }
  function binLabel(i, nBins) {
    if (i === 0) return "0x";
    if (i === 1) return "≤1x";
    const lo = Math.pow(2, i - 2), hi = Math.pow(2, i - 1);
    if (i === nBins - 1) return ">" + lo + "x";
    return lo + "–" + hi + "x";
  }

  function renderSweep() {
    if (!sweepData) return;
    const N_BINS = 13;
    const colors = { "always": "var(--accent)", "seed-gated": "var(--green)", "fully-gated": "var(--purple)" };
    const bins = {};
    for (const p of G.POLICIES) {
      bins[p] = new Array(N_BINS).fill(0);
      for (const r of sweepData.byPolicy[p]) bins[p][binIndex(r.multiple, N_BINS)]++;
    }
    const maxCount = Math.max(...G.POLICIES.flatMap(p => bins[p]));
    const W = 1060, H = 240, L = 30, R = 8, T = 26, B = 40;
    const bw = (W - L - R) / N_BINS, gw = bw / 4.2;
    let out = "";
    for (let b = 0; b < N_BINS; b++) {
      G.POLICIES.forEach((p, pi) => {
        const c = bins[p][b];
        const h = c / maxCount * (H - T - B);
        const xx = L + b * bw + gw * (pi + 0.35);
        out += `<rect x="${xx}" y="${H - B - h}" width="${gw * 0.85}" height="${Math.max(h, c ? 1.5 : 0)}"
                 fill="${colors[p]}" opacity="0.85"><title>${p}: ${c} chains ${binLabel(b, N_BINS)}</title></rect>`;
      });
      out += `<text x="${L + (b + 0.5) * bw}" y="${H - B + 15}" fill="var(--muted)" font-size="9.5"
              text-anchor="middle" font-family="var(--mono)">${binLabel(b, N_BINS)}</text>`;
    }
    out += `<text x="${L}" y="${T - 12}" fill="var(--muted)" font-size="10.5" font-family="var(--mono)">chains per outcome bin (dynasty transfer as multiple of funding)</text>`;
    // legend
    G.POLICIES.forEach((p, pi) => {
      out += `<rect x="${W - 330 + pi * 110}" y="${T - 20}" width="12" height="8" fill="${colors[p]}"/>
              <text x="${W - 314 + pi * 110}" y="${T - 12}" fill="var(--muted)" font-size="10" font-family="var(--mono)">${p}</text>`;
    });
    $("hist-chart").innerHTML = `<svg viewBox="0 0 ${W} ${H}" id="hist-svg">${out}<g id="hist-marker"></g></svg>`;
    markHistogram();

    // distribution table
    const rows = G.POLICIES.map(p => {
      const ms = sweepData.byPolicy[p].map(r => r.multiple);
      const q = G.quantiles(ms);
      const nd = sweepData.byPolicy[p].filter(r => !r.deployed).length;
      return `<tr><td>${p}</td><td>${ms.length}</td><td>${nd}</td>
        <td>${q.min.toFixed(2)}x</td><td>${q.p25.toFixed(2)}x</td>
        <td style="color:var(--accent)">${q.median.toFixed(2)}x</td>
        <td>${q.p75.toFixed(2)}x</td><td>${q.max.toFixed(0)}x</td><td>${q.mean.toFixed(2)}x</td></tr>`;
    }).join("");
    $("sweep-table").innerHTML = `<thead><tr><th>policy</th><th>chains</th><th>never deployed</th>
      <th>min</th><th>p25</th><th>median</th><th>p75</th><th>max</th><th>mean</th></tr></thead><tbody>${rows}</tbody>`;
  }

  function markHistogram() {
    const g = document.getElementById("hist-marker");
    if (!g || !sweepData) return;
    // nearest sweep start to the selected one, current policy
    const arr = sweepData.byPolicy[state.policy];
    if (!arr || !arr.length) { g.innerHTML = ""; return; }
    let best = arr[0];
    for (const r of arr) if (Math.abs(r.startMs - state.startMs) < Math.abs(best.startMs - state.startMs)) best = r;
    const N_BINS = 13, W = 1060, L = 30, R = 8;
    const bw = (W - L - R) / N_BINS;
    const b = binIndex(best.multiple, N_BINS);
    const xx = L + (b + 0.5) * bw;
    g.innerHTML = `<path d="M ${xx - 7} 12 L ${xx + 7} 12 L ${xx} 24 Z" fill="var(--text)">
      <title>your start (${fmtDate(best.startMs)}, ${state.policy}): ${best.multiple.toFixed(2)}x</title></path>`;
  }

  function updateComparable() {
    if (!sweepData) return;
    const today = G.entrySignal(metrics, lastMs).score;
    const matches = sweepData.byPolicy["always"].filter(r => Math.abs(signalFn(r.startMs) - today) <= 0.10);
    if (matches.length >= 4) {
      const q = G.quantiles(matches.map(r => r.multiple));
      renderReading(`${q.median.toFixed(1)}x median <small>(${matches.length} dates, ${q.p25.toFixed(1)}–${q.p75.toFixed(1)}x IQR)</small>`);
      renderReadingMeaning(`${q.median.toFixed(1)}x`);
    }
  }

  /* ------------------------------------------- hurdle-clearance figure -- */
  // The article's claim, checked: for every day with two years of forward
  // data, did BTC's actual 2-year move beat that funding month's actual
  // sec.7520 rate compounded over two years?
  function renderHurdleFigure() {
    const H2 = Math.trunc(365.25 * 2) * MS_DAY;
    const era = ERAS.find(e => e.key === state.era);
    const i0 = G.lowerBound(prices.t, era.ms);
    const runs = [];   // {startMs, endMs, ok}
    let ok = 0, total = 0;
    for (let i = i0; i < prices.t.length; i++) {
      const t = prices.t[i];
      const j = G.lowerBound(prices.t, t + H2);
      if (j >= prices.t.length) break;
      const r = G.get7520Rate(t) / 100;
      const cleared = prices.v[j] / prices.v[i] > Math.pow(1 + r, 2);
      total++; if (cleared) ok++;
      const last = runs[runs.length - 1];
      if (last && last.ok === cleared) last.endMs = t;
      else runs.push({ startMs: t, endMs: t, ok: cleared });
    }
    if (!total) { $("hurdle-stat").textContent = "Not enough data in this era."; return; }
    const firstStart = prices.t[i0], lastStart = runs[runs.length - 1].endMs;
    $("hurdle-stat").innerHTML =
      `<b>${(ok / total * 100).toFixed(1)}%</b> of the ${total.toLocaleString()} two-year windows ` +
      `since ${fmtDate(firstStart)} (${era.label.split("·")[0].trim()}) beat their actual §7520 hurdle. ` +
      `The rest cost nothing.`;
    const W = 680, HH = 64, T = 6, B = 22;
    const x = ms => (ms - firstStart) / (lastStart - firstStart) * W;
    let out = "";
    for (const run of runs) {
      const x1 = x(run.startMs), x2 = Math.max(x(run.endMs), x1 + 0.8);
      const col = run.ok ? "var(--green)" : "var(--red)";
      const days = Math.round((run.endMs - run.startMs) / MS_DAY) + 1;
      out += `<rect x="${x1.toFixed(1)}" y="${T}" width="${(x2 - x1).toFixed(1)}" height="${HH - T - B}"
        fill="${col}" opacity="${run.ok ? 0.75 : 0.95}" ${run.ok ? "" : 'class="hclick" style="cursor:pointer"'}
        data-ms="${run.startMs}"><title>${fmtDate(run.startMs)} → ${fmtDate(run.endMs)} (${days}d of window starts): 2-year windows ${run.ok ? "BEAT" : "MISSED"} the hurdle${run.ok ? "" : " — click to seed the chain here"}</title></rect>`;
    }
    // year ticks: at most ~8, aligned to Jan 1
    const y0 = new Date(firstStart).getUTCFullYear() + 1;
    const y1 = new Date(lastStart).getUTCFullYear();
    const step = Math.max(1, Math.ceil((y1 - y0) / 7));
    for (let yr = y0; yr <= y1; yr += step) {
      const xx = x(Date.UTC(yr, 0, 1));
      if (xx < 16 || xx > W - 16) continue;   // don't clip at the edges
      out += `<text x="${xx.toFixed(1)}" y="${HH - 8}" fill="var(--muted)"
        font-size="9.5" text-anchor="middle" font-family="var(--mono)">${yr}</text>`;
    }
    $("hurdle-strip").innerHTML = `<svg viewBox="0 0 ${W} ${HH}" role="img"
      aria-label="Two-year windows beating the section 7520 hurdle">${out}</svg>`;
  }
  // attach once: re-renders must not stack listeners
  $("hurdle-strip").addEventListener("click", e => {
    const ms = +(e.target.dataset?.ms ?? NaN);
    if (!isNaN(ms) && e.target.classList.contains("hclick")) {
      state.startMs = ms;
      syncStartUI(); scheduleRun();
      document.getElementById("simulator").scrollIntoView({ behavior: "smooth" });
    }
  });

  /* --------------------------------------- diminishing-returns section -- */
  const H2MS = Math.trunc(365.25 * 2) * MS_DAY;
  const EPOCH_STARTS = G.HALVINGS.slice(0, 4);
  const EPOCH_LABELS = ["Epoch 2 · 2012–16", "Epoch 3 · 2016–20",
                        "Epoch 4 · 2020–24", "Epoch 5 · 2024– (open)"];

  // all N-year windows from `fromMs`: {startMs, mult, hurdle, dd, epoch}
  function windowsNy(termYears, fromMs) {
    const HN = Math.trunc(365.25 * termYears) * MS_DAY;
    const out = [];
    for (let i = G.lowerBound(prices.t, fromMs); i < prices.t.length; i++) {
      const t = prices.t[i];
      const j = G.lowerBound(prices.t, t + HN);
      if (j >= prices.t.length) break;
      const r = G.get7520Rate(t) / 100;
      let epoch = -1;
      for (let e = 0; e < EPOCH_STARTS.length; e++) if (t >= EPOCH_STARTS[e]) epoch = e;
      out.push({ startMs: t, mult: prices.v[j] / prices.v[i],
                 hurdle: Math.pow(1 + r, termYears),
                 dd: Math.abs(G.interp(metrics.drawdown, t) ?? 0), epoch });
    }
    return out;
  }
  const windows2y = fromMs => windowsNy(2, fromMs);
  const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };

  function renderDecayFigure() {
    const ws = windows2y(EPOCH_STARTS[0]);
    if (!ws.length) return;
    // log-log regression: ln(mult) on ln(entry price) — the compression slope
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const w of ws) {
      const lx = Math.log10(G.priceAt(prices, w.startMs)), ly = Math.log10(w.mult);
      sx += lx; sy += ly; sxx += lx * lx; sxy += lx * ly;
    }
    const n = ws.length;
    const slope = (sxy - sx * sy / n) / (sxx - sx * sx / n);
    $("decay-stat").innerHTML =
      `Each <b>10×</b> rise in entry price has multiplied the median two-year window by ` +
      `<b>~${Math.pow(10, slope).toFixed(2)}×</b> (${n.toLocaleString()} windows, halving era).`;

    const W = 680, HH = 240, L = 40, R = 8, T = 10, B = 26;
    const x0 = ws[0].startMs, x1 = ws[ws.length - 1].startMs;
    const x = ms => L + (ms - x0) / (x1 - x0) * (W - L - R);
    const LO = 0.25, HI = 32;
    const y = m => T + (1 - (Math.log10(Math.min(Math.max(m, LO), HI)) - Math.log10(LO))
                        / (Math.log10(HI) - Math.log10(LO))) * (HH - T - B);
    let out = "";
    for (let m = LO; m <= HI; m *= 2) {
      out += `<line x1="${L}" x2="${W - R}" y1="${y(m)}" y2="${y(m)}" stroke="var(--line)" stroke-width="0.5"/>
        <text x="${L - 5}" y="${y(m) + 3.5}" fill="var(--muted)" font-size="9.5" text-anchor="end" font-family="var(--mono)">${m < 1 ? m : m + "x"}</text>`;
    }
    for (let yr = 2014; yr <= 2024; yr += 2) {
      out += `<text x="${x(Date.UTC(yr, 0, 1))}" y="${HH - 9}" fill="var(--muted)" font-size="9.5" text-anchor="middle" font-family="var(--mono)">${yr}</text>`;
    }
    for (const h of EPOCH_STARTS.slice(1)) {
      out += `<line x1="${x(h)}" x2="${x(h)}" y1="${T}" y2="${HH - B}" stroke="var(--muted)" stroke-width="0.7" stroke-dasharray="3 5" opacity="0.55"/>`;
    }
    // window dots (downsampled)
    for (let i = 0; i < ws.length; i += 4) {
      const w = ws[i];
      out += `<circle cx="${x(w.startMs).toFixed(1)}" cy="${y(w.mult).toFixed(1)}" r="1.1"
        fill="${w.mult > w.hurdle ? "var(--green)" : "var(--red)"}" opacity="0.3"/>`;
    }
    // per-date hurdle line (the line that does not decay)
    let hp = "";
    for (let i = 0; i < ws.length; i += 12) {
      hp += (hp ? "L" : "M") + x(ws[i].startMs).toFixed(1) + " " + y(ws[i].hurdle).toFixed(1);
    }
    out += `<path d="${hp}" fill="none" stroke="var(--text)" stroke-width="1" stroke-dasharray="5 4" opacity="0.8"/>`;
    // rolling 365-day median (two pointers + sorted window)
    let mp = "", lo = 0;
    const win = [];
    const insort = v => { let a = 0, b = win.length; while (a < b) { const m = (a + b) >> 1; if (win[m] < v) a = m + 1; else b = m; } win.splice(a, 0, v); };
    const remove = v => { let a = 0, b = win.length; while (a < b) { const m = (a + b) >> 1; if (win[m] < v) a = m + 1; else b = m; } win.splice(a, 1); };
    for (let i = 0; i < ws.length; i++) {
      insort(ws[i].mult);
      while (ws[lo].startMs < ws[i].startMs - 365 * MS_DAY) { remove(ws[lo].mult); lo++; }
      if (i % 3 === 0 && i > 30) {
        mp += (mp ? "L" : "M") + x(ws[i].startMs).toFixed(1) + " " + y(win[win.length >> 1]).toFixed(1);
      }
    }
    out += `<path d="${mp}" fill="none" stroke="var(--accent)" stroke-width="2"/>`;
    // epoch median labels
    for (let e = 0; e < 4; e++) {
      const ems = ws.filter(w => w.epoch === e).map(w => w.mult);
      if (!ems.length) continue;
      const cx = Math.min((Math.max(x(EPOCH_STARTS[e]), L)
        + (e + 1 < 4 ? x(EPOCH_STARTS[e + 1]) : W - R)) / 2, W - 52);
      out += `<text x="${cx.toFixed(0)}" y="${T + 11}" fill="var(--accent)" font-size="10.5"
        text-anchor="middle" font-family="var(--mono)">med ${median(ems).toFixed(2)}x</text>`;
    }
    $("decay-chart").innerHTML = `<svg viewBox="0 0 ${W} ${HH}" role="img"
      aria-label="Two-year window multiples decaying across halving epochs">${out}</svg>`;
  }

  function renderEpochTable() {
    const ws = windows2y(EPOCH_STARTS[0]);
    const rows = [];
    for (let e = 0; e < 4; e++) {
      const es = ws.filter(w => w.epoch === e);
      const medW = es.length ? median(es.map(w => w.mult)).toFixed(2) + "x" : "—";
      const beat = es.length
        ? Math.round(es.filter(w => w.mult > w.hurdle).length / es.length * 100) + "%" : "—";
      // chain seeded on the halving date, truncated to that epoch's 4 years
      const h = EPOCH_STARTS[e];
      const endMs = Math.min(h + 1461 * MS_DAY, lastMs);
      const cut = G.upperBound(prices.t, endMs);
      const sliced = { t: prices.t.slice(0, cut), v: prices.v.slice(0, cut) };
      let chain = "—";
      if (cut > G.lowerBound(prices.t, h) + 200) {
        const res = G.simulateChain(sliced, h, 5e6, {});
        const open = endMs < h + 1461 * MS_DAY;
        chain = res.transferMultiple.toFixed(2) + "x" +
                (open ? ` <span style="color:var(--muted)">(open, ${((lastMs - h) / 365.25 / MS_DAY).toFixed(1)}y in)</span>` : "");
      }
      let vol = "—";
      if (ctx.vol_1y) {
        const vs = [];
        for (let i = 0; i < ctx.vol_1y.t.length; i++) {
          const t = ctx.vol_1y.t[i];
          if (t >= h && (e === 3 || t < EPOCH_STARTS[e + 1])) vs.push(ctx.vol_1y.v[i]);
        }
        if (vs.length) vol = median(vs).toFixed(0) + "%";
      }
      rows.push(`<tr><td>${EPOCH_LABELS[e]}</td><td>${medW}</td><td>${beat}</td>
        <td>${chain}</td><td>${vol}</td></tr>`);
    }
    $("epoch-table").innerHTML = rows.join("");
  }

  function renderDdBars() {
    const mature = windows2y(EPOCH_STARTS[2]);   // epochs 4+5
    const BUCKETS = [["0–20% off the high", 0, 20], ["20–40% off", 20, 40],
                     ["40–60% off", 40, 60], [">60% off", 60, 999]];
    const nowDd = Math.abs(G.interp(metrics.drawdown, lastMs) ?? 0);
    const W = 680, ROW = 34, TOP = 22, HH = BUCKETS.length * ROW + TOP + 8;
    let out = `<text x="0" y="12" fill="var(--muted)" font-size="10.5" font-family="var(--mono)">share of mature-era two-year windows beating their §7520 hurdle, by entry drawdown</text>`;
    BUCKETS.forEach(([label, a, b], i) => {
      const es = mature.filter(w => w.dd >= a && w.dd < b);
      if (!es.length) return;
      const beat = es.filter(w => w.mult > w.hurdle).length / es.length;
      const med = median(es.map(w => w.mult));
      const here = nowDd >= a && nowDd < b;
      const yy = i * ROW + TOP + 6;
      out += `<text x="0" y="${yy + 14}" fill="${here ? "var(--accent)" : "var(--muted)"}"
          font-size="11" font-family="var(--mono)" ${here ? 'font-weight="bold"' : ""}>${label}${here ? " ◀ today" : ""}</text>
        <rect x="170" y="${yy}" width="${(W - 350) }" height="19" rx="4" fill="var(--panel-2)"/>
        <rect x="170" y="${yy}" width="${((W - 350) * beat).toFixed(1)}" height="19" rx="4"
          fill="${beat >= 0.7 ? "var(--green)" : beat >= 0.4 ? "var(--accent-dim)" : "var(--red)"}"
          ${here ? 'stroke="var(--accent)" stroke-width="1.5"' : ""}/>
        <text x="${W - 172}" y="${yy + 14}" fill="var(--text)" font-size="10.5" font-family="var(--mono)">
          ${(beat * 100).toFixed(0)}% · ${med.toFixed(2)}x · n=${es.length}</text>`;
    });
    $("dd-bars").innerHTML = `<svg viewBox="0 0 ${W} ${HH}" role="img"
      aria-label="Mature-era hurdle clearance by entry drawdown">${out}</svg>`;
  }

  function fillForwardSpans() {
    const ws = windows2y(EPOCH_STARTS[0]);
    const mature = windows2y(EPOCH_STARTS[2]);
    if (ctx.vol_1y) {
      const e2 = []; const now = G.interp(ctx.vol_1y, lastMs);
      for (let i = 0; i < ctx.vol_1y.t.length; i++) {
        const t = ctx.vol_1y.t[i];
        if (t >= EPOCH_STARTS[0] && t < EPOCH_STARTS[1]) e2.push(ctx.vol_1y.v[i]);
      }
      $("fwd-vol").textContent = `from a median of ~${median(e2).toFixed(0)}% in the first halving ` +
        `epoch to ~${now.toFixed(0)}% today — still more than an order of magnitude above the hurdle's pace`;
    }
    const deep = mature.filter(w => w.dd >= 40);
    if (deep.length) {
      const beat = deep.filter(w => w.mult > w.hurdle).length / deep.length;
      $("fwd-dd").textContent = `${(beat * 100).toFixed(0)}% of the time ` +
        `(median ${median(deep.map(w => w.mult)).toFixed(2)}x, n=${deep.length})`;
    }
    const px = prices.v[prices.v.length - 1];
    const r = G.get7520Rate(lastMs) / 100;
    const target = px * Math.pow(1 + r, 2);
    const end = new Date(lastMs); end.setUTCFullYear(end.getUTCFullYear() + 2);
    $("fwd-now").textContent =
      `The first link's arithmetic is concrete: a chain seeded at ${usdFull(px)} clears its first ` +
      `two-year hurdle if the price exceeds roughly ${usdFull(target)} by ` +
      `${end.toISOString().slice(0, 7)} — a ${((Math.pow(1 + r, 2) - 1) * 100).toFixed(1)}% ` +
      `cumulative move — and if it does not, the corpus returns and re-seeds at whatever the bottom ` +
      `turns out to have been.`;
  }

  /* ------------------------------------------------- term comparison --- */
  function renderTermTable() {
    const TERMS = [2, 3, 4];
    const beatPct = ws => ws.length
      ? Math.round(ws.filter(w => w.mult > w.hurdle).length / ws.length * 100) + "%" : "—";
    const cell = ws => ws.length
      ? `${median(ws.map(w => w.mult)).toFixed(2)}x med · ${beatPct(ws)} beat` : "—";
    const rows = TERMS.map(t => {
      const mature = windowsNy(t, EPOCH_STARTS[2]);
      const deep = mature.filter(w => w.dd >= 40);
      const near = mature.filter(w => w.dd < 20);
      return `<tr${t === 3 ? ' style="color:var(--text)"' : ""}>
        <td>${t}-year</td><td>${cell(mature)}</td><td>${cell(deep)}</td>
        <td>${cell(near)}</td><td id="term-chain-${t}">computing&hellip;</td></tr>`;
    });
    $("term-table").innerHTML = rows.join("");
    // chain medians per term, chunked in the background (halving era, 45d steps)
    const jobs = [];
    for (const t of TERMS) {
      const lp = lastMs - Math.trunc(365.25 * t) * MS_DAY;
      for (let d = EPOCH_STARTS[0]; d <= lp; d += 45 * MS_DAY) jobs.push([t, d]);
    }
    const byTerm = { 2: [], 3: [], 4: [] };
    let i = 0;
    (function tick() {
      const end = Math.min(i + 10, jobs.length);
      for (; i < end; i++) {
        const [t, d] = jobs[i];
        const r = G.runPolicyChain(metrics, d, "always",
          { fundUsd: 1e6, termYears: t, escalationPct: 0, graceDays: 0,
            signalThreshold: 0.5, minFundUsd: 0, signalFn });
        byTerm[t].push(r.transferMultiple);
      }
      for (const t of TERMS) {
        const el = $(`term-chain-${t}`);
        const lp = lastMs - Math.trunc(365.25 * t) * MS_DAY;
        const total = Math.floor((lp - EPOCH_STARTS[0]) / (45 * MS_DAY)) + 1;
        if (el && byTerm[t].length >= total) {
          el.textContent = `${median(byTerm[t]).toFixed(2)}x med · n=${byTerm[t].length}`;
        }
      }
      if (i < jobs.length) setTimeout(tick, 0);
    })();
    // prose spans: cycle-leg durations + annuity intensity
    const iAth = prices.v.indexOf(Math.max(...prices.v));
    const legs = [[Date.UTC(2015, 0, 14), Date.UTC(2017, 11, 17)],
                  [Date.UTC(2018, 11, 15), Date.UTC(2021, 10, 8)],
                  [Date.UTC(2022, 10, 21), prices.t[iAth]]];
    $("term-legs").textContent = legs.map(([a, b]) =>
      `${new Date(a).getUTCFullYear()}→${new Date(b).getUTCFullYear()}: ` +
      `${Math.round((b - a) / MS_DAY / 30.44)} months`).join("; ");
    const rNow = G.get7520Rate(lastMs);
    const pct = t => (100 / G.annuityFactor(rNow, t)).toFixed(0);
    $("term-annuity").textContent =
      `${pct(3)}% of corpus per year instead of the two-year term's ${pct(2)}% ` +
      `(at the current ${rNow.toFixed(1)}% §7520 rate)`;
  }

  /* -------------------------------------------- current-reading meaning -- */
  function renderReadingMeaning(comparable) {
    const sigNow = G.entrySignal(metrics, lastMs).score;
    // percentile of today's signal across all halving-era daily readings
    let below = 0, count = 0;
    for (let i = G.lowerBound(prices.t, EPOCH_STARTS[0]); i < prices.t.length; i += 3) {
      count++;
      if (signalFn(prices.t[i]) < sigNow) below++;
    }
    const pct = Math.round(below / count * 100);
    const ddNow = Math.abs(G.interp(metrics.drawdown, lastMs) ?? 0);
    const mature = windows2y(EPOCH_STARTS[2]);
    const lo = ddNow >= 60 ? 60 : ddNow >= 40 ? 40 : ddNow >= 20 ? 20 : 0;
    const hi = lo === 60 ? 999 : lo + 20;
    const bucket = mature.filter(w => w.dd >= lo && w.dd < hi);
    const beat = bucket.length
      ? Math.round(bucket.filter(w => w.mult > w.hurdle).length / bucket.length * 100) : null;
    const med = bucket.length ? median(bucket.map(w => w.mult)) : null;
    $("reading-meaning").innerHTML =
      `<strong>How to read this.</strong> The signal blends five cycle-position metrics into a 0–1
      score (fixed weights, listed under Methodology); 1.00 would be a once-in-history confluence of
      depressed readings. Today's <b>${sigNow.toFixed(2)}</b> is higher than <b>${pct}%</b> of every
      daily reading since the first halving — conditions seen mostly near cycle bottoms, not tops.
      The current drawdown puts new two-year windows in the entry bucket that beat the hurdle
      <b>${beat === null ? "—" : beat + "%"}</b> of the time in the mature era
      (median ${med === null ? "—" : med.toFixed(2) + "x"})` +
      (comparable ? `, and past dates with a similar composite signal produced median
      <b>${comparable}</b> always-roll chains` : "") +
      `. The fuller context — the two years behind us and the modeled forward distributions — is the
      subject of the section above; the standing caveat is that this is a probability statement over
      roughly three and a half cycles, not a prediction.`;
  }

  /* ------------------------------------------------- cycle section ----- */
  function renderCycleSection() {
    const px = prices.v[prices.v.length - 1];
    const ddNow = G.interp(metrics.drawdown, lastMs);
    const realized = G.interp(metrics.realized, lastMs);
    const lth = ctx.lth_cost ? G.interp(ctx.lth_cost, lastMs) : null;
    const mayer = G.interp(metrics.mayer, lastMs);
    const mvrv = G.interp(metrics.mvrv_z, lastMs);
    const iAth = prices.v.indexOf(Math.max(...prices.v));
    const athMs = prices.t[iAth], ath = prices.v[iAth];
    const monthsSinceTop = (lastMs - athMs) / MS_DAY / 30.44;

    // miner arithmetic (subsidy-only, protocol constants)
    const subsidyBtcDay = 450;   // 3.125 BTC x 144 blocks, post-Apr-2024
    $("c-miner").textContent =
      `the protocol mints ${subsidyBtcDay} BTC/day this epoch, so the same coins paid miners ` +
      `~$${(subsidyBtcDay * ath / 1e6).toFixed(0)}M a day at the ${fmtDate(athMs)} top and ` +
      `~$${(subsidyBtcDay * px / 1e6).toFixed(0)}M today — and 30-day miner revenue at past tops ran ` +
      `roughly 4–6× the following bottoms`;

    $("c-now").textContent =
      `As of the snapshot, the price is ${usdFull(px)}, ${ddNow.toFixed(0)}% below the ` +
      `${fmtDate(athMs)} high of ${usdFull(ath)}, ${monthsSinceTop.toFixed(1)} months after it.`;
    $("c-clock").textContent = `${Math.round(monthsSinceTop / 12.4 * 100)}%`;
    $("c-dd").textContent = `${ddNow.toFixed(0)}%`;
    $("c-real").textContent = `${usdFull(realized)}; price ${(px / realized).toFixed(2)}× it`;
    $("c-lth").textContent = lth ? `${usdFull(lth)}; ${(px / lth).toFixed(2)}×` : "—";
    $("c-mayer").textContent = mayer.toFixed(2) + " vs 0.40/0.51/0.71 at past bottoms";
    $("c-mvrv").textContent = mvrv.toFixed(2) + " vs −0.62/−0.51/−0.33";

    // template-bottom range, computed live from fixed historical anchors:
    // depth trend (−84.8, −83.1, −76.6 → linear next), higher-lows moderated
    // (2.0–2.9 × the $15.8k 2022 bottom), cost-basis (0.54–0.78 × realized)
    const depths = [-84.8, -83.1, -76.6];
    const nextDepth = depths[2] + (depths[2] - depths[0]) / 2;   // linear fit on 3 pts
    const depthPrice = ath * (1 + nextDepth / 100);
    const hlLo = 15798 * 2.0, hlHi = 15798 * 2.9;
    const cbLo = 0.54 * realized, cbHi = 0.78 * realized;
    const lo = Math.min(depthPrice, hlLo, cbLo), hi = Math.max(depthPrice, hlHi, cbHi);
    $("c-range").textContent =
      `${usd(Math.round(lo / 1000) * 1000)}–${usd(Math.round(hi / 1000) * 1000)} ` +
      `(depth trend ~${usd(depthPrice)}, higher-lows ${usd(hlLo)}–${usd(hlHi)}, ` +
      `cost-basis ${usd(cbLo)}–${usd(cbHi)})`;
    const bottomMs = athMs + Math.round(12.4 * 30.44) * MS_DAY;
    $("c-when").textContent = new Date(bottomMs).toISOString().slice(0, 7) +
      " if the 12.4-month median clock repeats";

    // scenario table from the published model results
    const NC = window.NC_SCENARIOS;
    if (!NC) { $("scenario-table").innerHTML = "<tr><td colspan=5>scenarios.js not found — run next_cycle_model.py</td></tr>"; return; }
    const DESC = {
      S0_repeat: ["No further decay", "epoch-4 cycle repeats: −77% bottoms, 8× uplegs"],
      S1_continuation: ["Decay continues", "−70% bottom, then 4.3× / 2.9× / 2.2× uplegs"],
      S2_maturation: ["Fast maturation", "−58% bottom, one 2.5× leg, then ~15%/yr drift"],
      S3_cycle_break_flat: ["Cycle breaks, flat", "+5%/yr drift — price grows at the hurdle"],
      S4_secular_bear: ["Secular bear", "−8%/yr drift with one dead-cat rally"],
    };
    const FUND = 5e6;
    $("scenario-table").innerHTML = Object.keys(DESC).map(k => {
      const r2 = NC.results[k]["term2_grace105"];
      return `<tr><td><strong>${DESC[k][0]}</strong></td><td>${DESC[k][1]}</td>
        <td><strong>${usd(r2.median * FUND)}</strong> <span style="color:var(--muted)">(${r2.median.toFixed(2)}×)</span></td>
        <td>${usd(r2.p10 * FUND)} – ${usd(r2.p90 * FUND)}</td>
        <td>${usd(r2.median * FUND * 0.4)}</td></tr>`;
    }).join("");
    const m = NC.mortality_S1["term2_grace105"];
    $("scenario-note").textContent =
      `*40% marginal federal rate applied to the median amount removed from the gross estate, for ` +
      `an estate already above the exemption; state estate tax additional where applicable. ` +
      `Always-roll, $5M seed, 2-year term, 105-day grace, flat 5.0% §7520 (simplification), 300 ` +
      `seeded paths per scenario; transfers counted only when distributed by mid-2038. ` +
      `Mortality-adjusted base case at P(survive)=${m.p_survive}: expected ` +
      `${usd(m.expected_multiple * FUND)}. Three-year-term results in the term section above; ` +
      `full percentiles in next_cycle_results.json.`;
    renderScenarioBars(NC, DESC);
    renderCompareTable();
  }

  function renderCompareTable() {
    const AC = window.AC_COMPARE;
    const el = $("compare-table");
    if (!el || !AC) { if (el) el.innerHTML = "<tr><td colspan=5>compare.js not found — run asset_comparison.py</td></tr>"; return; }
    const FUND = 5e6;
    const LABELS = {
      BTC_BASE_CASE: ["Bitcoin", "decay-continuation cycle · ~40% vol"],
      EQUITY_LIKE: ["U.S. equities", "+8%/yr drift · 16% vol"],
      BALANCED_60_40: ["60/40 portfolio", "+7%/yr drift · 10% vol"],
      GOLD_LIKE: ["Gold", "+5%/yr drift · 15% vol"],
    };
    el.innerHTML = Object.keys(LABELS).map(k => {
      const a = AC.assets[k];
      const hl = k === "BTC_BASE_CASE";
      return `<tr${hl ? ' style="color:var(--text)"' : ""}>
        <td><strong>${LABELS[k][0]}</strong></td><td>${LABELS[k][1]}</td>
        <td>${hl ? "<strong>" : ""}${usd(a.median * FUND)}${hl ? "</strong>" : ""} <span style="color:var(--muted)">(${a.median.toFixed(2)}×)</span></td>
        <td>${usd(a.p10 * FUND)} – ${usd(a.p90 * FUND)}</td>
        <td>${(a.failure_rate_mean * 100).toFixed(0)}%</td></tr>`;
    }).join("");
    // optionality spans
    const ob = AC.optionality?.BTC_BASE_CASE, oe = AC.optionality?.EQUITY_LIKE;
    if (ob && $("opt-first")) {
      $("opt-first").textContent =
        `in ${(ob.first_link.p_success * 100).toFixed(0)}% of modeled base-case paths the first ` +
        `link completes, delivering a median ${usd(ob.first_link.median_remainder_usd_when_success)} ` +
        `to the children's trust — already outside the estate, final, and free to be the last.`;
    }
    if (ob && oe && $("opt-year4")) {
      $("opt-year4").textContent =
        `By the end of year four — two rolls — the median base-case chain has moved ` +
        `${usd(ob.dynasty_usd_by_year4.median)} out of the estate; the same chain on equities, ` +
        `${usd(oe.dynasty_usd_by_year4.median)}.`;
    }
  }

  function renderScenarioBars(NC, DESC) {
    const el = $("scenario-bars");
    if (!el) return;
    const FUND = 5e6;
    const keys = Object.keys(DESC);
    const cells = keys.map(k => NC.results[k]["term2_grace105"]);
    const XMAX = Math.ceil(Math.max(...cells.map(c => c.p90)) * FUND / 1e7) * 10;  // $M, rounded to 10
    const W = 680, ROW = 46, T = 34, L = 168, R = 104;
    const HH = T + keys.length * ROW + 46;
    const x = vUsdM => L + Math.min(vUsdM, XMAX) / XMAX * (W - L - R);
    const M = mult => mult * FUND / 1e6;   // multiple -> $M
    let out = `<text x="${L}" y="13" fill="var(--muted)" font-size="10.5" font-family="var(--mono)">dollars delivered to the children's trust from a $5,000,000 seed</text>
      <text x="${L}" y="25" fill="var(--muted)" opacity="0.75" font-size="9" font-family="var(--mono)">twelve years · 10th–90th percentile of 300 simulated paths per scenario · median marked</text>`;
    // $5M reference: seed merely returned
    out += `<line x1="${x(5)}" x2="${x(5)}" y1="${T}" y2="${HH - 40}" stroke="var(--text)" stroke-width="1" stroke-dasharray="4 4" opacity="0.55"/>
      <text x="${x(5)}" y="${HH - 12}" fill="var(--muted)" font-size="9.5" text-anchor="middle" font-family="var(--mono)">↑ $5M seed returned</text>`;
    for (let g = 10; g <= XMAX; g += 10) {
      out += `<line x1="${x(g)}" x2="${x(g)}" y1="${T}" y2="${HH - 40}" stroke="var(--line)" stroke-width="0.5" opacity="0.5"/>
        <text x="${x(g)}" y="${HH - 26}" fill="var(--muted)" font-size="9.5" text-anchor="middle" font-family="var(--mono)">$${g}M</text>`;
    }
    keys.forEach((k, i) => {
      const c = cells[i];
      const yy = T + i * ROW + ROW / 2;
      const col = c.median >= 2 ? "var(--green)" : c.median >= 1 ? "var(--accent)" : "var(--red)";
      out += `<text x="${L - 10}" y="${yy + 3.5}" fill="var(--text)" font-size="10.5" text-anchor="end" font-family="var(--sans)">${DESC[k][0]}</text>
        <line x1="${x(M(c.p10))}" x2="${x(M(c.p90))}" y1="${yy}" y2="${yy}" stroke="${col}" stroke-width="2.5" opacity="0.45" stroke-linecap="round"/>
        <line x1="${x(M(c.p25))}" x2="${x(M(c.p75))}" y1="${yy}" y2="${yy}" stroke="${col}" stroke-width="8" opacity="0.8" stroke-linecap="round"/>
        <line x1="${x(M(c.median))}" x2="${x(M(c.median))}" y1="${yy - 9}" y2="${yy + 9}" stroke="var(--text)" stroke-width="2.2"/>
        <text x="${W - R + 8}" y="${yy + 3.5}" fill="${col}" font-size="10.5" font-family="var(--mono)">${usd(c.median * FUND)}</text>`;
      if (M(c.p90) > XMAX) {
        out += `<text x="${x(XMAX) + 3}" y="${yy + 3.5}" fill="${col}" font-size="10">›</text>`;
      }
    });
    el.innerHTML = `<svg viewBox="0 0 ${W} ${HH}" role="img" aria-label="Dollars delivered to the children's trust by scenario">${out}</svg>`;
  }

  /* ------------------------------------------------------------ boot --- */
  renderReading(null);
  renderEraUIs();
  renderHurdleFigure();
  renderDecayFigure();
  renderEpochTable();
  renderDdBars();
  fillForwardSpans();
  renderCycleSection();
  renderReadingMeaning(null);
  syncStartUI();
  run();
  setTimeout(scheduleSweepInner, 250);
  setTimeout(renderTermTable, 100);
})();
