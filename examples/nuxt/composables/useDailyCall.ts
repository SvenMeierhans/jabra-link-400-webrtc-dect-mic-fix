// Nuxt composable for a Daily CALL OBJECT (headless) with the DECT-dongle fix.
// Daily Prebuilt needs a different approach - see usePrebuiltCall.ts.
//
// Copy this file to composables/ and install the library: npm install github:SvenMeierhans/jabra-link-400-webrtc-dect-mic-fix
// All browser-only code is imported dynamically inside functions, so nothing runs during SSR.
import type { DailyCall } from '@daily-co/daily-js'

// Only devices whose label matches get the guard. Without a label (no mic permission yet) we guard to be safe.
const DECT_LABEL = /jabra\s+(link|engage)/i

export function useDailyCall() {
  const state = reactive({
    joined: false,
    mic: 'off' as 'off' | 'connecting' | 'ok' | 'degraded', // degraded: every attempt was silent
  })
  let call: DailyCall | null = null
  let micTrack: MediaStreamTrack | null = null

  async function micNeedsGuard(deviceId?: string) {
    const devices = await navigator.mediaDevices.enumerateDevices()
    const d = devices.find((x) => x.kind === 'audioinput' && x.deviceId === (deviceId ?? 'default'))
    return !d?.label || DECT_LABEL.test(d.label)
  }

  async function startMic(deviceId?: string) {
    if (!import.meta.client || !call) return
    state.mic = 'connecting'
    const { acquireWorkingMic, releaseMic } = await import('jabra-link-400-webrtc-dect-mic-fix')

    // Never track.stop() a track from acquireWorkingMic(): releaseMic() also remembers the time and sends on-hook.
    if (micTrack) {
      releaseMic(micTrack)
      micTrack = null
    }

    if (!(await micNeedsGuard(deviceId))) {
      // Other headsets: normal Daily path.
      if (deviceId) await call.setInputDevicesAsync({ audioDeviceId: deviceId })
      call.setLocalAudio(true)
      state.mic = 'ok'
      return
    }

    const { track, healthy } = await acquireWorkingMic({ deviceId, onStatus: (s) => console.debug('[mic]', s) })
    micTrack = track
    await call.setInputDevicesAsync({ audioSource: track }) // we own the track's lifecycle now
    call.setLocalAudio(true)
    state.mic = healthy ? 'ok' : 'degraded'
  }

  async function join(opts: { url: string; token?: string; micDeviceId?: string }) {
    const { default: Daily } = await import('@daily-co/daily-js')
    call = Daily.getCallInstance() ?? Daily.createCallObject()
    // Join right away without the mic (startAudioOff); the guarded mic follows. Do NOT call startCamera() with
    // audio before joining: Daily would open the mic itself and hold a second handle on the dongle.
    await call.join({ url: opts.url, token: opts.token, startAudioOff: true })
    state.joined = true
    await startMic(opts.micDeviceId)
  }

  async function leave() {
    const { releaseMic } = await import('jabra-link-400-webrtc-dect-mic-fix')
    await call?.leave()
    call?.destroy()
    call = null
    if (micTrack) {
      releaseMic(micTrack)
      micTrack = null
    }
    state.joined = false
    state.mic = 'off'
  }

  return { state, join, leave, switchMic: startMic }
}
