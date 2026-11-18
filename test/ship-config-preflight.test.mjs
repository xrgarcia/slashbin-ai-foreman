import test from "node:test";
import assert from "node:assert/strict";
import { shipConfigRefusal } from "../dist/credentials.js";

const full = {
  SLASHBIN_DATA_RECEIVER_BASE_URL: "http://127.0.0.1:1",
  SLASHBIN_EVENTS_SIGNING_KEY__FOREMAN_SESSION: "secret-k",
  SLASHBIN_EVENTS_SIGNING_KEY__WATERMARK: "secret-w",
};

test("the daemon starts only with the receiver URL and both signing keys, and never prints a value", () => {
  assert.equal(shipConfigRefusal(full), null);
  for (const name of Object.keys(full)) {
    const msg = shipConfigRefusal({ ...full, [name]: " " });
    assert.ok(msg?.includes(name), `${name} blank did not refuse`);
    assert.ok(!/secret-|127\.0\.0\.1/.test(msg), "a value leaked into the refusal");
  }
  const none = shipConfigRefusal({});
  for (const name of Object.keys(full)) assert.ok(none.includes(name));
});
