<!--
  One-time WebHID permission for DECT dongles. Shows only if
   - the browser supports WebHID,
   - a matching Jabra dongle is present, and
   - access has not been granted yet.
  The click opens the browser's device chooser (NOT the microphone prompt). The grant is remembered per browser
  profile and origin, so this disappears after the first use.
  Needs a microphone permission first, otherwise device labels are empty and the dongle cannot be recognised.
-->
<script setup lang="ts">
const show = ref(false)

onMounted(async () => {
  const { hookSupported, findHookDevice } = await import('jabra-link-400-webrtc-dect-mic-fix')
  const devices = await navigator.mediaDevices.enumerateDevices()
  const hasDongle = devices.some((d) => d.kind === 'audioinput' && /jabra\s+link/i.test(d.label))
  show.value = hookSupported() && hasDongle && !(await findHookDevice())
})

async function grant() {
  try {
    const { requestHookPermission } = await import('jabra-link-400-webrtc-dect-mic-fix')
    show.value = !(await requestHookPermission()) // opens the chooser; null if cancelled
  } catch (e) {
    console.warn('Headset access request failed', e)
  }
}
</script>

<template>
  <div v-if="show" class="headset-permission">
    <p>Allow headset access once so your microphone comes back instantly after a refresh. Without it this takes about ten seconds.</p>
    <button type="button" @click="grant">Connect headset</button>
  </div>
</template>
