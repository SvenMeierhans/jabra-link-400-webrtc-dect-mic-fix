import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vitest/config';

const root = path.dirname(fileURLToPath(import.meta.url));

/**
 * Dev-server only: collects the JSON lines that the lab pages post to /log into lab/out/testlog.jsonl,
 * so `npm run lab:summarize` and `npm run lab:timeline` can analyse a run. Truncated on every start.
 */
function labLog(): Plugin {
  return {
    name: 'lab-log',
    configureServer(server) {
      const outDir = path.join(root, 'lab', 'out');
      const file = path.join(outDir, 'testlog.jsonl');
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(file, '');
      server.middlewares.use('/log', (req, res, next) => {
        if (req.method !== 'POST') return next();
        let body = '';
        req.on('data', (d: Buffer) => (body += d));
        req.on('end', () => {
          fs.appendFileSync(file, body.replace(/\r?\n/g, ' ') + '\n');
          res.statusCode = 204;
          res.end();
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [labLog()],
  server: {
    // 127.0.0.1 and localhost are different origins on the same server: the Prebuilt simulation relies on that.
    host: '127.0.0.1',
    port: 8765,
    strictPort: true,
    open: false,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    minify: false,
    lib: {
      entry: path.join(root, 'src/index.ts'),
      formats: ['es'],
      fileName: 'index',
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
