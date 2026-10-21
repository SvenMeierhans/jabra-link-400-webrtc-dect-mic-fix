// Summarises a reload-test log:
//  - failure rate per delay, once for cycles whose predecessor was healthy and once for those whose predecessor was dead
//  - success of each recovery strategy
// Usage: npm run lab:summarize [-- path/to/testlog.jsonl]   (default: lab/out/testlog.jsonl)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface LogRec {
  ev: string;
  delay?: number;
  prev?: string | null;
  strat?: string;
  ok?: boolean;
  tSig?: number | null;
  firstSignal?: number | null;
}

const file = process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'out', 'testlog.jsonl');
const recs: LogRec[] = fs
  .readFileSync(file, 'utf8')
  .split('\n')
  .filter(Boolean)
  .flatMap((l) => {
    try {
      return [JSON.parse(l) as LogRec];
    } catch {
      return [];
    }
  });

const outcomes = recs.filter((r) => r.ev === 'good' || r.ev === 'dead');
const delays = [...new Set(outcomes.map((r) => r.delay))].sort((a, b) => (a ?? 0) - (b ?? 0));
console.log(`Samples: ${outcomes.length}  (dead: ${outcomes.filter((r) => r.ev === 'dead').length})`);

function table(title: string, filter: (r: LogRec) => boolean): void {
  console.log(`\n${title}`);
  console.log('delay(ms)   n   dead   rate');
  for (const d of delays) {
    const s = outcomes.filter((r) => r.delay === d && filter(r));
    const dead = s.filter((r) => r.ev === 'dead').length;
    console.log(`${String(d).padStart(8)}  ${String(s.length).padStart(2)}  ${String(dead).padStart(4)}   ${s.length ? Math.round((dead / s.length) * 100) + ' %' : '-'}`);
  }
}
table('Failure rate per delay - predecessor healthy (prev = good or recovered:*)', (r) => r.prev === 'good' || (r.prev ?? '').startsWith('recovered'));
table('Failure rate per delay - predecessor dead (prev = dead*)', (r) => (r.prev ?? '').startsWith('dead'));

const rec = recs.filter((r) => r.ev === 'recovery');
console.log('\nRecovery per strategy');
console.log('strategy        n   ok   time to first signal (ms)');
for (const s of [...new Set(rec.map((r) => r.strat))]) {
  const rs = rec.filter((r) => r.strat === s);
  console.log(
    `${(s ?? '').padEnd(14)} ${String(rs.length).padStart(2)}  ${String(rs.filter((r) => r.ok).length).padStart(2)}   ${rs
      .map((r) => (r.ok ? Math.round(r.tSig ?? 0) : 'FAIL'))
      .join(', ')}`,
  );
}
const healthy = outcomes.filter((r) => r.ev === 'good').map((r) => Math.round(r.firstSignal ?? 0));
console.log(`\nfirst signal of healthy starts (ms): ${healthy.join(', ')}`);
