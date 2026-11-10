// Keep a PR description true after a revision reverts or drops something it claims (foreman#116).
// The pure rewrite lives here, in the core; the read and write go through the code host (`editPrBody`).
import type { RepoConfig } from "./config.js";
import type { Logger } from "./logger.js";
import type { RoleResult } from "./contract/result-v1.js";
import { codeHost } from "./plugins/registry.js";

type Reviser = RoleResult<"reviser">;

export const REVERTED_HEADING = "## Reverted in revision";

/**
 * Whether the reviser's result says the description now claims something the branch no longer has:
 * the reviser said so (`pr_body_stale:true`), or it reverted and did not say it rewrote the body.
 * `pr_body_stale:false` on a revert is the skill's promise that it already did.
 */
export function revisionLeavesBodyStale(r: Pick<Reviser, "outcome" | "pr_body_stale">): boolean {
  return r.pr_body_stale === true || (r.outcome === "reverted" && r.pr_body_stale !== false);
}

const CLAIM_WORDS = /\*{0,2}\b(landed|delivered|done|complete[d]?|fixed|bumped|upgraded|added|implemented|merged)\b\*{0,2}/gi;
/** A line a revision already struck (or marked reverted) is never struck twice. */
const STRUCK = /~~|\*\*Reverted\*\*/;

/** One body line that names a reverted item, rewritten so it no longer claims the item landed. */
function strikeLine(line: string): string {
  if (line.includes("|")) {
    // A table row: strike each claim word in place and say why, keeping the columns.
    const cells = line.split("|");
    let hit = false;
    const out = cells.map((c) => c.replace(CLAIM_WORDS, (m) => { hit = true; return `~~${m.replace(/\*/g, "")}~~ **Reverted**`; }));
    if (hit) return out.join("|");
    const last = cells.length - 2 >= 1 ? cells.length - 2 : cells.length - 1;
    out[last] = `${out[last].replace(/\s+$/, "")} ~~claimed~~ **Reverted** `;
    return out.join("|");
  }
  const lead = /^(\s*(?:[-*+]\s+|\d+\.\s+)?(?:\[[ xX]\]\s+)?)(.*?)(\s*)$/.exec(line);
  if (!lead || !lead[2]) return line;
  return `${lead[1]}~~${lead[2]}~~ (reverted in revision)${lead[3]}`;
}

export interface BodyRewrite {
  body: string;
  /** The body lines that named a reverted item and were struck. */
  struck: number;
  changed: boolean;
}

/**
 * The PR body after a revision that reverted `items` (text the body claims: `#696`, a package, a file)
 * and findings `findings`. Lines naming an item are struck mechanically; a `## Reverted in revision`
 * section is appended (or replaced, so a second revision does not stack sections) and states that it
 * overrides anything above it. Idempotent: the same input again returns `changed: false`.
 */
export function rewriteBodyForRevert(body: string, opts: { items?: readonly string[]; findings?: readonly number[]; reason?: string }): BodyRewrite {
  const items = [...new Set((opts.items ?? []).map((i) => i.trim()).filter((i) => i.length >= 3))];
  // Drop a previous section first so its own text is never re-struck and a new revision updates it.
  const idx = body.indexOf(REVERTED_HEADING);
  const prior = idx >= 0 ? body.slice(idx) : "";
  const head = (idx >= 0 ? body.slice(0, idx) : body).replace(/\s+$/, "");
  const priorItems = [...prior.matchAll(/^- (.+)$/gm)].map((m) => m[1].trim());

  let struck = 0;
  const lines = head.split("\n").map((line) => {
    if (STRUCK.test(line) || /reverted in revision/i.test(line)) return line;
    const low = line.toLowerCase();
    // `#12` must not match `#123`.
    const named = items.some((it) => {
      const at = low.indexOf(it.toLowerCase());
      if (at < 0) return false;
      if (/^#\d+$/.test(it)) return !/\d/.test(low[at + it.length] ?? "");
      return true;
    });
    if (!named) return line;
    struck++;
    return strikeLine(line);
  });

  const all = [...new Set([...priorItems.filter((p) => !/^finding /.test(p)), ...items])];
  const findings = [...new Set([...(opts.findings ?? [])])];
  const bullets = [
    ...all.map((i) => `- ${i}`),
    ...(findings.length ? [`- finding ${findings.map((n) => `#${n}`).join(", ")} was resolved by reverting the change it was about`] : []),
  ];
  if (!bullets.length) bullets.push("- (the revision named no specific item; read the branch's final diff, not the description above, for what landed)");
  const section = `${REVERTED_HEADING}\n\nA revision dropped or reverted the following. This section overrides anything above that claims otherwise; the branch's final diff is the record of what landed.\n\n${bullets.join("\n")}${opts.reason ? `\n\nWhy: ${opts.reason.replace(/\s+/g, " ").trim().slice(0, 300)}` : ""}\n`;
  const next = `${lines.join("\n")}\n\n${section}`;
  return { body: next, struck, changed: next.trim() !== body.trim() };
}

/** Amend PR `pr`'s description for a revision that reverted what it claims. True when the body changed; throws when the host cannot read or write it. */
export async function amendRevisedPrBody(config: RepoConfig, pr: number, r: Reviser, logger: Logger): Promise<boolean> {
  return await codeHost().editPrBody(config, pr, (current) => {
    const next = rewriteBodyForRevert(current, { items: r.reverted_items, findings: r.reverted_findings, reason: r.reason_text });
    if (next.changed) logger.info(`PR #${pr}: striking ${next.struck} description line(s) and recording the revert`);
    return next.changed ? next.body : null;
  });
}
