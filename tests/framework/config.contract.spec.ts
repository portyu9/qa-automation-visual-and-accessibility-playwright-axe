import { test, expect } from '../fixtures/test.js';
import { readBaseURL, readPort } from '../../framework/config.js';

test.describe('runtime configuration contract', () => {
  test('accepts valid ports and rejects partial or out-of-range values', () => {
    expect(readPort(undefined)).toBe(4173);
    expect(readPort('8443')).toBe(8443);
    expect(() => readPort('4173x')).toThrow(/integer from 1 to 65535/);
    expect(() => readPort('0')).toThrow(/integer from 1 to 65535/);
    expect(() => readPort('65536')).toThrow(/integer from 1 to 65535/);
  });

  test('defaults to the deterministic loopback target', () => {
    expect(readBaseURL(undefined, 4173)).toBe('http://127.0.0.1:4173');
  });

  test('accepts absolute http and https targets without hidden URL state', () => {
    expect(readBaseURL('https://qa.example.test/app/', 4173)).toBe(
      'https://qa.example.test/app',
    );
    expect(readBaseURL('http://localhost:8080', 4173)).toBe('http://localhost:8080');
  });

  test('rejects unsupported schemes, embedded credentials, query strings, and fragments', () => {
    expect(() => readBaseURL('file:///tmp/site.html', 4173)).toThrow(/http or https/);
    expect(() => readBaseURL('https://user:secret@example.test', 4173)).toThrow(
      /must not embed credentials/,
    );
    expect(() => readBaseURL('https://example.test/?token=secret', 4173)).toThrow(
      /query string or fragment/,
    );
    expect(() => readBaseURL('https://example.test/#state', 4173)).toThrow(
      /query string or fragment/,
    );
  });
});
