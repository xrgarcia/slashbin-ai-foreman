// The retention rule for a repo's review checkout, and the reason it exists.
//
// A review session's cwd is the EM repo, so it has to get the service repo's
// code from somewhere. Before this, nothing said where — so every run cloned
// into /tmp under an invented name and left it there. /tmp on the host is a
// tmpfs with a hard cap of 1,048,576 INODES, and a repo plus node_modules is
// 40k-95k of them; 140 abandoned clones exhausted the cap while `df -h` still
// read 84%. With no inodes, Claude Code cannot create the output file it makes
// before every command, so no agent can run anything — including the cleanup.
//
// The rule under test: keep the checkout while the repo still has queued work
// (the expensive part is node_modules, and a repo with approved issues will be
// back within minutes); delete it when this was the last one.
//
// Run with `npm test` (node:test, no dependencies) after `npm run build`.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkoutPathFor, releaseReviewCheckout } from "../dist/review-checkout.js";

const quietLogger = { info() {}, warn() {}, debug() {}, error() {} };

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "foreman-checkout-test-"));
  const config = { reviewCheckoutRoot: root };
  const repoConfig = { name: "jerky_shipping", githubRepo: "xrgarcia/jerky_shipping" };
  const path = checkoutPathFor(config, repoConfig);
  mkdirSync(join(path, "node_modules"), { recursive: true });
  writeFileSync(join(path, "README.md"), "checkout\n");
  return { config, repoConfig, path };
}

test("the checkout path is per repo, under the configured root", () => {
  const path = checkoutPathFor(
    { reviewCheckoutRoot: "/srv/checkouts" },
    { name: "jerky_shipping", githubRepo: "xrgarcia/jerky_shipping" },
  );
  assert.equal(path, "/srv/checkouts/jerky_shipping");
});

test("queue empty — this was the last one, so the checkout is released", () => {
  const { config, repoConfig, path } = fixture();
  releaseReviewCheckout(config, repoConfig, 0, quietLogger);
  assert.equal(existsSync(path), false, "an idle repo must not keep its checkout");
});

test("work still queued — the checkout and its node_modules are kept", () => {
  const { config, repoConfig, path } = fixture();
  releaseReviewCheckout(config, repoConfig, 3, quietLogger);
  assert.equal(existsSync(path), true, "a repo mid-batch must keep its checkout");
  assert.equal(existsSync(join(path, "node_modules")), true, "node_modules is the reason to keep it");
});

test("one queued item still counts as queued — the boundary is zero, not one", () => {
  const { config, repoConfig, path } = fixture();
  releaseReviewCheckout(config, repoConfig, 1, quietLogger);
  assert.equal(existsSync(path), true);
});

test("releasing a checkout that is not there is a no-op, not a throw", () => {
  const { config, repoConfig, path } = fixture();
  releaseReviewCheckout(config, repoConfig, 0, quietLogger);
  assert.equal(existsSync(path), false);
  // A crashed run can release twice; bookkeeping must never fail the phase.
  assert.doesNotThrow(() => releaseReviewCheckout(config, repoConfig, 0, quietLogger));
});
