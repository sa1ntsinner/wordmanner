import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { renderContext } from "../src/context.js";
import { addNote, loadNotes, matchingNotes } from "../src/notes.js";

test("local preferences stay private and apply only to matching contexts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wordmanner-notes-"));
  try {
    const path = join(directory, "profile", "notes.jsonl");
    await addNote("Keep routine replies brief.", "en", "email", path);
    await addNote("Пиши прямо.", "ru", undefined, path);
    const notes = await loadNotes(path);
    assert.equal(notes.length, 2);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(directory, "profile"))).mode & 0o777, 0o700);
    assert.equal((await readFile(path, "utf8")).split("\n").filter(Boolean).length, 2);
    assert.deepEqual(matchingNotes(notes, "en", "chat"), []);
    assert.equal(matchingNotes(notes, "en", "email").length, 1);
    assert.equal(matchingNotes(notes, "ru", "presentation").length, 1);
    const context = renderContext({ language: "en", medium: "email" }, [], matchingNotes(notes, "en", "email"));
    assert.match(context, /Keep routine replies brief/);
    assert.doesNotMatch(context, /Пиши прямо/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent preference additions do not replace each other", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wordmanner-notes-"));
  try {
    const path = join(directory, "notes.jsonl");
    await Promise.all(Array.from({ length: 12 }, (_, index) => addNote(`Preference ${index}`, "en", "email", path)));
    const notes = await loadNotes(path);
    assert.equal(notes.length, 12);
    assert.equal(new Set(notes.map(note => note.text)).size, 12);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
