import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { test, expect } from '@playwright/test';

const serverScript = 'scripts/test-site-server.mjs';

async function stopServer(child: ReturnType<typeof spawn>): Promise<void> {
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
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });

    const [code] = await once(child, 'exit');
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
      child.stdout?.setEncoding('utf8');
      await Promise.race([
        once(child.stdout!, 'data'),
        once(child, 'exit').then(([code]) => {
          throw new Error(`fixture server exited before readiness with code ${String(code)}`);
        }),
      ]);

      const baseURL = `http://127.0.0.1:${port}`;
      const indexResponse = await fetch(`${baseURL}/`);
      expect(indexResponse.status).toBe(200);
      expect(indexResponse.headers.get('content-security-policy')).toContain("default-src 'self'");
      expect(indexResponse.headers.get('x-content-type-options')).toBe('nosniff');

      const traversalResponse = await fetch(`${baseURL}/%2e%2e%2fREADME.md`);
      expect(traversalResponse.status).toBe(403);
    } finally {
      await stopServer(child);
    }
  });
});
