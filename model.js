/*
 * model.js — Rolling Bitcoin GRAT chain engine (faithful JavaScript port of
 * grat_timing.py). All math runs client-side against the baked NewHedge
 * snapshot in data.js; no API calls, no tokens in the browser.
 *
 * Parity notes (kept bit-compatible with the Python engine):
 *  - due dates: fund + trunc(365.25 * k / ppy) days   (int() truncation)
 *  - grace window [due, due+grace] inclusive; trustee pays at the window max
 *  - exhaustion: btcNeeded >= btc pays out everything (graceful failure)
 *  - conservation: child fundBtc is the parent's btcPaid verbatim
 */
"use strict";

const MS_DAY = 86400000;

/* ---------------------------------------------------------------- rates -- */

// IRS sec.7520 rates (%), keyed "YYYY-MM". Transcribed from the IRS tables
// as of 2026-07. VERIFY any month you rely on.
const SEC7520_RATES = {
  "2010-01":3.0,"2010-02":3.4,"2010-03":3.2,"2010-04":3.2,"2010-05":3.4,
  "2010-06":3.2,"2010-07":2.8,"2010-08":2.6,"2010-09":2.4,"2010-10":2.0,
  "2010-11":2.0,"2010-12":1.8,
  "2011-01":2.4,"2011-02":2.8,"2011-03":3.0,"2011-04":3.0,"2011-05":3.0,
  "2011-06":2.8,"2011-07":2.4,"2011-08":2.2,"2011-09":2.0,"2011-10":1.4,
  "2011-11":1.4,"2011-12":1.6,
  "2012-01":1.4,"2012-02":1.4,"2012-03":1.4,"2012-04":1.4,"2012-05":1.6,
  "2012-06":1.2,"2012-07":1.2,"2012-08":1.0,"2012-09":1.0,"2012-10":1.2,
  "2012-11":1.0,"2012-12":1.2,
  "2013-01":1.0,"2013-02":1.2,"2013-03":1.4,"2013-04":1.4,"2013-05":1.2,
  "2013-06":1.2,"2013-07":1.4,"2013-08":2.0,"2013-09":2.0,"2013-10":2.4,
  "2013-11":2.0,"2013-12":2.0,
  "2014-01":2.2,"2014-02":2.4,"2014-03":2.2,"2014-04":2.2,"2014-05":2.4,
  "2014-06":2.2,"2014-07":2.2,"2014-08":2.2,"2014-09":2.2,"2014-10":2.2,
  "2014-11":2.2,"2014-12":2.0,
  "2015-01":2.2,"2015-02":2.0,"2015-03":1.8,"2015-04":2.0,"2015-05":1.8,
  "2015-06":2.0,"2015-07":2.2,"2015-08":2.2,"2015-09":2.2,"2015-10":2.0,
  "2015-11":2.0,"2015-12":2.0,
  "2016-01":2.2,"2016-02":2.2,"2016-03":1.8,"2016-04":1.8,"2016-05":1.8,
  "2016-06":1.8,"2016-07":1.8,"2016-08":1.4,"2016-09":1.4,"2016-10":1.6,
  "2016-11":1.6,"2016-12":1.8,
  "2017-01":2.4,"2017-02":2.6,"2017-03":2.4,"2017-04":2.6,"2017-05":2.4,
  "2017-06":2.4,"2017-07":2.2,"2017-08":2.4,"2017-09":2.4,"2017-10":2.2,
  "2017-11":2.4,"2017-12":2.6,
  "2018-01":2.6,"2018-02":2.8,"2018-03":3.0,"2018-04":3.2,"2018-05":3.2,
  "2018-06":3.4,"2018-07":3.4,"2018-08":3.4,"2018-09":3.4,"2018-10":3.4,
  "2018-11":3.6,"2018-12":3.6,
  "2019-01":3.4,"2019-02":3.2,"2019-03":3.2,"2019-04":3.0,"2019-05":2.8,
  "2019-06":2.8,"2019-07":2.6,"2019-08":2.2,"2019-09":2.2,"2019-10":1.8,
  "2019-11":2.0,"2019-12":2.0,
  "2020-01":2.0,"2020-02":2.2,"2020-03":1.8,"2020-04":1.2,"2020-05":0.8,
  "2020-06":0.6,"2020-07":0.6,"2020-08":0.4,"2020-09":0.4,"2020-10":0.4,
  "2020-11":0.4,"2020-12":0.6,
  "2021-01":0.6,"2021-02":0.6,"2021-03":0.8,"2021-04":1.0,"2021-05":1.2,
  "2021-06":1.2,"2021-07":1.2,"2021-08":1.2,"2021-09":1.0,"2021-10":1.0,
  "2021-11":1.4,"2021-12":1.6,
  "2022-01":1.6,"2022-02":1.6,"2022-03":2.0,"2022-04":2.2,"2022-05":3.0,
  "2022-06":3.6,"2022-07":3.6,"2022-08":3.8,"2022-09":3.6,"2022-10":4.0,
  "2022-11":4.8,"2022-12":5.2,
  "2023-01":4.6,"2023-02":4.6,"2023-03":4.4,"2023-04":5.0,"2023-05":4.4,
  "2023-06":4.2,"2023-07":4.6,"2023-08":5.0,"2023-09":5.0,"2023-10":5.4,
  "2023-11":5.6,"2023-12":5.8,
  "2024-01":5.2,"2024-02":4.8,"2024-03":5.0,"2024-04":5.2,"2024-05":5.4,
  "2024-06":5.6,"2024-07":5.4,"2024-08":5.2,"2024-09":4.8,"2024-10":4.4,
  "2024-11":4.4,"2024-12":5.0,
  "2025-01":5.2,"2025-02":5.4,"2025-03":5.4,"2025-04":5.0,"2025-05":5.0,
  "2025-06":5.0,"2025-07":5.0,"2025-08":4.8,"2025-09":4.8,"2025-10":4.6,
  "2025-11":4.6,"2025-12":4.6,
  "2026-01":4.6,"2026-02":4.6,"2026-03":4.8,"2026-04":4.6,"2026-05":5.0,
  "2026-06":5.0,"2026-07":5.2,
};
const DEFAULT_7520 = 4.6;
const ESCALATION_PCT = 20.0;  // Treas. Reg. 25.2702-3(b)(1)(ii) cap

