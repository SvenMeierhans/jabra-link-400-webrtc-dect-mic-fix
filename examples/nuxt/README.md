# Nuxt examples

Copy the files into your Nuxt 3 app (`composables/`, `components/`) and install the library and Daily:

```sh
npm install github:SvenMeierhans/jabra-link-400-webrtc-dect-mic-fix @daily-co/daily-js
```

| File | Use it for |
| --- | --- |
| `composables/useDailyCall.ts` | Daily **call object** (headless, you build the UI). The library hands Daily a checked mic track. |
| `composables/usePrebuiltCall.ts` | Daily **Prebuilt** (iframe UI). The library prepares the dongle before the frame exists. |
| `components/HeadsetPermission.client.vue` | The one-time WebHID permission button. Render it near your device settings or pre-join screen. |

Notes

- Everything that touches the browser is imported dynamically inside functions, and the component is `.client.vue`, so SSR never executes it.
- Trigger `join()` from client code (`onMounted`, a click handler), not from `useAsyncData`/server code.
- On route changes inside the SPA, call `leave()` in `onBeforeUnmount`, otherwise the track stays open.
- These examples are untested against a real Daily room; see the main README for what was verified.
