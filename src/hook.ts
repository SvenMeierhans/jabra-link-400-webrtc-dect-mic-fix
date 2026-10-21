/**
 * hook.ts - tell a DECT dongle "call active" (off-hook) / "call ended" (on-hook) over WebHID.
 *
 * Why: some DECT dongles (verified: Jabra Link 400, USB 0B0E:1131) hand out a microphone track that is
 * `live`, not `muted` and delivers frames - but only digital silence - when the mic is re-opened shortly
 * after it was closed (typically: a page refresh). A softphone avoids this by sending a telephony
 * "off-hook" signal to the dongle before it starts audio. This module sends exactly that signal from the
 * browser. See docs/root-cause.md for the measurements.
 *
 * What is written: ONE standardized HID Telephony output report (report ID 2, "Off-Hook" LED usage
 * 0x08/0x17) to the dongle's telephony collection. Vendor-defined collections are never touched.
 *
 * Requirements: a Chromium browser with WebHID (Chrome/Edge), a secure context (HTTPS or localhost) and a
 * one-time user grant via `requestHookPermission()` (see README, "The one-time permission").
 *
 * All functions are safe to import in SSR: nothing touches `window`/`navigator` at import time.
 */

/** Telephony usage page and the "Headset" usage; used to pick the right HID collection. */
const USAGE_PAGE_TELEPHONY = 0x000b;
const USAGE_HEADSET = 0x0005;

export interface HookTarget {
  vendorId: number;
  productId: number;
  /** HID report ID of the telephony output report. */
  reportId: number;
  /**
   * Bit of the "Off-Hook" LED usage inside the report's first data byte. Derived with HidP_SetUsages
   * (see lab/hid/hidbits.ps1), NOT guessed from the order of usages.
   */
  offHookMask: number;
}

/** Defaults are the values verified on a Jabra Link 400. */
const target: HookTarget = {
  vendorId: 0x0b0e, // GN Audio / Jabra
  productId: 0x1131, // Link 400
  reportId: 2,
  offHookMask: 0x01,
};

let device: HIDDevice | null = null;
let lastInfo: HookInfo | null = null;

/** Diagnostics of a `setOffHook()` call. */
export interface HookInfo {
  ok: boolean;
  /** Duration of the call in ms. */
  ms: number;
  err?: string;
}

/**
 * Override the target device, e.g. to experiment with another dongle. Only the given fields change.
 */
export function configureHook(o: Partial<HookTarget> = {}): void {
  Object.assign(target, o);
  device = null; // force a fresh lookup for the new target
}

/** True if the browser exposes WebHID (Chromium only). Safe to call during SSR. */
export const hookSupported = (): boolean => typeof navigator !== 'undefined' && 'hid' in navigator;

/**
 * Returns the already granted device (no dialog) or null. After the one-time grant the browser remembers it
 * for this profile and origin, so this also works after reloads.
 */
export async function findHookDevice(): Promise<HIDDevice | null> {
  if (!hookSupported()) return null;
  const all = await navigator.hid.getDevices();
  return (
    all.find(
      (d) =>
        d.vendorId === target.vendorId &&
        d.productId === target.productId &&
        d.collections.some((c) => c.usagePage === USAGE_PAGE_TELEPHONY),
    ) ?? null
  );
}

/**
 * Asks the user to grant access to the dongle. MUST be called from a user gesture (click handler).
 * Opens the browser's WebHID device chooser. Resolves to null if the user cancels.
 */
export async function requestHookPermission(): Promise<HIDDevice | null> {
  const [d] = await navigator.hid.requestDevice({
    filters: [
      {
        vendorId: target.vendorId,
        productId: target.productId,
        usagePage: USAGE_PAGE_TELEPHONY,
        usage: USAGE_HEADSET,
      },
    ],
  });
  device = d ?? null;
  return device;
}

async function ensureOpen(): Promise<HIDDevice | null> {
  if (!device) device = await findHookDevice();
  if (!device) return null;
  if (!device.opened) await device.open();
  return device;
}

/** Diagnostics of the most recent `setOffHook()` call, or null. */
export const getLastHookInfo = (): HookInfo | null => lastInfo;

/**
 * Sends off-hook (`true`) or on-hook (`false`). Never throws.
 *
 * A hanging write must never delay the microphone, so the call gives up after `timeoutMs`
 * (the write keeps running in the background). Measured: normal writes take ~10 ms.
 *
 * @returns true if the report was sent
 */
export async function setOffHook(on: boolean, timeoutMs = 700): Promise<boolean> {
  const t0 = performance.now();
  const ms = () => Math.round(performance.now() - t0);
  try {
    const d = await ensureOpen();
    if (!d) {
      lastInfo = { ok: false, ms: ms(), err: 'no granted device' };
      return false;
    }
    await Promise.race([
      d.sendReport(target.reportId, Uint8Array.of(on ? target.offHookMask : 0x00, 0x00)),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeoutMs)),
    ]);
    lastInfo = { ok: true, ms: ms() };
    return true;
  } catch (e) {
    const err = e as Error;
    lastInfo = { ok: false, ms: ms(), err: `${err.name}: ${err.message}` };
    return false;
  }
}
