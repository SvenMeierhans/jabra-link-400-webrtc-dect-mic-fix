/*
 * Reproduces and measures the "live but silent" microphone after a reload. Deliberately does NOT use the library:
 * it shows the bug itself.
 *
 * Every cycle: reload -> wait `delay` ms (simulates app boot time) -> getUserMedia -> read the samples with
 * MediaStreamTrackProcessor. If the stream delivers only exact zeros for 2 s it is declared DEAD and the next
 * recovery strategy is tried. Results are posted to /log (collected by the Vite plugin in vite.config.ts) and
 * summarised by `npm run lab:summarize`.
 *
 * Query parameters (all optional):
 *   tag      label written into the log                      (default "run")
 *   delays   comma list of delays in ms, cycled through      (default 0,1000,2000,3000,4500,6000)
 *   strats   recovery strategies, comma list                 (default wait13000,stop0,stop1000,stop3000,stop6000,parallel)
 *              waitN     keep the dead stream open for N ms and see whether it heals
 *              stopN     stop the track, wait N ms, open again
 *              parallel  open a second stream while the dead one stays open
 *   per      samples per strategy before the test ends       (default 3)
 *   max      hard limit of cycles                            (default 66)
 *   device   regular expression for the mic's label; the matching device is opened by deviceId
 *            (default "jabra"; the system default device is used if nothing matches)
 */

interface RunState {
  cycle: number;
  done: Record<string, number>;
  prev: string | null;
  runId?: number;
  hideAt?: number;
}

interface Watch {
  t0: number;
  firstFrame: number | null;
  firstSignal: number | null;
  zeroRunMs: number;
  maxZeroRunMs: number;
  stop: () => void;
}

const Q = new URLSearchParams(location.search);
const TAG = Q.get('tag') ?? 'run';
const MAX_CYCLES = Number(Q.get('max') ?? 66);
const PER_STRAT = Number(Q.get('per') ?? 3);
const DELAYS = (Q.get('delays') ?? '0,1000,2000,3000,4500,6000').split(',').map(Number);
const STRATS = (Q.get('strats') ?? 'wait13000,stop0,stop1000,stop3000,stop6000,parallel').split(',');
const DEVICE_RE = new RegExp(Q.get('device') ?? 'jabra', 'i');
const DEAD_AFTER_MS = 2000; // pure zeros for this long => dead (healthy starts needed up to ~1.4 s)
const AGE_MS = 1500; // a healthy stream runs this much longer before the next reload

const $ = (id: string) => document.getElementById(id)!;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const t = () => Math.round(performance.now());
const state: RunState = JSON.parse(sessionStorage.getItem('st') ?? '{"cycle":0,"done":{},"prev":null}');
state.runId ??= Date.now();

function log(ev: string, data: Record<string, unknown> = {}): void {
  const rec = { tag: TAG, run: state.runId, cycle: state.cycle, ev, t: t(), abs: Date.now(), ...data };
  try {
    navigator.sendBeacon('/log', JSON.stringify(rec));
  } catch {
    /* log sink not available */
  }
  $('out').textContent += ev + ' ' + JSON.stringify(data) + '\n';
}
addEventListener('pagehide', () => sessionStorage.setItem('st', JSON.stringify({ ...state, hideAt: Date.now() })));

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const end = t() + timeoutMs;
  while (t() < end) {
    if (cond()) return true;
    await sleep(40);
  }
  return cond();
}

/** Reads the track's samples: time of the first non-zero sample and the current run of exact zeros. */
function watch(track: MediaStreamTrack): Watch {
  const w: Watch = { t0: t(), firstFrame: null, firstSignal: null, zeroRunMs: 0, maxZeroRunMs: 0, stop: () => {} };
  const reader = new MediaStreamTrackProcessor({ track: track as MediaStreamAudioTrack }).readable.getReader();
  let active = true;
  void (async () => {
    while (active) {
      const r = await reader.read().catch(() => ({ done: true as const, value: undefined }));
      if (r.done || !r.value) break;
      const v = r.value as AudioData;
      const n = v.numberOfFrames;
      const sr = v.sampleRate;
      const buf = new Float32Array(n);
      v.copyTo(buf, { planeIndex: 0, format: 'f32-planar' });
      v.close();
      const nonZero = buf.some((x) => x !== 0);
      const now = t() - w.t0;
      w.firstFrame ??= now;
      if (nonZero) {
        w.firstSignal ??= now;
        w.zeroRunMs = 0;
      } else {
        w.zeroRunMs += (n / sr) * 1000;
        w.maxZeroRunMs = Math.max(w.maxZeroRunMs, w.zeroRunMs);
      }
    }
  })();
  w.stop = () => {
    active = false;
    reader.cancel().catch(() => {});
  };
  return w;
}

