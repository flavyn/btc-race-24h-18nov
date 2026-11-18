// verify.mjs — one command that replays the dev window against this repository and prints exactly the
// five things a submission decision needs: status, whether both executions produced the same action
// log, net PnL, trades and drawdown, plus whether the entry is prize-eligible and why not.
//
// It is not part of the graded entry: the grader runs `node /bot/main.ts` and nothing else. This is the
// pre-submit gate, kept beside the code so it cannot drift from it.
//
//   node verify.mjs --kit <unpacked kit> [--bundle <transcripts.tar.gz>] [--json]
//
// --bundle is what makes `no_transcripts` and `coverage_below_gate` leave the eligibility reasons: the
// site will not price or credit an entry whose transcripts it never saw. The bundle must name the same
// commit being submitted; build it after the last write.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));

/** The argument after `--name`, or the fallback. */
function argument(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at !== -1 && process.argv.length > at + 1 ? process.argv[at + 1] : fallback;
}

const kit = argument('kit', process.env.MAKEFUN_KIT ?? '');
const bundle = argument('bundle', '');
const asJson = process.argv.includes('--json');

if (kit === '' || !existsSync(join(kit, 'cli', 'makefun.mjs'))) {
  process.stderr.write('verify: pass --kit <the unpacked btc-race kit> (or set MAKEFUN_KIT)\n');
  process.exit(2);
}
if (bundle !== '' && !existsSync(bundle)) {
  process.stderr.write(`verify: --bundle ${bundle} does not exist\n`);
  process.exit(2);
}

// --worktree measures the files as they are, which is what gets pushed. It is also the only mode that
// works on Windows: the commit-copy path builds a `/C:/...` path that git refuses to open.
const args = [join(kit, 'cli', 'makefun.mjs'), 'grade-local', '--kit', resolve(kit), '--bot', resolve(HERE), '--driver', 'process', '--worktree', '--json'];
if (bundle !== '') args.push('--bundle', resolve(bundle));

/** Run the replay, answering its stdout once it exits. */
function replay() {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, args, { cwd: resolve(HERE), stdio: ['ignore', 'pipe', 'inherit'] });
    const chunks = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.on('error', rejectRun);
    child.on('close', () => resolveRun(Buffer.concat(chunks).toString('utf8')));
  });
}

const output = await replay();
const brace = output.indexOf('{');
if (brace < 0) {
  process.stderr.write(`verify: the replay printed no JSON\n${output.slice(0, 400)}\n`);
  process.exit(1);
}

const report = JSON.parse(output.slice(brace));
const metrics = report.result?.performance?.metrics ?? {};
const eligibility = report.result?.eligibility ?? {};
const reproduced = report.l1?.reproduced === true;
const trades = Number(metrics.trades ?? 0);
const netPnl = BigInt(metrics.net_pnl_quote_units ?? '0');

/** The dev phase's own gate, from the kit: an entry races only with a net PnL above 0 (competition.yaml,
 *  phases[dev].description) and is judged only when it trades at least guardrails.min_trades = 1. */
const gates = [
  { name: 'status finished', ok: report.status === 'finished', detail: String(report.status) },
  { name: 'two runs identical', ok: reproduced, detail: report.l1?.error ?? `action_log ${String(report.action_log_sha256).slice(0, 16)}…` },
  { name: 'trades >= min_trades (1)', ok: trades >= 1, detail: `${trades} trade(s)` },
  { name: 'net PnL > 0 (dev gate)', ok: netPnl > 0n, detail: `${netPnl} quote units` },
  { name: 'prize eligible', ok: eligibility.prize_eligible === true, detail: (eligibility.reasons ?? []).join(', ') || 'no reasons' },
];

if (asJson) {
  process.stdout.write(`${JSON.stringify({ status: report.status, reproduced, action_log_sha256: report.action_log_sha256, net_pnl_quote_units: String(netPnl), trades, drawdown: metrics.max_drawdown, prize_eligible: eligibility.prize_eligible, reasons: eligibility.reasons, gates }, null, 2)}\n`);
} else {
  process.stdout.write(`\nbtc-race replay · ${report.bot?.commit ?? '?'}\n\n`);
  for (const gate of gates) process.stdout.write(`  ${gate.ok ? 'PASS' : 'FAIL'}  ${gate.name.padEnd(26)} ${gate.detail}\n`);
  process.stdout.write(`\n  net_pnl     ${netPnl} quote units\n`);
  process.stdout.write(`  trades      ${trades}\n`);
  process.stdout.write(`  drawdown    ${metrics.max_drawdown}\n`);
  process.stdout.write(`  fees        ${metrics.fees_quote_units}\n`);
  process.stdout.write(`  symbols     ${metrics.distinct_symbols}\n`);
  process.stdout.write(`  result      ${report.result_sha256}\n\n`);
}

process.exit(gates.every((gate) => gate.ok) ? 0 : 1);
