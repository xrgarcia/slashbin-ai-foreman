// Idle API spend: fleet state answers "no open PR for this branch" without a live lookup,
// and the verify scan no longer forces a refresh on every pass, while an invalidation still does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fleetState } from "../dist/github-state.js";
import { configureIssueCache, knownNoOpenPr, forgetOpenPrs } from "../dist/github/cache.js";
import { findIssuesAwaitingVerify } from "../dist/github/lifecycle-scan.js";
import { createLogger } from "../dist/logger.js";

const logger = createLogger({ format: "text", level: "error" });
const conn = (nodes) => ({ pageInfo: { hasNextPage: false, endCursor: null }, nodes });
const issue = (number, labels) => ({ number, title: `#${number}`, state: "OPEN", updatedAt: "2026-11-14T11:59:00Z", labels: { nodes: labels.map((name) => ({ name })) } });
const pr = (number, head, base) => ({ number, url: `u/${number}`, title: "t", body: "", state: "OPEN", headRefName: head, baseRefName: base, headRefOid: "h", updatedAt: "2026-11-14T11:59:00Z" });

let queries = 0;
let labels = ["pr merged"];
let prs = [pr(5, "features", "develop")];
configureIssueCache({ ttlMs: 60_000 });
const setup = () => fleetState.configure({
  repos: ["a/x"],
  refreshMs: 30_000,
  logger,
  runAsync: async () => { queries++; return JSON.stringify({ data: { r0: { issues: conn([issue(1, labels)]), pullRequests: conn(prs) } } }); },
});

setup();
const cfg = { name: "x", githubRepo: "a/x", repoPath: "/tmp", lifecycleLabels: { prMerged: "pr merged", prApproved: "pr approved", readyForProd: "ready for prod" } };

test("knownNoOpenPr: true only when the fresh state holds no PR for head and base", async () => {
  assert.equal(await knownNoOpenPr("a/x", "features", "develop"), false);
  assert.equal(await knownNoOpenPr("a/x", "other", "develop"), true);
  assert.equal(await knownNoOpenPr("a/unwatched", "other", "develop"), false, "state cannot vouch for an unwatched repo");
});

test("knownNoOpenPr: a full page of PRs may be missing some, so it cannot vouch", async () => {
  const full = Array.from({ length: 100 }, (_, i) => pr(i + 100, `b${i}`, "develop"));
  prs = full;
  setup(); // a fresh full sync
  assert.equal(await knownNoOpenPr("a/x", "other", "develop"), false);
  prs = [pr(5, "features", "develop")];
  setup();
});

test("findIssuesAwaitingVerify: repeated idle passes cost no query; an invalidation does", async () => {
  forgetOpenPrs("a/x");
  assert.deepEqual(await findIssuesAwaitingVerify(cfg, logger), [1]);
  const base = queries;
  for (let i = 0; i < 5; i++) await findIssuesAwaitingVerify(cfg, logger);
  assert.equal(queries, base, "no forced refresh per pass");
  labels = ["pr merged", "pr approved"]; // a foreign SRE run approved it
  forgetOpenPrs("a/x"); // what verify does after the run
  assert.deepEqual(await findIssuesAwaitingVerify(cfg, logger), []);
  assert.equal(queries, base + 1);
});
