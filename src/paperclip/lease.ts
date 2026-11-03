// The session lease: which cards a live session holds, and the proof of it on
// the Foreman agent's metadata. While any session runs the agent's metadata
// carries a lease naming the cards it holds, renewed every few minutes; a sync
// reading the board defers to it, and on start the lease returns any card a dead
// process left in progress. It also publishes the config file the process runs
// on, writes the agent's running/idle status, and says whether a run of a
// card's assignee is in flight. It owns the holds and the running sessions.

import { createHash } from "node:crypto";
import type { SessionEvent } from "../adapters.js";
import { CONFIG_KEY, LIVE_LEASE_KEY, SESSION_FALLBACK_STAGE, type LiveLease, type PaperclipBucket } from "./board.js";
import type { PaperclipEnv } from "./env.js";
import type { Holds, PaperclipStepMove } from "./steps.js";

export class SessionLease {
  /** Task id → the live sessions holding it: how many, the phase of the first, and the stage a state reported meanwhile asks for. */
  readonly holds: Holds = new Map();
  /** Running sessions, by repo + phase + items. */
  private readonly sessions = new Map<string, { event: SessionEvent; since: Date }>();
  /** The agent status last written, so an unchanged one is never re-sent. */
  private agentStatusSent: string | null = null;
  /** The Foreman agent's metadata minus the lease, so a lease write keeps every other key. */
  private agentMetadata: Record<string, unknown> | null = null;
  /** The sha256 of the config text last published, so an unchanged reload writes nothing. */
  private publishedSha: string | null = null;
  /**
   * Lease recovery, until it settles. A session event waits on it: recovery
   * read jerky_service#87 as in progress (its implement session had died with
   * the old process), the new process's review session moved the card to the
   * Tech Lead meanwhile, and recovery's write then landed last — the card sat
   * in To-do while the Tech Lead reviewed PR #90 (2026-10-05).
   */
  recovery: Promise<void> = Promise.resolve();

  constructor(
    private readonly env: PaperclipEnv,
    /** Moves a card (placement); recovery returns a dead session's card to its stage with it. */
    private readonly move: (id: string, to: PaperclipStepMove) => Promise<boolean>,
  ) {}

  /** Recover the last process's lease; session events wait on `recovery` until it settles. */
  recover(): Promise<void> {
    this.recovery = this.recoverLease();
    return this.recovery;
  }

  /** Renew the lease while any session holds a card. */
  renew(): void {
    if (this.holds.size) void this.writeLease();
  }

  /** Record a session start, hand-off or end for the agent's status. */
  trackSession(event: SessionEvent): void {
    const key = `${event.repo}|${event.phase}|${event.items.map((i) => i.issueNumber).join(",")}`;
    if (event.status === "started") this.sessions.set(key, { event, since: new Date() });
    else if (event.status === "handoff") {
      const s = this.sessions.get(key);
      this.sessions.set(key, { event: { ...(s?.event ?? event), reviewer: event.reviewer }, since: s?.since ?? new Date() });
    } else this.sessions.delete(key);
  }

  /**
   * Return every card the last process's lease still names to the stage its
   * session came from: this process has no session yet, so a card shown in
   * progress for one belongs to a session that died with it. Then write an
   * empty lease. Never throws.
   */
  async recoverLease(): Promise<void> {
    if (!this.env.cfg.agentId) return;
    const agent = await this.env.safeCall("read agent", () => this.env.client.getAgent(this.env.cfg.agentId!));
    if (!agent.ok) return;
    const { [LIVE_LEASE_KEY]: lease, ...rest } = (agent.value?.metadata ?? {}) as Record<string, unknown>;
    this.agentMetadata = rest;
    const inProgress = this.env.statusName("in_progress");
    for (const r of (lease as Partial<LiveLease> | undefined)?.rows ?? []) {
      if (!r?.id || this.holds.has(r.id) || !(r.phase in SESSION_FALLBACK_STAGE)) continue;
      const row = await this.env.safeCall("read task", () => this.env.client.getIssue(r.id), r.id);
      if (!row.ok || row.value?.status !== inProgress) continue;
      await this.move(r.id, r.fallback ?? SESSION_FALLBACK_STAGE[r.phase]);
    }
    await this.writeLease();
  }

  /**
   * The lease: the cards held right now, stamped now. Paperclip replaces the
   * whole metadata object, so the agent's other keys are read fresh before every
   * write: a key someone else set since (githubLogin, by the EM's github-login.mjs)
   * survives, and only the lease and the published config are the Foreman's.
   * Unread, the lease is not written. Never throws.
   */
  async writeLease(): Promise<boolean> {
    if (!this.env.cfg.agentId) return false;
    const agent = await this.env.safeCall("read agent", () => this.env.client.getAgent(this.env.cfg.agentId!));
    if (!agent.ok) return false;
    const { [LIVE_LEASE_KEY]: _old, ...rest } = (agent.value?.metadata ?? {}) as Record<string, unknown>;
    const config = this.agentMetadata?.[CONFIG_KEY];
    this.agentMetadata = config === undefined ? rest : { ...rest, [CONFIG_KEY]: config };
    const lease: LiveLease = {
      leaseAt: new Date().toISOString(),
      rows: [...this.holds].map(([id, h]) => ({ id, phase: h.phase, ...(h.fallback ? { fallback: h.fallback } : {}) })),
    };
    const r = await this.env.safeCall("update agent", () =>
      this.env.client.updateAgent(this.env.cfg.agentId!, { metadata: { ...(this.agentMetadata ?? {}), [LIVE_LEASE_KEY]: lease } }));
    return r.ok;
  }

