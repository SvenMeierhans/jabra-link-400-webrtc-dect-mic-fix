/**
 * guard.ts - get a microphone track that really carries audio, even on DECT dongles that hand out a
 * "live but silent" track after a quick re-open (see docs/root-cause.md).
 *
 * Strategy, in order of preference:
 *  1. Off-hook (hook.ts): tell the dongle "call active" before opening the mic. Needs a one-time WebHID
 *     grant. With it the dead state never occurred in testing.
 *  2. Detect silence: a healthy mic delivers non-zero samples within ~1.5 s. A dead one delivers only
 *     exact zeros. On silence, try an on-/off-hook toggle, then fall back to
 *  3. Release and wait: stop the track, wait for the dongle's hold time to expire (>= 6 s), re-open.
 *
 * Two optional helpers cover apps that do not own the mic (Daily Prebuilt): see `prepareDongle()`.
 *
 * Import-safe in SSR. Call the functions in the browser only.
 */
import { getLastHookInfo, setOffHook, type HookInfo } from './hook';
import { setMicStatus } from './status';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const safe = <T>(fn: () => T): T | undefined => {
  try {
    return fn();
  } catch {
    return undefined;
  }
};

/*
 * Measured on a Jabra Link 400 (firmware 1.13 and 1.16, Windows 11, Edge/Chrome 155):
 *  - Windows keeps the capture pin open ~0.5 s after the last client closed. Re-opening within that grace
 *    time is invisible to the dongle and always fine.
 *  - After that the dongle holds its session for 5.48 s (5467-5488 ms observed). Re-opening the mic inside
 *    this window yields a dead (all-zero) stream. 5 s of waiting is NOT enough, 6 s is.
 */
const STOP_KEY = 'jabra-link-400-webrtc-dect-mic-fix:last-stop';
const GRACE_MS = 300;
const HOLD_MS = 6200;

/** Tracks handed out by this module that are still open. */
const live = new Set<MediaStreamTrack>();
/** For apps that do not hand us the track (Prebuilt): is a call (and thus the mic) active? */
let micActive = false;

/** Progress events for the low-level `onStatus` callbacks. For UIs prefer `onMicStatus()` from status.ts. */
export interface StatusEvent {
  state: 'off-hook' | 'idle-wait' | 'silent-hook-toggle' | 'silent' | 'waiting';
  sent?: boolean;
  ms?: number;
  attempt?: number;
  info?: HookInfo | null;
}

export interface AcquireOptions {
  /** Exact device to open; the default device if omitted. */
  deviceId?: string;
  /** How long to wait for a non-zero sample before the track is called dead. Default 2500. */
  probeMs?: number;
  /** Pause between stopping a dead track and re-opening. Default 6500. */
  releaseWaitMs?: number;
  /** Attempts before giving up and returning a silent track. Default 3. */
  maxAttempts?: number;
  /** Send off-hook first (effective only after the one-time WebHID grant). Default true. */
  hook?: boolean;
  /** Proactively wait out the dongle's hold time instead of reacting to silence. Default false. */
  waitForIdle?: boolean;
  /** Low-level progress callback. */
  onStatus?: (status: StatusEvent) => void;
}

export interface AcquireResult {
  track: MediaStreamTrack;
  /** false: every attempt was silent (or silence could not be ruled out); the returned track may be silent. */
  healthy: boolean;
  attempts: number;
}

/** Remember "the mic was in use until now". Survives a reload (localStorage). */
export function noteMicStop(): void {
  safe(() => localStorage.setItem(STOP_KEY, String(Date.now())));
}

/**
 * Use instead of `track.stop()` for tracks from `acquireWorkingMic()`: stops the track, remembers when, and
 * sends on-hook to the dongle (best effort).
 */
export function releaseMic(track: MediaStreamTrack): void {
  live.delete(track);
  track.stop();
  noteMicStop();
  void setOffHook(false);
  setMicStatus({ state: 'idle' });
}

let hookOnPageHide = false;

/**
 * - `onHookOnPageHide` (default false): also send on-hook when the page is left. Default is off because it
 *   made the next page's off-hook write hang in 4 of 6 measured reloads (WebHID NotAllowedError after 2-5 s).
 *   Trade-off: closing the tab mid-call leaves the dongle off-hook until the app sends on-hook again.
 */
export function configureGuard(o: { onHookOnPageHide?: boolean } = {}): void {
  if (o.onHookOnPageHide !== undefined) hookOnPageHide = o.onHookOnPageHide;
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    const open = micActive || [...live].some((t) => t.readyState === 'live');
    if (!open) return;
    noteMicStop();
    if (hookOnPageHide) void setOffHook(false);
  });
}

