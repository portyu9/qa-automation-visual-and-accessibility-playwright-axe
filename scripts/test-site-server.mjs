import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../test-site', import.meta.url)));
const portValue = process.env.TEST_PORT ?? '4173';

if (!/^\d+$/.test(portValue)) {
  throw new Error(`Invalid TEST_PORT: ${portValue}`);
}

const port = Number(portValue);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`Invalid TEST_PORT: ${portValue}`);
}

const mimeTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
]);

const securityHeaders = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

function send(response, statusCode, body, contentType = 'text/plain; charset=utf-8') {
  response.writeHead(statusCode, {
    ...securityHeaders,
    'Content-Type': contentType,
  });
  response.end(body);
}

function resolveRequestPath(urlPathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPathname);
  } catch {
    return null;
  }

  const requested = decoded === '/' ? 'index.html' : decoded.replace(/^[/\\]+/u, '');
  const absolutePath = resolve(root, requested);
  const relativePath = relative(root, absolutePath);

  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return null;
  }

  return absolutePath;
}

const server = createServer((request, response) => {
  if (request.url === '/healthz') {
    send(response, 200, JSON.stringify({ status: 'ok' }), 'application/json; charset=utf-8');
    return;
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    send(response, 405, 'Method not allowed');
    return;
  }

  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const filePath = resolveRequestPath(url.pathname);

  if (filePath === null) {
    send(response, 403, 'Forbidden');
    return;
  }

  let stats;
  try {
    stats = statSync(filePath);
  } catch {
    send(response, 404, 'Not found');
    return;
  }

  if (!stats.isFile()) {
    send(response, 404, 'Not found');
    return;
  }

  response.writeHead(200, {
    ...securityHeaders,
    'Content-Length': stats.size,
    'Content-Type': mimeTypes.get(extname(filePath)) ?? 'application/octet-stream',
  });

  if (request.method === 'HEAD') {
    response.end();
    return;
  }

  const stream = createReadStream(filePath);
  stream.on('error', (error) => response.destroy(error));
  stream.pipe(response);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Deterministic test site listening on http://127.0.0.1:${port}`);
});

function shutdown(signal) {
  console.log(`Received ${signal}; shutting down test site.`);
  server.close((error) => {
    if (error) {
      console.error(error);
      process.exitCode = 1;
    }
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
