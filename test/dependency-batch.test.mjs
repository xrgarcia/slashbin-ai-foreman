// Regression tests for the dependency BATCH issue — the path a version bump
// takes once Dependabot targets the feature branch.
//
// Origin: owner decision, 2026-09-07. Until now a dependency PR was merged by a
// phase that reads a CI check rollup and nothing else — no session, no build, no
// server started. A check rollup proves the code compiles; it never proves the
// application still runs, which is why `express` 4 -> 5 sat green and one review
// away from production in two repos on the same day.
//
// The fix routes bumps through the implement session instead, and that session
// is issue-driven: the review phase starts from issues labelled `pr under
// review`, promotion queries issues carrying the EM gate, and the promotion PR
// body is a list of issue numbers. A dependency PR with no issue can reach
// `develop` and then has no route to `main` at all.
//
// Run with `npm test` (node:test, no dependencies) after `npm run build`.
import test from "node:test";
import assert from "node:assert/strict";
import {
  describeDependencyPR,
  isMajorBump,
  buildDependencyBatchIssue,
  DEPENDENCY_BATCH_TITLE_PREFIX,
  dependencyBatchIssueCreateArgs,
} from "../dist/github.js";
import { versionMovesFromBody } from "../dist/github/dependencies.js";

// --- Title parsing. All four shapes were observed live on 2026-09-07. --------

test("a versioned bump yields the package and both versions", () => {
  const c = describeDependencyPR(415, "chore(deps): bump vite from 5.4.21 to 8.2.2");
  assert.deepEqual(c.packages, ["vite"]);
  assert.equal(c.from, "5.4.21");
  assert.equal(c.to, "8.2.2");
  assert.equal(c.major, true);
});

test("the bare `Bump X from A to B` shape parses identically", () => {
  const c = describeDependencyPR(11, "Bump form-data from 4.0.5 to 4.0.6");
  assert.deepEqual(c.packages, ["form-data"]);
  assert.equal(c.major, false);
});

test("a grouped bump lists its packages and claims NO version", () => {
  // The title carries no versions. Inventing one would put a wrong number in
  // front of the person deciding whether to approve, so both stay undefined.
  const c = describeDependencyPR(315, "chore(deps): bump qs and express");
  assert.deepEqual(c.packages, ["qs", "express"]);
  assert.equal(c.from, undefined);
  assert.equal(c.to, undefined);
  assert.equal(c.major, null, "unreadable versions are unknown: never reported as 'not a major'");
});

// A grouped Dependabot PR states its versions in the BODY (slashbin-ai-foreman#118).
const GROUPED_BODY = [
  "Bumps the npm_and_yarn group with 2 updates in the / directory: [qs](https://github.com/ljharb/qs) and [express](https://github.com/expressjs/express).",
  "",
  "Updates `qs` from 6.11.0 to 6.14.0",
  "<details><summary>Release notes</summary></details>",
  "",
  "Updates `express` from 4.21.2 to 5.2.1",
].join("\n");

test("a grouped bump reads each package's versions from the PR body and flags a major", () => {
  const c = describeDependencyPR(315, "chore(deps): bump qs and express", GROUPED_BODY);
  assert.deepEqual(c.packages, ["qs", "express"]);
  assert.deepEqual(c.moves, [
    { package: "qs", from: "6.11.0", to: "6.14.0" },
    { package: "express", from: "4.21.2", to: "5.2.1" },
  ]);
  assert.equal(c.major, true, "express 4 -> 5 is a major even though the title says nothing");
  assert.equal(c.from, undefined, "no single from/to for a multi-package PR");
});

test("a grouped bump whose every move is read and none is major is 'no'", () => {
  const body = "Updates `qs` from 6.11.0 to 6.11.2\n\nUpdates `express` from 4.21.1 to 4.21.2";
  assert.equal(describeDependencyPR(1, "chore(deps): bump qs and express", body).major, false);
});

