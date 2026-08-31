const DEFAULT_TEST_PORT = 4173;

export function readPort(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_TEST_PORT;
  }

  if (!/^\d+$/.test(value)) {
    throw new Error(`TEST_PORT must be an integer from 1 to 65535; received ${value}`);
  }

  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`TEST_PORT must be an integer from 1 to 65535; received ${value}`);
  }

  return port;
}

export function readBaseURL(value: string | undefined, port: number): string {
  const candidate = value ?? `http://127.0.0.1:${port}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error(`BASE_URL must be an absolute HTTP(S) URL; received ${candidate}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`BASE_URL must use http or https; received ${url.protocol}`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('BASE_URL must not embed credentials.');
  }
  if (url.search !== '' || url.hash !== '') {
    throw new Error('BASE_URL must not contain a query string or fragment.');
  }

  return url.href.replace(/\/$/, '');
}

const testPort = readPort(process.env.TEST_PORT);

export const runtimeConfig = Object.freeze({
  ci: process.env.CI === 'true',
  testPort,
  baseURL: readBaseURL(process.env.BASE_URL, testPort),
});
