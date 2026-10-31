// A running Tech Lead review's milestones reach the PR's cards (Ray,
// 2026-10-15): read off the Tech Lead's stderr, relayed at most once per stage
// (Paperclip cannot edit a comment), gated by the comment toggles, and never
// able to fail a review. Fake Tech Lead, fake Paperclip — no network.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ReviewProgressRelay, centralTime, milestoneChecklist, milestoneReader, parseProgressLine, withoutProgressLines,
} from "../dist/review-progress.js";
import { reviewViaTechLead } from "../dist/agent.js";
import { PaperclipClient } from "../dist/paperclip/client.js";
import { PaperclipMirror } from "../dist/paperclip/mirror.js";
import { sessionComment, DEFAULT_COMMENTS } from "../dist/paperclip/comments.js";

const line = (milestone, at, detail) => `TECH_LEAD_PROGRESS ${JSON.stringify({ milestone, at, ...(detail ? { detail } : {}) })}`;
const M = (milestone, at, detail) => ({ milestone, at, ...(detail ? { detail } : {}) });

// One review that found a blocking problem: every stage takes time.
const REVIEW = [
  M("reading_began", "2026-10-15T14:02:11Z"),
  M("reading_complete", "2026-10-15T14:13:40Z", "14 files, every one opened"),
  M("depth_check_began", "2026-10-15T14:13:40Z", "2 blocking findings"),
  M("depth_check_complete", "2026-10-15T14:31:05Z", "2 areas checked"),
  M("final_check_began", "2026-10-15T14:31:05Z"),
  M("final_check_complete", "2026-10-15T14:31:52Z", "REQUEST_CHANGES, posted"),
];

test("a milestone line parses; anything else is not one", () => {
  assert.deepEqual(parseProgressLine(line("reading_complete", "2026-10-15T14:13:40Z", "14 files,\n every one opened")),
    M("reading_complete", "2026-10-15T14:13:40Z", "14 files, every one opened"));
  assert.equal(parseProgressLine("Codex first read: 14 files"), null);
  assert.equal(parseProgressLine("TECH_LEAD_PROGRESS {not json"), null);
  assert.equal(parseProgressLine(line("reading_done", "2026-10-15T14:13:40Z")), null, "unknown milestone");
  assert.equal(parseProgressLine(line("reading_began", "yesterday")), null, "bad time");
});

test("the reader joins a line split across chunks and skips the rest of stderr", () => {
  const got = [];
  const r = milestoneReader((m) => got.push(m.milestone));
  const text = `warming up\n${line("reading_began", "2026-10-15T14:02:11Z")}\nnoise\n${line("reading_complete", "2026-10-15T14:13:40Z", "2 files")}`;
  for (let i = 0; i < text.length; i += 7) r.push(text.slice(i, i + 7));
  assert.deepEqual(got, ["reading_began"], "the last line has no newline yet");
  r.end();
  assert.deepEqual(got, ["reading_began", "reading_complete"]);
  const throwing = milestoneReader(() => { throw new Error("relay bug"); });
  assert.doesNotThrow(() => throwing.push(`${line("reading_began", "2026-10-15T14:02:11Z")}\n`));
  assert.equal(withoutProgressLines(`boom\n${line("reading_began", "2026-10-15T14:02:11Z")}\nafter`), "boom\nafter");
});

test("the checklist ticks what was reached, with Central time and the count, and leaves the rest open", () => {
  assert.equal(centralTime("2026-10-15T14:02:11Z"), "9:02 AM CT");
  assert.equal(milestoneChecklist(REVIEW.slice(0, 3)), [
    "- [x] Reading began · 9:02 AM CT",
    "- [x] Reading complete · 9:13 AM CT — 14 files, every one opened",
    "- [x] Depth check began · 9:13 AM CT — 2 blocking findings",
    "- [ ] Depth check complete",
    "- [ ] Final check ran",
    "- [ ] Final check complete",
  ].join("\n"));
});

/** A scheduler the test fires by hand. */
function clock() {
  const pending = [];
  return {
    schedule: (fn) => { const t = { fn, live: true }; pending.push(t); return () => { t.live = false; }; },
    fire: () => { for (const t of pending.splice(0)) if (t.live) t.fn(); },
    get waiting() { return pending.filter((t) => t.live).length; },
  };
}

