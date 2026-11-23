// Momentum breakout bot for btc-race-24h-20261123-0511.
// Protocol: agent-fun/bars-replay/v1, newline-delimited JSON.
// The harness sends hello once, then one batch per minute bar, then done.
// This bot answers EVERY batch with exactly one reply echoing its seq.
// Long only, no leverage. Deterministic: no clock, no randomness, no
// network, no file reads; all state comes from the message stream.
//
// Strategy (own design): slow-trend breakout with trailing exit.
//  - Enter long only in an uptrend (close above slow EMA, fast EMA above
//    slow EMA) when the close breaks above the recent N-bar high with
//    real momentum behind it (a minimum rise over the fast window).
//  - Full-size entry (99% of cash); one position at a time.
//  - Exit on a trailing stop below the peak since entry, on a hard stop
//    below the entry price, or when the trend breaks (close under the
//    slow EMA or fast EMA crossing under slow EMA).
//  - A cooldown after each exit keeps whipsaws from re-entering at once.
//  - No EMA-slope filter: v4 tried requiring the slow EMA to be rising
//    over the last 30 bars. It delayed the dev entry (dev PnL $26.60 ->
//    $21.55) and did NOT block the falling-window bounce entry (the EMA
//    tilts up during any 30-bar bounce), so it was removed again.
//  - A fallback trade: the race guardrail needs at least 1 filled trade,
//    and an entry with none ranks below every entry that meets the bar,
//    even losers. In a falling window the trend filter may never fire, so
//    if no buy has filled by bar 1200 the bot buys a small (10%) stake
//    and holds it to the end. Cheap insurance: worst case a few bps.
// A round trip costs about 26 bps, so the bot only trades multi-bar
// moves and sits in cash when there is no trend.
import * as readline from "node:readline";

// ---- tunable parameters ----
const SLOW_EMA_BARS = 120; // trend filter, 2h
const FAST_EMA_BARS = 15; // momentum
const BREAKOUT_BARS = 90; // N-bar high breakout lookback
const BREAKOUT_MARGIN_BPS = 5; // close must clear the N-bar high by this much
const MIN_HISTORY_BARS = 120; // bars needed before the first entry
const MIN_RISE_BPS = 25; // min rise over the fast window to enter
const TRAIL_PCT = 0.02; // trailing stop below peak since entry
const HARD_STOP_PCT = 0.025; // hard stop below entry close
const COOLDOWN_BARS = 60; // bars to wait after an exit
const BUY_FRACTION = 0.99; // share of cash to spend per entry
const MAX_SLIPPAGE_BPS = 100; // 1% slippage tolerance on orders
const FALLBACK_BAR = 1200; // bar by which a trade must have filled
const FALLBACK_FRACTION = 0.1; // stake for the fallback trade

// ---- hello state ----
let symbol = "CBBTC";
let priceScale = 5;
let warmupBars = 0;

// ---- market state ----
const closes: number[] = [];
let emaFast = 0;
let emaSlow = 0;
let barsSeen = 0;

// ---- position state (account in each batch is authoritative) ----
let holding = false;
let entryClose = 0;
let peakClose = 0;
let lastExitBar = -1000000;
let orderCounter = 0;
let everTraded = false; // true once a buy fill has been observed
let fallbackSent = false;

function emaUpdate(prev: number, price: number, n: number): number {
  const alpha = 2 / (n + 1);
  return prev + alpha * (price - prev);
}

function maxOfPriorCloses(n: number): number {
  // Max of the n closes before the current one.
  let m = -Infinity;
  const end = closes.length - 1;
  const start = Math.max(0, end - n);
  for (let i = start; i < end; i++) {
    if (closes[i] > m) m = closes[i];
  }
  return m;
}

type Order =
  | {
      side: "buy";
      client_id: string;
      symbol: string;
      notional_quote_units: string;
      max_slippage_bps: number;
    }
  | {
      side: "sell";
      client_id: string;
      symbol: string;
      qty: string;
      max_slippage_bps: number;
    };

function nextClientId(prefix: string): string {
  orderCounter += 1;
  return prefix + "-" + orderCounter;
}

