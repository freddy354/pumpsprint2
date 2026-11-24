# Pump.fun Bot Sprint: Make Bot And Win

[![make.fun](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/freddy354/pumpsprint2/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/freddy354/pumpsprint2/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A paper-trading bot for pump.fun style Solana markets, entered in the
[make.fun](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
competition "Pump.fun Bot Sprint: Make Bot And Win".

## Strategy — "early-flow launch sniper"

The bot trades a replay of pump.fun bonding-curve events and only buys in the
first 3 slots after a coin's `CreateEvent`, when early flow is strong:

- net buy flow >= 0.5 SOL in the early window
- 4–6 distinct non-creator buyers (too few = no genuine outside demand;
  too many that early = a bundled launch waiting to dump)
- dev buy <= 2 SOL, and the dev has not sold; dev buys in the 0.01–0.5 SOL
  band are rejected (small dev buys were the worst bucket in dev data)
- real SOL reserve between 0.3 and 30 SOL
- price not run up more than +25% from the create price

Size: 0.015 SOL in, pyramided (only while the position is in profit) to
0.06 SOL per coin. Exits, whichever hits first: take-profit +5%, stop-loss
-8%, trailing stop -10% from peak (armed at +5%), max hold 60 slots, and an
immediate exit when the dev sells or a single sell is >= 25% of the real
reserve. Pacing targets ~30 coins per 6 hours so the 20-coin guardrail is
met with margin.

## Development score (grade-local, dev window)

- Net PnL **+0.0146 SOL** (90% interval -0.011 … +0.045 SOL)
- 75 fills, 37 coins, 37 round trips, win rate 35.1%
- Max drawdown 0.0014 (guardrail <= 0.5)
- Guardrails met: 33 coins with a round trip >= 0.01 SOL (minimum 20)
- Deterministic: L1 regrade reproduced the action log byte for byte

Caveats: the edge is thin (the 90% interval includes 0; at 2x fees the dev
net is -0.0070 SOL) and the top 3 coins contribute 63% of gains. The final
phase runs on a fresh 6-hour window recorded after entries close, so this
dev score is a guide, not a promise.

## Files

- `main.ts` — thin wiring: runs the strategy through the vendored SDK shim.
- `strategy.ts` — the full strategy (entry filters, sizing, exits, pacing).
- `vendor/makefun-bot.ts` — byte-identical copy of the kit's `sdk/ts/makefun-bot.ts`.
