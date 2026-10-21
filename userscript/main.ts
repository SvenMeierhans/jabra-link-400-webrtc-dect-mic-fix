/*
 * Userscript for trying the fix on a live site BEFORE changing the site's code (Tampermonkey / Violentmonkey).
 *
 * What it does, in the page's own JS context (@grant none):
 *  1. Sends HID "off-hook" to the dongle as early as possible (needs the one-time WebHID grant, button in the HUD).
 *     Off-hook acts on the dongle, so it also helps when the page's UI runs in a cross-origin iframe (Daily Prebuilt).
 *  2. Wraps navigator.mediaDevices.getUserMedia. It never changes the stream; it only waits briefly for the off-hook
 *     write to finish before an audio request is passed on, and it watches a CLONE of the resulting track.
 *  3. Shows a small HUD: grant state, off-hook state, and for every mic the page opens whether real audio arrived
 *     ("alive after 78 ms") or only digital silence. With "auto-fix" on, a silent mic gets an on-/off-hook toggle,
 *     which revived it in testing after about 1.3 s.
 *
 * In iframes (e.g. Prebuilt) WebHID is blocked by the browser, so the script only watches there and reports to the top
 * frame, which shows the entry and performs the fix.
 */
import { findHookDevice, getLastHookInfo, hookSupported, requestHookPermission, setOffHook } from '../src/hook';

const IS_TOP = window === window.top;
const MSG = 'jabra-mic-fix';
const SETTINGS_KEY = 'jabra-mic-fix:settings';
const FRAME_ID = Math.random().toString(36).slice(2, 8);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type EntryState = 'checking' | 'alive' | 'silent' | 'fixed' | 'dead' | 'unmeasurable';
interface Entry {
  key: string;
  at: number;
  label: string;
  state: EntryState;
  ms?: number;
  inFrame: boolean;
}

interface Settings {
  autoFix: boolean;
  collapsed: boolean;
}

function loadSettings(): Settings {
  try {
    return { autoFix: true, collapsed: false, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Partial<Settings>) };
  } catch {
    return { autoFix: true, collapsed: false };
  }
}
const settings = loadSettings();
function saveSettings(): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* storage unavailable */
  }
}

const hud = {
  hid: 'unknown' as 'unknown' | 'unsupported' | 'not-granted' | 'granted',
  offHook: null as boolean | null,
  hookNote: '',
  entries: [] as Entry[],
};

/* ---------------------------------------------------------------------------------------------- hook */

let hookReady: Promise<boolean> = Promise.resolve(false);

async function initHook(): Promise<boolean> {
  if (!hookSupported()) {
    hud.hid = 'unsupported';
    return false;
  }
  if (!(await findHookDevice())) {
    hud.hid = 'not-granted';
    render();
    return false;
  }
  hud.hid = 'granted';
  return sendHook(true);
}

async function sendHook(on: boolean): Promise<boolean> {
  const ok = await setOffHook(on);
  const info = getLastHookInfo();
  hud.offHook = ok ? on : hud.offHook;
  hud.hookNote = ok ? `${on ? 'off-hook' : 'on-hook'} sent (${info?.ms ?? '?'} ms)` : `failed: ${info?.err ?? 'unknown'}`;
  render();
  return ok;
}

async function toggleHook(): Promise<boolean> {
  await sendHook(false);
  await sleep(150);
  return sendHook(true);
}

/* ---------------------------------------------------------------------------------------------- measuring */

/** ms until the first non-zero sample arrives, or null after timeoutMs (pure digital silence). */
async function firstSignal(track: MediaStreamTrack, timeoutMs: number): Promise<number | null> {
  const t0 = performance.now();
  const reader = new MediaStreamTrackProcessor({ track: track as MediaStreamAudioTrack }).readable.getReader();
  try {
    while (performance.now() - t0 < timeoutMs) {
      const r = await Promise.race([reader.read(), sleep(Math.max(0, timeoutMs - (performance.now() - t0))).then(() => null)]);
      if (!r || r.done || !r.value) break;
      const frame = r.value as AudioData;
      const buf = new Float32Array(frame.numberOfFrames);
      frame.copyTo(buf, { planeIndex: 0, format: 'f32-planar' });
      frame.close();
      if (buf.some((x) => x !== 0)) return Math.round(performance.now() - t0);
    }
    return null;
  } finally {
    reader.cancel().catch(() => {});
  }
}