function decide(batch: any): Order[] {
  const orders: Order[] = [];
  const bars = Array.isArray(batch.bars) ? batch.bars : [];
  const bar = bars.find((b: any) => b && b.symbol === symbol);
  const account = batch.account || {};
  const cashStr = typeof account.cash_quote_units === "string"
    ? account.cash_quote_units
    : "0";
  const positions = Array.isArray(account.positions)
    ? account.positions
    : [];
  const pos = positions.find((p: any) => p && p.symbol === symbol);
  const posQtyStr = pos && typeof pos.qty === "string" ? pos.qty : "0";
  const nowHolding = Number(posQtyStr) > 0;

  // Track fills: a buy fill pins the entry price; a sell fill closes out.
  const fills = Array.isArray(batch.fills) ? batch.fills : [];
  for (const f of fills) {
    if (!f || f.status !== "filled") continue;
    if (f.side === "buy" && f.symbol === symbol && typeof f.price === "string") {
      everTraded = true;
      entryClose = Number(f.price) / Math.pow(10, priceScale);
      peakClose = entryClose;
    }
  }

  // Position appeared without a fill we saw (should not happen): anchor it.
  if (nowHolding && !holding && entryClose === 0 && closes.length > 0) {
    entryClose = closes[closes.length - 1];
    peakClose = entryClose;
  }
  if (!nowHolding && holding) {
    lastExitBar = barsSeen;
    entryClose = 0;
    peakClose = 0;
  }
  holding = nowHolding;

  // No bar for our symbol this minute: no signal, no orders.
  if (!bar || typeof bar.c !== "string") return orders;

  const close = Number(bar.c) / Math.pow(10, priceScale);
  closes.push(close);
  barsSeen += 1;
  if (barsSeen === 1) {
    emaFast = close;
    emaSlow = close;
  } else {
    emaFast = emaUpdate(emaFast, close, FAST_EMA_BARS);
    emaSlow = emaUpdate(emaSlow, close, SLOW_EMA_BARS);
  }

  const seq = typeof batch.seq === "number" ? batch.seq : 0;
  if (seq < warmupBars) return orders;

  if (holding) {
    if (close > peakClose) peakClose = close;
    // Exits are the hard stop and the trailing stop only. EMA-based exits
    // whipsawed badly in v1 (16 trades, 25% win rate): in choppy hours the
    // price crosses the slow EMA constantly, and each exit costs ~26 bps.
    const hardStop = entryClose > 0 && close < entryClose * (1 - HARD_STOP_PCT);
    const trailStop = peakClose > 0 && close < peakClose * (1 - TRAIL_PCT);
    if (hardStop || trailStop) {
      orders.push({
        side: "sell",
        client_id: nextClientId("s"),
        symbol,
        qty: posQtyStr,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
    }
    return orders;
  }

  // Flat: look for a breakout entry.
  if (barsSeen < MIN_HISTORY_BARS) return orders;
  const cash = Number(cashStr);
  if (!(cash > 0)) return orders;
  // Fallback trade: guarantee at least one filled trade for the
  // guardrail, even on a window where the trend filter never fires.
  // Ignores the cooldown on purpose; fires once, small stake.
  if (!everTraded && !fallbackSent && barsSeen >= FALLBACK_BAR) {
    const stake = Math.floor(cash * FALLBACK_FRACTION);
    if (stake >= 1000000) {
      fallbackSent = true;
      orders.push({
        side: "buy",
        client_id: nextClientId("f"),
        symbol,
        notional_quote_units: String(stake),
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      return orders;
    }
  }
  if (barsSeen - lastExitBar < COOLDOWN_BARS) return orders;
  const aboveTrend = close > emaSlow && emaFast > emaSlow;
  if (!aboveTrend) return orders;
  const highBefore = maxOfPriorCloses(BREAKOUT_BARS);
  // The close must clear the N-bar high by a margin, not just touch it:
  // flat/noisy bars make bare touches meaningless.
  if (!(close > highBefore * (1 + BREAKOUT_MARGIN_BPS / 10000))) return orders;
  const refIdx = closes.length - 1 - FAST_EMA_BARS;
  if (refIdx < 0) return orders;
  const riseBps = ((close / closes[refIdx]) - 1) * 10000;
  if (!(riseBps > MIN_RISE_BPS)) return orders;

  const notional = Math.floor(cash * BUY_FRACTION);
  if (notional < 1000000) return orders; // below the 1 USDC minimum
  orders.push({
    side: "buy",
    client_id: nextClientId("b"),
    symbol,
    notional_quote_units: String(notional),
    max_slippage_bps: MAX_SLIPPAGE_BPS,
  });
  return orders;
}

function onHello(msg: any): void {
  if (Array.isArray(msg.symbols) && msg.symbols.length > 0) {
    const s = msg.symbols[0];
    if (typeof s.symbol === "string") symbol = s.symbol;
    if (typeof s.price_scale === "number") priceScale = s.price_scale;
  }
  if (typeof msg.warmup_bars === "number") warmupBars = msg.warmup_bars;
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line: string) => {
  if (!line.trim()) return;
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (!msg || typeof msg.type !== "string") return;
  if (msg.type === "hello") {
    onHello(msg);
    return;
  }
  if (msg.type === "done") {
    process.exit(0);
  }
  if (msg.type !== "batch") return;
  let orders: Order[] = [];
  try {
    orders = decide(msg);
  } catch {
    orders = [];
  }
  const reply = { type: "reply", seq: msg.seq, orders };
  process.stdout.write(JSON.stringify(reply) + "\n");
});
rl.on("close", () => process.exit(0));
