import { afterEach, describe, expect, it, vi } from 'vitest';
import * as lib from '../src/index';

// The library must be importable on the server (Nuxt/Next SSR) where there is no window/navigator.
// This file runs in a plain Node environment on purpose.

const STAMP_KEY = 'jabra-link-400-webrtc-dect-mic-fix:last-stop';

/** localStorage stand-in for the stamp that releaseMic()/pagehide leave behind. */
function stubStamp(msAgo: number): void {
  const store: Record<string, string> = { [STAMP_KEY]: String(Date.now() - msAgo) };
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SSR safety', () => {
  it('exports the public API', () => {
    for (const name of [
      'acquireWorkingMic',
      'releaseMic',
      'hasSignal',
      'noteMicStop',
      'waitUntilDongleIdle',
      'configureGuard',
      'prepareDongle',
      'releaseDongle',
      'markMicActive',
      'markMicInactive',
      'hookSupported',
      'findHookDevice',
      'requestHookPermission',
      'setOffHook',
      'getLastHookInfo',
      'configureHook',
      'onMicStatus',
      'getMicStatus',
    ] as const) {
      expect(typeof lib[name], name).toBe('function');
    }
  });

  it('hookSupported() is false without a browser', () => {
    expect(lib.hookSupported()).toBe(false);
  });

  it('setOffHook() never throws and reports failure without WebHID', async () => {
    expect(await lib.setOffHook(true)).toBe(false);
    expect(lib.getLastHookInfo()?.ok).toBe(false);
  });

  it('findHookDevice() resolves null without WebHID', async () => {
    expect(await lib.findHookDevice()).toBeNull();
  });
});

describe('waitUntilDongleIdle', () => {
  it('does not wait when the mic was never used', async () => {
    expect(await lib.waitUntilDongleIdle()).toBe(0);
  });

  it('waits out the remaining hold time', async () => {
    stubStamp(1000);
    const waited = await lib.waitUntilDongleIdle(() => {}, { holdMs: 1300 });
    expect(waited).toBeGreaterThanOrEqual(250);
    expect(waited).toBeLessThanOrEqual(330);
  });

  it('ignores a stamp younger than the grace time by default', async () => {
    stubStamp(100);
    expect(await lib.waitUntilDongleIdle(() => {}, { holdMs: 1300 })).toBe(0);
  });

  it('waits even for a fresh stamp with ignoreGrace (the mic is opened later by a third party)', async () => {
    stubStamp(100);
    const waited = await lib.waitUntilDongleIdle(() => {}, { ignoreGrace: true, holdMs: 1300 });
    expect(waited).toBeGreaterThanOrEqual(1150);
    expect(waited).toBeLessThanOrEqual(1230);
  });

  it('does not wait once the hold time has passed', async () => {
    stubStamp(7000);
    expect(await lib.waitUntilDongleIdle()).toBe(0);
  });
});

describe('prepareDongle (Prebuilt fallback)', () => {
  it('waits for the hold time without WebHID', async () => {
    stubStamp(100);
    const states: string[] = [];
    const r = await lib.prepareDongle({ holdMs: 1300, onStatus: (s) => states.push(s.state) });
    expect(r.hooked).toBe(false);
    expect(r.waited).toBeGreaterThanOrEqual(1150);
    expect(r.waited).toBeLessThanOrEqual(1230);
    expect(states).toContain('idle-wait');
  });

  it('returns immediately without WebHID and without a stamp', async () => {
    const t0 = Date.now();
    expect(await lib.prepareDongle()).toEqual({ hooked: false, waited: 0 });
    expect(Date.now() - t0).toBeLessThan(500);
  });
});
