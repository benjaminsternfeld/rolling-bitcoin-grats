/* desk.js — shared logic for the desk pages (signal.html, vintages.html).
   Everything is computed client-side from the committed snapshot (data.js)
   through the same engine the article uses (model.js). The GRAT Entry Index
   is a pure function of that snapshot: any past reading can be reproduced
   from the data.js in that day's git commit. */
"use strict";
(function () {
  const G = window.GRAT;
  const D = window.NH_DATA;

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
  const lastMs = prices.t[prices.t.length - 1];
  const lastPrice = prices.v[prices.v.length - 1];

  /* ------------------------------------------------------- entry index --- */
  // Index = round(100 x composite entry signal). Weights live in model.js
  // (SIGNAL_WEIGHTS) and are documented on the page; the mapping below is the
  // ONLY editorial act, fixed here and never tuned after the fact.
  const REGIMES = [
    [70, "Deep Drawdown Entry", "deep",
     "Conditions in the strongest historical entry bucket: deep discount to the prior high, on-chain valuation compressed."],
    [55, "Favorable Entry", "fav",
     "Meaningfully discounted entry; most comparable historical windows cleared their hurdle."],
    [40, "Neutral", "neutral",
     "Mixed readings: whatever discount exists is not yet paired with the on-chain valuation and cycle-phase levels that marked the strongest historical entries."],
    [25, "Extended", "ext",
     "Price extended above trend; comparable windows show the weakest two-year beat rates."],
    [0, "Peak Risk", "peak",
     "Late-cycle readings; historically the entries most likely to see the first GRAT in a chain fail gracefully."],
  ];
  function regimeFor(index) {
    for (const [floor, word, cls, expl] of REGIMES) if (index >= floor) return { word, cls, expl };
    return { word: "Neutral", cls: "neutral", expl: "" };
  }

  const sig = G.entrySignal(metrics, lastMs);
  const index = Math.round(sig.score * 100);
  const regime = regimeFor(index);

  const ddNow = (() => {
    const d = G.interp(metrics.drawdown, lastMs);
    if (d === null) return null;
    return Math.abs(d) > 1 ? Math.abs(d) : Math.abs(d) * 100;
  })();
  const rateNow = G.get7520Rate(lastMs);

  // percentile: share of halving-era days with a SHALLOWER drawdown than today
  const HALVING0 = Date.UTC(2012, 10, 28);
  function ddPercentile() {
    if (ddNow === null) return null;
    const dd = metrics.drawdown;
    let n = 0, shallower = 0;
    for (let i = 0; i < dd.t.length; i++) {
      if (dd.t[i] < HALVING0) continue;
      const v = Math.abs(dd.v[i]) > 1 ? Math.abs(dd.v[i]) : Math.abs(dd.v[i]) * 100;
      n++; if (v < ddNow) shallower++;
    }
    return n ? 100 * shallower / n : null;
  }

  /* ---------------------------------------------------------- stamp bar --- */
  const fmtUsd0 = x => "$" + Math.round(x).toLocaleString("en-US");
  const fmtDate = ms => new Date(ms).toISOString().slice(0, 10);

  function fillStamp() {
    const el = document.getElementById("stampbar");
    if (!el) return;
    el.innerHTML =
      `<span>${fmtDate(lastMs)}</span>` +
      `<span>BTC <b>${fmtUsd0(lastPrice)}</b></span>` +
      `<span>&sect;7520 <b>${rateNow.toFixed(1)}%</b></span>` +
      `<span>DRAWDOWN <b class="down">-${ddNow === null ? "&mdash;" : ddNow.toFixed(1)}%</b></span>` +
      `<span>ENTRY INDEX <b style="color:var(--accent)">${index}</b></span>`;
  }

  /* ------------------------------------------------------------ analogs --- */
  // Historical dates whose composite signal was closest to today's, spaced
  // at least 180 days apart, each with room for a full 2-year first GRAT.
  function findAnalogs(k = 3) {
    const cutoff = lastMs - Math.trunc(365.25 * 2) * G.MS_DAY;
    const cands = [];
    for (let i = 0; i < prices.t.length; i += 7) {
      const ms = prices.t[i];
      if (ms < HALVING0 || ms > cutoff) continue;
      cands.push([Math.abs(G.entrySignal(metrics, ms).score - sig.score), ms]);
    }
    cands.sort((a, b) => a[0] - b[0]);
    const picked = [];
    for (const [, ms] of cands) {
      if (picked.every(p => Math.abs(p - ms) > 180 * G.MS_DAY)) picked.push(ms);
      if (picked.length === k) break;
    }
    return picked.sort((a, b) => a - b).map(ms => {
      const chain = G.simulateChain(prices, ms, 1e6, { termYears: 2 });
      const g0 = chain.grats.length ? chain.grats[0] : null;
      const sc = G.entrySignal(metrics, ms);
      const dd = G.interp(metrics.drawdown, ms);
      return {
        ms, index: Math.round(sc.score * 100),
        dd: dd === null ? null : (Math.abs(dd) > 1 ? Math.abs(dd) : Math.abs(dd) * 100),
        rate: G.get7520Rate(ms),
        firstStatus: g0 ? g0.status : "n/a",
        firstRemainderPct: g0 && g0.fundValueUsd ? 100 * g0.remainderUsd / g0.fundValueUsd : 0,
        chainMultiple: chain.transferMultiple, nGrats: chain.nGrats,
      };
    });
  }

  /* ----------------------------------------------------- vintage sweep ---- */
  // One chain per calendar month: seeded the first trading day >= the 1st,
  // $1M, 2-year zeroed-out GRATs, annuities re-rolled ("always" policy) —
  // identical mechanics to the article's simulator.
  function monthStarts(fromMs) {
    const out = [];
    const d0 = new Date(fromMs);
    let y = d0.getUTCFullYear(), m = d0.getUTCMonth();
    const lastPossible = lastMs - Math.trunc(365.25 * 2) * G.MS_DAY;
    for (;;) {
      const ms = Date.UTC(y, m, 1);
      if (ms > lastPossible) break;
      if (ms >= fromMs) out.push(ms);
      m++; if (m === 12) { m = 0; y++; }
    }
    return out;
  }

  function sweepVintages(fromMs, onRow, onDone) {
    const starts = monthStarts(fromMs);
    const rows = [];
    let i = 0;
    (function step() {
      const t0 = performance.now();
      while (i < starts.length && performance.now() - t0 < 40) {
        const ms = starts[i++];
        const p = G.priceOnOrAfter(prices, ms);
        if (!p) continue;
        const chain = G.simulateChain(prices, p.t, 1e6, { termYears: 2 });
        const dd = G.interp(metrics.drawdown, p.t);
        const sc = G.entrySignal(metrics, p.t);
        rows.push({
          ms: p.t, price: p.v, rate: G.get7520Rate(p.t),
          dd: dd === null ? null : (Math.abs(dd) > 1 ? Math.abs(dd) : Math.abs(dd) * 100),
          index: Math.round(sc.score * 100),
          nGrats: chain.nGrats, nCompleted: chain.nCompleted, nFailed: chain.nFailed,
          dynastyUsd: chain.dynastyUsd, multiple: chain.transferMultiple,
        });
        if (onRow) onRow(rows.length, starts.length);
      }
      if (i < starts.length) requestAnimationFrame(step);
      else onDone(rows);
    })();
  }

  function bucketStats(rows) {
    const buckets = { deep: [], mid: [], shallow: [] };
    for (const r of rows) {
      if (r.dd === null) continue;
      (r.dd >= 50 ? buckets.deep : r.dd >= 25 ? buckets.mid : buckets.shallow).push(r.multiple);
    }
    const med = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    return {
      deep: { n: buckets.deep.length, median: med(buckets.deep) },
      mid: { n: buckets.mid.length, median: med(buckets.mid) },
      shallow: { n: buckets.shallow.length, median: med(buckets.shallow) },
    };
  }

  window.DESK = {
    metrics, prices, lastMs, lastPrice, rateNow, ddNow, sig, index, regime,
    ddPercentile, fillStamp, findAnalogs, sweepVintages, bucketStats,
    fmtUsd0, fmtDate, HALVING0,
    generated: D.generated,
  };
})();