/**
 * Resolves true as soon as the track delivers a non-zero sample, false after `timeoutMs`
 * of pure digital silence, and null if it cannot be measured.
 *
 * A healthy mic has a noise floor, so exact zeros mean "no audio path". Uses MediaStreamTrackProcessor
 * (Chromium); falls back to an AudioContext analyser elsewhere, which only counts if the context runs.
 *
 * @param timeoutMs healthy starts needed 0.6-1.4 s in testing (the radio link is set up first)
 */
export async function hasSignal(track: MediaStreamTrack, timeoutMs = 2500): Promise<boolean | null> {
  if (typeof MediaStreamTrackProcessor !== 'undefined') {
    // The DOM typings distinguish audio and video tracks; ours is an audio track by construction.
    const reader = new MediaStreamTrackProcessor({ track: track as MediaStreamAudioTrack }).readable.getReader();
    const end = performance.now() + timeoutMs;
    try {
      while (performance.now() < end) {
        const r = await Promise.race([
          reader.read(),
          sleep(Math.max(0, end - performance.now())).then(() => null),
        ]);
        if (!r || r.done) break;
        const frame = r.value as AudioData;
        const buf = new Float32Array(frame.numberOfFrames);
        frame.copyTo(buf, { planeIndex: 0, format: 'f32-planar' });
        frame.close();
        if (buf.some((x) => x !== 0)) return true;
      }
      return false;
    } finally {
      reader.cancel().catch(() => {});
    }
  }
  // Fallback (Firefox/Safari): suspended contexts also output zeros, so only trust a running context.
  const ctx = new AudioContext();
  try {
    await ctx.resume().catch(() => {});
    if (ctx.state !== 'running') return null;
    const an = ctx.createAnalyser();
    an.fftSize = 2048;
    ctx.createMediaStreamSource(new MediaStream([track])).connect(an);
    const buf = new Float32Array(an.fftSize);
    const end = performance.now() + timeoutMs;
    while (performance.now() < end) {
      an.getFloatTimeDomainData(buf);
      if (buf.some((x) => x !== 0)) return true;
      await sleep(40);
    }
    return false;
  } finally {
    void ctx.close().catch(() => {});
  }
}

/**
 * If the mic was in use less than ~6.2 s ago (according to the stamp left by `releaseMic()` / the pagehide
 * handler), wait until the dongle's hold time has expired. Resolves to the number of ms waited.
 *
 * By default a stamp younger than ~0.3 s is ignored: if the mic is opened right now, Windows has not yet closed
 * the pin and the dongle never noticed the stop. That shortcut is wrong when the mic is opened LATER by someone
 * else (a Prebuilt iframe booting), so `prepareDongle()` passes `ignoreGrace: true`.
 *
 * @param options.holdMs overrides the measured hold time; exists for tests.
 */
export async function waitUntilDongleIdle(
  onStatus: (status: StatusEvent) => void = () => {},
  { ignoreGrace = false, holdMs }: { ignoreGrace?: boolean; holdMs?: number } = {},
): Promise<number> {
  const hold = holdMs ?? HOLD_MS;
  const last = Number(safe(() => localStorage.getItem(STOP_KEY)));
  const since = Date.now() - last;
  if (!last || since < 0 || since >= hold) return 0;
  if (!ignoreGrace && since <= GRACE_MS) return 0;
  const wait = hold - since;
  onStatus({ state: 'idle-wait', ms: wait });
  setMicStatus({ state: 'waiting', reason: 'dongle-busy', etaMs: wait, etaAt: Date.now() + wait });
  await sleep(wait);
  return wait;
}

/**
 * Acquire a microphone track and make sure it carries audio.
 *
 * @returns the track; `healthy: false` means every attempt was silent and the returned track is silent too.
 * @throws whatever `getUserMedia` throws (permission denied, device not found, ...); status becomes `error`.
 */
