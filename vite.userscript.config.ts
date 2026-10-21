import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const root = path.dirname(fileURLToPath(import.meta.url));

/**
 * Tampermonkey / Violentmonkey metadata block. Edit the @match lines for your own site.
 * No @noframes: the script also runs in iframes (e.g. Daily Prebuilt) where it only watches the mic.
 */
const header = `// ==UserScript==
// @name         Jabra Link 400 mic fix (test)
// @namespace    https://github.com/SvenMeierhans/jabra-link-400-webrtc-dect-mic-fix
// @version      0.1.0
// @description  Sends off-hook to a Jabra DECT dongle before the page opens the mic and shows whether the mic delivers audio. For trying the fix before changing a site.
// @match        https://*.daily.co/*
// @match        https://your-app.example.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

`;

/** Vite's library mode does not apply output.banner to the IIFE, so prepend the metadata block ourselves. */
function userscriptHeader(): Plugin {
  return {
    name: 'userscript-header',
    enforce: 'post',
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type === 'chunk') file.code = header + file.code;
      }
    },
  };
}

// Bundles userscript/main.ts (and the library modules it imports) into ONE self-contained file: userscript/dect-mic-fix.user.js
export default defineConfig({
  publicDir: false,
  plugins: [userscriptHeader()],
  build: {
    outDir: path.join(root, 'userscript'),
    emptyOutDir: false,
    target: 'es2022',
    minify: false,
    sourcemap: false,
    lib: {
      entry: path.join(root, 'userscript/main.ts'),
      formats: ['iife'],
      name: 'jabraMicFix',
      fileName: () => 'dect-mic-fix.user.js',
    },
  },
});
