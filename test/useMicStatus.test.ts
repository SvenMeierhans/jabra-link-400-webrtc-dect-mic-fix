import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, ref } from 'vue';
import { setMicStatus } from '../src/status';

// Tests the timing rules of examples/nuxt/composables/useMicStatus.ts with fake timers: when the hint appears,
// that it does not flash on healthy starts, that it stays visible for a minimum time, and the countdown.

type UseMicStatus = typeof import('../examples/nuxt/composables/useMicStatus').useMicStatus;
let useMicStatus: UseMicStatus;
let unmountHooks: Array<() => void>;

beforeEach(async () => {
  vi.useFakeTimers();
  unmountHooks = [];
  vi.stubGlobal('ref', ref);
  vi.stubGlobal('computed', computed);
  vi.stubGlobal('onMounted', (fn: () => void) => void fn());
  vi.stubGlobal('onBeforeUnmount', (fn: () => void) => unmountHooks.push(fn));
  setMicStatus({ state: 'idle' });
  ({ useMicStatus } = await import('../examples/nuxt/composables/useMicStatus'));
});

afterEach(() => {
  unmountHooks.forEach((fn) => fn());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Mounts the composable and waits until it has subscribed (dynamic import inside onMounted). */
async function mount(options?: { showAfterMs?: number; minVisibleMs?: number }) {
  const api = useMicStatus(options);
  await vi.dynamicImportSettled();
  return api;
}

describe('useMicStatus', () => {
  it('does not show a hint for a healthy start (ready after 120 ms)', async () => {
    const { showHint, busy } = await mount();
    setMicStatus({ state: 'starting' });
    expect(busy.value).toBe(true);
    await vi.advanceTimersByTimeAsync(120);
    setMicStatus({ state: 'ready', healthy: true });
    await vi.advanceTimersByTimeAsync(2000);
    expect(showHint.value).toBe(false);
  });

  it('shows the hint after showAfterMs when starting takes longer, and keeps it for minVisibleMs', async () => {
    const { showHint } = await mount({ showAfterMs: 400, minVisibleMs: 600 });
    setMicStatus({ state: 'starting' });
    await vi.advanceTimersByTimeAsync(399);
    expect(showHint.value).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(showHint.value).toBe(true); // visible since t=400

    await vi.advanceTimersByTimeAsync(100); // t=501: ready arrives only 101 ms after the hint appeared
    setMicStatus({ state: 'ready', healthy: true });
    await vi.advanceTimersByTimeAsync(300);
    expect(showHint.value).toBe(true); // still within the 600 ms minimum
    await vi.advanceTimersByTimeAsync(300);
    expect(showHint.value).toBe(false);
  });

  it('shows "waiting" immediately and counts down', async () => {
    const { showHint, remainingSec, status } = await mount();
    setMicStatus({ state: 'waiting', reason: 'reconnecting', etaMs: 5000, etaAt: Date.now() + 5000 });
    expect(showHint.value).toBe(true);
    expect(status.value.reason).toBe('reconnecting');
    expect(remainingSec.value).toBe(5);
    await vi.advanceTimersByTimeAsync(2100);
    expect(remainingSec.value).toBe(3);
    setMicStatus({ state: 'ready', healthy: true });
    expect(remainingSec.value).toBeNull();
    await vi.advanceTimersByTimeAsync(700);
    expect(showHint.value).toBe(false);
  });

  it('a pending "starting" hint turns into an immediate one when the status becomes "waiting"', async () => {
    const { showHint } = await mount({ showAfterMs: 400 });
    setMicStatus({ state: 'starting' });
    await vi.advanceTimersByTimeAsync(100);
    expect(showHint.value).toBe(false);
    setMicStatus({ state: 'waiting', reason: 'reconnecting', etaMs: 7500, etaAt: Date.now() + 7500 });
    expect(showHint.value).toBe(true);
  });

  it('flags problems for degraded and error', async () => {
    const { problem } = await mount();
    expect(problem.value).toBe(false);
    setMicStatus({ state: 'degraded', healthy: false });
    expect(problem.value).toBe(true);
    setMicStatus({ state: 'error', error: 'NotAllowedError' });
    expect(problem.value).toBe(true);
    setMicStatus({ state: 'ready', healthy: true });
    expect(problem.value).toBe(false);
  });

  it('stops listening after unmount', async () => {
    const { status } = await mount();
    unmountHooks.forEach((fn) => fn());
    setMicStatus({ state: 'starting' });
    expect(status.value.state).toBe('idle');
  });
});
