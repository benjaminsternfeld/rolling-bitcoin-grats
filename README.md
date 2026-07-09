# Rolling Bitcoin GRATs

An interactive article and simulator exploring rolling zeroed-out Grantor Retained
Annuity Trusts (GRATs) funded with Bitcoin — how a chain of short-term GRATs converts
Bitcoin's drawdowns into systematic, gift-tax-free wealth transfers above the IRC §7520
hurdle rate.

## What's here

- **Article** — the legal architecture of the Walton GRAT, the rolling chain mechanic,
  and why Bitcoin's halving-cycle volatility suits the structure, including a live
  hurdle-clearance analysis of every two-year window against its funding month's
  actual §7520 rate
- **Simulator** — runs rolling GRAT chains over real market data (2010–present) with
  actual monthly §7520 rates, modeling estate-tax outcomes, mortality risk, and
  alternative funding scenarios
- **Methodology** — assumptions, data sources, era controls, and limitations

## Implementation

Plain HTML/CSS/JavaScript — no frameworks, no build step, no external requests.
The chain simulation engine (`model.js`) is a line-for-line JavaScript port of a
Python backtesting engine validated by a 26-test suite and a full-precision parity
harness. Historical market data is baked into `data.js` at build time.

By Benjamin Ross Sternfeld. Educational analysis, not legal or tax advice.
