/*
 * Stands in for a third-party UI such as Daily Prebuilt: after `delay` ms it opens the default microphone,
 * checks whether real audio arrives and reports to the host page. The host cannot touch the stream.
 * It never stops the mic itself; the stream is closed when the host page reloads.
 */
const delay = Number(new URLSearchParams(location.search).get('delay') ?? 0);
await new Promise<void>((r) => setTimeout(r, delay));

const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
const track = stream.getAudioTracks()[0]!;
const t0 = performance.now();
const reader = new MediaStreamTrackProcessor({ track: track as MediaStreamAudioTrack }).readable.getReader();
let firstSignal: number | null = null;
let zeroRunMs = 0;
while (performance.now() - t0 < 4500 && firstSignal === null && zeroRunMs < 2000) {
  const { value, done } = await reader.read();
  if (done || !value) break;
  const frame = value as AudioData;
  const buf = new Float32Array(frame.numberOfFrames);
  frame.copyTo(buf, { planeIndex: 0, format: 'f32-planar' });
  const { sampleRate, numberOfFrames } = frame;
  frame.close();
  if (buf.some((x) => x !== 0)) firstSignal = Math.round(performance.now() - t0);
  else zeroRunMs += (numberOfFrames / sampleRate) * 1000;
}
reader.cancel().catch(() => {});
parent.postMessage({ type: 'result', alive: firstSignal !== null, firstSignal }, '*');
(window as unknown as { keepAlive: MediaStream }).keepAlive = stream; // keep the mic open, like a call would

export {};
