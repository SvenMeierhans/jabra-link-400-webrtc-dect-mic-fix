/*
 * Reload loop for the userscript: the page itself knows nothing about the fix. Each cycle waits an "app boot" delay,
 * opens the default mic with plain getUserMedia (directly or inside a cross-origin iframe), checks independently whether
 * real audio arrives, and logs what the userscript's HUD reported.
 *
 * Query parameters: mode=direct|frame (default direct), delays=comma list in ms, tag=label for the log.
 */
interface HudEntry {
  state: string;
  ms?: number;
}
interface HudApi {
  hud: { hid: string; offHook: boolean | null; hookNote: string; entries: HudEntry[] };
}

const Q = new URLSearchParams(location.search);
const MODE = Q.get('mode') ?? 'direct';
const TAG = Q.get('tag') ?? 'userscript-' + MODE;
const DELAYS = (Q.get('delays') ?? '1000,2000,4500,1000,3000,1500').split(',').map(Number);
const FRAME_HOST = location.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
const FRAME_ORIGIN = `${location.protocol}//${FRAME_HOST}:${location.port}`;

const $ = (id: string) => document.getElementById(id)!;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const t = () => Math.round(performance.now());
const state: { cycle: number; runId?: number } = JSON.parse(sessionStorage.getItem('uh') ?? '{"cycle":0}');
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

async function openDirect(): Promise<{ alive: boolean; firstSignal: number | null }> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); // wrapped by the userscript
  const track = stream.getAudioTracks()[0]!;
  const t0 = performance.now();
  const reader = new MediaStreamTrackProcessor({ track: track as MediaStreamAudioTrack }).readable.getReader();
  let firstSignal: number | null = null;
  let zeroRunMs = 0;
  while (performance.now() - t0 < 4500 && firstSignal === null && zeroRunMs < 2000) {
    const { value, done } = await reader.read();
    if (done || !value) break;
    const frame = value as AudioData;
    const buf = new Float32Array(frame.numberOfFrames);
    frame.copyTo(buf, { planeIndex: 0, format: 'f32-planar' });
    const { sampleRate, numberOfFrames } = frame;
    frame.close();
    if (buf.some((x) => x !== 0)) firstSignal = Math.round(performance.now() - t0);
    else zeroRunMs += (numberOfFrames / sampleRate) * 1000;
  }
  reader.cancel().catch(() => {});
  (window as unknown as { keepAlive: MediaStream }).keepAlive = stream;
  return { alive: firstSignal !== null, firstSignal };
}

function openInFrame(delay: number): Promise<{ alive: boolean; firstSignal: number | null }> {
  const result = new Promise<{ alive: boolean; firstSignal: number | null }>((resolve) => {
    addEventListener('message', (e: MessageEvent) => {
      if (e.origin === FRAME_ORIGIN && e.data?.type === 'result') resolve(e.data);
    });
  });
  const frame = document.createElement('iframe');
  frame.allow = 'microphone';
  frame.src = `${FRAME_ORIGIN}/lab/prebuilt-sim-frame.html?delay=${delay}`;
  document.body.appendChild(frame);
  return result;
}

if (state.cycle >= DELAYS.length) {
  $('status').textContent = 'DONE';
  log('done');
} else {
  const delay = DELAYS[state.cycle]!;
  $('status').textContent = `Cycle ${state.cycle + 1}/${DELAYS.length}, mode ${MODE}, app boot ${delay} ms`;
  log('load', { delay });
  if (MODE === 'frame') {
    // the frame waits `delay` itself, like a UI that boots inside the iframe
    var r = await openInFrame(delay);
  } else {
    await sleep(delay);
    var r = await openDirect();
  }
  await sleep(600); // let the userscript finish its own check of the track
  const api = (window as unknown as { __jabraMicFix?: HudApi }).__jabraMicFix;
  log('harness-result', {
    mode: MODE,
    delay,
    alive: r.alive,
    firstSignal: r.firstSignal,
    scriptLoaded: Boolean(api),
    hid: api?.hud.hid,
    offHook: api?.hud.offHook,
    hookNote: api?.hud.hookNote,
    hudEntry: api?.hud.entries.at(-1)?.state,
    hudMs: api?.hud.entries.at(-1)?.ms,
  });
  await sleep(1200);
  state.cycle++;
  sessionStorage.setItem('uh', JSON.stringify(state));
  location.reload();
}

export {};
