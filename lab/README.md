# Lab

Tools to reproduce the bug, measure it and look at what the dongle does. The HID tools need Windows; the browser pages work anywhere WebHID and `MediaStreamTrackProcessor` exist (Chromium).

```sh
npm install
npm run dev      # Vite dev server: http://localhost:8765
```

Use `localhost` (a secure context). The dev server binds to 127.0.0.1. A small Vite plugin ([vite.config.ts](../vite.config.ts)) collects what the pages post to `/log` in `lab/out/testlog.jsonl` (truncated on every start).

## 1. Reproduce the bug: `reload-test`

Put the headset on (out of the charging cradle, linked to the dongle) and open

```
http://localhost:8765/lab/reload-test.html?tag=baseline
```

The page reloads itself, delays `getUserMedia` by different amounts (simulating app boot time), reads the samples and declares a stream **dead** if only exact zeros arrive for 2 s. Dead streams are then used to test recovery strategies (`stopN`, `parallel`, `waitN`). When it says DONE:

```sh
npm run lab:summarize
```

You get the failure rate per delay and the success of each recovery strategy. On a Jabra Link 400, delays of 1-4.5 s are dead every time; 0 ms and 6 s are fine. Query parameters are documented at the top of [reload-test.ts](reload-test.ts) (`delays`, `strats`, `per`, `max`, `device`).

## 2. Watch the dongle: `hid/`

All HID tools only read; none writes anything.

```powershell
# What does the dongle report while the mic is opened/closed? (run in a second terminal, then use the reload test)
powershell -ExecutionPolicy Bypass -File lab\hid\hidmon.ps1 -Seconds 120 -Match "vid_0b0e&pid_1131"

# Merge it with the browser log:
npm run lab:timeline

# Which collections / usages / report IDs does the device have?
powershell -ExecutionPolicy Bypass -File lab\hid\hidinfo.ps1 -Match "vid_0b0e&pid_1131"

# Which exact bytes set the Off-Hook usage? (computed with HidP_SetUsages, nothing is sent)
powershell -ExecutionPolicy Bypass -File lab\hid\hidbits.ps1 -Col col02 -ReportId 2
```

Find your dongle's VID/PID in Device Manager (Details > Hardware Ids) or with `Get-PnpDevice -PresentOnly | Where-Object InstanceId -like 'USB\VID_*'`.

## 3. Test the fix against a "third-party UI": `prebuilt-sim`

Simulates Daily Prebuilt: the host page prepares the dongle, then embeds a cross-origin iframe (`127.0.0.1` vs `localhost`) that opens the mic after a delay.

```
http://localhost:8765/lab/prebuilt-sim.html?s=hook   # off-hook via WebHID first (needs the one-time grant)
http://localhost:8765/lab/prebuilt-sim.html?s=idle   # no WebHID: wait out the dongle's hold time
http://localhost:8765/lab/prebuilt-sim.html?s=none   # baseline: expect dead iframes
```

Results (`prebuilt-result` events with `alive`) land in `lab/out/testlog.jsonl`.

## 4. Test the userscript: `userscript-harness`

Loads `userscript/dect-mic-fix.user.js` first, like Tampermonkey does, then opens the mic with plain `getUserMedia` as any website would:

```sh
npm run build:userscript
```

```
http://localhost:8765/lab/userscript-harness.html?mode=direct   # mic opened in the page
http://localhost:8765/lab/userscript-harness.html?mode=frame    # mic opened in a cross-origin iframe
```

## Safety

The tools are read-only, except that the *library itself* writes one standard HID Off-Hook / On-Hook report when you use it. Do not point `configureHook()` at a report you have not derived with `hidbits.ps1`; the WebHID chooser grants access to every collection of the device, including vendor-defined ones.
