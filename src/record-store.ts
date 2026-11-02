// The record store's shared pieces (EM#1244 f1): the in-memory store, for tests
// and for a work source that keeps no durable store, and the one comparison every
// store uses to decide that a save changes nothing. Source-neutral on purpose:
// no GitHub here, so another connector can import it alone.

import type { ItemRecord, RecordKey, RecordLoad } from "./adapters.js";
import type { RepoConfig } from "./config.js";

/** The map key one record lives under. */
export function recordId(key: RecordKey): string {
  return `${key.repo}#${key.kind}#${key.number}`;
}

/** JSON with object keys sorted, so two records with the same content compare equal whatever their key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Whether `value` is a plain JSON object a record can be: not an array, not null. */
export function isItemRecord(value: unknown): value is ItemRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Records held in this process only. Copies on the way in and out, so a caller's later edit never changes a stored record. */
export class InMemoryRecordStore {
  private readonly records = new Map<string, string>();

  async loadRecord(key: RecordKey, _repoConfig?: RepoConfig): Promise<RecordLoad> {
    const json = this.records.get(recordId(key));
    return json === undefined ? { status: "absent" } : { status: "found", record: JSON.parse(json) as ItemRecord };
  }

  async saveRecord(key: RecordKey, record: ItemRecord, _repoConfig?: RepoConfig): Promise<boolean> {
    if (!isItemRecord(record)) return false;
    this.records.set(recordId(key), canonicalJson(record));
    return true;
  }
}
