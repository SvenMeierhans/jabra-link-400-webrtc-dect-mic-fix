/*
 * Host page of the Daily Prebuilt simulation.
 *
 * Query parameters:
 *   s       strategy: hook (off-hook before the iframe), idle (wait out the hold time, no WebHID), none (baseline, expect failures)
 *   delays  comma list, cycled: how long the iframe waits before getUserMedia (simulated app boot), default 1000,2000,4500,1000,3000,1500
 *   tag     label for the log
 */
import {
  findHookDevice,
  hookSupported,
  markMicActive,
  onMicStatus,
  prepareDongle,
  releaseDongle,
  requestHookPermission,
} from '../src/index';

interface SimState {
  cycle: number;
  runId?: number;
}

const Q = new URLSearchParams(location.search);
const STRAT = Q.get('s') ?? 'hook';
const TAG = Q.get('tag') ?? 'prebuilt-' + STRAT;
const DELAYS = (Q.get('delays') ?? '1000,2000,4500,1000,3000,1500').split(',').map(Number);
// "localhost" and "127.0.0.1" are different origins on the same server: the iframe cannot be touched by this page.
const FRAME_HOST = location.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
const FRAME_ORIGIN = `${location.protocol}//${FRAME_HOST}:${location.port}`;

const $ = (id: string) => document.getElementById(id)!;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const t = () => Math.round(performance.now());
const state: SimState = JSON.parse(sessionStorage.getItem('ps') ?? '{"cycle":0}');
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

onMicStatus((s) => log('mic-status', { state: s.state, reason: s.reason, etaMs: s.etaMs }), { immediate: false });

async function runCycle(): Promise<void> {
  if (state.cycle >= DELAYS.length) {
    await releaseDongle();
    $('status').textContent = 'DONE';
    log('done');
    return;
  }
  const delay = DELAYS[state.cycle]!;
  $('status').textContent = `Cycle ${state.cycle + 1}/${DELAYS.length}, strategy ${STRAT}, iframe boot delay ${delay} ms`;
  log('load', { delay });

  // The step under test: runs BEFORE the third-party UI exists.
  const prep =
    STRAT === 'none'
      ? { hooked: false, waited: 0 }
      : await prepareDongle({
          hook: STRAT === 'hook',
          waitForIdle: STRAT === 'idle',
          onStatus: (s) => log('status', { ...s }),
        });
  log('prepared', prep);

  const result = new Promise<{ alive: boolean; firstSignal: number | null }>((resolve) => {
    addEventListener('message', (e: MessageEvent) => {
      if (e.origin === FRAME_ORIGIN && e.data?.type === 'result') resolve(e.data);
    });
  });
  const frame = document.createElement('iframe');
  frame.allow = 'microphone';
  frame.src = `${FRAME_ORIGIN}/lab/prebuilt-sim-frame.html?delay=${delay}`;
  document.body.appendChild(frame);

  const r = await result;
  markMicActive(); // as a real integration would do on Daily's `joined-meeting`
  log('prebuilt-result', {
    strat: STRAT,
    delay,
    alive: r.alive,
    firstSignal: r.firstSignal,
    hooked: prep.hooked,
    waited: prep.waited,
    sinceLoadMs: t(),
  });
  await sleep(1500);
  state.cycle++;
  sessionStorage.setItem('ps', JSON.stringify(state));
  location.reload();
}

if (STRAT === 'hook' && !(await findHookDevice())) {
  if (!hookSupported()) {
    $('status').textContent = 'WebHID is not available in this browser.';
  } else {
    $('ask').hidden = false;
    $('status').textContent = 'Waiting for permission ...';
    $('btn').onclick = async () => {
      const d = await requestHookPermission();
      if (d) {
        $('ask').hidden = true;
        void runCycle();
      }
    };
  }
} else {
  void runCycle();
}