  /**
   * Publish the config file this process runs on its agent's metadata
   * (`foremanConfig`), so anything else that places the same cards reads the
   * Foreman's mapping instead of a copy of it. `text` is the file as loaded; it
   * is stored less its trailing newline and hashed that way. Refused, with a
   * warning, when the file holds a secret-shaped key or a known secret value.
   * Unchanged text writes nothing. Never throws.
   */
  async publishConfig(text: string): Promise<void> {
    if (this.env.cfg.publishConfig === false || !this.env.cfg.agentId) return;
    const body = text.replace(/\n+$/, "");
    const sha256 = createHash("sha256").update(body).digest("hex");
    if (sha256 === this.publishedSha) return;
    const refusal = configSecretRefusal(body, this.env.secrets);
    if (refusal) {
      this.env.logger.warn(`paperclip: config not published: ${refusal}`);
      return;
    }
    await this.recovery;
    if (this.agentMetadata === null) {
      const agent = await this.env.safeCall("read agent", () => this.env.client.getAgent(this.env.cfg.agentId!));
      if (!agent.ok) return;
      const { [LIVE_LEASE_KEY]: _old, ...rest } = (agent.value?.metadata ?? {}) as Record<string, unknown>;
      this.agentMetadata = rest;
    }
    // The lease write carries every other key, so the config rides on it.
    this.agentMetadata = { ...this.agentMetadata, [CONFIG_KEY]: { sha256, publishedAt: new Date().toISOString(), text: body } };
    if (await this.writeLease()) {
      this.publishedSha = sha256;
      this.env.logger.info(`paperclip: published config sha256=${sha256.slice(0, 12)}`);
    }
  }

  /** The agent's status: running while any session runs, else idle. Written only on a change. */
  async syncAgentStatus(): Promise<void> {
    if (!this.env.cfg.agentStatus || !this.env.cfg.agentId) return;
    const want = this.sessions.size ? "running" : "idle";
    if (this.agentStatusSent === want) return;
    const r = await this.env.safeCall("update agent", () => this.env.client.updateAgent(this.env.cfg.agentId!, { status: want }));
    if (r.ok) this.agentStatusSent = want;
  }

  /**
   * True when moving `id` to `to` now would cut across a run of the card's
   * assignee. Assigning a card to a seat that wakes on assignment opens a run
   * whose checkout flips the card to in_progress; a second write within a
   * second or two that sets any other status (and reassigns) makes Paperclip
   * cancel the run, and the cancel's recovery settle leaves an execution hold
   * that freezes the card (SLA-2959, 2026-10-29). A write leaving the status
   * in_progress cancels cleanly (SLA-2948, SLA-2918), so it goes through.
   *
   * Decided on the card's own `executionRunId` / `checkoutRunId`, as the API
   * returns them, not on a timer: on SLA-2959 the row already showed the
   * checkout (status in_progress) when the second write arrived, and a timer
   * would also delay every legitimate back-to-back reassignment. An unreadable
   * row defers nothing.
   */
  async runInFlight(id: string, target: PaperclipBucket | "done"): Promise<boolean> {
    if (target === "in_progress") return false;
    const row = await this.env.safeCall("read task", () => this.env.client.getIssue(id), id);
    const assignee = row.ok ? row.value?.assigneeAgentId : undefined;
    if (row.ok && assignee && assignee !== this.env.cfg.agentId && (row.value?.executionRunId || row.value?.checkoutRunId)) return true;
    return false;
  }
}

/** Why a config text must not be published, or null: a secret-shaped key holding a value, or a known secret's value anywhere in it. */
export function configSecretRefusal(text: string, secrets: ReadonlyArray<{ name: string; value: string }>): string | null {
  for (const s of secrets) if (s.value && text.includes(s.value)) return `it contains the value of ${s.name}`;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return "it is not JSON"; }
  const found: string[] = [];
  const walk = (v: unknown, path: string): void => {
    if (!v || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const at = path ? `${path}.${k}` : k;
      if (SECRET_KEY.test(k) && typeof x === "string" && x.length > 0) found.push(at);
      walk(x, at);
    }
  };
  walk(parsed, "");
  return found.length ? `secret-shaped key ${found.join(", ")}` : null;
}

const SECRET_KEY = /(api[_-]?key|token|secret|password)$/i;
