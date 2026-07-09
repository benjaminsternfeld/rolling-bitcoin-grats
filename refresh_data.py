"""
Regenerate data.js from the NewHedge API.

The token is read from the NEWHEDGE_TOKEN environment variable and is NEVER
embedded in the site. In CI it comes from an encrypted GitHub Actions secret.

CI-hardened, fail-closed: if ANY series fails to fetch, comes back empty, or
fails the sanity gates below (freshness, point count, cross-series lag,
plausibility, no regression vs the committed snapshot), the script exits
nonzero and writes nothing — the site keeps serving the previous snapshot.
"""
import json
import os
import re
import sys
import urllib.request
from datetime import datetime, timezone

TOKEN = os.environ.get("NEWHEDGE_TOKEN", "").strip()
if not TOKEN:
    sys.exit("Set NEWHEDGE_TOKEN first (newhedge.io/account/api-settings).")
if not re.fullmatch(r"[A-Za-z0-9_-]+", TOKEN):
    # A malformed token (stray whitespace/control chars) can surface the full
    # request URL in urllib exception text. Refuse before any request is made.
    sys.exit("NEWHEDGE_TOKEN contains unexpected characters — aborting.")

BASE = "https://newhedge.io/api/v2"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/125.0 Safari/537.36")

# (key, url path) — slugs verified against /api/v2/catalog, 2026-06.
SERIES = [
    ("price",    "price/historical"),
    ("drawdown", "metrics/price-drawdown/price_drawdown_btc"),
    ("mvrv_z",   "metrics/mvrv-z-score/mvrv_z"),
    ("mayer",    "metrics/mayer-multiple/mayer_multiple"),
    ("realized", "metrics/realized-price/realized_price"),
    ("nupl",     "metrics/net-unrealized-profit-loss/net_unrealized_profit_loss"),
    # context series (current-reading facts + chart annotations):
    ("pi_fast",  "metrics/pi-cycle-top-indicator/dma_111_btc"),
    ("pi_slow",  "metrics/pi-cycle-top-indicator/dma_350_btc_2"),
    ("lth_cost", "metrics/long-term-holder-realized-price/realized_price_lth"),
    ("vol_1y",   "metrics/volatility-index/price_1y_volatility"),
    ("cagr_2y",  "metrics/cagr/price_cagr_2y"),
]

DAY_MS = 86_400_000
MIN_POINTS = 1000          # every series is 15+ years of daily history
MAX_PRICE_AGE_DAYS = 5     # last price point must be recent
MAX_SERIES_LAG_DAYS = 7    # no metric may trail the price series by more
PRICE_BAND = (1_000, 10_000_000)  # sanity band for the last BTC close


def fetch(path):
    url = f"{BASE}/{path}?api_token={TOKEN}"
    req = urllib.request.Request(url, headers={"User-Agent": UA,
                                               "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def to_pairs(raw):
    """Normalize to [[ms, value], ...] ascending, nulls dropped."""
    if isinstance(raw, dict):
        for v in raw.values():
            if isinstance(v, list) and v and isinstance(v[0], (list, tuple)):
                raw = v
                break
    pairs = [[int(p[0]), float(p[1])] for p in raw
             if isinstance(p, (list, tuple)) and len(p) >= 2
             and p[1] is not None]
    pairs.sort(key=lambda p: p[0])
    # de-dup timestamps (keep last)
    out = []
    for p in pairs:
        if out and out[-1][0] == p[0]:
            out[-1] = p
        else:
            out.append(p)
    return out


def load_previous(path):
    """Parse the committed data.js so a bad API day can't regress the site."""
    try:
        with open(path, encoding="utf-8") as fh:
            txt = fh.read()
        return json.loads(txt[txt.index("{"):txt.rindex("}") + 1])
    except Exception:
        return None


out_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data.js")

data = {"generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "newhedge.io API v2", "series": {}}
failures = []
for key, path in SERIES:
    try:
        pairs = to_pairs(fetch(path))
        if not pairs:
            raise ValueError("empty series")
        # round to keep the file lean: price/realized to cents, rest 4dp
        nd = 2 if key in ("price", "realized") else 4
        data["series"][key] = [[p[0], round(p[1], nd)] for p in pairs]
        first = datetime.fromtimestamp(pairs[0][0] / 1000, tz=timezone.utc)
        last = datetime.fromtimestamp(pairs[-1][0] / 1000, tz=timezone.utc)
        print(f"  {key:9s} {len(pairs):6d} pts  {first.date()} .. {last.date()}")
    except Exception as e:
        failures.append(key)
        # Never echo raw exception text: sanitize so the token can't reach
        # (publicly readable) CI logs even via unusual error messages.
        msg = str(e).replace(TOKEN, "***")
        print(f"  FAIL {key}: {type(e).__name__}: {msg}")

if failures:
    sys.exit(f"Aborting without writing data.js — failed series: {failures}")

# --- sanity gates: refuse to publish implausible or regressed data ---------
problems = []
now_ms = datetime.now(timezone.utc).timestamp() * 1000
price = data["series"]["price"]
price_ts, price_val = price[-1]

if now_ms - price_ts > MAX_PRICE_AGE_DAYS * DAY_MS:
    problems.append(f"price stale: last point is "
                    f"{(now_ms - price_ts) / DAY_MS:.1f} days old")
if not (PRICE_BAND[0] <= price_val <= PRICE_BAND[1]):
    problems.append(f"last price implausible: {price_val}")

for key, series in data["series"].items():
    if len(series) < MIN_POINTS:
        problems.append(f"{key}: only {len(series)} points")
    if price_ts - series[-1][0] > MAX_SERIES_LAG_DAYS * DAY_MS:
        lag = (price_ts - series[-1][0]) / DAY_MS
        problems.append(f"{key}: trails price by {lag:.0f} days")

prev = load_previous(out_path)
if prev:
    for key, series in data["series"].items():
        old = prev.get("series", {}).get(key)
        if not old:
            continue
        if len(series) < 0.95 * len(old):
            problems.append(f"{key}: point count regressed "
                            f"{len(old)} -> {len(series)}")
        if series[-1][0] < old[-1][0]:
            problems.append(f"{key}: last timestamp went backwards")

if problems:
    sys.exit("Aborting without writing data.js — sanity checks failed: "
             + "; ".join(problems))

last_dt = datetime.fromtimestamp(price_ts / 1000, tz=timezone.utc)
print(f"  last BTC close: {last_dt.date()} ${price_val:,.0f}")

with open(out_path, "w") as fh:
    fh.write("// Generated by refresh_data.py — NewHedge data snapshot. "
             "Do not edit by hand.\n")
    fh.write("window.NH_DATA = ")
    json.dump(data, fh, separators=(",", ":"))
    fh.write(";\n")
print(f"wrote {out_path} ({os.path.getsize(out_path):,} bytes)")