const SORTED_RATE_KEYS = Object.keys(SEC7520_RATES).sort();

function monthKey(ms) {
  const d = new Date(ms);
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${d.getUTCFullYear()}-${m}`;
}

function get7520Rate(ms, dflt = DEFAULT_7520) {
  const key = monthKey(ms);
  if (key in SEC7520_RATES) return SEC7520_RATES[key];
  // most recent prior month in the table, else default
  let best = null;
  for (const k of SORTED_RATE_KEYS) {
    if (k < key) best = k; else break;
  }
  return best === null ? dflt : SEC7520_RATES[best];
}

/* --------------------------------------------------------- annuity math -- */

function annuityFactor(ratePct, termYears, ppy = 1, escalationPct = 0) {
  if (escalationPct < 0 || escalationPct > ESCALATION_PCT) {
    throw new Error("escalation capped at 20%/yr (Treas. Reg. 25.2702-3(b)(1)(ii))");
  }
  const r = ratePct / 100, n = termYears * ppy;
  const rp = Math.pow(1 + r, 1 / ppy) - 1;
  if (escalationPct === 0) {
    if (rp === 0) return n;
    return (1 - Math.pow(1 + rp, -n)) / rp;
  }
  const g = escalationPct / 100;
  let f = 0;
  for (let k = 1; k <= n; k++) {
    const year = Math.ceil(k / ppy);
    f += Math.pow(1 + g, year - 1) / Math.pow(1 + rp, k);
  }
  return f;
}

function buildSchedule(fundMs, fundUsd, ratePct, termYears, ppy = 1, escalationPct = 0) {
  const factor = annuityFactor(ratePct, termYears, ppy, escalationPct);
  const a1 = fundUsd / factor;
  const g = escalationPct / 100, n = termYears * ppy, out = [];
  for (let k = 1; k <= n; k++) {
    const due = fundMs + Math.trunc(365.25 * k / ppy) * MS_DAY;
    const year = Math.ceil(k / ppy);
    out.push([due, a1 * Math.pow(1 + g, year - 1)]);
  }
  return out;
}

// sec.2036(a): annuity capitalized at the 7520 rate at death, capped at FMV
// (Treas. Reg. 20.2036-1(c)(2)(i); Badgley v. U.S., 957 F.3d 969 (9th Cir. 2020))
function estateInclusion(annualAnnuityUsd, ratePctAtDeath, trustFmvUsd) {
  return Math.min(annualAnnuityUsd / (ratePctAtDeath / 100), trustFmvUsd);
}

/* ----------------------------------------------------------- primitives -- */

// first index with arr[i] >= x  (Python bisect_left)
function lowerBound(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; }
  return lo;
}
// first index with arr[i] > x  (Python bisect_right)
function upperBound(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] <= x) lo = m + 1; else hi = m; }
  return lo;
}

function priceOnOrAfter(prices, ms) {
  const i = lowerBound(prices.t, ms);
  return i < prices.t.length ? { t: prices.t[i], v: prices.v[i] } : null;
}
function priceAt(prices, ms) {
  const p = priceOnOrAfter(prices, ms);
  if (p) return p.v;
  return prices.v.length ? prices.v[prices.v.length - 1] : null;
}
// nearest value at/just before ms (Python _interp)
function interp(series, ms) {
  const i = upperBound(series.t, ms);
  return i ? series.v[i - 1] : null;
}

// Neumaier compensated sum (stands in for Python math.fsum)
function fsum(values) {
  let s = 0, c = 0;
  for (const x of values) {
    const t = s + x;
    c += Math.abs(s) >= Math.abs(x) ? (s - t) + x : (x - t) + s;
    s = t;
  }
  return s + c;
}

// tiny binary min-heap on [sortKeyA, sortKeyB, payload...]
class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  _lt(x, y) { return x[0] !== y[0] ? x[0] < y[0] : x[1] < y[1]; }
  push(item) {
    const a = this.a; a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this._lt(a[i], a[p])) { [a[i], a[p]] = [a[p], a[i]]; i = p; } else break;
    }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < a.length && this._lt(a[l], a[m])) m = l;
        if (r < a.length && this._lt(a[r], a[m])) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]]; i = m;
      }
    }
    return top;
  }
}

/* --------------------------------------------------------- payment loop -- */

function runGratPayments(prices, fundMs, fundBtc, schedule, graceDays = 0, stopMs = null, gratId = 0) {
  let btc = fundBtc;
  const payments = [];
  for (let k = 1; k <= schedule.length; k++) {
    const [due, usdDue] = schedule[k - 1];
    if (stopMs !== null && due >= stopMs) {
      return { payments, btcRemaining: btc, endState: "death", endMs: stopMs, endPrice: priceAt(prices, stopMs) };
    }
    const lo = lowerBound(prices.t, due);
    const hiRaw = graceDays > 0
      ? upperBound(prices.t, due + graceDays * MS_DAY)
      : Math.min(lo + 1, prices.t.length);
    if (lo >= hiRaw) {
      // no price data in the payment window (off the data end / gap)
      const n = prices.t.length;
      return { payments, btcRemaining: btc, endState: "data_end",
               endMs: n ? prices.t[n - 1] : due, endPrice: n ? prices.v[n - 1] : null };
    }
    let hi = hiRaw;
    if (stopMs !== null) hi = Math.min(hi, lowerBound(prices.t, stopMs));
    if (lo >= hi) {
      // window had prices but death removed them all
      return { payments, btcRemaining: btc, endState: "death", endMs: stopMs, endPrice: priceAt(prices, stopMs) };
    }
    // trustee pays at the window's local price high -> fewest BTC out
    // (Treas. Reg. 25.2702-3(b)(4) grace period)
    let j = lo;
    for (let i = lo + 1; i < hi; i++) if (prices.v[i] > prices.v[j]) j = i;
    const payMs = prices.t[j], payPrice = prices.v[j];
    const btcNeeded = usdDue / payPrice;
    if (btcNeeded >= btc) {
      payments.push({ gratId, k, dueMs: due, payMs, payPrice, usdDue,
                      btcPaid: btc, usdValue: btc * payPrice, exhausted: true });
      return { payments, btcRemaining: 0, endState: "failed", endMs: payMs, endPrice: payPrice };
    }
    btc -= btcNeeded;
    payments.push({ gratId, k, dueMs: due, payMs, payPrice, usdDue,
                    btcPaid: btcNeeded, usdValue: usdDue, exhausted: false });
  }
  const termEnd = schedule[schedule.length - 1][0];
  return { payments, btcRemaining: btc, endState: "term_end", endMs: termEnd, endPrice: priceAt(prices, termEnd) };
}

/* ---------------------------------------------------------- chain engine -- */

function annuityYearAmount(schedule, whenMs, ppy) {
  for (const [due, usd] of schedule) if (due >= whenMs) return usd * ppy;
  return schedule[schedule.length - 1][1] * ppy;
}

function firstQualifying(prices, fromMs, signalFn, threshold, deadlineMs, deathMs = null) {
  for (let i = lowerBound(prices.t, fromMs); i < prices.t.length; i++) {
    const d = prices.t[i];
    if (d > deadlineMs) return null;
    if (deathMs !== null && d >= deathMs) return null;
    if (signalFn(d) >= threshold) return d;
  }
  return null;
}

function simulateChain(prices, startMs, fundUsd, opts = {}) {
  const {
    rateLookup = get7520Rate, termYears = 2, ppy = 1, escalationPct = 0,
    graceDays = 0, deathMs = null, refundPolicy = "always",
    signalThreshold = 0.5, signalFn = null, minFundUsd = 0,
  } = opts;
  if (!prices.t.length) throw new Error("empty price series");
  const start = priceOnOrAfter(prices, startMs);
  if (!start) throw new Error("start beyond price data");
  const p0 = start.v;
  if (refundPolicy === "signal" && !signalFn) throw new Error("signal policy needs signalFn");

  const horizon = prices.t[prices.t.length - 1];
  const spawnDeadline = horizon - Math.trunc(365.25 * termYears) * MS_DAY;

  let seq = 0;
  const heap = new Heap();
  const rootBtc = fundUsd / p0;
  heap.push([startMs, seq++, "fund", { parentId: null, fundMs: startMs, fundBtc: rootBtc, fundPrice: p0, pooled: false }]);

  const grats = [], events = [], byId = new Map();
  const unrolledBtc = [], unrolledUsd = [], pool = [];
  let poolPending = false;
  const dynBtc = [], dynUsd = [], estBtc = [], estUsd = [];

  const hold = (btc, usd, ms, gid, note) => {
    unrolledBtc.push(btc); unrolledUsd.push(usd);
    events.push({ ms, kind: "held", gratId: gid, btc, usd, note });
  };
  const routePayment = (grat, pay) => {
    if (pay.btcPaid <= 0) return;
    if (refundPolicy === "always") {
      if (pay.payMs > spawnDeadline) {
        hold(pay.btcPaid, pay.usdValue, pay.payMs, grat.id, "term would overrun price data; stays with grantor");
      } else if (pay.usdValue < minFundUsd) {
        hold(pay.btcPaid, pay.usdValue, pay.payMs, grat.id, "below minimum re-fund size");
      } else {
        heap.push([pay.payMs, seq++, "fund", { parentId: grat.id, fundMs: pay.payMs, fundBtc: pay.btcPaid, fundPrice: pay.payPrice, pooled: false }]);
      }
    } else {
      heap.push([pay.payMs, seq++, "contrib", { srcId: grat.id, btc: pay.btcPaid, usd: pay.usdValue }]);
    }
  };

  while (heap.size) {
    const [ms, , kind, payload] = heap.pop();

    if (kind === "contrib") {
      pool.push(payload.btc);
      events.push({ ms, kind: "held", gratId: payload.srcId, btc: payload.btc, usd: payload.usd,
                    note: "annuity receipt held (signal below threshold)" });
      if (!poolPending) {
        const dep = firstQualifying(prices, ms, signalFn, signalThreshold, spawnDeadline, deathMs);
        if (dep !== null) {
          poolPending = true;
          heap.push([dep, seq++, "fund", { parentId: null, fundMs: dep, fundBtc: null, fundPrice: null, pooled: true }]);
        }
      }
      continue;
    }

    const job = payload;
    if (job.pooled) {
      poolPending = false;
      const pooledBtc = fsum(pool);
      const pp = priceOnOrAfter(prices, job.fundMs);
      if (pooledBtc <= 0) continue;
      if (pooledBtc * pp.v < minFundUsd) {
        events.push({ ms: job.fundMs, kind: "held", gratId: null, btc: pooledBtc, usd: pooledBtc * pp.v,
                      note: "pool below minimum re-fund size; kept holding" });
        continue;
      }
      job.fundBtc = pooledBtc; job.fundPrice = pp.v;
      pool.length = 0;
    }
    if (deathMs !== null && job.fundMs >= deathMs) {
      hold(job.fundBtc, job.fundBtc * job.fundPrice, job.fundMs, job.parentId, "grantor deceased; not re-rolled");
      continue;
    }

    const fundValue = job.fundBtc * job.fundPrice;
    const rate = rateLookup(job.fundMs);
    const gid = grats.length + 1;
    const factor = annuityFactor(rate, termYears, ppy, escalationPct);
    const schedule = buildSchedule(job.fundMs, fundValue, rate, termYears, ppy, escalationPct);
    const a1 = fundValue / factor;
    const parent = byId.get(job.parentId);
    const grat = {
      id: gid, parentId: job.parentId, generation: parent ? parent.generation + 1 : 0,
      fundMs: job.fundMs, fundPrice: job.fundPrice, fundValueUsd: fundValue,
      fundBtc: job.fundBtc, ratePct: rate, termYears, ppy, escalationPct,
      annuityFactor: factor, firstYearAnnuityUsd: a1, schedule,
      // Treas. Reg. 25.7520-3(b)(2): largest annual payment vs 7520 amount
      exhaustionFlag: a1 * Math.pow(1 + escalationPct / 100, termYears - 1) * ppy > fundValue * rate / 100,
      pooled: job.pooled, payments: [], status: "completed", endMs: null,
      remainderBtc: 0, remainderUsd: 0, btcAtHorizon: 0, horizonValueUsd: 0,
      includibleEstateUsd: 0, estateBtc: 0,
    };
    events.push({ ms: job.fundMs, kind: job.pooled ? "pool_fund" : "fund", gratId: gid,
                  btc: job.fundBtc, usd: fundValue, note: `sec.7520 ${rate.toFixed(2)}%` });

    const run = runGratPayments(prices, job.fundMs, job.fundBtc, schedule, graceDays, deathMs, gid);
    grat.payments = run.payments;
    for (const pay of run.payments) {
      events.push({ ms: pay.payMs, kind: "payment", gratId: gid, btc: pay.btcPaid, usd: pay.usdValue,
                    note: pay.exhausted ? "exhausting (paid all remaining BTC)" : `annuity ${pay.k}` });
      routePayment(grat, pay);
    }

    if (run.endState === "term_end") {
      grat.status = "completed"; grat.endMs = run.endMs;
      grat.remainderBtc = run.btcRemaining;
      const ep = run.endPrice !== null ? run.endPrice : job.fundPrice;
      grat.remainderUsd = run.btcRemaining * ep;
      dynBtc.push(grat.remainderBtc); dynUsd.push(grat.remainderUsd);
      if (run.btcRemaining > 0) {
        events.push({ ms: run.endMs, kind: "remainder", gratId: gid, btc: grat.remainderBtc,
                      usd: grat.remainderUsd, note: "to dynasty trust; stops rolling" });
      }
    } else if (run.endState === "failed") {
      grat.status = "failed"; grat.endMs = run.endMs;
      events.push({ ms: run.endMs, kind: "failed", gratId: gid, btc: 0, usd: 0,
                    note: "trust exhausted; remainder $0 (no gift, no loss)" });
    } else if (run.endState === "data_end") {
      grat.status = "active_at_horizon"; grat.endMs = horizon;
      grat.btcAtHorizon = run.btcRemaining;
      grat.horizonValueUsd = run.btcRemaining * prices.v[prices.v.length - 1];
      events.push({ ms: horizon, kind: "horizon", gratId: gid, btc: grat.btcAtHorizon,
                    usd: grat.horizonValueUsd, note: "still in term at end of data" });
    } else { // death
      grat.status = "died_during_term"; grat.endMs = deathMs;
      const pd = run.endPrice !== null ? run.endPrice : job.fundPrice;
      const fmv = run.btcRemaining * pd;
      const annuityNow = annuityYearAmount(schedule, deathMs, ppy);
      grat.includibleEstateUsd = estateInclusion(annuityNow, rateLookup(deathMs), fmv);
      grat.estateBtc = run.btcRemaining;
      estBtc.push(grat.estateBtc); estUsd.push(grat.includibleEstateUsd);
      events.push({ ms: deathMs, kind: "death_inclusion", gratId: gid, btc: grat.estateBtc,
                    usd: grat.includibleEstateUsd, note: "sec.2036(a) inclusion (capped at trust FMV)" });
    }
    grats.push(grat); byId.set(gid, grat);
  }

  // peak concurrency (ends count before starts on the same date)
  const pts = [];
  for (const g of grats) { pts.push([g.fundMs, 1]); pts.push([g.endMs ?? horizon, -1]); }
  pts.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let cur = 0, peak = 0;
  for (const [, d] of pts) { cur += d; if (cur > peak) peak = cur; }

  const count = s => grats.filter(g => g.status === s).length;
  const nCompleted = count("completed"), nFailed = count("failed");
  const dynastyBtc = fsum(dynBtc), dynastyUsd = fsum(dynUsd);
  const horizonBtc = fsum(grats.map(g => g.btcAtHorizon));
  const gUnrolled = fsum(unrolledBtc), heldPool = fsum(pool);
  const estateBtcTotal = fsum(estBtc);
  events.sort((a, b) => a.ms - b.ms || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));

  return {
    grats, events, dynastyBtc, dynastyUsd,
    transferMultiple: fundUsd ? dynastyUsd / fundUsd : 0,
    nGrats: grats.length, nCompleted, nFailed,
    nActiveAtHorizon: count("active_at_horizon"), nDied: count("died_during_term"),
    peakConcurrent: peak,
    failureRate: nFailed / Math.max(1, nFailed + nCompleted),
    grantorUnrolledBtc: gUnrolled, grantorUnrolledUsd: fsum(unrolledUsd),
    heldPoolBtc: heldPool, horizonMs: horizon, deathMs,
    estateInclusionUsd: fsum(estUsd), estateBtc: estateBtcTotal,
    rootFundBtc: rootBtc,
    conservationResidualBtc: rootBtc - fsum([dynastyBtc, horizonBtc, gUnrolled, heldPool, estateBtcTotal]),
  };
}

/* --------------------------------------------------------- entry signal -- */

const HALVINGS = [
  Date.UTC(2012, 10, 28), Date.UTC(2016, 6, 9), Date.UTC(2020, 4, 11),
  Date.UTC(2024, 3, 20), Date.UTC(2028, 2, 1),
];
const SIGNAL_WEIGHTS = { drawdown: 0.30, mvrv_z: 0.20, mayer: 0.20, realized: 0.15, cycle_phase: 0.15 };

const clip01 = x => Math.max(0, Math.min(1, x));

function monthsSinceHalving(ms) {
  let prior = null;
  for (const h of HALVINGS) if (h <= ms) prior = h;
  return prior === null ? 0 : (ms - prior) / MS_DAY / 30.44;
}

function entrySignal(metrics, ms) {
  const comp = {};
  const dd = interp(metrics.drawdown, ms);
  if (dd !== null) {
    const f = Math.abs(dd) > 1 ? Math.abs(dd) / 100 : Math.abs(dd);
    comp.drawdown = clip01(f / 0.75);
  }
  const z = interp(metrics.mvrv_z, ms);
  if (z !== null) comp.mvrv_z = clip01((3.0 - z) / 5.0);
  const m = interp(metrics.mayer, ms);
  if (m !== null) comp.mayer = clip01((1.5 - m) / 1.3);
  const px = interp(metrics.price, ms), rp = interp(metrics.realized, ms);
  if (px !== null && rp) comp.realized = clip01((1.4 - px / rp) / 1.2);
  const msh = monthsSinceHalving(ms);
  comp.cycle_phase = clip01(1 - Math.abs(msh - 12) / 18);

  let totalW = 0;
  for (const k in SIGNAL_WEIGHTS) if (k in comp) totalW += SIGNAL_WEIGHTS[k];
  let score = 0;
  for (const k in comp) if (k in SIGNAL_WEIGHTS) score += comp[k] * SIGNAL_WEIGHTS[k] / (totalW || 1);
  return { score, components: comp, monthsSinceHalving: msh };
}

function makeSignalFn(metrics) {
  const memo = new Map();
  return ms => {
    let v = memo.get(ms);
    if (v === undefined) { v = entrySignal(metrics, ms).score; memo.set(ms, v); }
    return v;
  };
}

/* ------------------------------------------------- policies + sweeps ----- */

const POLICIES = ["always", "seed-gated", "fully-gated"];

function runPolicyChain(metrics, startMs, policy, opts) {
  const prices = metrics.price;
  const lastPossible = prices.t[prices.t.length - 1] - Math.trunc(365.25 * (opts.termYears ?? 2)) * MS_DAY;
  const signalFn = opts.signalFn ?? makeSignalFn(metrics);
  const o = { ...opts, signalFn };
  if (policy === "always") return simulateChain(prices, startMs, opts.fundUsd, { ...o, refundPolicy: "always" });
  const seed = firstQualifying(prices, startMs, signalFn, o.signalThreshold ?? 0.5, lastPossible, o.deathMs ?? null);
  if (seed === null) return null;
  const refund = policy === "seed-gated" ? "always" : "signal";
  return simulateChain(prices, seed, opts.fundUsd, { ...o, refundPolicy: refund });
}

function sweepChains(metrics, opts, stepDays = 30, onProgress = null) {
  const prices = metrics.price;
  const termYears = opts.termYears ?? 2;
  const lastPossible = prices.t[prices.t.length - 1] - Math.trunc(365.25 * termYears) * MS_DAY;
  const starts = [];
  for (let d = prices.t[0]; d <= lastPossible; d += stepDays * MS_DAY) starts.push(d);
  const signalFn = makeSignalFn(metrics);
  const out = {};
  for (const p of POLICIES) {
    out[p] = starts.map((s, i) => {
      if (onProgress) onProgress(p, i, starts.length);
      const r = runPolicyChain(metrics, s, p, { ...opts, signalFn });
      return { startMs: s, multiple: r ? r.transferMultiple : 0, deployed: r !== null, result: r };
    });
  }
  return { starts, byPolicy: out };
}

function quantiles(values) {
  const vs = [...values].sort((a, b) => a - b);
  const n = vs.length;
  if (!n) return { min: 0, p25: 0, median: 0, p75: 0, max: 0, mean: 0 };
  const q = p => {
    const idx = p * (n - 1), lo = Math.floor(idx), hi = Math.ceil(idx);
    return vs[lo] + (vs[hi] - vs[lo]) * (idx - lo);
  };
  return { min: vs[0], p25: q(0.25), median: q(0.5), p75: q(0.75), max: vs[n - 1],
           mean: vs.reduce((a, b) => a + b, 0) / n };
}

/* expose */
window.GRAT = {
  MS_DAY, SEC7520_RATES, DEFAULT_7520, ESCALATION_PCT, HALVINGS, POLICIES,
  get7520Rate, annuityFactor, buildSchedule, estateInclusion,
  lowerBound, upperBound, priceOnOrAfter, priceAt, interp, fsum,
  runGratPayments, simulateChain, entrySignal, makeSignalFn,
  firstQualifying, runPolicyChain, sweepChains, quantiles, monthsSinceHalving,
};
