import type { RepoConfig } from "./config.js";
import { legacyCardBlocksPending } from "./legacy-records.js";
import { loadRepoRecord, updateRepoRecord, type CardBlockRecord } from "./issue-records.js";

// The Paperclip mirror's card blocks, kept in each repo's own record (issue-records.ts `RepoRecord.cardBlocks`):
// a card is Paperclip's and its uuid is the only key the mirror holds at restart, so the block names the repo
// its card belongs to and that repo's record carries it. (EM#1244 f4 moved them out of `.agent-state.json`.)

export interface CardBlockStoreImpl {
  /** Every block of every configured repo, by card id; null when any repo's record cannot be read (never a partial answer). */
  load(): Promise<Record<string, CardBlockRecord> | null>;
  /** Record `block` for card `id` in `repo`'s record, or forget it (null). True when the record holds it. */
  save(id: string, block: CardBlockRecord | null, repo?: string): Promise<boolean>;
}

/** `repos` is read at each call, so a reload that adds a repo is followed. */
export function createCardBlockStore(repos: () => readonly RepoConfig[]): CardBlockStoreImpl {
  /** Card id → the repo (`githubRepo`) whose record holds its block, from the last load or save. */
  const home = new Map<string, string>();
  const byName = (githubRepo: string): RepoConfig | undefined => repos().find((r) => r.githubRepo === githubRepo);
  return {
    async load() {
      // Blocks still in the legacy file are not in any record yet: the set read now would be incomplete, so none is read.
      if (legacyCardBlocksPending()) return null;
      const out: Record<string, CardBlockRecord> = {};
      for (const repo of repos()) {
        const record = await loadRepoRecord(repo);
        if (!record) return null;
        for (const [id, b] of Object.entries(record.cardBlocks ?? {})) {
          out[id] = b;
          home.set(id, repo.githubRepo);
        }
      }
      return out;
    },
    async save(id, block, repo) {
      const target = byName(repo ?? home.get(id) ?? "");
      // Forgetting a block no repo holds is done; keeping one with no repo to hold it is not.
      if (!target) return block === null;
      const ok = await updateRepoRecord(target, (d) => {
        const blocks = { ...(d.cardBlocks ?? {}) };
        if (block) blocks[id] = block;
        else delete blocks[id];
        d.cardBlocks = blocks;
      });
      if (!ok) return false;
      const was = home.get(id);
      // A block filed under another repo (the import files them all under the first one) leaves that record: moved to
      // its card's own repo, or cleared. Left there it would come back at the next restart. If that fails, `home` keeps
      // pointing at the old record so the retry removes it.
      const old = was && was !== target.githubRepo ? byName(was) : undefined;
      if (old && !(await updateRepoRecord(old, (d) => { const b = { ...(d.cardBlocks ?? {}) }; delete b[id]; d.cardBlocks = b; }))) return false;
      if (block) home.set(id, target.githubRepo);
      else home.delete(id);
      return true;
    },
  };
}
