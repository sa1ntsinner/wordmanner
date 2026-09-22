import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { blindCases, parseCase, scoreRun, writeBlindRun } from "../src/benchmark.js";

test("blind ballot hides variant names and scoring uses the private key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wordmanner-bench-"));
  try {
    const input = join(directory, "cases.jsonl");
    const output = join(directory, "run");
    const item = parseCase({ id: "case-1", prompt: "Reply briefly", candidates: { raw: "Certainly, happy to help.", wordmanner: "Sure, I'll send it." } });
    assert.deepEqual(blindCases([item], "fixed-seed"), blindCases([item], "fixed-seed"));
    await writeFile(input, JSON.stringify(item) + "\n");
    assert.equal(await writeBlindRun(input, output, "fixed-seed"), 1);
    const ballotText = await readFile(join(output, "ballot.jsonl"), "utf8");
    assert.doesNotMatch(ballotText, /"raw"|"wordmanner"/);
    const key = JSON.parse(await readFile(join(output, "key.json"), "utf8")) as { cases: { labels: Record<string, string> }[] };
    const label = Object.entries(key.cases[0]!.labels).find(([, name]) => name === "wordmanner")?.[0];
    assert.ok(label);
    const ratings = join(directory, "ratings.jsonl");
    await writeFile(ratings, JSON.stringify({ id: "case-1", chosen_label: label, rater: "human-1" }) + "\n");
    assert.deepEqual(await scoreRun(join(output, "key.json"), ratings), { total: 1, wins: { wordmanner: 1 } });
    await assert.rejects(writeBlindRun(input, output, "fixed-seed"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
