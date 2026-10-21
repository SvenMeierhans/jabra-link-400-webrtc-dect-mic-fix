// ==UserScript==
// @name         Jabra Link 400 mic fix (test)
// @namespace    https://github.com/SvenMeierhans/jabra-link-400-webrtc-dect-mic-fix
// @version      0.1.0
// @description  Sends off-hook to a Jabra DECT dongle before the page opens the mic and shows whether the mic delivers audio. For trying the fix before changing a site.
// @match        https://*.daily.co/*
// @match        https://your-app.example.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function() {
  "use strict";
  const USAGE_PAGE_TELEPHONY = 11;
  const USAGE_HEADSET = 5;
  const target = {
    vendorId: 2830,
    // GN Audio / Jabra
    productId: 4401,
    // Link 400
    reportId: 2,
    offHookMask: 1
  };
  let device = null;
  let lastInfo = null;
  const hookSupported = () => typeof navigator !== "undefined" && "hid" in navigator;
  async function findHookDevice() {
    if (!hookSupported()) return null;
    const all = await navigator.hid.getDevices();
    return all.find(
      (d) => d.vendorId === target.vendorId && d.productId === target.productId && d.collections.some((c) => c.usagePage === USAGE_PAGE_TELEPHONY)
    ) ?? null;
  }
  async function requestHookPermission() {
    const [d] = await navigator.hid.requestDevice({
      filters: [
        {
          vendorId: target.vendorId,
          productId: target.productId,
          usagePage: USAGE_PAGE_TELEPHONY,
          usage: USAGE_HEADSET
        }
      ]
    });
    device = d ?? null;
    return device;
  }
  async function ensureOpen() {
    if (!device) device = await findHookDevice();
    if (!device) return null;
    if (!device.opened) await device.open();
    return device;
  }
  const getLastHookInfo = () => lastInfo;
  async function setOffHook(on, timeoutMs = 700) {
    const t0 = performance.now();
    const ms = () => Math.round(performance.now() - t0);
    try {
      const d = await ensureOpen();
      if (!d) {
        lastInfo = { ok: false, ms: ms(), err: "no granted device" };
        return false;
      }
      await Promise.race([
        d.sendReport(target.reportId, Uint8Array.of(on ? target.offHookMask : 0, 0)),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), timeoutMs))
      ]);
      lastInfo = { ok: true, ms: ms() };
      return true;
    } catch (e) {
      const err = e;
      lastInfo = { ok: false, ms: ms(), err: `${err.name}: ${err.message}` };
      return false;
    }
  }
  const IS_TOP = window === window.top;
  const MSG = "jabra-mic-fix";
  const SETTINGS_KEY = "jabra-mic-fix:settings";
  const FRAME_ID = Math.random().toString(36).slice(2, 8);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function loadSettings() {
    try {
      return { autoFix: true, collapsed: false, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") };
    } catch {
      return { autoFix: true, collapsed: false };
    }
  }
  const settings = loadSettings();
  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
    }
  }
  const hud = {
    hid: "unknown",
    offHook: null,
    hookNote: "",
    entries: []
  };
  let hookReady = Promise.resolve(false);
  async function initHook() {
    if (!hookSupported()) {
      hud.hid = "unsupported";
      return false;
    }
    if (!await findHookDevice()) {
      hud.hid = "not-granted";
      render();
      return false;
    }
    hud.hid = "granted";
    return sendHook(true);
  }
  async function sendHook(on) {
    const ok = await setOffHook(on);
    const info = getLastHookInfo();
    hud.offHook = ok ? on : hud.offHook;
    hud.hookNote = ok ? `${on ? "off-hook" : "on-hook"} sent (${info?.ms ?? "?"} ms)` : `failed: ${info?.err ?? "unknown"}`;
    render();
    return ok;
  }
  async function toggleHook() {
    await sendHook(false);
    await sleep(150);
    return sendHook(true);
  }
  async function firstSignal(track, timeoutMs) {
    const t0 = performance.now();
    const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    try {
      while (performance.now() - t0 < timeoutMs) {
        const r = await Promise.race([reader.read(), sleep(Math.max(0, timeoutMs - (performance.now() - t0))).then(() => null)]);
        if (!r || r.done || !r.value) break;
        const frame = r.value;
        const buf = new Float32Array(frame.numberOfFrames);
        frame.copyTo(buf, { planeIndex: 0, format: "f32-planar" });
        frame.close();
        if (buf.some((x) => x !== 0)) return Math.round(performance.now() - t0);
      }
      return null;
    } finally {
      reader.cancel().catch(() => {
      });
    }
  }
  async function probe(track, timeoutMs) {
    const clone = track.clone();
    try {
      return await firstSignal(clone, timeoutMs);
    } finally {
      clone.stop();
    }
  }
  let seq = 0;
  async function inspect(track) {
    const entry = { key: `${FRAME_ID}:${++seq}`, at: Date.now(), label: track.label || "microphone", state: "checking", inFrame: !IS_TOP };
    publish(entry);
    if (typeof MediaStreamTrackProcessor === "undefined") {
      entry.state = "unmeasurable";
      return publish(entry);
    }
    const first = await probe(track, 2500);
    if (first !== null) {
      entry.state = "alive";
      entry.ms = first;
      return publish(entry);
    }
    entry.state = "silent";
    publish(entry);
    if (!settings.autoFix) return;
    const t0 = performance.now();
    if (IS_TOP) await toggleHook();
    else window.top?.postMessage({ type: MSG, kind: "fix-request" }, "*");
    const again = await probe(track, 3500);
    entry.state = again !== null ? "fixed" : "dead";
    entry.ms = again !== null ? Math.round(performance.now() - t0) : void 0;
    publish(entry);
  }
  function installWrapper() {
    const md = navigator.mediaDevices;
    if (!md?.getUserMedia) return;
    const original = md.getUserMedia.bind(md);
    md.getUserMedia = async (constraints) => {
      if (IS_TOP && constraints?.audio) await Promise.race([hookReady, sleep(800)]);
      const stream = await original(constraints);
      const track = stream.getAudioTracks()[0];
      if (track) void inspect(track);
      return stream;
    };
  }
  function publish(entry) {
    if (IS_TOP) {
      upsert(entry);
      render();
    } else {
      window.top?.postMessage({ type: MSG, kind: "entry", entry }, "*");
    }
  }
  function upsert(entry) {
    const i = hud.entries.findIndex((e) => e.key === entry.key);
    const copy = { ...entry };
    if (i >= 0) hud.entries[i] = copy;
    else hud.entries.push(copy);
    hud.entries = hud.entries.slice(-6);
  }
  if (IS_TOP) {
    window.addEventListener("message", (e) => {
      const d = e.data;
      if (!d || d.type !== MSG) return;
      if (d.kind === "entry" && d.entry) {
        upsert({ ...d.entry, inFrame: true });
        render();
      } else if (d.kind === "fix-request" && settings.autoFix) {
        void toggleHook();
      }
    });
  }
  const CSS = `
:host { all: initial; }
.box { position: fixed; right: 12px; bottom: 12px; z-index: 2147483647; width: 320px; font: 12px/1.45 system-ui, sans-serif;
  background: #14181f; color: #e8ecf1; border: 1px solid #39424f; border-radius: 10px; box-shadow: 0 6px 24px #0008; overflow: hidden; }
.head { display: flex; align-items: center; gap: 8px; padding: 7px 10px; background: #1d232d; cursor: pointer; user-select: none; }
.head b { flex: 1; font-size: 12px; }
.dot { width: 9px; height: 9px; border-radius: 50%; background: #7a8494; }
.dot.ok { background: #38c172; } .dot.warn { background: #f2b53d; } .dot.bad { background: #e3534b; }
.body { padding: 8px 10px; display: grid; gap: 6px; }
.row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.muted { color: #9aa5b4; }
button { font: inherit; color: inherit; background: #2a3342; border: 1px solid #435066; border-radius: 6px; padding: 3px 9px; cursor: pointer; }
button:hover { background: #34405a; }
.entry { padding: 3px 0; border-top: 1px solid #262e3a; }
.alive { color: #5fd38d; } .fixed { color: #6cb6ff; } .silent, .checking { color: #f2b53d; } .dead { color: #ff7b72; }
label { display: flex; gap: 5px; align-items: center; }
`;
  let host = null;
  let root = null;
  function el(tag, props = {}, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") node.className = String(v);
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
      else if (k === "checked") node.checked = Boolean(v);
      else node.setAttribute(k, String(v));
    }
    node.append(...kids);
    return node;
  }
  function describe(e) {
    const where = e.inFrame ? "iframe " : "";
    switch (e.state) {
      case "checking":
        return `${where}${e.label}: checking ...`;
      case "alive":
        return `${where}${e.label}: audio after ${e.ms} ms`;
      case "silent":
        return `${where}${e.label}: SILENT${settings.autoFix ? " - fixing ..." : ""}`;
      case "fixed":
        return `${where}${e.label}: SILENT, revived after ${e.ms} ms`;
      case "dead":
        return `${where}${e.label}: SILENT, fix did not help`;
      default:
        return `${where}${e.label}: cannot be measured in this browser`;
    }
  }
  function render() {
    if (!IS_TOP) return;
    if (!host) {
      if (!document.documentElement) return;
      host = document.createElement("div");
      root = host.attachShadow({ mode: "open" });
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      root.adoptedStyleSheets = [sheet];
      document.documentElement.appendChild(host);
    }
    const worst = hud.entries.some((e) => e.state === "dead" || e.state === "silent") ? "bad" : hud.offHook ? "ok" : "warn";
    const dot = el("span", { class: "dot " + worst });
    const head = el("div", { class: "head", onclick: () => {
      settings.collapsed = !settings.collapsed;
      saveSettings();
      render();
    } }, dot, el("b", {}, "Jabra mic fix (test)"), el("span", { class: "muted" }, settings.collapsed ? "show" : "hide"));
    const box = el("div", { class: "box" }, head);
    if (!settings.collapsed) {
      const body = el("div", { class: "body" });
      const hidText = { unknown: "checking ...", unsupported: "WebHID unavailable (use Chrome/Edge over HTTPS)", "not-granted": "not granted yet", granted: "granted" }[hud.hid];
      const hidRow = el("div", { class: "row" }, el("span", {}, "Headset access: " + hidText));
      if (hud.hid === "not-granted") {
        hidRow.append(el("button", { onclick: async () => {
          if (await requestHookPermission()) {
            hud.hid = "granted";
            hookReady = sendHook(true);
          }
          render();
        } }, "Grant"));
      }
      body.append(hidRow);
      body.append(el("div", { class: "muted" }, `Dongle: ${hud.offHook === null ? "no signal sent yet" : hud.offHook ? "off-hook" : "on-hook"}${hud.hookNote ? " - " + hud.hookNote : ""}`));
      body.append(
        el(
          "div",
          { class: "row" },
          el("button", { onclick: () => void toggleHook() }, "Toggle off-hook"),
          el("button", { onclick: () => void sendHook(false) }, "On-hook (release)"),
          el("label", {}, el("input", { type: "checkbox", checked: settings.autoFix, onchange: (ev) => {
            settings.autoFix = ev.target.checked;
            saveSettings();
            render();
          } }), "auto-fix")
        )
      );
      if (hud.entries.length === 0) body.append(el("div", { class: "muted" }, "No microphone opened yet on this page."));
      for (const e of hud.entries.slice().reverse()) {
        body.append(el("div", { class: "entry " + e.state }, `${new Date(e.at).toLocaleTimeString()}  ${describe(e)}`));
      }
      box.append(body);
    }
    root.replaceChildren(box);
  }
  installWrapper();
  if (IS_TOP) {
    hookReady = initHook();
    void hookReady.then(render);
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", render);
    else render();
    window.__jabraMicFix = { hud, toggleHook, sendHook, settings };
  }
})();
