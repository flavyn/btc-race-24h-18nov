# btc-race-24h-20261118-1444 — BTC trading bot

[![make.fun competition](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444)
[![make.fun rank](https://make.fun/badge/btc-race-24h-20261118-1444/flavyn/btc-race-24h-18nov/rank.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444)
[![make.fun reward](https://make.fun/badge/btc-race-24h-20261118-1444/flavyn/btc-race-24h-18nov/reward.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444)

A trading bot for make.fun's 24-hour BTC race, written to the `agent-fun/bars-replay/v1` protocol.

The grader runs `node /bot/main.ts` in a container with no network, a read-only `/bot` and an empty
`/tmp`, and speaks the protocol to it over stdin/stdout: one `hello`, then one `batch` per minute of
the window, then `done`. The bot answers exactly one JSON line per batch, on the bar it was given,
and every order it decides fills at the next bar's open.

## Layout

```
main.ts                 the entrypoint: wires the strategy into the protocol shim
vendor/makefun-bars.ts  the kit's protocol shim, byte-identical to sdk/makefun-bars.ts
```

`vendor/makefun-bars.ts` is never edited: it owns the wire (reading stdin, keeping `state`, writing one
reply per batch, validating the reply before it leaves), and `main.ts` supplies the decision.

## How it trades

The strategy lives in `decideOrders` in `main.ts`. It sees, per bar: the universe and its caps and
fees, every symbol's latest bar with its pool depth, the account (cash, positions, equity), the phase
seed, and the fills of the previous bar's orders — including the ones the market refused, with the
reason. It returns at most `caps.max_orders_per_bar` orders.

## Determinism

Every entry runs twice and the two action logs must match byte for byte. The bot never reads the wall
clock (time is the bar time in each batch), the environment, the filesystem or `Math.random`; any
randomness is seeded from `state.hello.seed`.

## Local check

See [GATE.md](GATE.md) for the exact commands and the rows they must show before this repository is
entered.

## License

MIT — see [LICENSE](LICENSE).