test("one post per stage, three at most; a burst is one post", () => {
  const c = clock();
  const posts = [];
  const relay = new ReviewProgressRelay((ms) => posts.push(ms.map((m) => m.milestone)), 10_000, c.schedule);
  relay.push(REVIEW[0]);
  c.fire();
  relay.push(REVIEW[1]);
  relay.push(REVIEW[2]);
  c.fire();
  relay.push(REVIEW[3]);
  relay.push(REVIEW[4]);
  c.fire();
  relay.push(REVIEW[5]);
  assert.equal(c.waiting, 0, "a complete never posts by itself");
  relay.close();
  assert.deepEqual(posts, [
    ["reading_began"],
    ["reading_began", "reading_complete", "depth_check_began"],
    REVIEW.slice(0, 5).map((m) => m.milestone),
  ]);
  assert.equal(relay.milestones.length, 6, "the end comment gets all six");

  // A skipped depth check: began, complete and final check within the settle → one post.
  const c2 = clock();
  const posts2 = [];
  const r2 = new ReviewProgressRelay((ms) => posts2.push(ms.length), 10_000, c2.schedule);
  r2.push(REVIEW[0]);
  c2.fire();
  for (const m of REVIEW.slice(1, 5)) r2.push(m);
  c2.fire();
  r2.push(REVIEW[0]);
  assert.equal(c2.waiting, 0, "a repeated milestone is ignored");
  assert.deepEqual(posts2, [1, 5]);
});

test("a review that ends inside the settle posts nothing more; a post that throws is swallowed", () => {
  const c = clock();
  const posts = [];
  const relay = new ReviewProgressRelay((ms) => posts.push(ms.length), 10_000, c.schedule);
  relay.push(REVIEW[0]);
  relay.close();
  c.fire();
  relay.push(REVIEW[1]);
  assert.deepEqual(posts, []);

  const c2 = clock();
  const bad = new ReviewProgressRelay(() => { throw new Error("paperclip down"); }, 10_000, c2.schedule);
  bad.push(REVIEW[0]);
  assert.doesNotThrow(() => c2.fire());
  const c3 = clock();
  const rejecting = new ReviewProgressRelay(() => Promise.reject(new Error("paperclip down")), 10_000, c3.schedule);
  rejecting.push(REVIEW[0]);
  assert.doesNotThrow(() => c3.fire());
});

// --- The hand-off reads them as they stream ---

const quiet = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
process.env.TECHLEAD_GITHUB_KEY ||= "test-token-not-real";

function fakeTechLead(script) {
  const dir = mkdtempSync(join(tmpdir(), "fake-tech-lead-"));
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin/tech-lead.mjs"), script);
  return { techLeadPath: dir, emRepoPath: "/em", reviewMaxDurationMs: 30_000 };
}

test("reviewViaTechLead hands each stderr milestone to onProgress; the trailer and outcome are unchanged", async () => {
  const lines = REVIEW.map((m) => line(m.milestone, m.at, m.detail));
  const cfg = fakeTechLead(`
    const lines = ${JSON.stringify(lines)};
    process.stderr.write("codex: starting\\n" + lines[0].slice(0, 20));
    process.stderr.write(lines[0].slice(20) + "\\n" + lines.slice(1).join("\\n") + "\\n");
    console.log("Requested changes on o/r#5");
    console.log("FOREMAN_REVIEW pr=#5 verdict=REQUEST_CHANGES merged=no deploy=NA");
  `);
  const got = [];
  const r = await reviewViaTechLead({ name: "r", githubRepo: "o/r" }, cfg, 5, quiet, undefined, undefined, (m) => got.push(m));
  assert.equal(r.success, true);
  assert.equal(r.trailers[0].verdict, "REQUEST_CHANGES");
  assert.deepEqual(got, REVIEW);

  const throws = await reviewViaTechLead({ name: "r", githubRepo: "o/r" }, cfg, 5, quiet, undefined, undefined, () => { throw new Error("relay bug"); });
  assert.equal(throws.success, true, "a broken relay never fails the review");
});

test("a failed run's error is its real stderr, not the milestone lines", async () => {
  const cfg = fakeTechLead(`process.stderr.write(${JSON.stringify(line("reading_began", "2026-10-15T14:02:11Z"))} + "\\nboom after posting\\n"); process.exit(1);`);
  const r = await reviewViaTechLead({ name: "r", githubRepo: "o/r" }, cfg, 5, quiet);
  assert.equal(r.success, false);
  assert.match(r.error, /boom after posting/);
  assert.doesNotMatch(r.error, /TECH_LEAD_PROGRESS/);
});

// --- The mirror puts them on the card ---

const CID = "company-1";
function fakePaperclip(rows) {
  const comments = {};
  let down = false;
  const fetch = async (url, init = {}) => {
    if (down) throw new Error("ECONNREFUSED");
    const u = new URL(url);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    const ok = (obj, status = 200) => new Response(JSON.stringify(obj), { status });
    if (method === "GET" && u.pathname === `/api/companies/${CID}/issues`) {
      const off = Number(u.searchParams.get("offset") ?? 0);
      return ok(rows.slice(off, off + Number(u.searchParams.get("limit"))));
    }
    let m = u.pathname.match(/^\/api\/issues\/([^/]+)$/);
    if (m && method === "GET") return ok(rows.find((x) => x.id === m[1]) ?? {});
    m = u.pathname.match(/^\/api\/issues\/([^/]+)\/comments$/);
    if (m && method === "GET") return ok((comments[m[1]] ?? []).map((b, i) => ({ id: `c${i}`, body: b })));
    if (m && method === "POST") {
      (comments[m[1]] ??= []).push(body.body);
      return ok({ id: "c", body: body.body }, 201);
    }
    return ok({}, 404);
  };
  return { comments, fetch, goDown: () => { down = true; } };
}