test("a group title that names no package takes the packages from the body table", () => {
  const body = [
    "Bumps the npm_and_yarn group with 2 updates.", "",
    "| Package | From | To |", "| --- | --- | --- |",
    "| [vite](https://github.com/vitejs/vite) | `5.4.21` | `8.2.2` |",
    "| [form-data](https://github.com/form-data/form-data) | `4.0.5` | `4.0.6` |",
  ].join("\n");
  const c = describeDependencyPR(9, "chore(deps): bump the npm_and_yarn group across 1 directory with 2 updates", body);
  assert.deepEqual(c.packages, ["vite", "form-data"]);
  assert.equal(c.major, true);
});

test("one package unread among read ones: a known major still shows, otherwise unknown", () => {
  const body = "Updates `qs` from 6.11.0 to 6.11.2";
  assert.equal(describeDependencyPR(2, "chore(deps): bump qs and express", body).major, null, "express is unread: unknown, not no");
  const withMajor = "Updates `qs` from 1.0.0 to 2.0.0";
  assert.equal(describeDependencyPR(3, "chore(deps): bump qs and express", withMajor).major, true);
});

test("versionMovesFromBody reads the three Dependabot forms and invents nothing", () => {
  assert.deepEqual(versionMovesFromBody("Bumps [vite](https://x/y) from 5.4.21 to 8.2.2.\n"), [{ package: "vite", from: "5.4.21", to: "8.2.2" }]);
  assert.deepEqual(versionMovesFromBody("Updates `esbuild` from 0.25.12 to 0.28.1"), [{ package: "esbuild", from: "0.25.12", to: "0.28.1" }]);
  assert.deepEqual(versionMovesFromBody("Bumps the group with 2 updates: [a](u) and [b](u)."), []);
  assert.deepEqual(versionMovesFromBody(""), []);
});

test("an unknown major prints 'unknown' in the batch issue, never 'no'", () => {
  const c = describeDependencyPR(315, "chore(deps): bump qs and express");
  const { title, body } = buildDependencyBatchIssue("develop", [c]);
  assert.match(body, /\| #315 \| qs, express \| grouped — read the PR \| unknown \|/);
  assert.match(body, /grouped with versions the PR does not state/);
  assert.doesNotMatch(body, /None of these crosses a major version/);
  assert.match(title, /\(1 unknown\)/);
});

test("a grouped PR with readable versions renders each move in the issue", () => {
  const c = describeDependencyPR(315, "chore(deps): bump qs and express", GROUPED_BODY);
  const { title, body } = buildDependencyBatchIssue("develop", [c]);
  assert.match(body, /qs `6\.11\.0` → `6\.14\.0`; express `4\.21\.2` → `5\.2\.1` \| \*\*yes\*\* \|/);
  assert.match(title, /\(1 major\)/);
});

test("a grouped bump drops the trailing directory qualifier", () => {
  const c = describeDependencyPR(469, "chore(deps-dev): bump react-dom and @types/react-dom in /desktop");
  assert.deepEqual(c.packages, ["react-dom", "@types/react-dom"]);
});

// --- Major detection --------------------------------------------------------

test("a leading-component change is a major", () => {
  assert.equal(isMajorBump("4.21.2", "5.2.1"), true);
  assert.equal(isMajorBump("3.25.76", "4.5.4"), true);
});

test("0.x counts every minor as breaking — the esbuild case", () => {
  // Under semver a 0.y release may break on every minor. Reading 0.25 -> 0.28 as
  // "not a major" would file an issue calling a breaking upgrade routine.
  assert.equal(isMajorBump("0.25.12", "0.28.1"), true);
  assert.equal(isMajorBump("0.28.0", "0.28.1"), false);
});

test("a patch or minor inside a stable major is not a major", () => {
  assert.equal(isMajorBump("4.0.5", "4.0.6"), false);
  assert.equal(isMajorBump("10.9.0", "10.11.0"), false);
});

test("a caret or other prefix does not defeat the comparison", () => {
  assert.equal(isMajorBump("^4.21.2", "^5.2.1"), true);
});

test("an unparseable version is reported as NOT major rather than guessed", () => {
  assert.equal(isMajorBump("latest", "5.0.0"), false);
});

// --- The issue body ---------------------------------------------------------

const changes = [
  describeDependencyPR(415, "chore(deps): bump vite from 5.4.21 to 8.2.2"),
  describeDependencyPR(11, "Bump form-data from 4.0.5 to 4.0.6"),
];

test("the title carries the idempotency prefix, the count and the major count", () => {
  const { title } = buildDependencyBatchIssue("develop", changes);
  assert.ok(title.startsWith(DEPENDENCY_BATCH_TITLE_PREFIX),
    "the prefix IS the at-most-one-open-issue mechanism — a title that loses it files a duplicate every cycle");
  assert.match(title, /2 dependency updates/);
  assert.match(title, /\(1 major\)/);
});

test("a batch with no major says so instead of claiming one", () => {
  const { title, body } = buildDependencyBatchIssue("develop", [changes[1]]);
  assert.doesNotMatch(title, /major\)/);
  assert.match(body, /None of these crosses a major version/);
  assert.match(title, /1 dependency update\b/, "singular, not '1 dependency updates'");
});

