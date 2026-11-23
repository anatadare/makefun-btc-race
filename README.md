# BTC Race Bot — btc-race-24h-20261123-0511

A trend-following trading bot for the make.fun competition
"Race a BTC trading bot live for 24 hours". It trades Coinbase Wrapped
BTC (cbBTC) against USDC on 1-minute on-chain bars, starting with
$1,000 of paper money, for the highest net PnL over a 24-hour race
window. Simulation only: nothing is traded for real.

## How it runs

`main.ts` (Node 22, standard library only) speaks
`agent-fun/bars-replay/v1`: newline-delimited JSON on stdin/stdout.
The harness sends `hello` once, then one `batch` per minute bar, then
`done`. The bot answers every batch with exactly one `reply` echoing
its `seq`. Long only, no leverage, no network, no wall clock, no file
reads; two runs on the same data produce identical orders.

## Strategy

Slow-trend breakout with a trailing exit, designed to catch multi-hour
moves and sit in cash otherwise (a round trip costs about 26 bps, so
one-minute noise is untradable):

- **Entry (long, full size, 99% of cash):** close above the 120-bar
  EMA, fast (15-bar) EMA above the slow EMA, close breaking above the
  90-bar high by at least 5 bps, with a rise of at least 25 bps over
  the last 15 bars. At least 120 bars of history first.
- **Exits:** a 2% trailing stop below the peak since entry, or a 2.5%
  hard stop below the entry price. No EMA-based exits: they whipsawed
  badly in testing (16 trades, 25% win rate in v1).
- **Cooldown:** 60 bars after an exit before re-entering.
- **Fallback trade:** if no buy has filled by bar 1200, the bot buys a
  small 10% stake so the entry still meets the race guardrail of at
  least 1 trade, even on a window where the trend filter never fires.

## Results (local grade, dev window, 1,440 bars)

| Version | Net PnL | Trades | Max drawdown |
| --- | --- | --- | --- |
| v1 (EMA exits) | -$12.52 | 16 | 3.8% |
| v2 (hard stop + trail only) | +$26.60 | 1 | 2.0% |
| v3 (+ fallback trade) | +$26.60 | 1 | 2.0% |
| v4 (+ EMA slope filter) | +$21.55 | 1 | 2.0% |
| v5 (slope filter removed) | +$26.60 | 1 | 2.0% |

Final: **+$26.60 net PnL** on the dev window, 1 trade, max drawdown
1.96%, guardrails met, two executions byte-identical (deterministic).
Stress-tested offline on a mirrored falling window (-$21.69, guardrail
met) and a flat window (-$0.13, fallback trade fired, guardrail met).

## License

MIT. See LICENSE.
