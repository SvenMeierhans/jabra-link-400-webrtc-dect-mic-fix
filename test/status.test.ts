import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as Lib from '../src/index';
import type { MicStatus } from '../src/index';

// A fake browser: a microphone whose samples are either audio or digital silence, so the state machine can be
// exercised without hardware.
let samples: 'audio' | 'silence' = 'audio';
let gumError: string | null = null;
let lib: typeof Lib;

class FakeProcessor {
  readable = {
    getReader: () => ({
      read: async () => {
        await new Promise((r) => setTimeout(r, 5));
        return {
          done: false,
          value: {
            numberOfFrames: 4,
            copyTo: (buf: Float32Array) => buf.set(samples === 'audio' ? [0.1, 0, 0, 0] : [0, 0, 0, 0]),
            close() {},
          },
        };
      },
      cancel: async () => {},
    }),
  };
}

beforeAll(async () => {
  vi.stubGlobal('MediaStreamTrackProcessor', FakeProcessor);
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia: async () => {
        if (gumError) throw Object.assign(new Error('denied'), { name: gumError });
        const track = { readyState: 'live', stop() {} };
        return { getAudioTracks: () => [track], getTracks: () => [track] };
      },
    },
  });
  lib = await import('../src/index');
});

afterAll(() => {
  vi.unstubAllGlobals();
});

function record() {
  const seen: MicStatus[] = [];
  const off = lib.onMicStatus((s) => seen.push(s), { immediate: false });
  return { seen, off, states: () => seen.map((s) => s.state + (s.reason ? ':' + s.reason : '')) };
}

const fakeTrack = () => ({ stop() {}, readyState: 'ended' }) as unknown as MediaStreamTrack;

describe('onMicStatus', () => {
  it('calls the listener immediately with the current status and can unsubscribe', () => {
    const calls: string[] = [];
    const off = lib.onMicStatus((s) => calls.push(s.state));
    expect(calls).toEqual(['idle']);
    off();
    lib.releaseMic(fakeTrack()); // emits idle
    expect(calls).toEqual(['idle']);
  });

  it('a faulty listener does not break the others', () => {
    const good: string[] = [];
    const offBad = lib.onMicStatus(() => {
      throw new Error('boom');
    }, { immediate: false });
    const offGood = lib.onMicStatus((s) => good.push(s.state), { immediate: false });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    lib.releaseMic(fakeTrack());
    spy.mockRestore();
    expect(good).toEqual(['idle']);
    offBad();
    offGood();
  });
});

describe('acquireWorkingMic status flow', () => {
  it('healthy start: starting -> ready, immediately', async () => {
    samples = 'audio';
    const r = record();
    const res = await lib.acquireWorkingMic({ hook: false, probeMs: 200 });
    r.off();
    expect(res.healthy).toBe(true);
    expect(res.attempts).toBe(1);
    expect(r.states()).toEqual(['starting', 'starting', 'ready']);
    const last = r.seen.at(-1)!;
    expect(last.healthy).toBe(true);
    expect(last.durationMs!).toBeLessThan(500);
  });

  it('silent start: reports waiting(reconnecting) with a countdown, then degraded', async () => {
    samples = 'silence';
    const r = record();
    const res = await lib.acquireWorkingMic({ hook: false, probeMs: 40, releaseWaitMs: 30, maxAttempts: 2 });
    r.off();
    expect(res.healthy).toBe(false);
    expect(res.attempts).toBe(3);
    const waiting = r.seen.find((s) => s.state === 'waiting')!;
    expect(waiting.reason).toBe('reconnecting');
    expect(waiting.etaMs).toBe(1030); // wait + ~1 s link warm-up
    expect(waiting.etaAt!).toBeGreaterThanOrEqual(Date.now());
    expect(waiting.etaAt!).toBeLessThanOrEqual(Date.now() + 1030);
    expect(r.seen.at(-1)!.state).toBe('degraded');
  });

  it('getUserMedia failure: status error with the DOMException name, and the promise rejects', async () => {
    gumError = 'NotAllowedError';
    const r = record();
    await expect(lib.acquireWorkingMic({ hook: false })).rejects.toThrow('denied');
    r.off();
    gumError = null;
    expect(r.seen.at(-1)!.state).toBe('error');
    expect(r.seen.at(-1)!.error).toBe('NotAllowedError');
  });
});

describe('Prebuilt status flow', () => {
  it('markMicActive -> ready, markMicInactive -> idle', () => {
    const r = record();
    lib.markMicActive();
    lib.markMicInactive();
    r.off();
    expect(r.states()).toEqual(['ready:external-ui', 'idle']);
  });

  it('prepareDongle() reports starting for the external UI', async () => {
    const r = record();
    await lib.prepareDongle({ hook: false, waitForIdle: false });
    r.off();
    expect(r.states()[0]).toBe('starting:external-ui');
  });
});
