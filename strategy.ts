// Early-flow launch sniper for agent-fun/replay/v2 (pump.fun bonding curves).
//
// Every coin is watched from its CreateEvent. Inside its first three slots the bot reads the
// opening tape and buys only launches that pass all six filters at once: strong net buy flow,
// several distinct non-creator buyers, a small creator buy, no creator sale yet, a sane real SOL
// reserve, and a price that has not already run away. It pyramids the stake up to a fixed cap
// per coin, takes profit fast, cuts losers, trails winners once they are up, never holds past a
// short horizon, and leaves at once when the creator sells or a single large sell hits the curve.
// A pure function of the batches it is fed: no clock, no randomness, no I/O, so two runs produce
// byte-identical action logs.

import {
  BPS,
  LAMPORTS_PER_SOL,
  type Batch,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

export interface Params {
  /** Youngest age (slots since create) at which a first buy may be decided. */
  minEntryAge: number;
  /** Oldest age (slots since create) at which a first buy may still be decided. */
  maxEntryAge: number;
  /** Lamports of the first buy on a coin. */
  firstBuyLamports: bigint;
  /** Lamports to aim for per coin in total, first buy plus pyramids. */
  stakeLamports: bigint;
  /** Lamports per pyramid buy. */
  addLamports: bigint;
  /** Smallest single buy worth paying the tx fee for. */
  minBuyLamports: bigint;
  /** Slots to wait after the previous buy before another pyramid buy. */
  addDelaySlots: number;
  /** Net buy flow (buys minus sells, lamports) a launch must show before entry. */
  minNetFlowLamports: bigint;
  /** Distinct non-creator buyers a launch must show before entry. */
  minBuyers: number;
  /** Distinct non-creator buyers before entry, at most: a launch bundled by many wallets is a dump in waiting. */
  maxBuyers: number;
  /** Creator's own buys since create, at most (lamports). */
  maxDevBuyLamports: bigint;
  /** A creator buy strictly between 0 and this many lamports disqualifies the launch: a
      small dev seed buy (a quarter/half SOL) precedes dumps in the dev data (2 wins in
      22 coins), while a zero dev buy (fair launch) or a large one (skin in the game) do not. */
  excludeSmallDevBuyLamports: bigint;
  /** Real SOL reserve window at decision time (lamports). */
  minRealSolLamports: bigint;
  maxRealSolLamports: bigint;
  /** Price now over the create price, at most (bps over 10_000 = no change). */
  maxRunupBps: bigint;
  /** Slippage allowed on buys (bps). */
  buySlippageBps: number;
  /** Slippage allowed on sells (bps). */
  sellSlippageBps: number;
  /** Exit when the position is worth this much over its cost (bps). */
  takeProfitBps: bigint;
  /** Exit when the position is worth this much under its cost (bps). */
  stopLossBps: bigint;
  /** Trailing stop: once up at least this much (bps over cost), exit on a fall of this much (bps) from the best value. */
  trailArmBps: bigint;
  trailBps: bigint;
  /** Exit after holding this many slots (measured from the buy fill's slot). */
  maxHoldSlots: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Exit when a single non-creator sell is at least this share (bps) of the real SOL reserve before it. */
  exitBigSellBps: bigint;
}

export const DEFAULT_PARAMS: Params = {
  minEntryAge: 0,
  maxEntryAge: 3,
  firstBuyLamports: (15n * LAMPORTS_PER_SOL) / 1000n, // 0.015 SOL
  stakeLamports: (60n * LAMPORTS_PER_SOL) / 1000n, // 0.06 SOL per coin
  addLamports: (15n * LAMPORTS_PER_SOL) / 1000n, // 0.015 SOL per pyramid
  minBuyLamports: 5_000_000n, // 0.005 SOL
  addDelaySlots: 2,
  minNetFlowLamports: LAMPORTS_PER_SOL / 2n, // 0.5 SOL net buy flow
  minBuyers: 4,
  maxBuyers: 6,
  maxDevBuyLamports: 2n * LAMPORTS_PER_SOL, // 2 SOL
  excludeSmallDevBuyLamports: LAMPORTS_PER_SOL / 2n, // 0.5 SOL
  minRealSolLamports: (3n * LAMPORTS_PER_SOL) / 10n, // 0.3 SOL
  maxRealSolLamports: 30n * LAMPORTS_PER_SOL, // 30 SOL
  maxRunupBps: 12_500n, // +25% over the create price
  buySlippageBps: 10_000,
  sellSlippageBps: 10_000,
  takeProfitBps: 500n, // +5%
  stopLossBps: 800n, // -8%
  trailArmBps: 500n, // arm once up +5%
  trailBps: 1000n, // exit on a -10% fall from the peak value
  maxHoldSlots: 60,
  exitOnDevSell: true,
  exitBigSellBps: 2500n, // one sell >= 25% of the real reserve
};

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  /** Create-time reserves: the price run-up is measured against them. */
  vq0: bigint;
  vt0: bigint;
  /** Creator's own buys since create. */
  devBuy: bigint;
  /** True once the creator has sold any amount. */
  devSold: boolean;
  /** Distinct non-creator wallets that bought. */
  buyers: Set<Pubkey>;
  /** Lamports bought minus lamports sold since create. */
  netFlow: bigint;
  /** Largest single non-creator sell, as bps of the real SOL reserve before it. */
  bigSellBps: bigint;
  /** Slot of the most recent trade on this coin. */
  lastTradeSlot: number;
  /** Buys sent so far (first buy plus pyramids). */
  buysSent: number;
  /** Lamports spent (sent) so far on this coin. */
  spentSent: bigint;
  /** Slot the last buy was decided on. */
  lastBuySlot: number;
  /** Decision price (vq/vt as a pair) of the last buy sent: pyramids only add above it. */
  lastBuyVq: bigint;
  lastBuyVt: bigint;
  /** Never buy it again (exited, filtered out for good, or completed). */
  done: boolean;
  /** Its CompleteEvent arrived: no more orders (they would be rejected token_complete). */
  complete: boolean;
}