/** Probes a clone, so the page's own track is never touched. */
async function probe(track: MediaStreamTrack, timeoutMs: number): Promise<number | null> {
  const clone = track.clone();
  try {
    return await firstSignal(clone, timeoutMs);
  } finally {
    clone.stop();
  }
}

let seq = 0;
async function inspect(track: MediaStreamTrack): Promise<void> {
  const entry: Entry = { key: `${FRAME_ID}:${++seq}`, at: Date.now(), label: track.label || 'microphone', state: 'checking', inFrame: !IS_TOP };
  publish(entry);
  if (typeof MediaStreamTrackProcessor === 'undefined') {
    entry.state = 'unmeasurable';
    return publish(entry);
  }
  const first = await probe(track, 2500);
  if (first !== null) {
    entry.state = 'alive';
    entry.ms = first;
    return publish(entry);
  }
  entry.state = 'silent';
  publish(entry);
  if (!settings.autoFix) return;

  const t0 = performance.now();
  if (IS_TOP) await toggleHook();
  else window.top?.postMessage({ type: MSG, kind: 'fix-request' }, '*'); // WebHID is blocked in iframes: the top frame does it
  const again = await probe(track, 3500);
  entry.state = again !== null ? 'fixed' : 'dead';
  entry.ms = again !== null ? Math.round(performance.now() - t0) : undefined;
  publish(entry);
}

/* ---------------------------------------------------------------------------------------------- getUserMedia */

function installWrapper(): void {
  const md = navigator.mediaDevices;
  if (!md?.getUserMedia) return;
  const original = md.getUserMedia.bind(md);
  md.getUserMedia = async (constraints?: MediaStreamConstraints) => {
    // Only wait for an off-hook write that is already in flight; never delay by more than 800 ms.
    if (IS_TOP && constraints?.audio) await Promise.race([hookReady, sleep(800)]);
    const stream = await original(constraints);
    const track = stream.getAudioTracks()[0];
    if (track) void inspect(track);
    return stream;
  };
}

/* ---------------------------------------------------------------------------------------------- reporting */

function publish(entry: Entry): void {
  if (IS_TOP) {
    upsert(entry);
    render();
  } else {
    window.top?.postMessage({ type: MSG, kind: 'entry', entry }, '*');
  }
}

function upsert(entry: Entry): void {
  const i = hud.entries.findIndex((e) => e.key === entry.key);
  const copy = { ...entry };
  if (i >= 0) hud.entries[i] = copy;
  else hud.entries.push(copy);
  hud.entries = hud.entries.slice(-6);
}

if (IS_TOP) {
  window.addEventListener('message', (e: MessageEvent) => {
    const d = e.data as { type?: string; kind?: string; entry?: Entry } | null;
    if (!d || d.type !== MSG) return;
    if (d.kind === 'entry' && d.entry) {
      upsert({ ...d.entry, inFrame: true });
      render();
    } else if (d.kind === 'fix-request' && settings.autoFix) {
      void toggleHook();
    }
  });
}

/* ---------------------------------------------------------------------------------------------- HUD */

const CSS = `
:host { all: initial; }
.box { position: fixed; right: 12px; bottom: 12px; z-index: 2147483647; width: 320px; font: 12px/1.45 system-ui, sans-serif;
  background: #14181f; color: #e8ecf1; border: 1px solid #39424f; border-radius: 10px; box-shadow: 0 6px 24px #0008; overflow: hidden; }
.head { display: flex; align-items: center; gap: 8px; padding: 7px 10px; background: #1d232d; cursor: pointer; user-select: none; }
.head b { flex: 1; font-size: 12px; }
.dot { width: 9px; height: 9px; border-radius: 50%; background: #7a8494; }
.dot.ok { background: #38c172; } .dot.warn { background: #f2b53d; } .dot.bad { background: #e3534b; }
.body { padding: 8px 10px; display: grid; gap: 6px; }
.row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.muted { color: #9aa5b4; }
button { font: inherit; color: inherit; background: #2a3342; border: 1px solid #435066; border-radius: 6px; padding: 3px 9px; cursor: pointer; }
button:hover { background: #34405a; }
.entry { padding: 3px 0; border-top: 1px solid #262e3a; }
.alive { color: #5fd38d; } .fixed { color: #6cb6ff; } .silent, .checking { color: #f2b53d; } .dead { color: #ff7b72; }
label { display: flex; gap: 5px; align-items: center; }
`;

