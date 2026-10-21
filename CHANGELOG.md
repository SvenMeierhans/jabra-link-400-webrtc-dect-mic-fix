# Changelog

## 0.1.0

First public release.

- `acquireWorkingMic()`: opens the mic, detects the "live but silent" state and recovers (off-hook, on-/off-hook toggle, release-and-wait).
- WebHID off-hook/on-hook for the Jabra Link 400 (`setOffHook`, `requestHookPermission`, `findHookDevice`).
- Observable status for UIs: `onMicStatus()` / `getMicStatus()` (`idle`, `starting`, `waiting` with countdown, `ready`, `degraded`, `error`).
- Helpers for apps that do not own the mic (Daily Prebuilt): `prepareDongle`, `markMicActive`, `markMicInactive`, `releaseDongle`.
- Tampermonkey/Violentmonkey userscript with a HUD, to try the fix on a live site before changing its code.
- Nuxt examples: Daily call object, Daily Prebuilt, permission button, status composable and hint component.
- Reproduction lab (Vite dev server) and read-only HID analysis tools under `lab/`.
- TypeScript throughout; built with Vite; tested with Vitest.

Verified only on: Jabra Link 400 (firmware 1.13 and 1.16), Windows 11, Edge 155 / Chrome 155.
