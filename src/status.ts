/**
 * status.ts - a tiny observable "what is the microphone doing right now" for UIs.
 *
 * Frontends use it to show things like "Starting your microphone..." and to close that hint again. It is a plain
 * subscribe/unsubscribe hub with no dependencies, so it fits any framework (see examples/nuxt for a Vue composable).
 *
 *  state      meaning                                  typical UI
 *  ---------  ---------------------------------------  ------------------------------------------------
 *  idle       no mic requested / mic released          nothing
 *  starting   opening the mic, waiting for audio       "Starting your microphone ..."  (usually < 0.2 s)
 *  waiting    deliberately waiting for the dongle      "Reconnecting your headset, about N s"  (up to ~10 s)
 *               reason 'dongle-busy'   : waiting out the hold time of the last call before opening
 *               reason 'reconnecting'  : the stream was silent, mic released, waiting before the next try
 *               `etaAt` (epoch ms) lets a UI render a countdown
 *  ready      the mic carries audio (or, for Prebuilt, the call has been joined)    close the hint
 *  degraded   every attempt stayed silent                  "No microphone signal. Switch the headset off and on."
 *  error      getUserMedia failed; `error` is the DOMException name   permission / device hint
 *
 * Tip for UIs: do not show anything for the first ~400 ms of `starting`, or the hint flickers on every healthy start.
 */

export type MicState = 'idle' | 'starting' | 'waiting' | 'ready' | 'degraded' | 'error';

export interface MicStatus {
  state: MicState;
  /** starting: 'hook-toggle' | 'external-ui'; waiting: 'dongle-busy' | 'reconnecting'; ready: 'external-ui' */
  reason?: string;
  attempt?: number;
  /** waiting: estimated remaining time when the status was set, and the epoch ms it should end (for countdowns). */
  etaMs?: number;
  etaAt?: number;
  /** ready / degraded: did real audio arrive? */
  healthy?: boolean;
  attempts?: number;
  durationMs?: number;
  startedAt?: number;
  /** error: DOMException name, e.g. 'NotAllowedError' */
  error?: string;
  /** Epoch ms of this status change. */
  at: number;
}

export type MicStatusListener = (status: MicStatus) => void;

const listeners = new Set<MicStatusListener>();
let current: MicStatus = { state: 'idle', at: Date.now() };

/** The most recent status. */
export const getMicStatus = (): MicStatus => current;

/**
 * Subscribe to status changes.
 * @param listener called on every change
 * @param options.immediate (default true) also call the listener right away with the current status
 * @returns unsubscribe function
 */
export function onMicStatus(listener: MicStatusListener, { immediate = true }: { immediate?: boolean } = {}): () => void {
  listeners.add(listener);
  if (immediate) {
    try {
      listener(current);
    } catch (e) {
      console.error(e);
    }
  }
  return () => {
    listeners.delete(listener);
  };
}

/** @internal Used by guard.ts; not exported from the package entry point. */
export function setMicStatus(next: Omit<MicStatus, 'at'>): void {
  current = { ...next, at: Date.now() };
  for (const l of [...listeners]) {
    try {
      l(current);
    } catch (e) {
      console.error(e); // a faulty listener must never break microphone start-up
    }
  }
}
