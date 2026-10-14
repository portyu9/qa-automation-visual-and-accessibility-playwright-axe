import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { test, expect } from '@playwright/test';

const serverScript = 'scripts/test-site-server.mjs';

type SpawnedServer = ReturnType<typeof spawn>;

function waitForExit(child: SpawnedServer): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
}

async function stopServer(child: SpawnedServer): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await once(child, 'exit');
}

test.describe('deterministic fixture server contract', () => {
  test('rejects partially numeric ports instead of silently truncating them', async () => {
    const child = spawn(process.execPath, [serverScript], {
      cwd: process.cwd(),
      env: { ...process.env, TEST_PORT: '4173x' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    const code = await waitForExit(child);
    expect(code).not.toBe(0);
    expect(stderr).toContain('Invalid TEST_PORT: 4173x');
  });

  test('serves only contained fixture files with defensive response headers', async () => {
    const port = 45_000 + (process.pid % 1_000);
    const child = spawn(process.execPath, [serverScript], {
      cwd: process.cwd(),
      env: { ...process.env, TEST_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
      child.stdout.setEncoding('utf8');
      await Promise.race([
        once(child.stdout, 'data'),
        waitForExit(child).then((code) => {
          throw new Error(`fixture server exited before readiness with code ${String(code)}`);
        }),
      ]);

      const baseURL = `http://127.0.0.1:${port}`;
      const indexResponse = await fetch(`${baseURL}/`);
      expect(indexResponse.status).toBe(200);
      const csp = indexResponse.headers.get('content-security-policy') ?? '';
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("style-src 'self' 'report-sample'");
      // WebKit's built-in select emits one exact style attribute. Independently
      // compute its hash; the server must not grant any general inline CSS.
      const selectStyleHash = createHash('sha256').update('text-overflow:inherit').digest('base64');
      expect(csp).toContain(`style-src-attr 'unsafe-hashes' 'sha256-${selectStyleHash}'`);
      expect(csp).not.toContain("'unsafe-inline'");
      expect(csp).toContain("script-src 'self'");
      expect(indexResponse.headers.get('x-content-type-options')).toBe('nosniff');

      const traversalResponse = await fetch(`${baseURL}/%2e%2e%2fREADME.md`);
      expect(traversalResponse.status).toBe(403);
    } finally {
      await stopServer(child);
    }
  });
});
