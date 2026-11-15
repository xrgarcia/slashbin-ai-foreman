// QA's acceptance walk (engineering-manager#864 feature 1) rendered in both QA Report bodies.
import test from "node:test";
import assert from "node:assert/strict";
import { acceptanceSection, qaGateBody, qaReportBody } from "../dist/qa-report.js";

const base = { verdict: "PASS", reason: "ok", sha: "a".repeat(40), pages: [], shots: [] };
const walked = { ...base, acceptance: {
  status: "walked", issue: "o/app#2", epic: "o/em#1", hold: null,
  criteria: [
    { section: "Happy path", text: "Given A, I expect B.", outcome: "pass", reason: "B shown", evidence: ["walk/a.png"] },
    { section: "Happy path", text: "Given C, I expect D.", outcome: "unexercised", reason: "sibling work", evidence: [] },
    { section: "Negative cases", text: "Given E, I expect no F.", outcome: "held", reason: "needs a production third-party write", evidence: ["walk/x.png"] },
    { section: "Negative cases", text: "Given G, I expect H.", outcome: "fail", reason: "H missing", evidence: ["walk/g.png"] },
  ],
} };
const line = (out, text) => out.find((l) => l.includes(text)) ?? "";

test("walked: heading, epic and issue, one line per criterion under its section", () => {
  const out = acceptanceSection(walked);
  assert.ok(out.includes("### Acceptance walk"));
  assert.ok(out.some((l) => l.includes("o/em#1") && l.includes("o/app#2")));
  assert.ok(out.indexOf("**Happy path**") < out.indexOf("**Negative cases**"));
  assert.match(line(out, "Given A"), /PASS.*B shown.*walk\/a\.png/);
  assert.match(line(out, "Given G"), /FAIL.*H missing.*walk\/g\.png/);
});

test("held and unexercised carry their reason, no pass mark and no evidence", () => {
  const out = acceptanceSection(walked);
  for (const t of ["Given C", "Given E"]) assert.doesNotMatch(line(out, t), /\bpass|evidence/i);
  assert.match(line(out, "Given C"), /UNEXERCISED.*sibling work/);
  assert.match(line(out, "Given E"), /HELD.*third-party/);
});

test("held walk: reason, owner and resume", () => {
  const out = acceptanceSection({ ...base, acceptance: { status: "held", issue: null, epic: null, criteria: [],
    hold: { reason: "no-linked-issue", owner: "the PR's author", resume: "link the PR" } } }).join("\n");
  assert.match(out, /no-linked-issue/); assert.match(out, /the PR's author/); assert.match(out, /link the PR/);
});

test("off or absent renders nothing, and both bodies keep their verdict line", () => {
  assert.deepEqual(acceptanceSection(base), []);
  assert.deepEqual(acceptanceSection({ ...base, acceptance: { status: "off" } }), []);
  for (const body of [qaGateBody(1, { kind: "manifest", exitCode: 0, manifest: walked }), qaReportBody(1, { kind: "manifest", exitCode: 0, manifest: walked })]) {
    assert.match(body, /\*\*Verdict: PASS\*\*/);
    assert.match(body, /### Acceptance walk/);
  }
});
