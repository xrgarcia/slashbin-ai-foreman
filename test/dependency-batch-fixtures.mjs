// Shared fixtures for the dependency-batch tests (foreman#230): an in-memory fake of the
// DependencyBatchLedger interface, and a stateful fake code host the real collaborators run against.
import {
  describeDependencyPR, buildDependencyBatchIssue, selectSecurityPRs, dependencyBatchBases,
} from "../dist/github/dependencies.js";

export const quiet = { info() {}, warn() {}, error() {}, debug() {}, child() { return quiet; } };
export const logs = () => {
  const lines = [];
  const l = { info: (m) => lines.push(["info", m]), warn: (m) => lines.push(["warn", m]), error() {}, debug: (m) => lines.push(["debug", m]), child() { return l; }, lines };
  return l;
};

export const repoConfig = (over = {}) => ({
  name: "svc", githubRepo: "o/svc", repoPath: "/tmp/x", baseBranch: "develop", productionBranch: "main", featureBranch: "features",
  github: { dependencyBatchTitlePrefix: "chore(deps): validate and land ", dependencyBranchPrefixes: ["dependabot/"] },
  dependabot: { securityOnly: false }, dependencyPreApproved: true, triggerLabel: "approved", ...over,
});

/** In-memory fake of DependencyBatchLedger. `broken` makes every read answer unavailable. */
export class FakeLedger {
  constructor() { this.table = new Map(); this.broken = false; this.failWrites = false; }
  #h(batch) {
    if (!this.table.has(batch.key)) this.table.set(batch.key, { prs: [...batch.prs], filings: [], issues: [] });
    return this.table.get(batch.key);
  }
  async historyOf(_r, batch) { return this.broken ? null : structuredClone(this.table.get(batch.key)); }
  async recordFiling(_r, batch, at) { if (this.failWrites) return false; this.#h(batch).filings.push(at.toISOString()); return true; }
  async attachIssue(_r, batch, n) { this.#h(batch).issues.push(n); return true; }
  async batchOfIssue(_r, issue) {
    if (this.broken) return null;
    const { DependencyBatch } = await import("../dist/dependency-batch/batch.js");
    for (const h of this.table.values()) if (h.issues.includes(issue)) return { batch: DependencyBatch.fromRefs(h.prs), history: structuredClone(h) };
    return undefined;
  }
  async recordOutcome(_r, batch, outcome, at) { const h = this.#h(batch); h.outcome = outcome; h.outcomeAt = at.toISOString(); return true; }
}

/** A fake code host with one dependency PR list, one issue list and switches for each failure. */
export class FakeHost {
  constructor() {
    this.prs = []; this.issues = []; this.alerts = new Set(); this.alertsFail = false;
    this.retireFails = false; this.retired = []; this.filed = []; this.nextIssue = 100; this.ghFails = false;
  }
  addPr(number, headRefOid, title = `chore(deps): bump pkg${number} from 1.0.0 to 2.0.0`, base = "features") {
    this.prs = this.prs.filter((p) => p.number !== number);
    this.prs.push({ number, url: `u${number}`, title, body: "", headRefName: `dependabot/npm_and_yarn/pkg${number}`, baseRefName: base, headRefOid });
  }
  dependencyBatchBases = dependencyBatchBases;
  findDependencyPRs(_r, _c, bases) { return this.prs.filter((p) => bases.includes(p.baseRefName)); }
  fetchOpenAlertPackages() { if (this.alertsFail) throw new Error("404"); return this.alerts; }
  selectSecurityPRs = selectSecurityPRs;
  formatGhError(err) { return { message: String(err), stderr: "", status: 1 }; }
  findOpenDependencyBatchIssue() { return this.issues.find((i) => i.open); }
  describeDependencyPR = describeDependencyPR;
  buildDependencyBatchIssue = buildDependencyBatchIssue;
  createDependencyBatchIssue(_r, _c, title, body, label) {
    if (this.ghFails) return null;
    const number = this.nextIssue++;
    this.issues.push({ number, title, body, label, open: true });
    this.filed.push({ number, title, body, label });
    return number;
  }
  retireDependencyPR(_cfg, number, reason) {
    if (this.retireFails) throw new Error("close refused");
    this.prs = this.prs.filter((p) => p.number !== number);
    this.retired.push({ number, reason });
  }
  closeIssue(n) { this.issues.find((i) => i.number === n).open = false; }
}
