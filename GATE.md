# GATE.md — what must be green before this repository is entered

Written so that a submission is never spent on something this file could have caught.
Run every command from the repository root. Use Node 22 (the grader's runtime).

## 1. The frame completes on the real dev window

```
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot <repo> --driver process --json
```

`<kit>` is the unpacked `btc-race-24h-20261118-1444-kit`. This replays the kit's dev window against
`main.ts` exactly as the grader does.

What must be true in the JSON it prints:

| row | must be | why |
| --- | --- | --- |
| `status` | `finished` | a run that times out or breaks the protocol is a failed run, not a score |
| `run_completes` (or `working`) | pass / `1` | the bot answered `hello`, every `batch` and `done`, then exited 0 |
| `action_log_sha256` of both executions | identical | both runs must produce byte-identical action logs; a mismatch is unranked |
| `pnl` / `score` | present (any value, including 0) | the frame trades nothing on purpose; a number proves the replay priced it |

A run that exits before `done`, writes anything but replies to stdout, or reads the clock will fail
here. Diagnostics go to stderr, never stdout.

## 1b. The submission decision, in one command

```
node verify.mjs --kit <kit> --bundle <transcripts.tar.gz>
```

`verify.mjs` replays the dev window with `grade-local --driver process`, then prints the five things a
submission decision rests on and exits non-zero if any of them fails:

```
PASS  status finished              finished
PASS  two runs identical           action_log 194ddc25734cb6a3…
PASS  trades >= min_trades (1)     3 trade(s)
PASS  net PnL > 0 (dev gate)       1840000 quote units
PASS  prize eligible               no reasons

net_pnl / trades / drawdown / fees / symbols / result sha256 follow
```

Raw form, if you want the whole JSON:

```
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot <repo> --driver process --worktree --bundle <bundle> --json
```

`--worktree` is not optional on Windows: the commit-copy path builds a `/C:/…` path that git refuses
(`does not appear to be a git repository`). It is also the honest mode locally — it measures the files
as they are, which are the files that get pushed. The bundle names the commit; the replay names the
tree.
then read `status`, `l1.reproduced`, `result.performance.metrics.net_pnl_quote_units`,
`result.performance.metrics.trades`, `result.performance.metrics.max_drawdown`,
`result.eligibility.prize_eligible` and `result.eligibility.reasons`.

**`--bundle` is what removes `no_transcripts` and `coverage_below_gate` from `reasons`.** Without it the
site has nothing to price or credit, and every entry is `prize_eligible:false` no matter how it trades.
The bundle must name the commit being submitted — build it after the last write.
`cost_unpriced` clears the same way; `non_compliant` clears only by meeting the guardrails below.

### The guardrails, quoted from `competition.yaml`

```yaml
guardrails:
  min_trades: 1
  min_distinct_symbols: 0
  max_drawdown: "0.250000000"
caps:
  max_open_positions: 1
  max_orders_per_bar: 16
  max_weight_bps: 10000
fees:
  fee_bps: 4
  slippage_bps: 2
  min_notional_quote_units: "1000000"
```

`min_trades` is a **number, and it is 1** — the scorer tests `trades >= min_trades`, so one fill is
enough for compliance. It is not enough to race, though: `phases[dev].description` says **"only an entry
whose dev grade made a net PnL above 0 races"**. So the real bar is *trade at least once and finish
above 0*, and `max_drawdown` 0.25 is the outer guardrail on how it gets there.

Note `max_open_positions: 1`: at most one position open at a time, which bounds any strategy that
wanted to hold several symbols at once.

## 2. The site's own pre-submit checks

```
node <kit>/cli/makefun.mjs check --repo <repo> --worktree --transcripts <bundle.tar.gz>
```

Every line below must read `pass`:

```
license_osi             LICENSE declares SPDX-License-Identifier: MIT
entrypoint              main.ts at the root selects node22
snapshot                within the intake's caps
transcripts_present     at least one agent session parsed
transcripts_recorded    every session is a harness log (no handed_over)
thinking_wellformed     every message timestamped, every tool result answering its call
thinking_in_window      every timestamp between the opening and the receipt
thinking_reproduces     >= 30% of counted lines authored, and entrypoint has an authored line
thinking_turns          >= 5 assistant turns carrying text or thinking
thinking_priced         every usage record prices to a known model
thinking_revised        a file takes its final content from >= 2 write/edit messages
transcripts_run_record  prompt, harness, version, provider, model and effort all declared
```

The run record needs six things on the `bundle` command, and a missing one writes no bundle at all:

```
--prompt-file <file>        the operator's own words, verbatim
--prompt-origin handed-off --prompt-via "<what started the run>"
--instructions withheld:"harness instruction files sit outside the repository tree"
--mcp none
--harness dsh --harness-version <version> --provider <provider> --model <model> --effort <level>
```

`--effort` is required; `--effort default` is a legal declaration and `none` is a real level.

## 3. The three rows only the site can see

These are `submission` phase in `check` output, and they decide intake, not the score:

- `repo_public` — the GitHub repository is public at the submitted commit.
- `repo_owner` — its owner is the account's GitHub login, or `.makefun/owner.json` names a linked
  wallet (this repository carries one).
- `repo_created_after_open` — GitHub's creation time is at or after the opening, `2026-11-17T06:03Z`.
- `commit_in_repo` — the submitted sha is pushed to a branch.
- `duplicate_snapshot` — the files differ from every earlier entry.
- `repo_readme` — the README carries this competition's three live make.fun badges (not
  `img.shields.io`), links to a make.fun page, and holds no `{owner}` placeholder. The badge URLs in
  this README name `flavyn/btc-race-24h-18nov`: **if the repository is created under another name, those
  two URLs must be changed to match before submitting.**
- `repo_about` — GitHub About has a website on make.fun and the topic `makefun`.

## 4. Before every submission

1. `git status` clean and the commit pushed (the site snapshots the commit, not the worktree).
2. Bundle **after** the last write, and make the bundle name that same commit: a write after bundling
   changes the sha the run record carries.
3. `check` green on the exact commit being submitted.
4. Do not spend an attempt on a repository whose README still has a placeholder badge URL.
