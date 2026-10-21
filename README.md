# jabra-link-400-webrtc-dect-mic-fix

**Fixes the "live but silent" microphone that DECT headset dongles (verified: Jabra Link 400) deliver after a page refresh in WebRTC apps such as [Daily](https://www.daily.co/).**

After a refresh, `getUserMedia` succeeds, the track is `readyState: "live"`, `muted: false`, frames keep arriving - and every single sample is `0`. Neither the browser nor your WebRTC library reports an error, so the call just has a dead microphone until the user leaves and re-joins.

`jabra-link-400-webrtc-dect-mic-fix` prevents this by telling the dongle *"a call is active"* (HID telephony off-hook, exactly what a softphone does) before the mic is opened. Where that is not possible it detects the silence and recovers on its own.

> **Status: experimental.** Verified on exactly one setup (see [Compatibility](#compatibility)). Reports for other dongles are very welcome.

## Contents

- [Am I affected?](#am-i-affected)
- [How it works](#how-it-works)
- [Install](#install)
- [Quick start](#quick-start)
- [Showing progress in the UI](#showing-progress-in-the-ui)
- [Daily.co: call object vs. Prebuilt](#dailyco-call-object-vs-prebuilt)
- [The one-time permission](#the-one-time-permission)
- [Try it before changing your site (userscript)](#try-it-before-changing-your-site-userscript)
- [API](#api)
- [Compatibility](#compatibility)
- [Limitations and trade-offs](#limitations-and-trade-offs)
- [Reproduce, investigate, contribute](#reproduce-investigate-contribute)
- [Disclaimer](#disclaimer)

## Am I affected?

You probably are if a wireless headset on a USB DECT dongle works fine, but after pressing F5 in a call the remote side hears nothing, while leaving and re-joining a few seconds later fixes it. Wired USB headsets are reportedly not affected.

Confirm it with this snippet (Chromium, paste into the console right after a refresh of a page that has the mic open, or call it from your app 1-5 s after the previous page closed the mic):

```js
const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
const track = stream.getAudioTracks()[0];
const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
let nonZero = false;
const end = performance.now() + 3000;
while (performance.now() < end && !nonZero) {
  const { value } = await reader.read();
  const buf = new Float32Array(value.numberOfFrames);
  value.copyTo(buf, { planeIndex: 0, format: 'f32-planar' });
  value.close();
  nonZero = buf.some((x) => x !== 0);
}
console.log(track.readyState, 'muted=' + track.muted, nonZero ? 'audio present' : 'ONLY SILENCE');
```

`live`, `muted=false` and `ONLY SILENCE` is the bug. For a repeatable measurement use the [reload test](lab/README.md).

## How it works

The dongle keeps a "session" with the headset. When the host stops the USB audio stream, the dongle holds that session for another **~5.5 s** before tearing down the radio link. If the mic is re-opened inside that window (0.5-5.5 s after the last close - exactly a page refresh plus app boot time), the dongle does not re-attach its microphone path to the radio link and sends zeros until the session has expired once.

The fix works in three layers (`acquireWorkingMic`):

1. **Prevent.** Send HID *off-hook* via WebHID before opening the mic. In testing the dead state never occurred with it (mic ready ~0.1 s after load).
2. **Detect.** A healthy mic delivers a non-zero sample within ~1.5 s; a dead one delivers only exact zeros.
3. **Recover.** If dead anyway: toggle off-hook once; if that does not help, stop the track, wait 6.5 s (the hold time plus margin) and open it again.

Full measurements, the HID byte layout and how to adapt this to another dongle: [docs/root-cause.md](docs/root-cause.md).

## Install

Not published to npm yet. Install from GitHub (the package builds itself on install):

```sh
npm install github:SvenMeierhans/jabra-link-400-webrtc-dect-mic-fix
```

Written in TypeScript, built with Vite, ESM only, no runtime dependencies, ships its own type declarations. It is safe to *import* in SSR (Nuxt, Next); only *call* it in the browser.

## Quick start

```ts
import { acquireWorkingMic, releaseMic, requestHookPermission } from 'jabra-link-400-webrtc-dect-mic-fix';

// Once, from a click handler, for users with a DECT dongle (see "The one-time permission"):
button.onclick = () => requestHookPermission();

// When the user starts a call:
const { track, healthy } = await acquireWorkingMic({ deviceId });
if (!healthy) showHint('The microphone delivers no signal.');

// When the call ends - always use releaseMic() instead of track.stop():
releaseMic(track);
```

`acquireWorkingMic` is a drop-in replacement for `getUserMedia({ audio })` that returns the track instead of a stream.

## Showing progress in the UI

Starting is instant on a healthy setup, but can take up to ~10 s when the dongle has to be reconnected. `onMicStatus()` lets your frontend show a hint ("Starting your microphone ...") and close it again:

```ts
import { onMicStatus } from 'jabra-link-400-webrtc-dect-mic-fix';

const unsubscribe = onMicStatus((s) => {
  // s.state: 'idle' | 'starting' | 'waiting' | 'ready' | 'degraded' | 'error'
  hint.visible = s.state === 'starting' || s.state === 'waiting';
  if (s.state === 'waiting') countdownTo(s.etaAt); // s.reason: 'dongle-busy' | 'reconnecting'
});
```

| `state` | Meaning | Typical UI |
| --- | --- | --- |
| `idle` | no mic requested / mic released | nothing |
| `starting` | opening the mic, waiting for audio (usually < 0.2 s) | "Starting your microphone ..." - show only after ~400 ms, or it flashes on every healthy start |
| `waiting` | deliberately waiting for the dongle (`dongle-busy`, `reconnecting`); `etaAt` is the expected end | "Reconnecting your headset, about N s" |
| `ready` | the mic carries audio (Prebuilt: the call was joined) | close the hint |
| `degraded` | every attempt stayed silent | "No microphone signal. Switch the headset off and on." + retry |
| `error` | `getUserMedia` failed; `error` is the `DOMException` name | permission / device hint |

`getMicStatus()` returns the current status synchronously. The listener is called immediately with the current status (pass `{ immediate: false }` to skip that) and never breaks mic start-up if it throws.

For Nuxt there is a ready-made composable that decides *when* to show and hide the hint (no flicker, minimum visible time, countdown) and an example component: [`useMicStatus`](examples/nuxt/composables/useMicStatus.ts) and [`MicStatusHint`](examples/nuxt/components/MicStatusHint.client.vue).

## Daily.co: call object vs. Prebuilt

|  | **Call object** (`Daily.createCallObject()`) | **Prebuilt** (`Daily.createFrame()` / embedded iframe) |
| --- | --- | --- |
| What it is | Headless: you build the UI | Ready-made Daily UI in an iframe |
| Who opens the mic | **You can** (`audioSource: track`) | Daily, inside the iframe |
| Access to the audio track | Yes | No (`audioSource` is not supported per Daily docs) |
| Fix used | `acquireWorkingMic()` + hand the track to Daily | `prepareDongle()` before creating the frame |
| Without the WebHID grant | silence is detected and repaired (~10 s after refresh) | waits out the dongle's hold time before creating the frame (up to ~5.5 s) |

### Call object

```ts
import Daily from '@daily-co/daily-js';
import { acquireWorkingMic, releaseMic } from 'jabra-link-400-webrtc-dect-mic-fix';

const call = Daily.createCallObject();
await call.join({ url, startAudioOff: true }); // join immediately, mic follows

const { track } = await acquireWorkingMic({ deviceId });
await call.setInputDevicesAsync({ audioSource: track }); // you own the track's lifecycle
call.setLocalAudio(true);

// leaving
await call.leave();
releaseMic(track);
```

Do not call `startCamera()` with audio before joining; it would make Daily open the mic itself. A complete Nuxt composable is in [examples/nuxt](examples/nuxt).

### Prebuilt

```ts
import Daily from '@daily-co/daily-js';
import { prepareDongle, markMicActive, releaseDongle } from 'jabra-link-400-webrtc-dect-mic-fix';

await prepareDongle(); // BEFORE the frame exists: Prebuilt may open the mic on its pre-join screen

const frame = Daily.createFrame(container, { /* your props */ });
frame.on('joined-meeting', markMicActive).on('left-meeting', releaseDongle);
await frame.join({ url });
```

Off-hook acts on the dongle, so it helps no matter who opens the mic. The Prebuilt path was validated with a cross-origin iframe simulating Prebuilt, not with Daily itself ([lab/prebuilt-sim.html](lab/prebuilt-sim.html)).

## The one-time permission

Sending off-hook uses [WebHID](https://developer.mozilla.org/docs/Web/API/WebHID_API). Browsers require the user to select the device once in a chooser dialog. This is **not** the microphone prompt; it is a separate dialog that lists the dongle ("Jabra Link 400") with a **Connect** button.

- Must be triggered by a click: `requestHookPermission()`.
- Granted once per browser profile, origin and device. It survives reloads and browser restarts; you do not ask on every visit. Use `findHookDevice()` to check whether it exists already.
- Asked again if the user clears site data or revokes it, uses another profile or machine, or the app moves to another origin.
- Needs HTTPS (or localhost) and a Chromium browser. In an iframe, the iframe needs `allow="hid"`.
- Managed machines can pre-grant it with the browser policy `WebHidAllowDevicesForUrls` (Chrome/Edge). *Not tested.*
- Without the grant (or in Firefox/Safari) the library still works through silence detection / waiting, only slower.

## Try it before changing your site (userscript)

[`userscript/dect-mic-fix.user.js`](userscript/dect-mic-fix.user.js) applies the fix to any site from the outside, so you can see whether it helps before touching the site's code. It runs in the page's own context, sends off-hook early, wraps `getUserMedia` without changing the stream, and shows a small HUD (bottom right) with the grant state and, for every microphone the page opens, whether real audio arrived ("audio after 78 ms") or only silence. With *auto-fix* on, a silent mic gets an on-/off-hook toggle (revived in testing after ~1.3 s).

1. Install [Tampermonkey](https://www.tampermonkey.net/) (or Violentmonkey). In Chrome/Edge, enable **Allow user scripts** in the extension's details page.
2. Open the raw file `https://raw.githubusercontent.com/SvenMeierhans/jabra-link-400-webrtc-dect-mic-fix/main/userscript/dect-mic-fix.user.js` - the extension offers to install it. Or create a new script and paste the file.
3. Change the second `@match` line from `https://your-app.example.com/*` to your site. Daily-hosted rooms (`https://*.daily.co/*`) are included.
4. Open the site, click **Grant** in the HUD once (the browser's device chooser opens), join a call and press F5.

Notes: it works for Daily Prebuilt too, because off-hook acts on the dongle and the HUD sits in the top frame; the mic inside the iframe is only measured if the script also runs there (it does when the iframe's origin is matched, but WebHID is blocked in iframes, so the top frame performs the fix). Rebuild the file with `npm run build:userscript`.

## API

| Function | Purpose |
| --- | --- |
| `acquireWorkingMic(options?)` | Open the mic and make sure it carries audio. Returns `{ track, healthy, attempts }`. |
| `releaseMic(track)` | Stop a track from `acquireWorkingMic`, remember the time, send on-hook. Use instead of `track.stop()`. |
| `hasSignal(track, timeoutMs?)` | `true` audio, `false` pure silence, `null` not measurable. |
| `prepareDongle(options?)` | For apps that do not own the mic (Prebuilt). Call before creating the UI. |
| `markMicActive()` / `markMicInactive()` / `releaseDongle()` | Tell the library when an external call starts / ends. |
| `onMicStatus(listener, opts?)` / `getMicStatus()` | Observable microphone status for UIs (see above). `onMicStatus` returns an unsubscribe function. |
| `waitUntilDongleIdle()` | Wait out the dongle's hold time if the mic was used less than ~6 s ago. |
| `hookSupported()` / `findHookDevice()` / `requestHookPermission()` | WebHID availability, existing grant, grant dialog. |
| `setOffHook(on, timeoutMs?)` | Low-level off-hook / on-hook. Never throws, times out after 700 ms. |
| `configureGuard({ onHookOnPageHide })` | See [Limitations](#limitations-and-trade-offs). |
| `configureHook({ vendorId, productId, reportId, offHookMask })` | Target a different dongle (experimental). |

`acquireWorkingMic` options: `deviceId`, `hook` (default `true`), `probeMs` (2500), `releaseWaitMs` (6500), `maxAttempts` (3), `waitForIdle` (`false`), `onStatus` (low-level progress; use `onMicStatus` for UIs). Full types ship with the package (source in [src/](src/)).

## Compatibility

| | Verified | Not verified |
| --- | --- | --- |
| Dongle | Jabra Link 400 (USB `0B0E:1131`), firmware 1.13 and 1.16 (inferred from the USB revision) | Other Jabra/GN dongles, other vendors' DECT dongles |
| OS | Windows 11 (build 26200) | macOS, Linux |
| Browser | Edge 155, Chrome 155 | Firefox / Safari (no WebHID; silence detection falls back to an AudioContext analyser, untested) |
| App | Plain `getUserMedia` pages; cross-origin-iframe simulation of Prebuilt; the Nuxt examples type-check and build with SSR in Nuxt 3.21 (the server renders the page without errors) | An actual Daily call |

Firmware 1.16 (the latest at the time of writing) does not fix the problem. Please open a [device report](https://github.com/SvenMeierhans/jabra-link-400-webrtc-dect-mic-fix/issues/new?template=device-report.yml) for anything else, successful or not.

## Limitations and trade-offs

- **Stale off-hook.** By default no on-hook is sent when the page is left, because it made the next page's off-hook write hang in 4 of 6 measured reloads. If the user closes the tab mid-call the dongle stays "off-hook" until your app sends on-hook (`releaseMic` / `releaseDongle`) or the dongle is replugged. It did not recover on its own within 15 s. Effects on other softphones are untested. `configureGuard({ onHookOnPageHide: true })` restores the on-hook-on-leave behaviour.
- **Only the telephony collection is written** (report ID 2, the Off-Hook LED bit). Vendor-defined collections are never touched. The WebHID chooser nevertheless grants access to the whole device, so never send other reports.
- **Volume pulses.** The dongle emits 9 Volume-Up/Down consumer-control pulses around session start/stop. Whether Windows applies them to the system volume was not examined.
- **Timing constants** (5.48 s hold, 0.5 s grace) are measured, not documented by the vendor. Other dongles or firmware may differ.
- **Silence detection assumes a noisy mic.** A mic that outputs exact digital zeros for another reason (hardware mute) is treated as dead and costs up to `maxAttempts` retries. Limit the guard to DECT devices, e.g. by matching `MediaDeviceInfo.label`.

## Reproduce, investigate, contribute

[`lab/`](lab/README.md) contains everything used to find the cause:

- `lab/reload-test.html`: automated reload loop that proves the bug and measures how long a re-open must be delayed.
- `lab/hid/`: read-only HID monitor and report-layout dumper (Windows, PowerShell + C#) to watch the dongle's session state and to derive the off-hook bytes for another dongle.
- `lab/prebuilt-sim.html`: cross-origin-iframe simulation of Daily Prebuilt.
- `lab/userscript-harness.html`: runs a plain page under the userscript.

To add a dongle: run the monitor, find its telephony collection and off-hook bit with `hidbits.ps1`, try `configureHook({ ... })`, and file a device report with your numbers.

```sh
npm install
npm run dev               # Vite dev server on http://localhost:8765 (lab pages, demo, log collector)
npm run typecheck         # tsc --noEmit
npm test                  # Vitest
npm run build             # library -> dist/ (ESM + .d.ts)
npm run build:userscript  # userscript/dect-mic-fix.user.js
npm run lab:summarize     # evaluate lab/out/testlog.jsonl
```

## Disclaimer

This is an independent project. It is not affiliated with, endorsed or supported by GN Audio A/S / Jabra or Daily.co. "Jabra" and "Daily" are trademarks of their respective owners and are used only to describe compatibility. The library writes a standard HID telephony report to a USB device you own; it was tested on one device and is provided as-is under the MIT license, without warranty.

## License

[MIT](LICENSE)
