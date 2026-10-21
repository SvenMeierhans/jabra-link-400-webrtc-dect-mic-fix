// Nuxt composable for Daily PREBUILT (iframe UI) with the DECT-dongle fix.
//
// Prebuilt opens the microphone itself inside the iframe and does not accept an audioSource track, so the app
// cannot hand it a checked track. Instead the host page prepares the DONGLE before the frame exists:
//  - with the one-time WebHID grant: sends off-hook (~10 ms), which prevents the dead stream;
//  - without it: waits until the dongle's hold time since the last call has expired (up to ~5.5 s).
//
// NOTE: validated only with a cross-origin iframe simulation (lab/prebuilt-sim.html), not with Daily itself.
import type { DailyCall } from '@daily-co/daily-js'

export function usePrebuiltCall() {
  let frame: DailyCall | null = null

  async function join(container: HTMLElement, url: string) {
    const { default: Daily } = await import('@daily-co/daily-js')
    const { prepareDongle, markMicActive, releaseDongle } = await import('jabra-link-400-webrtc-dect-mic-fix')

    // Must run BEFORE createFrame(): Prebuilt may open the mic immediately (pre-join screen).
    await prepareDongle()

    frame = Daily.getCallInstance() ?? Daily.createFrame(container, { showLeaveButton: true })
    frame.on('joined-meeting', () => markMicActive()).on('left-meeting', () => releaseDongle())
    await frame.join({ url })
  }

  async function leave() {
    await frame?.leave()
    frame?.destroy()
    frame = null
  }

  return { join, leave }
}
