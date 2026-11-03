// Test helper (EM#1244 f2): the phases keep each issue's skip, hold, verify hold, unstick questions,
// prod verification and stall notice in the work source's record store (src/issue-records.ts). A test
// that drives a phase gives the active work source an in-memory store, so the fake `gh` beside it
// needs no comment endpoint, and seeds or reads a record directly.
import { activeWorkSource } from "../dist/plugins/registry.js";
import { InMemoryRecordStore } from "../dist/record-store.js";

/** Replace the active work source's record store with a fresh in-memory one (call after the plugins started; the test builds its own `ForemanRuntime`, which the helpers below take first). */
export function memoryRecords() {
  const source = activeWorkSource();
  if (!source) throw new Error("no active work source: start the plugins first");
  const store = new InMemoryRecordStore();
  source.loadRecord = (key, repoConfig) => store.loadRecord(key, repoConfig);
  source.saveRecord = (key, record, repoConfig) => store.saveRecord(key, record, repoConfig);
  return store;
}

/** Put `fields` into issue `n`'s record (what a previous pass would have left). */
export async function seed(rt, repoConfig, n, fields) {
  const ok = await rt.records.updateIssueRecord(repoConfig, n, (d) => { Object.assign(d, fields); });
  if (!ok) throw new Error(`could not seed #${n}`);
}

/** Issue `n`'s record as the Foreman reads it. */
export const recordOf = async (rt, repoConfig, n) => (await rt.records.loadIssueRecord(repoConfig, n)) ?? {};

/** After `memoryRecords()`: loads of these issues' records answer `unavailable`; `saves` makes only their saves fail. */
export function breakRecords(numbers, { saves = false, kind = "issue" } = {}) {
  const source = activeWorkSource();
  const broken = new Set(numbers);
  const load = source.loadRecord;
  const save = source.saveRecord;
  const hit = (key) => key.kind === kind && broken.has(key.number);
  if (!saves) source.loadRecord = async (key, rc) => (hit(key) ? { status: "unavailable" } : load(key, rc));
  else source.saveRecord = async (key, record, rc) => (hit(key) ? false : save(key, record, rc));
}

/** Like `breakRecords`, for pull request records. */
export const breakPrRecords = (numbers, opts = {}) => breakRecords(numbers, { ...opts, kind: "pr" });

/** Put `fields` into PR `n`'s record (what a previous pass would have left). A `release` also makes the sweep read it. */
export async function seedPr(rt, repoConfig, n, fields) {
  const ok = await rt.records.updatePrRecord(repoConfig, n, (d) => { Object.assign(d, fields); });
  if (!ok) throw new Error(`could not seed PR #${n}`);
  if (fields.release || fields.tracked) rt.releases.noteReleasePrs(repoConfig.githubRepo, [n]);
  if (fields.release) rt.releases.noteLiveRelease(repoConfig.githubRepo, n);
}

/** Seed a release (what `prodReleases[pr]` held) on its PR's record. */
export const seedRelease = (rt, repoConfig, rel) => seedPr(rt, repoConfig, rel.pr, { release: rel });

/** PR `n`'s record as the Foreman reads it. */
export const prRecordOf = async (rt, repoConfig, n) => (await rt.records.loadPrRecord(repoConfig, n)) ?? {};

/** The release PR `n` carries now, or undefined. */
export const releaseOf = async (rt, repoConfig, n) => (await prRecordOf(rt, repoConfig, n)).release;

/** The repo's own record as the Foreman reads it (EM#1244 f4): its EM questions about no issue, rulings carried out, card blocks. */
export const repoRecordOf = async (rt, repoConfig) => (await rt.records.loadRepoRecord(repoConfig)) ?? {};
