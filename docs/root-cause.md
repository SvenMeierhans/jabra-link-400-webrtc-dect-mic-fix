# Root cause and measurements

Everything here was measured on one setup: **Jabra Link 400** (USB `0B0E:1131`, firmware 1.13 then 1.16, USB revision `REV_0113` / `REV_0116`), Windows 11 (build 26200) with the inbox `usbaudio` driver (`wdma_usb.inf`), Edge 155 and Chrome 155. The dongle sat behind a USB hub. Firmware versions are inferred from the USB revision field and Jabra's release notes, not read from the device. Jabra Direct was *not* installed for the 1.13 measurements and was running for 1.16. Treat the numbers as "what this device did", not as vendor documentation.

## Symptom

`getUserMedia` resolves, and the track reports `readyState: "live"`, `muted: false`, `enabled: true`. `MediaStreamTrackProcessor` delivers audio frames at the normal rate, **but every sample is exactly `0.0`**. A healthy mic always has a noise floor (peaks around 1e-4 even in silence), so exact zeros are a reliable indicator. No `mute`/`ended` event fires.

## It is not the browser, the driver or Daily

- Reproduced with a bare `getUserMedia` page: no WebRTC library involved.
- Identical in Edge 155 and Chrome 155.
- The audio driver is the Windows inbox class driver; there is no vendor driver to blame.
- Firmware 1.13 and 1.16 behave the same.

## The dongle's state machine

Observed through the dongle's HID input reports (read-only monitor, `lab/hid/hidmon.ps1`):

| Event on the host | What the dongle reports over HID | Timing |
| --- | --- | --- |
| Capture stream opens, dongle idle | Session start: telephony input `02 04 00` (Hook Switch bit), vendor input `04 08 ...`, then 9 consumer-control "Volume Up" pulses | at stream open; audio arrives ~0.6-1.4 s later (radio link set-up) |
| Capture stream closes | 9 "Volume Down" pulses | ~0.5 s after the close (Windows keeps the pin open that long) |
| (nothing) | - | dongle holds the session |
| Hold time expires | Session end: telephony `02 00 00`, vendor `04 00 ...` | **5.48 s** after the stream stopped (5467-5488 ms across all measurements) |

### When the stream is dead

| Gap between the previous close and the new open | Result |
| --- | --- |
| < ~0.5 s (re-open before Windows closes the pin) | healthy; the dongle never notices (mic ready in ~75 ms) |
| ~0.5 s to ~5.5 s (dongle has seen the stop, session still held) | **dead**: no new session-start report, mic path not re-attached, zeros |
| > 5.5 s | healthy: fresh session start, mic ready in ~0.85 s |

Scan with a re-open delay of 100/300/450 ms: 0 of 5 dead; 600/800 ms: 4 of 4 dead; 1000-4500 ms: dead in every attempt (several dozen). Every dead run was preceded by the "Volume Down" burst; no healthy run was.

A dead stream stays dead (observed for 13 s). It is not an audio-engine problem on the host side: the host sees a perfectly valid stream.

## What fixes a dead stream, and what does not

| Action on a dead stream | Result |
| --- | --- |
| Wait up to 13 s | still dead |
| Stop the track and re-open immediately / after 1 s / 3 s / 4 s / 5 s | still dead (3 of 3 each) |
| Open a second stream in parallel | still dead |
| Stop, wait **6 s** (or 8 s), re-open | **alive** (3 of 3 each), signal after ~0.87 s |
| Another process keeps the mic open the whole time | never dead (0 of 12) |
| Send telephony **Off-Hook** to the dongle | **alive** (3 of 3), signal after ~1.1 s |
| Off-Hook, then On-Hook, then Off-Hook | alive (3 of 3) |
| Mute LED output (`02 02 00`) | still dead (0 of 3) |

### Prevention with off-hook

Sending off-hook right after page load, then opening the mic after an app-load delay of 100 ms / 1 s / 4.5 s: **12 of 12 healthy**, signal after ~75 ms. Keeping off-hook set across the reload (never sending on-hook) also worked (6 of 6).

With WebHID in Edge, six reloads with delays of 1-4.5 s: off-hook sent in ~10 ms every time, mic ready in ~120 ms every time (provided no on-hook was sent when leaving the previous page - see below).

## HID layout used

Dumped with `lab/hid/hidinfo.ps1`, bytes computed with `HidP_SetUsages` (`lab/hid/hidbits.ps1`) - **do not assume bit positions from the order of usages**: the bit order of the output report is the reverse of the order in `HidP_GetButtonCaps`, so a guess sets the wrong LED.

Telephony collection (usage page `0x000B`, usage `0x0005` Headset), report ID `2`, 3 bytes:

| Direction | Usage | Byte 1 bit |
| --- | --- | --- |
| input | Hook Switch (`0x0B:0x20`) | `0x04` |
| output (LED page `0x08`) | **Off-Hook `0x17`** | **`0x01`** |
| output | Mute `0x09` | `0x02` |
| output | Ring `0x18` | `0x04` (inferred, never sent) |
| output | Hold `0x20` | `0x08` |
| output | Microphone `0x21` | `0x10` |
| output | Online `0x2A` | `0x20` |

The dongle also exposes vendor-defined collections (`0xFF99`, `0xFF00`, `0xFF55`; one mirrors the telephony report as ID 4/5) and a consumer-control collection (`0x000C`, volume up/down). They are only read, never written.

## Why `pagehide` does not send on-hook by default

Sending on-hook from `pagehide` and then off-hook from the next page made the *next* `sendReport` hang for 2-5 s and fail with `NotAllowedError: Failed to write the report.` in 4 of 6 reloads. Without the on-hook the write succeeded 6 of 6 in ~10 ms. The cause is unknown (a pending write in the previous document, or the dongle being busy). The cost of the default is a stale off-hook state when a tab is closed mid-call.

## Method

1. `lab/reload-test.html`: opens the mic, watches the samples with `MediaStreamTrackProcessor`, reloads itself with a configurable delay before `getUserMedia`, and calls a stream dead after 2 s of exact zeros (healthy starts need up to ~1.4 s). Recovery strategies are tried automatically on dead streams.
2. `lab/hid/hidmon.ps1`: opens each HID collection of the dongle read-only and timestamps every input report. `lab/hid/merge-timeline.js` merges that with the browser log.
3. Hypotheses were tested one at a time on the same hardware; the negative results are in the table above.

Not examined: USB-level traffic (alt-setting changes) - that needs an elevated ETW or hardware trace - and the dongle firmware itself. The state machine above is inferred from HID reports and audio behaviour.

## Adapting to another dongle

1. Plug it in, run `lab/reload-test.html` and see whether the bug reproduces (dead for a re-open delay of ~1-4 s).
2. `lab/hid/hidinfo.ps1 -Match "vid_XXXX&pid_YYYY"` lists the HID collections and their usages. Look for usage page `0x0B` (Telephony) with an output LED `0x08:0x17` (Off-Hook).
3. `lab/hid/hidbits.ps1` shows how to compute the exact output report with `HidP_SetUsages`.
4. Run `hidmon.ps1` while opening/closing the mic to see the dongle's session reports and its hold time.
5. Try `configureHook({ vendorId, productId, reportId, offHookMask })` and the reload test with the grant in place. Please share the result in a device report.
