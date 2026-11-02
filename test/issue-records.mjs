// Test helper (EM#1244 f2): the phases keep each issue's skip, hold, verify hold, unstick questions,
// prod verification and stall notice in the work source's record store (src/issue-records.ts). A test
// that drives a phase gives the active work source an in-memory store, so the fake `gh` beside it
// needs no comment endpoint, and seeds or reads a record directly.
import { activeWorkSource } from "../dist/plugins/registry.js";
import { InMemoryRecordStore } from "../dist/record-store.js";
import { loadIssueRecord, resetIssueRecordsForTests, updateIssueRecord } from "../dist/issue-records.js";

/** Replace the active work source's record store with a fresh in-memory one (call after the plugins started). */
export function memoryRecords() {
  const source = activeWorkSource();
  if (!source) throw new Error("no active work source: start the plugins first");
  const store = new InMemoryRecordStore();
  source.loadRecord = (key, repoConfig) => store.loadRecord(key, repoConfig);
  source.saveRecord = (key, record, repoConfig) => store.saveRecord(key, record, repoConfig);
  resetIssueRecordsForTests();
  return store;
}

/** Put `fields` into issue `n`'s record (what a previous pass would have left). */
export async function seed(repoConfig, n, fields) {
  const ok = await updateIssueRecord(repoConfig, n, (d) => { Object.assign(d, fields); });
  if (!ok) throw new Error(`could not seed #${n}`);
}

/** Issue `n`'s record as the Foreman reads it. */
export const recordOf = async (repoConfig, n) => (await loadIssueRecord(repoConfig, n)) ?? {};
