/**
 * Integration smoke test (AC8).
 *
 * Boots a minimal Express HTTP server with the logger installed, issues one
 * GET request, and asserts the emitted line is valid JSON containing the
 * expected `service` and `level` fields.
 *
 * Express is a devDependency only — the observability package itself has no
 * Express runtime dependency.
 */

import http from 'node:http';
import { Writable } from 'node:stream';
import express from 'express';
import { createLogger } from '../src/logger.js';

function makeCapture(): { stream: Writable; getOutput: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc: BufferEncoding, cb: () => void) {
      chunks.push(chunk.toString('utf-8'));
      cb();
    },
  });
  return { stream, getOutput: () => chunks.join('') };
}

describe('integration smoke test — Express + logger', () => {
  it('emits parseable JSON with service and level fields on a GET request', (done) => {
    const { stream, getOutput } = makeCapture();
    const logger = createLogger({ service: 'smoke-test-service' }, stream);

    const app = express();

    app.get('/health', (req, res) => {
      logger.info({ path: req.path, method: req.method }, 'health check');
      res.status(200).json({ ok: true });
    });

    const server = http.createServer(app);

    server.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        done(new Error('Unexpected server address type'));
        return;
      }

      const port = addr.port;

      http.get(`http://localhost:${port}/health`, (res) => {
        res.resume();
        res.on('end', () => {
          server.close(() => {
            // Give pino one tick to flush to the capture stream.
            setImmediate(() => {
              const output = getOutput();
              const jsonLine = output
                .split('\n')
                .map((l) => l.trim())
                .find((l) => l.startsWith('{'));

              expect(jsonLine).toBeDefined();

              const parsed = JSON.parse(jsonLine as string) as Record<string, unknown>;
              expect(parsed['service']).toBe('smoke-test-service');
              expect(typeof parsed['level']).toBe('string');
              expect(parsed['msg']).toBe('health check');
              done();
            });
          });
        });
      }).on('error', (err: Error) => {
        server.close();
        done(err);
      });
    });
  });
});
