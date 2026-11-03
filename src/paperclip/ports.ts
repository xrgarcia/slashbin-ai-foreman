// What each mirror collaborator offers the others, written as interfaces so a
// collaborator names what it needs without importing the file that has it. The
// mirror hands each collaborator the real owner behind these; no collaborator
// ever imports or calls another by name. Shared state has one owner each: the
// card index owns the rows, placement the blocks and labels, the session lease
// the holds, thread notes the comment memory.

import type { WorkEvent, WorkItem } from "../adapters.js";
import type { PaperclipStage } from "./config.js";
import type { Duplicate, NoteOpts, PaperclipStepMove, RowContent, CardContent } from "./steps.js";
import type { SessionEvent } from "../adapters.js";
import type { HandoffFacts } from "./handoff.js";

/** The card index: which task is the card for which issue, and what each card shows. */
export interface IndexPort {
  readonly rowState: Map<string, string>;
  readonly rowRepo: Map<string, string>;
  readonly rowNumber: Map<string, number>;
  readonly rowContent: Map<string, RowContent>;
  readonly blockAction: Map<string, string>;
  readonly closedCards: Set<string>;
  readonly servedRepos: Set<string>;
  duplicates: Duplicate[];
  keyNow(repo: string): string;
  warm(...repos: string[]): Promise<void>;
  warmEvent(event: WorkEvent): Promise<void>;
  mirroredKey(key: string): boolean;
  resolve(item: WorkItem, create: boolean): Promise<string | null>;
  defaultContent(item: WorkItem): CardContent;
  createTask(item: WorkItem, content: CardContent): Promise<string | null>;
  ensureIndex(fresh?: boolean): Promise<boolean>;
  refreshRow(id: string): Promise<void>;
  isClosedCard(id: string): boolean;
  markClosed(id: string): void;
  markOpen(id: string): void;
  terminal(id: string): boolean;
  setHolder(id: string, agentId: string | null): void;
  repoOfCard(id: string): string | undefined;
  writtenRepo(id: string): string | null;
}

/** Placement: where a card goes, the blocks it is held in, its labels. */
export interface PlacementPort {
  readonly rowStage: Map<string, PaperclipStage>;
  readonly blockedReason: Map<string, string>;
  readonly blockedOwner: Map<string, string>;
  readonly deferredMoves: Map<string, PaperclipStepMove>;
  readonly ghStage: Map<string, PaperclipStage | "done">;
  readonly blockedAt: Map<string, PaperclipStage | "done" | undefined>;
  readonly labelBlocked: Set<string>;
  readonly escalatedAt: Map<string, string>;
  readonly rulingHeld: Set<string>;
  readonly restoredBlocks: Set<string>;
  readonly holdAction: Map<string, string>;
  ensureBlocks(): Promise<boolean>;
  persistBlock(id: string): void;
  clearBlock(id: string): void;
  externalHold(id: string): boolean;
  holdOutranks(id: string, stage: PaperclipStage): boolean;
  rulingPending(id: string, stage: PaperclipStage): boolean;
  holderMatches(id: string, stage: PaperclipStage | "done"): boolean;
  placeHeld(id: string): Promise<void>;
  move(id: string, to: PaperclipStepMove, held?: boolean, liveOpen?: boolean): Promise<boolean>;
  retryDeferredMoves(): Promise<void>;
  labelIdsFor(id: string, key: string | null | undefined): Promise<string[] | null>;
  needsIssueLabel(id: string, have: RowContent | undefined): Promise<boolean>;
  patch(id: string, body: Record<string, unknown>, commentAuthor?: string | null): Promise<boolean>;
}

/** The session lease: what a live session holds, and the proof of it on the agent. */
export interface LeasePort {
  readonly recovery: Promise<void>;
  trackSession(event: SessionEvent): void;
  writeLease(): Promise<boolean>;
  syncAgentStatus(): Promise<void>;
}

/** Thread notes: what the card's comment thread says. */
export interface NotesPort {
  readonly lastNote: Map<string, string>;
  note(id: string, text: string, opts: NoteOpts): Promise<void>;
  latestComment(id: string): Promise<string | undefined>;
  handoffFacts(id: string | null, stage: PaperclipStage, item: WorkItem, evidence?: HandoffFacts["evidence"], owner?: string): HandoffFacts | null;
}