let host: HTMLElement | null = null;
let root: ShadowRoot | null = null;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = String(v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'checked') (node as HTMLInputElement).checked = Boolean(v);
    else node.setAttribute(k, String(v));
  }
  node.append(...kids);
  return node;
}

function describe(e: Entry): string {
  const where = e.inFrame ? 'iframe ' : '';
  switch (e.state) {
    case 'checking': return `${where}${e.label}: checking ...`;
    case 'alive': return `${where}${e.label}: audio after ${e.ms} ms`;
    case 'silent': return `${where}${e.label}: SILENT${settings.autoFix ? ' - fixing ...' : ''}`;
    case 'fixed': return `${where}${e.label}: SILENT, revived after ${e.ms} ms`;
    case 'dead': return `${where}${e.label}: SILENT, fix did not help`;
    default: return `${where}${e.label}: cannot be measured in this browser`;
  }
}

function render(): void {
  if (!IS_TOP) return;
  if (!host) {
    if (!document.documentElement) return;
    host = document.createElement('div');
    root = host.attachShadow({ mode: 'open' });
    const sheet = new CSSStyleSheet(); // constructed stylesheets are not blocked by a page's CSP
    sheet.replaceSync(CSS);
    root.adoptedStyleSheets = [sheet];
    document.documentElement.appendChild(host);
  }
  const worst = hud.entries.some((e) => e.state === 'dead' || e.state === 'silent') ? 'bad' : hud.offHook ? 'ok' : 'warn';
  const dot = el('span', { class: 'dot ' + worst });
  const head = el('div', { class: 'head', onclick: () => { settings.collapsed = !settings.collapsed; saveSettings(); render(); } }, dot, el('b', {}, 'Jabra mic fix (test)'), el('span', { class: 'muted' }, settings.collapsed ? 'show' : 'hide'));
  const box = el('div', { class: 'box' }, head);

  if (!settings.collapsed) {
    const body = el('div', { class: 'body' });
    const hidText = { unknown: 'checking ...', unsupported: 'WebHID unavailable (use Chrome/Edge over HTTPS)', 'not-granted': 'not granted yet', granted: 'granted' }[hud.hid];
    const hidRow = el('div', { class: 'row' }, el('span', {}, 'Headset access: ' + hidText));
    if (hud.hid === 'not-granted') {
      hidRow.append(el('button', { onclick: async () => { if (await requestHookPermission()) { hud.hid = 'granted'; hookReady = sendHook(true); } render(); } }, 'Grant'));
    }
    body.append(hidRow);
    body.append(el('div', { class: 'muted' }, `Dongle: ${hud.offHook === null ? 'no signal sent yet' : hud.offHook ? 'off-hook' : 'on-hook'}${hud.hookNote ? ' - ' + hud.hookNote : ''}`));
    body.append(
      el('div', { class: 'row' },
        el('button', { onclick: () => void toggleHook() }, 'Toggle off-hook'),
        el('button', { onclick: () => void sendHook(false) }, 'On-hook (release)'),
        el('label', {}, el('input', { type: 'checkbox', checked: settings.autoFix, onchange: (ev: Event) => { settings.autoFix = (ev.target as HTMLInputElement).checked; saveSettings(); render(); } }), 'auto-fix'),
      ),
    );
    if (hud.entries.length === 0) body.append(el('div', { class: 'muted' }, 'No microphone opened yet on this page.'));
    for (const e of hud.entries.slice().reverse()) {
      body.append(el('div', { class: 'entry ' + e.state }, `${new Date(e.at).toLocaleTimeString()}  ${describe(e)}`));
    }
    box.append(body);
  }
  root!.replaceChildren(box);
}

/* ---------------------------------------------------------------------------------------------- start */

installWrapper(); // as early as possible: the page's first getUserMedia must go through the wrapper
if (IS_TOP) {
  hookReady = initHook();
  void hookReady.then(render);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render);
  else render();
  (window as unknown as Record<string, unknown>).__jabraMicFix = { hud, toggleHook, sendHook, settings };
}

export {};
