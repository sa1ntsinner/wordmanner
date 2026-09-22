import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { generateCandidates } from "../src/generate.js";

test("generation passes private prompts as arguments without a shell and preserves existing candidates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wordmanner-generate-"));
  try {
    const input = join(directory, "input.jsonl");
    const output = join(directory, "output.jsonl");
    const marker = join(directory, "should-not-exist");
    const prompt = `Use literal $(touch ${marker}) and \`echo hi\``;
    await writeFile(input, JSON.stringify({ id: "case-1", prompt, candidates: { human: "Actual reply" } }) + "\n");
    assert.equal(await generateCandidates({ input, output, name: "agent", command: process.execPath, commandArgs: ["-e", "process.stdout.write(process.argv[1])"] }), 1);
    const result = JSON.parse(await readFile(output, "utf8")) as { candidates: Record<string, string> };
    assert.deepEqual(result.candidates, { human: "Actual reply", agent: prompt });
    await assert.rejects(access(marker));
    await assert.rejects(generateCandidates({ input: output, output: join(directory, "again.jsonl"), name: "agent", command: process.execPath, commandArgs: ["-e", "process.stdout.write(process.argv[1])"] }), /already exists/);

    const personalizedInput = join(directory, "personalized.jsonl");
    const store = join(directory, "samples.jsonl");
    const notes = join(directory, "notes.jsonl");
    await writeFile(personalizedInput, JSON.stringify({ id: "case-2", prompt: "Reply briefly", language: "en", medium: "email", reference: "Human reply" }) + "\n");
    await writeFile(store, JSON.stringify({ id: "sample-1", text: "Hi, yes, I'll send it today.", language: "en", medium: "email" }) + "\n");
    await writeFile(notes, JSON.stringify({ id: "note-1", text: "Use the direct style shown in my replies.", language: "en", medium: "email" }) + "\n");
    const personalizedOutput = join(directory, "personalized-output.jsonl");
    await generateCandidates({ input: personalizedInput, output: personalizedOutput, name: "wordmanner", command: process.execPath, commandArgs: ["-e", "process.stdout.write(process.argv[1])"], wordmanner: true, store, notes });
    const personalized = JSON.parse(await readFile(personalizedOutput, "utf8")) as { candidates: Record<string, string> };
    assert.equal(personalized.candidates.human, "Human reply");
    assert.match(personalized.candidates.wordmanner!, /Hi, yes, I'll send it today/);
    assert.match(personalized.candidates.wordmanner!, /Use the direct style/);
    assert.doesNotMatch(personalized.candidates.wordmanner!, /Human reply/);

    const stdinOutput = join(directory, "stdin-output.jsonl");
    await generateCandidates({ input, output: stdinOutput, name: "stdin", command: process.execPath, commandArgs: ["-e", "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('done'))"], timeoutMs: 2000 });
    const stdinResult = JSON.parse(await readFile(stdinOutput, "utf8")) as { candidates: Record<string, string> };
    assert.equal(stdinResult.candidates.stdin, "done");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
