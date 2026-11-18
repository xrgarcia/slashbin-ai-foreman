import test from "node:test";
import assert from "node:assert/strict";
import { shipConfigRefusal } from "../dist/credentials.js";
import { BASE_URL_ENV, KEY_ENV, WATERMARK_KEY_ENV } from "../dist/metrics/ship.js";

const on = { metrics: { enabled: true } };
const full = {
  [BASE_URL_ENV]: "http://receiver.example.test",
  [KEY_ENV]: "secret-k",
  [WATERMARK_KEY_ENV]: "secret-w",
};

test("the daemon starts only with the receiver URL and both signing keys, and never prints a value", () => {
  assert.equal(shipConfigRefusal(on, full), null);
  for (const name of Object.keys(full)) {
    const msg = shipConfigRefusal(on, { ...full, [name]: " " });
    assert.ok(msg?.includes(name), `${name} blank did not refuse`);
    assert.ok(!/secret-|receiver\.example/.test(msg), "a value leaked into the refusal");
  }
  const none = shipConfigRefusal(on, {});
  for (const name of Object.keys(full)) assert.ok(none.includes(name));
});

test("an install with shipping disabled starts without any shipper config", () => {
  assert.equal(shipConfigRefusal({ metrics: { enabled: false } }, {}), null);
  assert.equal(shipConfigRefusal({}, {}), null);
});
