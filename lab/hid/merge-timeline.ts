// Merges the HID monitor log with the reload-test log into one timeline (ms relative to the first browser event).
// Consumer-control volume pulses are collapsed into one line each.
// Usage: npm run lab:timeline -- [hid.log] [testlog.jsonl] [fromMs] [toMs]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface Ev {
  t: number;
  kind: 'HID' | 'APP';
  label?: string;
  text: string;
}

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'out');
const hidLog = process.argv[2] ?? path.join(out, 'hid.log');
const browserLog = process.argv[3] ?? path.join(out, 'testlog.jsonl');
const from = Number(process.argv[4] ?? -30000);
const to = Number(process.argv[5] ?? 1e9);

const events: Ev[] = [];
for (const line of fs.readFileSync(hidLog, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^(\d{13}) (\S+) (.*)$/);
  if (m) events.push({ t: Number(m[1]), kind: 'HID', label: m[2], text: m[3]! });
}
for (const line of fs.readFileSync(browserLog, 'utf8').split('\n').filter(Boolean)) {
  const r = JSON.parse(line) as Record<string, unknown>;
  if (['load', 'good', 'dead', 'recovery'].includes(String(r.ev))) {
    const extra = [r.strat, r.ok !== undefined && `ok=${r.ok}`, r.firstSignal != null && `firstSignal=${Math.round(Number(r.firstSignal))}`]
      .filter(Boolean)
      .join(' ');
    events.push({ t: Number(r.abs), kind: 'APP', text: `${r.tag} c${r.cycle} ${r.ev} ${extra}`.trim() });
  }
}
events.sort((a, b) => a.t - b.t);

const t0 = events.find((e) => e.kind === 'APP')?.t ?? events[0]?.t ?? 0;
let up = 0;
let down = 0;
const flushPulses = (): void => {
  if (up || down) console.log(`              [volume pulses: ${up} up, ${down} down]`);
  up = down = 0;
};
for (const e of events) {
  const rel = e.t - t0;
  if (rel < from || rel > to) continue;
  if (e.kind === 'HID' && e.label?.startsWith('col05')) {
    // consumer control: first data byte bit 0 = Volume Up, bit 1 = Volume Down
    if (/01 01 00/.test(e.text)) up++;
    if (/01 02 00/.test(e.text)) down++;
    continue;
  }
  flushPulses();
  console.log(`${String(rel).padStart(7)} ms  ${e.kind === 'HID' ? `HID ${e.label?.slice(0, 5)} ${e.text.slice(0, 40)}` : `APP ${e.text}`}`);
}
flushPulses();
