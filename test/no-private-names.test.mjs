// This repo is public. A customer's name, a customer's or Slashbin's private repo
// and service names, an operator's login or personal name, or an internal MCP
// server name must never appear in any tracked file: code, comments, tests, docs,
// skills or fixtures. An incident is cited by what happened and the Foreman's own
// issue number, with any other repo named generically ("a customer's orders
// service"). A deployment's own values go in its .ai-agent.json, which git ignores.
//
// The banned words are stored as SHA-256 hashes so this guard does not publish
// the very names it keeps out. Each tracked text file is split into runs of
// [a-z0-9_.-]; every run, and every contiguous span of its pieces (split on
// _ . -, rejoined with "-"), is hashed and checked. So `xyz_service`, `xyz-com`
// and `Org/xyz` all hit a banned `xyz`, and `a-b` hits a banned `a-b` in
// `a_b_c`. To ban a new word, append sha256(lowercase, separators as "-").
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BANNED = new Set([
  "4e605ba19bb9781a2af0f2b04256b7af1b2d9923a3d9f91837f33afee13b24e8",
  "6d667202a95e18481a2edaf0ac02d175fba7d56c3ce92aa3ea25ad05c79bdd88",
  "64d7eea9441fec777f0c17befd045e1db05917b44812c79110f7fbc8dd53db08",
  "95daa942ba0d72ab87fffbcd83e0038ed2fe33b3c5e7daaee009cbfc030becd8",
  "251ebc298017f5331bd9d16cd266533f618fed646c894c46b1c885fb155e2953",
  "e9b71991b7f947a3467fff8aeb5f6944a34cb9c5f9ab9e605411dd3655190c6c",
  "c04bc270f965db4d7ab365b3b865b743e35e13e295c7b15fb795e2a01d24a639",
  "e1ae0f511a7d306ec64021cfae4861cfda83c5264d826c4662715b8b687687dd",
  "b44f06a233a8da6f7095861b474a79cbfce75ed2285d70f650c699e0c158f3b1",
  "a580aabeaf1239b664d59d0108c326cf6f06b4b9476694c89ff7f47c68ca6ec9",
  "d465532d34173e6d3102dca40989dfcc8636652d61c6f67383a2cc3ad2898d54",
  "4fe22dc761aba50c6bdf4e3211d7dc04f85c52310e8d5024ce1a4fe5e5580ed9",
  "f87f23aece9f772fb01a39cb3c4326dffc0549ebbe37f1b13ec905a269b8a4c6",
  "16a61f28385c98d23f75094cc533242b96762becdf90830e8294250297b0187b",
  "6b5550ab124e6920122973ac3249cb20b88cdb277a5edff4bf46992886d62b43",
  "282de8d669d6132734abee717e77dadbbe018533619a385dc590824513208d44",
  "56e24a8d2a324a8ae0193a5da692776e2d3e5b527d6b97bc4e6beab5744bbb9d",
  "7f56533b3edb13d165e8846ad5066f11366e58d4c083e238b0bf87e13e7e846a",
  "01fa4d64bf83efcac7eb00fc78be6b04b0caea86b831c3102689cae63b40e25a",
  "64db4c04c166ef2f01398f0915d86ffa155d073d8f5eaae6f271c7f5e5c4ced7",
  "77a0f6a2656b964a2cb9b664cb8f8bfda9f4104fcfa8da89a47a8d50a24cdedc",
  "bb2ccab206d861b13635caed8ca1bf003098cc45a6a1da58e5af39814a5ef4af",
  "2028e31bc7c1d0dede80ada69aebf734574cc6cb625ad0e732149a5a037fdb37",
]);

const sha = (s) => createHash("sha256").update(s).digest("hex");

/** Every banned hit in `text`, as the span that matched. */
export function bannedSpans(text) {
  const hits = [];
  for (const run of text.toLowerCase().match(/[a-z0-9_.-]+/g) ?? []) {
    const parts = run.split(/[_.-]+/).filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      for (let j = i + 1; j <= parts.length && j - i <= 4; j++) {
        const span = parts.slice(i, j).join("-");
        if (BANNED.has(sha(span))) hits.push(span);
      }
    }
  }
  return hits;
}

test("the guard catches a banned word in every shape it hides in", () => {
  // Only the hash of the empty-safe sample is computed here, never a real name.
  BANNED.add(sha("zzqx"));
  BANNED.add(sha("zzqx-console"));
  try {
    for (const s of ["zzqx", "Zzqx_service", "org/zzqx-com", "zzqx.com", "x_zzqx_console_y"]) {
      assert.ok(bannedSpans(s).length > 0, s);
    }
    assert.deepEqual(bannedSpans("zzqxa azzqx console"), []);
  } finally {
    BANNED.delete(sha("zzqx"));
    BANNED.delete(sha("zzqx-console"));
  }
});

test("no tracked file names a customer, a private service, or an operator", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  const hits = [];
  for (const f of files) {
    for (const span of bannedSpans(f)) hits.push(`${f} (file name): ${span}`);
    let text;
    try { text = readFileSync(new URL(`../${f}`, import.meta.url), "utf8"); } catch { continue; }
    if (text.includes("\0")) continue;
    text.split("\n").forEach((line, i) => {
      for (const span of bannedSpans(line)) hits.push(`${f}:${i + 1}: ${span}`);
    });
  }
  assert.deepEqual(hits, [], `private names in a public repo — replace each with a generic one (see CLAUDE.md, "Public repo"):\n${hits.join("\n")}`);
});