const gum = (id: string | null) =>
  navigator.mediaDevices.getUserMedia({ audio: id ? { deviceId: { exact: id } } : true });

interface Recovery {
  ok: boolean;
  tSig: number | null;
  err?: string;
}

async function recover(strat: string, stream: MediaStream, w: Watch, id: string | null): Promise<Recovery> {
  if (strat.startsWith('wait')) {
    await waitFor(() => w.firstSignal !== null, Number(strat.slice(4)));
    return { ok: w.firstSignal !== null, tSig: w.firstSignal };
  }
  if (strat === 'parallel' || strat.startsWith('stop')) {
    if (strat.startsWith('stop')) {
      w.stop();
      stream.getTracks().forEach((x) => x.stop());
      await sleep(Number(strat.slice(4)));
    }
    const s2 = await gum(id);
    const w2 = watch(s2.getAudioTracks()[0]!);
    await waitFor(() => w2.firstSignal !== null, 8000);
    return { ok: w2.firstSignal !== null, tSig: w2.firstSignal };
  }
  throw new Error('unknown strategy ' + strat);
}

function advance(): void {
  state.cycle++;
  sessionStorage.setItem('st', JSON.stringify(state));
  location.reload();
}

async function main(): Promise<void> {
  const finished = state.cycle >= MAX_CYCLES || STRATS.every((s) => (state.done[s] ?? 0) >= PER_STRAT);
  if (finished) {
    $('status').textContent = 'DONE - you can close this window.';
    $('banner').style.display = 'none';
    log('done', { done: state.done });
    return;
  }
  const delay = DELAYS[state.cycle % DELAYS.length]!;
  const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  log('load', {
    navType: nav?.type,
    gapSincePagehideMs: state.hideAt ? Date.now() - state.hideAt : null,
    delay,
    prev: state.prev,
    ua: navigator.userAgent,
  });
  $('status').textContent = `Cycle ${state.cycle + 1}/${MAX_CYCLES} | delay=${delay} ms | recovery samples: ${JSON.stringify(state.done)}`;
  if (delay) await sleep(delay);

  // Find the device once. Labels are only visible after a first permission grant, hence the priming call.
  let id = localStorage.getItem('deviceId');
  if (!id) {
    try {
      (await gum(null)).getTracks().forEach((x) => x.stop());
    } catch (e) {
      log('prime-error', { name: (e as Error).name });
    }
    const devs = await navigator.mediaDevices.enumerateDevices();
    const match = devs.find(
      (d) => d.kind === 'audioinput' && DEVICE_RE.test(d.label) && !['default', 'communications'].includes(d.deviceId),
    );
    if (match) {
      id = match.deviceId;
      localStorage.setItem('deviceId', id);
      log('device', { label: match.label });
    } else {
      log('device-not-found', { regex: String(DEVICE_RE) });
    }
  }

  const t1 = t();
  let stream: MediaStream;
  try {
    stream = await gum(id);
  } catch (e) {
    log('gum-error', { name: (e as Error).name, msg: (e as Error).message });
    state.prev = 'error';
    return advance();
  }
  const track = stream.getAudioTracks()[0]!;
  const gumMs = t() - t1;
  const w = watch(track);
  await waitFor(() => w.firstSignal !== null || w.zeroRunMs >= DEAD_AFTER_MS, 4500);

  if (w.firstSignal !== null) {
    await sleep(AGE_MS);
    const diedLater = w.zeroRunMs >= 1000;
    log('good', {
      delay,
      prev: state.prev,
      gumMs,
      muted: track.muted,
      ready: track.readyState,
      firstFrame: w.firstFrame,
      firstSignal: w.firstSignal,
      diedLater,
    });
    state.prev = diedLater ? 'dead' : 'good';
    return advance();
  }

  // Dead: the track is live but carries only zeros.
  const strat = STRATS.filter((s) => (state.done[s] ?? 0) < PER_STRAT).sort(
    (a, b) => (state.done[a] ?? 0) - (state.done[b] ?? 0),
  )[0]!;
  log('dead', { delay, prev: state.prev, gumMs, muted: track.muted, ready: track.readyState, firstFrame: w.firstFrame, strat });
  let res: Recovery;
  try {
    res = await recover(strat, stream, w, id);
  } catch (e) {
    res = { ok: false, tSig: null, err: (e as Error).name + ': ' + (e as Error).message };
  }
  log('recovery', { strat, ...res });
  state.done[strat] = (state.done[strat] ?? 0) + 1;
  state.prev = res.ok ? 'recovered:' + strat : 'dead:' + strat;
  advance();
}

void main();
