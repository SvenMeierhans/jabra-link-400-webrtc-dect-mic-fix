// Reactive microphone status for Nuxt UIs: decides WHEN to show a "starting your microphone" hint and when to close it.
//
//   const { showHint, status, remainingSec, problem } = useMicStatus()
//
// - `showHint` is true while the mic is starting or waiting for the dongle, but only after `showAfterMs`
//   (default 400 ms) so healthy starts (~0.1 s) never flash a popup. Long waits ("reconnecting", up to ~10 s)
//   show immediately. Once shown it stays at least `minVisibleMs` so it does not blink away.
// - `remainingSec` counts down while the status is "waiting" (reason 'dongle-busy' or 'reconnecting').
// - `problem` is true for 'degraded' (no signal after all attempts) and 'error' (getUserMedia failed).
// - `status` is the raw status object (state, reason, error, ...) if you want to word the messages yourself.
import type { MicStatus } from 'jabra-link-400-webrtc-dect-mic-fix'

export function useMicStatus(options: { showAfterMs?: number; minVisibleMs?: number } = {}) {
  const { showAfterMs = 400, minVisibleMs = 600 } = options

  const status = ref<MicStatus>({ state: 'idle', at: Date.now() })
  const showHint = ref(false)
  const remainingSec = ref<number | null>(null)
  const busy = computed(() => status.value.state === 'starting' || status.value.state === 'waiting')
  const problem = computed(() => status.value.state === 'degraded' || status.value.state === 'error')

  let unsubscribe: (() => void) | undefined
  let showTimer: ReturnType<typeof setTimeout> | undefined
  let hideTimer: ReturnType<typeof setTimeout> | undefined
  let tick: ReturnType<typeof setInterval> | undefined
  let shownAt = 0

  function show() {
    clearTimeout(showTimer)
    showTimer = undefined
    if (!showHint.value) {
      showHint.value = true
      shownAt = Date.now()
    }
  }

  function onChange(s: MicStatus) {
    status.value = s

    clearInterval(tick)
    remainingSec.value = null
    if (s.state === 'waiting' && s.etaAt) {
      const eta = s.etaAt
      const update = () => (remainingSec.value = Math.max(0, Math.ceil((eta - Date.now()) / 1000)))
      update()
      tick = setInterval(update, 250)
    }

    if (s.state === 'starting' || s.state === 'waiting') {
      clearTimeout(hideTimer)
      if (s.state === 'waiting') show()
      else if (!showHint.value && showTimer === undefined) showTimer = setTimeout(show, showAfterMs)
    } else {
      clearTimeout(showTimer)
      showTimer = undefined
      if (showHint.value) {
        const left = Math.max(0, minVisibleMs - (Date.now() - shownAt))
        hideTimer = setTimeout(() => (showHint.value = false), left)
      }
    }
  }

  onMounted(async () => {
    const { onMicStatus } = await import('jabra-link-400-webrtc-dect-mic-fix')
    unsubscribe = onMicStatus(onChange) // also delivers the current status immediately
  })

  onBeforeUnmount(() => {
    unsubscribe?.()
    clearTimeout(showTimer)
    clearTimeout(hideTimer)
    clearInterval(tick)
  })

  return { status, busy, problem, showHint, remainingSec }
}
