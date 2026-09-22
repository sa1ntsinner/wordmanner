import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadSamples } from "../src/store.js";
import { applyTelegram, excludeTelegram, prepareTelegram, previewTelegram } from "../src/telegram.js";

test("Telegram preview separates identity, chat choice, review, and private import", async () => {
  const root = await mkdtemp(join(tmpdir(), "wordmanner-telegram-"));
  try {
    const source = join(root, "result.json");
    await writeFile(source, JSON.stringify({ chats: { list: [
      { id: 1, type: "saved_messages", messages: [{ id: 1, type: "message", from_id: "user-self", text: "Моя заметка для себя на завтра утром." }] },
      { id: 2, name: "Friend", type: "personal_chat", messages: [
        { id: 2, type: "message", from_id: "user-other", text: "Чужое сообщение про завтрашнюю встречу." },
        { id: 3, type: "message", from_id: "user-self", date: "2026-09-23T10:00:00", text: "Давай встретимся завтра после работы, напиши когда будешь свободен." },
        { id: 4, type: "message", from_id: "user-self", date: "2026-09-23T11:00:00", text: ["Привет, ", { type: "bold", text: "давай созвонимся сегодня после обеда." }] },
        { id: 5, type: "message", from_id: "user-self", forwarded_from: "Someone", text: "Пересылаю длинное сообщение, которое написал совсем другой человек." },
        { id: 6, type: "message", from_id: "user-self", media_type: "photo", text: "Подпись к фотографии не должна становиться примером моего стиля." },
        { id: 7, type: "message", from_id: "user-self", text: "I will send you the files when I get back to the office." },
      ] },
      { id: 3, name: "Colleague", type: "personal_chat", messages: [
        { id: 8, type: "message", from_id: "user-self", text: "Проверю этот вопрос завтра и тогда напишу, что удалось выяснить." },
      ] },
    ] } }));
    const previewDir = join(root, "preview");
    const preview = await previewTelegram(source, previewDir);
    assert.equal(preview.selfId, "user-self");
    assert.equal(preview.chats.find(chat => chat.id === "2")?.eligible.ru, 2);
    assert.equal(preview.chats.find(chat => chat.id === "2")?.eligible.en, 1);
    assert.equal((await stat(previewDir)).mode & 0o777, 0o700);
    assert.equal((await stat(join(previewDir, "manifest.json"))).mode & 0o777, 0o600);
    assert.doesNotMatch(await readFile(join(previewDir, "report.md"), "utf8"), /встретимся/);
    await assert.rejects(previewTelegram(source, join(root, "wrong-self"), "user-other"), /conflicts/);

    const preparedDir = join(root, "prepared");
    assert.equal(await prepareTelegram({ previewDir, outputDir: preparedDir, chatIds: ["2"], language: "ru", audience: "friend" }), 2);
    const prepared = (await readFile(join(preparedDir, "samples.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line) as { text: string; audience: string });
    assert.equal(prepared.length, 2);
    assert.ok(prepared.every(sample => sample.audience === "friend"));
    assert.ok(prepared.every(sample => !sample.text.includes("Чужое")));
    assert.equal((await stat(join(preparedDir, "samples.jsonl"))).mode & 0o777, 0o600);
    assert.equal(await excludeTelegram(preparedDir, [2]), 1);
    assert.equal((await stat(join(preparedDir, "excluded.json"))).mode & 0o777, 0o600);
    await assert.rejects(excludeTelegram(preparedDir, [3]), /between 1 and 2/);
    const store = join(root, "samples.jsonl");
    assert.equal(await applyTelegram(preparedDir, store), 1);
    assert.equal((await loadSamples(store)).length, 1);
    await assert.rejects(applyTelegram(preparedDir, store), /duplicate sample id/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
