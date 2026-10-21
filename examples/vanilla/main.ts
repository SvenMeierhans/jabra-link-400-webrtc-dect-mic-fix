import {
  acquireWorkingMic,
  findHookDevice,
  hookSupported,
  onMicStatus,
  releaseMic,
  requestHookPermission,
  type MicStatus,
} from '../../src/index';

const $ = (id: string) => document.getElementById(id)!;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const Q = new URLSearchParams(location.search);
const LOOP = Number(Q.get('loop') ?? 0);
const DELAYS = [1000, 2000, 4500, 1000, 3000, 1500];
const state: { n: number } = JSON.parse(sessionStorage.getItem('demo') ?? '{"n":0}');
let micTrack: MediaStreamTrack | null = null;

function say(msg: string): void {
  $('out').textContent += `${new Date().toLocaleTimeString()}  ${msg}\n`;
}
function post(ev: string, data: Record<string, unknown>): void {
  if (Q.get('log') === '1') navigator.sendBeacon('/log', JSON.stringify({ tag: 'demo', ev, cycle: state.n, abs: Date.now(), ...data }));
}

// The hint a real frontend would show: appears only if starting takes longer than 400 ms, closes on ready.
let hintTimer: number | undefined;
let countdown: number | undefined;
function renderHint(s: MicStatus): void {
  const box = $('hint');
  window.clearTimeout(hintTimer);
  window.clearInterval(countdown);
  const busy = s.state === 'starting' || s.state === 'waiting';
  if (!busy) {
    box.style.display = 'none';
    return;
  }
  const text = () => {
    if (s.state === 'waiting' && s.etaAt) return `Reconnecting your headset ... about ${Math.max(0, Math.ceil((s.etaAt - Date.now()) / 1000))} s`;
    return 'Starting your microphone ...';
  };
  hintTimer = window.setTimeout(() => {
    box.textContent = text();
    box.style.display = 'block';
    if (s.state === 'waiting') countdown = window.setInterval(() => (box.textContent = text()), 250);
  }, s.state === 'waiting' ? 0 : 400);
}
onMicStatus((s) => {
  say('status ' + JSON.stringify({ state: s.state, reason: s.reason, etaMs: s.etaMs }));
  renderHint(s);
});

async function start(): Promise<void> {
  $('result').textContent = 'Opening the microphone ...';
  const t0 = performance.now();
  const { track, healthy, attempts } = await acquireWorkingMic();
  micTrack = track;
  const ms = Math.round(performance.now() - t0);
  $('result').textContent = healthy ? `Mic OK after ${ms} ms (attempts: ${attempts})` : `Mic is SILENT after ${ms} ms (attempts: ${attempts})`;
  say($('result').textContent);
  post('result', { healthy, attempts, ms });
}

$('grant').onclick = async () => {
  const d = await requestHookPermission();
  say(d ? 'WebHID access granted' : 'WebHID access cancelled');
};
$('start').onclick = () => void start();
$('stop').onclick = () => {
  if (micTrack) {
    releaseMic(micTrack);
    micTrack = null;
    say('mic released');
  }
};
$('reload').onclick = () => location.reload();

say(
  hookSupported()
    ? (await findHookDevice())
      ? 'WebHID: access already granted'
      : 'WebHID: not granted yet (button 1)'
    : 'WebHID not available - fallback mode only',
);

if (LOOP) {
  if (state.n >= LOOP) {
    say('loop finished');
    post('done', {});
  } else {
    const delay = DELAYS[state.n % DELAYS.length]!;
    say(`loop ${state.n + 1}/${LOOP}: simulated app boot ${delay} ms`);
    await sleep(delay);
    await start();
    await sleep(1500);
    state.n++;
    sessionStorage.setItem('demo', JSON.stringify(state));
    location.reload();
  }
}