export async function acquireWorkingMic({
  deviceId,
  probeMs = 2500,
  releaseWaitMs = 6500,
  maxAttempts = 3,
  waitForIdle = false,
  hook = true,
  onStatus = () => {},
}: AcquireOptions = {}): Promise<AcquireResult> {
  const constraints: MediaStreamConstraints = { audio: deviceId ? { deviceId: { exact: deviceId } } : true };
  const startedAt = Date.now();

  // `measured: false` = silence could not be measured (no MediaStreamTrackProcessor, suspended AudioContext):
  // report ready instead of a false "degraded" warning.
  const done = (track: MediaStreamTrack, healthy: boolean, attempts: number, measured = true): AcquireResult => {
    live.add(track);
    setMicStatus({
      state: healthy || !measured ? 'ready' : 'degraded',
      healthy,
      attempts,
      startedAt,
      durationMs: Date.now() - startedAt,
    });
    return { track, healthy, attempts };
  };

  try {
    setMicStatus({ state: 'starting', startedAt });

    // 1. Prevent: tell the dongle "call active" before the mic is opened (then no dead stream occurs).
    const hooked = hook ? await setOffHook(true) : false;
    onStatus({ state: 'off-hook', sent: hooked, info: getLastHookInfo() });

    if (waitForIdle) await waitUntilDongleIdle(onStatus);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      setMicStatus({ state: 'starting', attempt, startedAt });
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      const track = stream.getAudioTracks()[0]!;
      const ok = await hasSignal(track, probeMs);
      if (ok !== false) return done(track, ok === true, attempt, ok !== null);

      // 2. Dead despite off-hook: toggle on-/off-hook once (measured: stream recovers after ~1.3 s).
      if (hooked) {
        onStatus({ state: 'silent-hook-toggle', attempt });
        setMicStatus({ state: 'starting', reason: 'hook-toggle', attempt, startedAt });
        await setOffHook(false);
        await sleep(150);
        await setOffHook(true);
        if ((await hasSignal(track, 3000)) !== false) return done(track, true, attempt);
      }

      // 3. Still dead: release the endpoint completely and wait out the dongle's hold time.
      onStatus({ state: 'silent', attempt });
      stream.getTracks().forEach((t) => t.stop());
      noteMicStop();
      if (attempt < maxAttempts) {
        const wait = releaseWaitMs + (attempt - 1) * 2000;
        onStatus({ state: 'waiting', ms: wait });
        // + ~1 s: the link needs about that long to carry audio after a clean start
        setMicStatus({
          state: 'waiting',
          reason: 'reconnecting',
          attempt,
          startedAt,
          etaMs: wait + 1000,
          etaAt: Date.now() + wait + 1000,
        });
        await sleep(wait);
      }
    }

    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    return done(stream.getAudioTracks()[0]!, false, maxAttempts + 1);
  } catch (e) {
    setMicStatus({ state: 'error', error: e instanceof Error ? e.name : String(e), startedAt });
    throw e;
  }
}

/* ------------------------------------------------------------------------------------------------
 * Apps that do not own the mic (Daily Prebuilt, any third-party iframe)
 * --------------------------------------------------------------------------------------------- */

export interface PrepareOptions {
  /** Send off-hook (effective only after the one-time WebHID grant). Default true. */
  hook?: boolean;
  /** Without off-hook: wait out the dongle's hold time since the last call. Default true. */
  waitForIdle?: boolean;
  onStatus?: (status: StatusEvent) => void;
  /** Test-only override of the measured hold time. */
  holdMs?: number;
}

/**
 * Call BEFORE the third-party UI (e.g. `Daily.createFrame()`) is created, because it may open the mic
 * immediately (pre-join screen). Off-hook acts on the dongle, so it also helps when someone else opens the mic.
 *
 * - With the WebHID grant: sends off-hook (~10 ms) and returns.
 * - Without it: falls back to waiting until the dongle's hold time since the last call has expired
 *   (needs `markMicActive()` / `markMicInactive()` around the call).
 */
export async function prepareDongle({
  hook = true,
  waitForIdle = true,
  onStatus = () => {},
  holdMs,
}: PrepareOptions = {}): Promise<{ hooked: boolean; waited: number }> {
  setMicStatus({ state: 'starting', reason: 'external-ui', startedAt: Date.now() });
  const hooked = hook ? await setOffHook(true) : false;
  onStatus({ state: 'off-hook', sent: hooked, info: getLastHookInfo() });
  // The third-party UI opens the mic later, so the "opened right now" grace shortcut must not apply here.
  const waited = !hooked && waitForIdle ? await waitUntilDongleIdle(onStatus, { ignoreGrace: true, holdMs }) : 0;
  return { hooked, waited };
}

/** Call when the third-party call has started (e.g. Daily `joined-meeting`). Used for the idle-wait fallback. */
export function markMicActive(): void {
  micActive = true;
  setMicStatus({ state: 'ready', reason: 'external-ui', healthy: true });
}

/** Call when the call has ended (e.g. Daily `left-meeting`). */
export function markMicInactive(): void {
  micActive = false;
  noteMicStop();
  setMicStatus({ state: 'idle' });
}

/** Call when the call ended: stops reminding the dongle of the call (on-hook, best effort). */
export async function releaseDongle(): Promise<boolean> {
  markMicInactive();
  return setOffHook(false);
}
