/**
 * Single-symbol dip entry and bounce exit for agent-fun/bars-replay/v1.
 *
 * Input is newline-delimited JSON: one hello, minute-bar batches, then done.
 * The vendor runBars loop replies once to every batch and echoes its seq.
 * Returning [] is a complete decision; hello and done need no reply.
 * Orders decided at a close execute at the following bar's open.
 * Fees, slippage and pool impact therefore belong to the execution model.
 *
 * The fixed development-window parameters are used without runtime tuning:
 * 90 closes give the entry a trailing reference including the current bar.
 * An 80 bps discount to that mean identifies the dip to buy.
 * A 190 bps marked gain over recorded cost identifies the bounce to sell.
 * A 150 bps marked loss bounds the adverse move before requesting an exit.
 * Ten flat bars after an exit decision separate successive entry attempts.
 * After 600 observed bars without an entry, the dip threshold becomes 30 bps.
 * This keeps the delayed entry tied to a measured discount to the mean.
 * Both order sides allow 200 bps slippage for next-open execution.
 * The 0.15 sigma fallback is reserved for insufficient mean history; the
 * complete-window entry rule below prevents trading in that situation.
 *
 * Cash, quantities and order amounts retain their raw integer wire units.
 * Entry spends the full cash balance; exit sells the complete position.
 * Only the first hello symbol is traded. Warm-up bars build history but
 * never generate orders. Missing symbol bars do not advance that history.
 * All decisions use replay state and bounded in-memory storage, with no
 * clock, randomness, environment reads, filesystem access or outside data.
 */

import { runBars } from './vendor/makefun-bars.ts';
import type { Batch, BuyOrder, Order, SellOrder, BarsState as State } from './vendor/makefun-bars.ts';

// Fixed strategy parameters: bars, basis points, and the reserved sigma value.
const LOOKBACK_BARS = 90;
const DIP_BPS = 80;
const TAKE_PROFIT_BPS = 190;
const STOP_BPS = 150;
const COOLDOWN_BARS = 10;
const FALLBACK_BAR = 600;
const FALLBACK_DIP_BPS = 30;
const MAX_SLIPPAGE_BPS = 200;
const FALLBACK_SIGMA = 0.15;

// Retain 700 closes while counting every observed bar, including warm-up.
const HISTORY_LIMIT = 700;
const closes: number[] = [];
let barsSeen = 0;
let cooldown = 0;
let entrySent = false;

/** Append one observed close, evicting only the oldest stored observation. */
function pushClose(close: number): void {
  closes.push(close);
  barsSeen += 1;
  if (closes.length > HISTORY_LIMIT) closes.shift();
}

/** Sum the requested trailing window in chronological order. */
function meanOf(count: number): number {
  let total = 0;
  for (let index = closes.length - count; index < closes.length; index++) {
    total += closes[index];
  }
  return total / count;
}

/** Build a full-cash order; raw quote units remain a decimal integer string. */
function buyWithCash(state: State, symbol: string): BuyOrder {
  return {
    side: 'buy',
    client_id: state.clientId(),
    symbol,
    notional_quote_units: state.cash.toString(),
    max_slippage_bps: MAX_SLIPPAGE_BPS,
  };
}

/** Build a whole-position exit without converting the raw quantity to Number. */
function sellPosition(state: State, symbol: string, qty: bigint): SellOrder {
  return {
    side: 'sell',
    client_id: state.clientId(),
    symbol,
    qty: qty.toString(),
    max_slippage_bps: MAX_SLIPPAGE_BPS,
  };
}

/**
 * Evaluate the current close after the vendor applies bars and account state.
 * Every path returns an order array so the frame can answer every batch.
 */
function decideOrders(state: State, batch: Batch): Order[] {
  const symbol = state.hello.symbols[0].symbol;

  // Skip absent symbol bars before reading a possibly stale vendor close.
  const bar = batch.bars.find((candidate) => candidate.symbol === symbol);
  if (bar === undefined) return [];

  // Include this close in both the trailing history and lifetime bar count.
  const close = Number(state.close(symbol));
  pushClose(close);

  // Warm-up contributes observations while keeping every decision empty.
  if (state.warmingUp) return [];

  // Holding takes precedence over all flat-account entry conditions.
  const position = state.positions.get(symbol);
  if (position !== undefined) {
    const cost = Number(position.cost);
    const marked = Number(state.value(symbol, position.qty));
    const gainBps = (marked - cost) * 10000 / cost;
    // The stop exits the whole position at a loss of 150 bps or more, including equality.
    if (gainBps <= -STOP_BPS || gainBps >= TAKE_PROFIT_BPS) {
      // Start the wait at the exit decision, ahead of its next-open fill.
      cooldown = COOLDOWN_BARS;
      return [sellPosition(state, symbol, position.qty)];
    }
    return [];
  }

  // Each flat cooldown bar consumes one count and cannot initiate an entry.
  if (cooldown > 0) {
    cooldown -= 1;
    return [];
  }

  // A complete mean window is mandatory; no short-history sigma entry is used.
  if (closes.length < LOOKBACK_BARS) return [];

  // The entire cash balance must meet the fee schedule's minimum notional.
  const minimumCash = BigInt(state.hello.fees.min_notional_quote_units);
  if (state.cash < minimumCash) return [];

  // The trailing mean includes the current close, oldest observation first.
  const mean = meanOf(LOOKBACK_BARS);
  const dipBpsNow = (mean - close) * 10000 / mean;

  // Relax the discount only after the timeout and before any entry was sent.
  // Keep entry signal-driven when a whole window never dips 80 bps, avoiding zero-trade non-compliance.
  const required = !entrySent && barsSeen >= FALLBACK_BAR
    ? FALLBACK_DIP_BPS
    : DIP_BPS;
  if (dipBpsNow < required) return [];

  // Record the sent entry immediately, regardless of its eventual fill status.
  entrySent = true;
  return [buyWithCash(state, symbol)];
}

// Keep the vendor frame responsible for serialization and one reply per batch.
await runBars({
  onBatch(state, batch) {
    return decideOrders(state, batch);
  },
});
