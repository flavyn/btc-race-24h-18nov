/**
 * BTC race entry for agent-fun/bars-replay/v1.
 *
 * The harness sends newline-delimited JSON: hello, one batch per bar, then done.
 * runBars emits exactly one reply per batch, echoing its seq even when there
 * are no orders. Hello and done need no replies; stdout belongs to the wire.
 *
 * Decisions use a bar's close and fill at the next bar's open, subject to fees,
 * slippage and pool impact. Buy notional and position cost include entry fees.
 * Amounts on the wire remain raw integer strings in the declared quote or
 * quantity scale. Marked position value comes from the vendor state helper.
 *
 * The measured 90-bar mean supplies the dip reference, including today's close.
 * An 80 bps dip triggers entry; a 190 bps gain takes profit on the bounce.
 * A 150 bps loss limits damage relative to recorded cost. After either exit,
 * 10 flat bars delay another entry so the strategy waits before buying again.
 * After 600 observed bars without any entry attempt, a 30 bps dip is enough
 * to enter. These measured parameters are fixed rather than tuned at runtime.
 *
 * Both sides allow 200 bps of execution slippage. This is an order tolerance,
 * not a fee or an assumed fill price. Entries spend all available cash and
 * exits sell the complete position; the harness flattens holdings at the end.
 *
 * History includes warm-up closes, while warm-up decisions always stay empty.
 * The strategy uses only replay data and in-memory counters: no clock, random
 * input, external data, environment reads or filesystem access is needed.
 */

import { runBars } from './vendor/makefun-bars.ts';
import type { Batch, BuyOrder, Order, SellOrder, State } from './vendor/makefun-bars.ts';

// Fixed measured parameters, expressed in bars and basis points.
const lookback = 90;
const dipBps = 80;
const takeProfitBps = 190;
const stopBps = 150;
const cooldownBars = 10;
const fallbackBar = 600;
const fallbackDipBps = 30;

// Keep enough closes for the signal without retaining the entire replay.
// pushCount counts all observed symbol bars, independent of history eviction.
const closes: number[] = [];
let pushCount = 0;
let cooldown = 0;
let entrySent = false;

/**
 * Append the current close and retain the most recent 700 observations.
 * The lifetime count also includes warm-up bars and never resets on an exit.
 */
function pushClose(close: number): void {
  closes.push(close);
  pushCount++;
  if (closes.length > 700) closes.shift();
}

/**
 * Average trailing closes from oldest to newest, including the current close.
 * Callers ensure that the requested number of observations is available.
 */
function meanOf(count: number): number {
  let sum = 0;
  for (let i = closes.length - count; i < closes.length; i++) {
    sum += closes[i];
  }
  return sum / count;
}

// Order builders preserve raw integer amounts as decimal strings on the wire.
// Allocate a client ID only when an order is actually being returned.

/**
 * Spend the entire available cash balance, including the entry fee.
 * The slippage limit bounds execution under the harness's market model.
 */
function buyWithCash(state: State, symbol: string): BuyOrder {
  return {
    side: 'buy',
    client_id: state.clientId(),
    symbol,
    notional_quote_units: state.cash.toString(),
    max_slippage_bps: 200,
  };
}

/**
 * Request liquidation of all held units at the next bar's open.
 * The supplied account remains the authority on whether a position is held.
 */
function sellPosition(state: State, symbol: string, qty: bigint): SellOrder {
  return {
    side: 'sell',
    client_id: state.clientId(),
    symbol,
    qty: qty.toString(),
    max_slippage_bps: 200,
  };
}

/**
 * Decide orders after runBars applies the batch's bars and account.
 * Every branch returns an array, including empty decisions during warm-up.
 */
function decideOrders(state: State, batch: Batch): Order[] {
  const symbol = state.hello.symbols[0].symbol;

  // Missing symbol bars neither extend history nor trigger a stale decision.
  const bar = batch.bars.find((bar) => bar.symbol === symbol);
  if (bar === undefined) return [];

  // Every observed close contributes to history and the lifetime bar count.
  const close = Number(state.close(symbol));
  pushClose(close);

  // Warm-up builds history but must never send an order.
  if (state.warmingUp) return [];

  // While holding, compare marked value with fee-inclusive recorded cost.
  const position = state.positions.get(symbol);
  if (position !== undefined) {
    const cost = Number(position.cost);
    const marked = Number(state.value(symbol, position.qty));
    const gainBps = (marked - cost) * 10000 / cost;
    // Stop at a loss of at least 150 bps from cost, including equality.
    if (gainBps <= -stopBps || gainBps >= takeProfitBps) {
      // Set the cooldown on the exit decision, before the next-open fill.
      cooldown = cooldownBars;
      return [sellPosition(state, symbol, position.qty)];
    }
    return [];
  }

  // Flat bars consume the cooldown; the exit decision itself does not.
  if (cooldown > 0) {
    cooldown--;
    return [];
  }

  // Require a complete trailing window before evaluating a dip.
  if (closes.length < lookback) return [];

  // Full-cash entry must meet the market's raw quote minimum notional.
  if (state.cash < BigInt(state.hello.fees.min_notional_quote_units)) return [];

  // Compute the current dip against the trailing mean in its supplied scale.
  const mean = meanOf(lookback);
  const dipBpsNow = (mean - close) * 10000 / mean;

  // The shallower threshold applies only before the first entry is sent.
  // A shallow dip keeps entry signal-driven when a window never dips 80 bps, avoiding zero-trade non-compliance.
  const requiredDip = !entrySent && pushCount >= fallbackBar
    ? fallbackDipBps
    : dipBps;
  if (dipBpsNow < requiredDip) return [];

  // Record the attempt immediately, without waiting for a reported fill.
  entrySent = true;
  return [buyWithCash(state, symbol)];
}

// Delegate framing, account updates and reply serialization to the vendor shim.
// The callback returns exactly the strategy's orders without extra filtering.
await runBars({
  onBatch(state, batch) {
    return decideOrders(state, batch);
  },
});
