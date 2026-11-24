// Pump.fun Bot Sprint entry: the "early-flow launch sniper" strategy.
//
// Wiring: the vendored SDK shim (vendor/makefun-bot.ts, a byte-identical copy of the kit's
// sdk/ts file) drives the replay harness — `runBot` feeds every batch of events/marks/fills
// to the strategy's `onBatch` and submits whatever orders it returns. All decision logic
// lives in strategy.ts: `createStrategy(DEFAULT_PARAMS)` builds the sniper with its tuned
// entry filters and exits; main.ts itself holds no parameters and makes no trading
// decisions, it only wires the strategy into the harness.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

const strategy = createStrategy(DEFAULT_PARAMS);

await runBot({
  onBatch: (state, batch) => strategy.onBatch(state, batch),
});
