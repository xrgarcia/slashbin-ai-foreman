// A dependency batch: the set of Dependabot PRs one batch issue stands for.
//
// A value object. It has an identity and nothing else: no behaviour that knows
// about GitHub, filing or outcomes. Two batches are the same batch exactly when
// they cover the same PRs at the same head commits, so a Dependabot push (a new
// head SHA) is a different batch and the old batch's outcome does not speak for
// it. Same keying as no-commit-streak.ts (PR + head SHA).

/** One Dependabot PR at one head commit. */
export interface DependencyPrRef {
  readonly number: number;
  /** The PR's head commit. `unknown` only when the host did not return one. */
  readonly headSha: string;
}

export const UNKNOWN_HEAD = "unknown";

export class DependencyBatch {
  /** The PRs, ordered by number, each once. */
  readonly prs: readonly DependencyPrRef[];

  private constructor(prs: readonly DependencyPrRef[]) {
    this.prs = prs;
  }

  /** The batch of `prs`: sorted by number and de-duplicated, so the same set always has the same key. */
  static of(prs: Iterable<{ number: number; headSha?: string | null }>): DependencyBatch {
    const byNumber = new Map<number, DependencyPrRef>();
    for (const p of prs) byNumber.set(p.number, { number: p.number, headSha: p.headSha || UNKNOWN_HEAD });
    return new DependencyBatch([...byNumber.values()].sort((a, b) => a.number - b.number));
  }

  /** Rebuild a batch from what the ledger stored. */
  static fromRefs(refs: readonly DependencyPrRef[]): DependencyBatch {
    return DependencyBatch.of(refs);
  }

  /** The identity: `627@<sha>,631@<sha>`. Stable across restarts and processes. */
  get key(): string {
    return this.prs.map((p) => `${p.number}@${p.headSha}`).join(",");
  }

  get isEmpty(): boolean {
    return this.prs.length === 0;
  }

  equals(other: DependencyBatch): boolean {
    return this.key === other.key;
  }
}
