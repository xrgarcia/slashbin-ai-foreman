// Where a card sits on the Paperclip board: the one mapping from an issue's
// lifecycle stage to the agent holding the card, its status and its stage
// label, read from `paperclip.board`. The mirror applies it as each step
// happens; anything else that writes the same rows (a periodic sync from
// GitHub) imports these functions so the two can never place a card
// differently.
//
// Pure, apart from `ensureStageLabels`, which reads and creates the company's
// labels.

import {
  PAPERCLIP_FOREMAN_ROLE,
  paperclipBoardDefaults,
  type LifecycleLabels,
  type PaperclipConfig,
  type PaperclipStage,
} from "../config.js";
import type { PaperclipClient } from "./client.js";

/** A Paperclip status bucket; `statusMap` may rename each one. */
export type PaperclipBucket = "todo" | "in_progress" | "in_review" | "blocked" | "done" | "cancelled";

/** A session phase and the stage it puts its card in while it runs. */
export const SESSION_STAGE = Object.freeze({
  implement: "implementing",
  review: "reviewing",
  revise: "revising",
} as const satisfies Record<string, PaperclipStage>);

/** The stage a card returns to when a session ends and nothing newer said where it belongs. */
export const SESSION_FALLBACK_STAGE = Object.freeze({
  implement: "approved",
  review: "inReview",
  revise: "changesRequested",
} as const satisfies Record<keyof typeof SESSION_STAGE, PaperclipStage>);

/** The Foreman agent's metadata key holding its live-session lease. */
export const LIVE_LEASE_KEY = "foremanLive";

/** The lease: the cards a running session holds in progress, renewed while any runs. */
export type LiveLease = { leaseAt: string; rows: Array<{ id: string; phase: keyof typeof SESSION_STAGE }> };

/** The board settings a mapping needs; missing ones take the defaults. */
type BoardConfig = Pick<PaperclipConfig, "agentId"> & Partial<Pick<PaperclipConfig, "board" | "roles" | "stageLabels" | "statusMap">>;

function filled(cfg: BoardConfig) {
  const d = paperclipBoardDefaults();
  return { board: cfg.board ?? d.board, roles: cfg.roles ?? d.roles, stageLabels: cfg.stageLabels ?? d.stageLabels };
}

/**
 * The lifecycle stage GitHub labels put an open issue in, latest stage first;
 * "done" once promoted (the close is all that is left); null when the issue is
 * not in the Foreman's lifecycle at all. `inRelease` = an open release PR
 * names it.
 */
export function issueStage(
  labels: readonly string[],
  inRelease: boolean,
  lifecycle: LifecycleLabels,
  triggerLabel: string,
): PaperclipStage | "done" | null {
  const has = (l: string) => labels.includes(l);
  if (has(lifecycle.readyToClose)) return "done";
  if (inRelease || has(lifecycle.readyForProd)) return "awaitingRelease";
  if (has(lifecycle.prApproved)) return "pendingVerification";
  if (has(lifecycle.prPendingActions)) return "changesRequested";
  if (has(lifecycle.prUnderReview)) return "inReview";
  if (has(triggerLabel)) return "approved";
  return null;
}

/** The agent id a role key resolves to: the Foreman's own for "foreman" or a role with no id yet. */
export function agentFor(cfg: BoardConfig, owner: string): string | undefined {
  if (owner === PAPERCLIP_FOREMAN_ROLE) return cfg.agentId;
  return filled(cfg).roles[owner]?.id ?? cfg.agentId;
}

/** The status name for a bucket, after `statusMap`. */
export function statusName(cfg: BoardConfig, bucket: PaperclipBucket): string {
  return cfg.statusMap?.[bucket] ?? bucket;
}

/** Where a stage puts a card: its status bucket, the agent holding it, and its stage label key (null = none). */
export function stageTarget(cfg: BoardConfig, stage: PaperclipStage): { bucket: PaperclipBucket; agentId: string | undefined; label: string | null } {
  const s = filled(cfg).board[stage];
  return { bucket: s.status, agentId: agentFor(cfg, s.owner), label: s.label };
}

/** The card ids a live lease still holds at `now`; empty once it has lapsed. */
export function liveRows(metadata: unknown, now: number, leaseMinutes = 15): Set<string> {
  const lease = (metadata as Record<string, unknown> | null | undefined)?.[LIVE_LEASE_KEY] as Partial<LiveLease> | undefined;
  const at = Date.parse(String(lease?.leaseAt ?? ""));
  if (!Number.isFinite(at) || now - at > leaseMinutes * 60_000) return new Set();
  return new Set((Array.isArray(lease?.rows) ? lease.rows : []).map((r) => (typeof r === "string" ? r : r?.id)).filter((x): x is string => !!x));
}

/**
 * A card's label ids with exactly one stage label: `key`'s, or none when `key`
 * is null. Every other label the card carries is kept, in order.
 */
export function withStage(labelIds: readonly string[], stageLabelIds: ReadonlyMap<string, string>, key: string | null): string[] {
  const stage = new Set(stageLabelIds.values());
  const kept = labelIds.filter((id) => !stage.has(id));
  const want = key === null ? undefined : stageLabelIds.get(key);
  return want ? [...kept, want] : kept;
}

/**
 * Stage label key → the company's label id, creating each configured label
 * that is missing (by name). A create that loses a race to another writer
 * (409) is resolved by listing again. Throws on any other failure.
 */
export async function ensureStageLabels(client: Pick<PaperclipClient, "listLabels" | "createLabel">, cfg: BoardConfig): Promise<Map<string, string>> {
  const want = Object.entries(filled(cfg).stageLabels);
  const byName = async () => new Map((await client.listLabels()).map((l) => [l.name, l.id]));
  let have = await byName();
  for (const [, l] of want) {
    if (have.has(l.name)) continue;
    try {
      const made = await client.createLabel({ name: l.name, color: l.color });
      have.set(l.name, made.id);
    } catch (err) {
      if ((err as { status?: number })?.status !== 409) throw err;
      have = await byName();
    }
  }
  const out = new Map<string, string>();
  for (const [key, l] of want) {
    const id = have.get(l.name);
    if (id) out.set(key, id);
  }
  return out;
}