test("every PR appears in the table and in References", () => {
  const { body } = buildDependencyBatchIssue("develop", changes);
  for (const c of changes) {
    assert.ok(body.includes(`| #${c.number} |`), `PR #${c.number} missing from the table`);
    assert.ok(body.includes(`- #${c.number}`), `PR #${c.number} missing from References`);
  }
});

test("the body demands the app be STARTED, not merely built", () => {
  // This is the whole point of the change. A body that only says "build" would
  // reproduce the CI-rollup gate the issue exists to replace.
  const { body } = buildDependencyBatchIssue("develop", changes);
  assert.match(body, /Start the application and confirm it serves/);
  assert.match(body, /Exercise the flows/);
});

test("the body carries the flight-gate sections the approval gate requires", () => {
  const { body } = buildDependencyBatchIssue("develop", changes);
  // Match whole lines: `## Problem` is the first line of the body, so a
  // "\n## Problem\n" test would fail on a body that is perfectly correct.
  const headings = new Set(body.split("\n").map((l) => l.trim()));
  for (const section of ["## Problem", "## Required Changes", "## Acceptance", "## Pre-Flight", "## References"]) {
    assert.ok(headings.has(section), `missing ${section}`);
  }
  assert.match(body, /\*\*No-Script:\*\*/, "the acceptance hatch needs a stated reason, not an omission");
  for (const bullet of ["Design locked", "Preconditions", "Dev-safety"]) {
    assert.ok(body.includes(bullet), `Pre-Flight missing ${bullet}`);
  }
});

test("a grouped PR renders as 'read the PR' rather than a fabricated version", () => {
  const { body } = buildDependencyBatchIssue("develop", [describeDependencyPR(315, "chore(deps): bump qs and express")]);
  assert.match(body, /grouped — read the PR/);
  assert.ok(body.includes("qs, express"));
});

test("the landing branch name is taken from the caller, never hardcoded", () => {
  const { title, body } = buildDependencyBatchIssue("wip", changes);
  assert.match(title, /on `wip`/);
  assert.ok(body.includes("`wip`"));
  assert.ok(!body.includes("`features`"));
});

// --- Pre-authorization (owner decision, 2026-09-29) --------------------------
//
// From 2026-09-07 batches were filed without the trigger label and waited for a
// hand approval that never came: six sat open 22 days, and each one blocked the
// next, so no Dependabot PR — security updates included — reached a session.
//
// The authorization is SCOPED: slashbin.io repos only, opt-in per repo. The same
// afternoon it shipped fleet-wide by mistake and began building customer
// (jerky.com) dependency batches the owner had not authorized. Both directions
// of the label are pinned here.

test("a pre-approved repo files its batch carrying the trigger label", () => {
  const args = dependencyBatchIssueCreateArgs("xrgarcia/repo", "t", "b", ["approved", "deliver-to-prod"]);
  const i = args.indexOf("--label");
  assert.ok(i >= 0, "no --label on the create call — the batch would stall unapproved");
  assert.equal(args[i + 1], "approved");
  assert.equal(args[args.lastIndexOf("--label") + 1], "deliver-to-prod", "no production grant — the EM gate would hold the batch");
});