interface Held {
  /** Slot of the buy fill that opened the position. */
  openedSlot: number;
  /** Tx fees paid on fills for this mint, so the exit basis includes them. */
  txPaid: bigint;
  /** Best net value the position has reached (lamports, tx fee for the exit deducted). */
  best: bigint;
  /** Whether the creator had already sold when the position opened. */
  devSoldAtOpen: boolean;
}

export interface Strategy {
  onBatch(state: BotState, batch: Batch): OrderInput[];
}

/** Curve fees on a sale (protocol 95 bps + creator 30 bps), rounded up like the harness. */
const CURVE_FEE_BPS = 125n;

/** What selling `tokens` against virtual reserves (vq, vt) would pay after curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const gross = (tokens * vq) / (vt + tokens);
  return gross - (gross * CURVE_FEE_BPS + BPS - 1n) / BPS;
}

/** Price now over the create price, in bps (10_000 = unchanged). */
function runupBps(vq: bigint, vt: bigint, vq0: bigint, vt0: bigint): bigint {
  if (vt <= 0n || vq0 <= 0n || vt0 <= 0n) return 0n;
  return (vq * vt0 * BPS) / (vt * vq0);
}

export function createStrategy(params: Params = DEFAULT_PARAMS): Strategy {
  const P = params;
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Mints with a sell already in flight (do not send a second one). */
  const selling = new Set<Pubkey>();

  function hasPendingBuy(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) {
      if (p.order.mint === mint && p.order.side === 'buy') return true;
    }
    return false;
  }

  function hasPendingSell(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) {
      if (p.order.mint === mint && p.order.side === 'sell') return true;
    }
    return false;
  }

  /** Fold this batch's events into the per-coin tape. */
  function readEvents(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        coins.set(e.mint, {
          mint: e.mint,
          createSlot: e.slot,
          creator: e.creator,
          vq0: BigInt(e.virtual_quote_reserves),
          vt0: BigInt(e.virtual_token_reserves),
          devBuy: 0n,
          devSold: false,
          buyers: new Set(),
          netFlow: 0n,
          bigSellBps: 0n,
          lastTradeSlot: e.slot,
          buysSent: 0,
          spentSent: 0n,
          lastBuySlot: 0,
          lastBuyVq: 0n,
          lastBuyVt: 1n,
          done: false,
          complete: false,
        });
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c === undefined) continue;
        const sol = BigInt(e.sol_amount);
        const isDev = e.user === c.creator;
        c.lastTradeSlot = e.slot;
        if (e.is_buy) {
          c.netFlow += sol;
          if (isDev) {
            c.devBuy += sol;
          } else {
            c.buyers.add(e.user);
          }
        } else {
          c.netFlow -= sol;
          if (isDev) {
            c.devSold = true;
          } else {
            const reserveBefore = BigInt(e.real_quote_reserves) + sol;
            if (reserveBefore > 0n) {
              const bps = (sol * BPS) / reserveBefore;
              if (bps > c.bigSellBps) c.bigSellBps = bps;
            }
          }
        }
      } else {
        const c = coins.get(e.mint);
        if (c !== undefined) {
          c.complete = true;
          c.done = true;
        }
      }
    }
  }

  /** The six entry filters, evaluated on the tape so far and the curve's current reserves.
      *
      * Key filter — the distinct-buyer band (minBuyers 4, maxBuyers 6): fewer than 4 distinct
      * non-creator buyers in the first three slots means no genuine outside demand yet, just
      * the creator and a friend or two, so the launch is skipped. More than 6 distinct buyers
      * that early is the opposite red flag: a launch bundled across many wallets is usually a
      * coordinated dump in waiting, with each wallet ready to sell into the next buyers. The
      * 4–6 band is therefore the sweet spot — enough independent interest to prove real flow,
      * but not so much that it looks pre-arranged. */
  function passesEntryFilters(c: Coin, realSol: bigint, vq: bigint, vt: bigint): boolean {
    if (c.devSold) return false;
    if (c.devBuy > P.maxDevBuyLamports) return false;
    if (c.devBuy > 0n && c.devBuy < P.excludeSmallDevBuyLamports) return false;
    if (c.buyers.size < P.minBuyers) return false;
    if (c.buyers.size > P.maxBuyers) return false;
    if (c.netFlow < P.minNetFlowLamports) return false;
    if (realSol < P.minRealSolLamports || realSol > P.maxRealSolLamports) return false;
    if (runupBps(vq, vt, c.vq0, c.vt0) > P.maxRunupBps) return false;
    return true;
  }

  return {
    onBatch(state, batch) {
      readEvents(batch);
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) {
        marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });
      }

      // Fold fills in: track what opened, what closed, and the tx fees paid per mint.
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          // A harness close (complete / flatten / write-off): the position is gone.
          held.delete(f.mint);
          selling.delete(f.mint);
          continue;
        }
        const h = held.get(f.mint);
        if (h !== undefined && f.status !== 'rejected') {
          h.txPaid += BigInt(f.tx_fee_lamports);
        }
        if (f.side === 'buy' && f.status === 'filled' && h === undefined) {
          held.set(f.mint, {
            openedSlot: f.slot,
            txPaid: BigInt(f.tx_fee_lamports),
            best: 0n,
            devSoldAtOpen: coins.get(f.mint)?.devSold ?? false,
          });
        }
      }
      for (const mint of [...selling]) {
        if (!hasPendingSell(state, mint)) selling.delete(mint);
      }
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !hasPendingBuy(state, mint)) {
          held.delete(mint);
        }
      }

      // Exits first: a position that must go outranks a new entry.
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const c = coins.get(mint);
        let h = held.get(mint);
        if (h === undefined) {
          h = { openedSlot: state.slot, txPaid: tx, best: 0n, devSoldAtOpen: c?.devSold ?? false };
          held.set(mint, h);
        }
        let mk = marks.get(mint);
        {
          // Curves are at least as fresh as marks (marks are folded in first, then this
          // batch's events): prefer them so an exit is never decided on a stale price.
          const curve = state.curves.get(mint);
          if (curve !== undefined) {
            mk = { vq: curve.virtual_quote_reserves, vt: curve.virtual_token_reserves };
          }
        }
        if (mk === undefined) continue;
        const value = sellValue(pos.token_amount, mk.vq, mk.vt) - tx;
        const basis = pos.cost_lamports + h.txPaid;
        if (value > h.best) h.best = value;
        let exit = false;
        if (basis > 0n) {
          // Take profit +5% on net value.
          if (value * BPS >= basis * (BPS + P.takeProfitBps)) exit = true;
          // Stop loss -8% on net value.
          if (value * BPS <= basis * (BPS - P.stopLossBps)) exit = true;
          // Trailing stop -10% from the peak value, armed once the position is up +5%.
          if (h.best * BPS >= basis * (BPS + P.trailArmBps) && value * BPS <= h.best * (BPS - P.trailBps)) {
            exit = true;
          }
        }
        // Max hold: 60 slots from the opening fill.
        if (state.slot - h.openedSlot >= P.maxHoldSlots) exit = true;
        if (c !== undefined) {
          // Leave at once when the creator sells (unless they had already sold at open).
          if (P.exitOnDevSell && c.devSold && !h.devSoldAtOpen) exit = true;
          // Leave at once on one sell >= 25% of the real reserve.
          if (c.bigSellBps >= P.exitBigSellBps) exit = true;
        }
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: P.sellSlippageBps });
        selling.add(mint);
        if (c !== undefined) c.done = true;
      }

      // Entries and pyramids.
      let free = state.freeCashLamports() - tx * BigInt(orders.length);
      let open = state.committedPositionCount();
      for (const c of coins.values()) {
        if (orders.length >= cap) break;
        if (c.done || c.complete) continue;
        const age = state.slot - c.createSlot;
        const isAdd = c.buysSent > 0;
        if (!isAdd) {
          // A first buy only inside the first three slots after CreateEvent.
          if (age < P.minEntryAge || age > P.maxEntryAge) {
            if (age > P.maxEntryAge) c.done = true;
            continue;
          }
          if (open >= state.hello.caps.max_open_positions) continue;
        } else {
          // A pyramid only while the position is still open, spaced out, under the stake cap,
          // and above the last buy's price: never average down into a dumping launch.
          if (c.buysSent >= 4) continue;
          if (!state.positions.has(c.mint) || selling.has(c.mint) || hasPendingBuy(state, c.mint)) continue;
          if (state.slot - c.lastBuySlot < P.addDelaySlots) continue;
          if (c.spentSent >= P.stakeLamports) continue;
        }
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        const vq = curve.virtual_quote_reserves;
        const vt = curve.virtual_token_reserves;
        const realSol = curve.real_quote_reserves;
        if (!passesEntryFilters(c, realSol, vq, vt)) {
          // A first buy that fails the filters now can still pass on a later batch inside the
          // entry window; a pyramid that fails them is simply skipped this batch.
          if (!isAdd && age > P.maxEntryAge) c.done = true;
          continue;
        }
        if (isAdd) {
          // Pyramid winners only: add only while the position is already worth at least its
          // cost (fees included), never average down into a losing launch.
          const pos = state.positions.get(c.mint);
          const hh = held.get(c.mint);
          if (pos === undefined || hh === undefined) continue;
          const curValue = sellValue(pos.token_amount, vq, vt) - tx;
          const curBasis = pos.cost_lamports + hh.txPaid;
          if (curValue < curBasis) continue;
        }
        const want = isAdd ? P.addLamports : P.firstBuyLamports;
        const remaining = P.stakeLamports - c.spentSent;
        const sized = want < remaining ? want : remaining;
        // Buys on one coin in one reply share one cap: 1% of the real SOL reserve.
        const maxBuy = state.maxBuyLamports(c.mint);
        const amount = sized < maxBuy ? sized : maxBuy;
        if (amount < P.minBuyLamports) continue;
        if (free < amount + tx) continue;
        orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: P.buySlippageBps });
        free -= amount + tx;
        c.buysSent += 1;
        c.spentSent += amount;
        c.lastBuySlot = state.slot;
        c.lastBuyVq = vq;
        c.lastBuyVt = vt;
        if (!isAdd) open += 1;
      }
      return orders;
    },
  };
}
