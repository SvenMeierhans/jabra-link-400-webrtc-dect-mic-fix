<!--
  Example hint for "your microphone is starting". Shows nothing for healthy starts, a short notice for slow ones,
  a countdown while the headset reconnects, and a retry prompt if no signal arrives. Restyle and translate freely:
  map `status.state` / `status.reason` to your own i18n keys.

  <MicStatusHint @retry="switchMic()" />
-->
<script setup lang="ts">
const { status, showHint, remainingSec, problem } = useMicStatus()
const emit = defineEmits<{ retry: [] }>()
</script>

<template>
  <Transition name="mic-hint">
    <div v-if="showHint" class="mic-hint" role="status" aria-live="polite">
      <template v-if="status.state === 'waiting'">
        Reconnecting your headset<template v-if="remainingSec"> - about {{ remainingSec }} s</template> ...
      </template>
      <template v-else>Starting your microphone ...</template>
    </div>
  </Transition>

  <div v-if="problem" class="mic-problem" role="alert">
    <template v-if="status.state === 'error'">
      The microphone could not be opened ({{ status.error }}). Check the browser's microphone permission.
    </template>
    <template v-else>No microphone signal. Switch your headset off and on, then retry.</template>
    <button type="button" @click="emit('retry')">Retry</button>
  </div>
</template>

<style scoped>
.mic-hint-enter-active,
.mic-hint-leave-active {
  transition: opacity 0.2s;
}
.mic-hint-enter-from,
.mic-hint-leave-to {
  opacity: 0;
}
</style>
