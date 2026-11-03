// The Foreman's runtime: the one object that owns every store and every phase's
// memory for a daemon.
//
// The stores used to be module-level maps behind free functions, so two things
// in one process shared them and a test had to reset them by hand. Each store
// is now a class; the daemon builds ONE runtime and passes it down the lane
// pass to the phases (phases -> runtime/stores -> plugin interfaces). A test
// builds its own runtime, and a fresh one starts empty.
//
// Process-wide by design, and therefore NOT here (each carries a
// `Process-wide:` comment saying why): the lane and checkout locks and the
// session limit (lanes.ts), the shutdown flag and the lane passes in flight
// (orchestrator.ts), the runs the shutdown drain aborts (phases/common.ts
// activeRuns), the plugin registry, the gh usage counters, the state
// directory, the work-source event queue, the backoff config, the
// upstream-backoff wiring and the secret-gate log flag (agent.ts).
//
// Import rule: only the composition roots (daemon, cli, tests) import this
// module as a value. Everything else uses `import type`, so it never becomes
// an import cycle.

import { BuildsInFlight } from "./build-in-flight.js";
import { ClaudeTrust } from "./claude-trust.js";
import { DivergenceMemory } from "./divergence.js";
import { IssueRecordStore } from "./issue-records.js";
import { LegacyImport } from "./legacy-records.js";
import { NoCommitStreaks } from "./no-commit-streak.js";
import { Onboarding } from "./onboarding.js";
import { PhaseMemory } from "./phase-memory.js";
import { QaReports } from "./qa-report.js";
import { ReleaseTracker } from "./release-tracker.js";
import { SkillSync } from "./skill-sync.js";
import { EmHandoffs } from "./unstick.js";

export class ForemanRuntime {
  readonly records = new IssueRecordStore();
  readonly releases = new ReleaseTracker(this.records);
  readonly streaks = new NoCommitStreaks(this.records);
  readonly divergence = new DivergenceMemory();
  readonly handoffs = new EmHandoffs(this.records);
  readonly legacy = new LegacyImport(this.records, this.releases, this.streaks, this.divergence);
  readonly onboarding = new Onboarding();
  readonly trust = new ClaudeTrust();
  readonly skillSync = new SkillSync();
  readonly qaReports = new QaReports();
  readonly builds = new BuildsInFlight();
  readonly memory = new PhaseMemory();
}