test("a repo that is NOT pre-approved files its batch with no label at all", () => {
  const args = dependencyBatchIssueCreateArgs("xrgarcia/repo", "t", "b", []);
  assert.ok(!args.includes("--label"), "a label here flies work the owner never authorized");
  assert.ok(!args.includes("approved"));
});

test("the label comes from config, never hardcoded", () => {
  const args = dependencyBatchIssueCreateArgs("xrgarcia/repo", "t", "b", ["go"]);
  assert.equal(args[args.indexOf("--label") + 1], "go");
  assert.ok(!args.includes("approved"));
});

test("batch instructions merge into the issue's own branch and deliver via its PR, never merge into base locally (#208 review S2)", async () => {
  const { buildDependencyBatchIssue } = await import("../dist/github.js");
  const { body } = buildDependencyBatchIssue("develop", [{ number: 1, packages: ["x"], from: "1.0.0", to: "1.0.1", major: false }], undefined, "develop");
  assert.match(body, /Merge the Dependabot branches into \*\*this issue's own assigned branch\*\*/);
  assert.match(body, /Never merge into `develop` locally/);
  assert.doesNotMatch(body, /Merge the branches into `develop` locally/);
  assert.match(body, /own PR into `develop`/);
});

test("the issue's acceptance: plain `Updates express from 4.22.3 to 5.3.0` reads as a major, renders yes, counts in the title", () => {
  const c = describeDependencyPR(158, "chore(deps): bump express and @types/express", "Updates express from 4.22.3 to 5.3.0");
  assert.equal(c.major, true);
  const { title, body } = buildDependencyBatchIssue("develop", [c]);
  assert.match(title, /\(1 major\)/);
  assert.match(body, /\*\*yes\*\*/);
  assert.match(body, /\*\*1 of these is a major version change\.\*\*/);
});

test("a generic group keeps an unread package in its inventory: major stays unknown, nothing claims no major", () => {
  const body = "Updates `qs` from 6.11.0 to 6.14.0\n\n| Package | From | To |\n|---|---|---|\n| [qs](https://x/qs) | `6.11.0` | `6.14.0` |\n| [express](https://x/express) | see changelog | see changelog |\n";
  const c = describeDependencyPR(315, "chore(deps): bump the npm_and_yarn group with 2 updates", body);
  assert.deepEqual(c.packages.map((p) => p.toLowerCase()).sort(), ["express", "qs"]);
  assert.equal(c.major, null);
  const { title, body: issue } = buildDependencyBatchIssue("develop", [c]);
  assert.match(title, /\(1 unknown\)/);
  assert.doesNotMatch(issue, /None of these crosses a major version/);
  assert.match(issue, /express \(version not stated\)/);
});

test("a mixed batch reports the known major and the unknown ones in the anchor sentence as well as the title", () => {
  const known = describeDependencyPR(415, "chore(deps): bump vite from 5.4.21 to 8.2.2");
  const unread = describeDependencyPR(315, "chore(deps): bump qs and express");
  const { title, body } = buildDependencyBatchIssue("develop", [known, unread]);
  assert.match(title, /\(1 major\) \(1 unknown\)/);
  assert.match(body, /\*\*1 of these is a major version change\.\*\*.*A further 1 is grouped with versions the PR does not state/);
});

test("a group summary line ('Bumps the x group ...: [qs](u) and [express](u)') keeps express in the inventory even when only qs states versions", () => {
  const body = "Bumps the npm_and_yarn group with 2 updates in the / directory: [qs](u) and [express](u).\n\nUpdates `qs` from 6.11.0 to 6.14.0";
  const c = describeDependencyPR(315, "chore(deps): bump the npm_and_yarn group with 2 updates", body);
  assert.deepEqual(c.packages.map((p) => p.toLowerCase()).sort(), ["express", "qs"]);
  assert.equal(c.major, null);
  const { title, body: issue } = buildDependencyBatchIssue("develop", [c]);
  assert.match(title, /\(1 unknown\)/);
  assert.doesNotMatch(issue, /None of these crosses a major version/);
  assert.match(issue, /\| unknown \|/);
});
