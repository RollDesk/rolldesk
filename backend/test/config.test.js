import { test } from 'node:test';
import assert from 'node:assert/strict';

// config.js reads process.env at import time, so we set env vars first and then
// import a fresh module instance using a cache-busting query string.
async function loadConfig(env) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    const mod = await import(`../src/config.js?t=${Math.random()}`);
    return mod.config;
  } finally {
    // Restore only the keys we touched.
    for (const key of Object.keys(env)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test('parses a comma-separated ALLOWED_IPS list and trims entries', async () => {
  const config = await loadConfig({ ALLOWED_IPS: '203.0.113.4, 198.51.100.0/24 ,10.8.0.0/24' });
  assert.deepEqual(config.allowedIps, ['203.0.113.4', '198.51.100.0/24', '10.8.0.0/24']);
});

test('an empty ALLOWED_IPS yields an empty list', async () => {
  const config = await loadConfig({ ALLOWED_IPS: '' });
  assert.deepEqual(config.allowedIps, []);
});

test('trustProxy is true only when TRUST_PROXY equals "1"', async () => {
  assert.equal((await loadConfig({ TRUST_PROXY: '1' })).trustProxy, true);
  assert.equal((await loadConfig({ TRUST_PROXY: '0' })).trustProxy, false);
  assert.equal((await loadConfig({ TRUST_PROXY: 'true' })).trustProxy, false);
});

test('smtp.secure is true only for the string "true"', async () => {
  assert.equal((await loadConfig({ SMTP_SECURE: 'true' })).smtp.secure, true);
  assert.equal((await loadConfig({ SMTP_SECURE: 'false' })).smtp.secure, false);
});

test('port falls back to 3000 when PORT is unset', async () => {
  const config = await loadConfig({ PORT: '' });
  assert.equal(config.port, 3000);
});
