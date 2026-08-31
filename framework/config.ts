const DEFAULT_TEST_PORT = 4173;

function readPort(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_TEST_PORT;
  }

  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`TEST_PORT must be an integer from 1 to 65535; received ${value}`);
  }

  return port;
}

const testPort = readPort(process.env.TEST_PORT);

export const runtimeConfig = Object.freeze({
  ci: process.env.CI === 'true',
  testPort,
  baseURL: process.env.BASE_URL ?? `http://127.0.0.1:${testPort}`,
});