function mirrorWith(fake, comments) {
  const cfg = { enabled: true, url: "http://pc.test", companyId: CID, agentId: "agent-1", agentName: "Foreman",
    identityKeyFormat: "source: {repo}#{N}", comments };
  const client = new PaperclipClient({ url: cfg.url, companyId: CID, fetch: fake.fetch });
  return new PaperclipMirror(client, cfg, [], quiet);
}

const item = { issueNumber: 7, repo: "example/r" };
const progressEvent = (milestones) => ({ kind: "reviewProgress", repo: "example/r", pr: 91, items: [item], milestones });
const rich = (extra = {}) => ({ enabled: true, events: {}, maxLength: 3000, includeDiffStat: true, ...extra });

test("the card gets the checklist so far, one comment per relayed stage", async () => {
  const fake = fakePaperclip([{ id: "r7", status: "in_progress", description: "source: example/r#7" }]);
  const mirror = mirrorWith(fake, rich());
  await mirror.onEvent(progressEvent(REVIEW.slice(0, 1)), quiet);
  await mirror.onEvent(progressEvent(REVIEW.slice(0, 3)), quiet);
  assert.deepEqual(fake.comments.r7, [
    "**Tech Lead review of PR #91: in progress**\n\n- [x] Reading began · 9:02 AM CT\n- [ ] Reading complete\n- [ ] Depth check began\n- [ ] Depth check complete\n- [ ] Final check ran\n- [ ] Final check complete",
    [
      "**Tech Lead review of PR #91: in progress**",
      "",
      "- [x] Reading began · 9:02 AM CT",
      "- [x] Reading complete · 9:13 AM CT — 14 files, every one opened",
      "- [x] Depth check began · 9:13 AM CT — 2 blocking findings",
      "- [ ] Depth check complete",
      "- [ ] Final check ran",
      "- [ ] Final check complete",
    ].join("\n"),
  ]);
});

test("comments off, or the progress toggle off: no milestone comment", async () => {
  for (const comments of [{ enabled: false }, rich({ events: { progress: false } })]) {
    const fake = fakePaperclip([{ id: "r7", status: "in_progress", description: "source: example/r#7" }]);
    await mirrorWith(fake, comments).onEvent(progressEvent(REVIEW.slice(0, 3)), quiet);
    assert.equal(fake.comments.r7, undefined, JSON.stringify(comments));
  }
});

test("Paperclip down: the relay throws nothing", async () => {
  const fake = fakePaperclip([{ id: "r7", status: "in_progress", description: "source: example/r#7" }]);
  fake.goDown();
  await assert.doesNotReject(mirrorWith(fake, rich()).onEvent(progressEvent(REVIEW.slice(0, 1)), quiet));
});

test("the review's end comment carries the whole checklist, final check complete included", () => {
  const ev = (status, report, detail) => ({ phase: "review", status, repo: "example/r", pr: 91, items: [item], reviewer: "Tech Lead", report, detail });
  const done = sessionComment(ev("finished", { milestones: REVIEW, review: { verdict: "REQUEST_CHANGES", merged: false, deploy: "NA", findings: [] } }), item, DEFAULT_COMMENTS);
  assert.match(done, /^\*\*Tech Lead review: REQUEST_CHANGES\*\* — PR #91 not merged · no deploy/);
  assert.match(done, /- \[x\] Final check complete · 9:31 AM CT — REQUEST_CHANGES, posted$/);
  const stopped = sessionComment(ev("failed", { milestones: REVIEW.slice(0, 1) }, "Tech Lead could not take it (Codex first read failed (timeout))"), item, DEFAULT_COMMENTS);
  assert.match(stopped, /- \[x\] Reading began · 9:02 AM CT\n- \[ \] Reading complete/, "a stopped review shows where");
  assert.equal(sessionComment(ev("failed", undefined, "exit 1"), item, DEFAULT_COMMENTS), "**Review failed** — PR #91: exit 1", "no milestones: unchanged");
});

test("the review phase hands the relay to the Tech Lead and closes it before the end comment", async () => {
  const { orchestratorSource } = await import("./source-text.mjs");
  const src = orchestratorSource();
  assert.match(src, /reviewViaTechLead\([^)]*transcriptPath, onProgress(, noMerge)?\)/);
  const close = src.indexOf("progress.close();");
  const end = src.indexOf('await emit({ kind: "session", session: { ...session, ...ended, reviewer');
  assert.ok(close > 0 && end > close, "closed first, so no stage post lands after the end comment");
  assert.match(src, /kind: "reviewProgress"/);
});
