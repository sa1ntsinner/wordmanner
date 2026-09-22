import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { parser } from "stream-json";
import { ignore } from "stream-json/filters/ignore.js";
import { pick } from "stream-json/filters/pick.js";
import { streamArray } from "stream-json/streamers/stream-array.js";
import { streamValues } from "stream-json/streamers/stream-values.js";
import { parseJsonl, parseSample, type Language, type Sample } from "./sample.js";
import { appendSamples, defaultStore } from "./store.js";

interface Chat {
  index: number;
  id: string;
  name: string;
  type: string;
  sent: number;
  latest?: string;
  eligible: Record<Language, number>;
}

export interface TelegramManifest {
  version: 1;
  source: { path: string; size: number; mtimeMs: number };
  selfId: string;
  selfDetection: "saved_messages" | "explicit";
  chats: Chat[];
}

type JsonObject = Record<string, unknown>;

const englishWords = new Set(["a", "and", "are", "be", "can", "do", "for", "have", "i", "in", "is", "it", "my", "of", "on", "please", "that", "the", "this", "to", "we", "will", "with", "you", "your"]);

function object(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringId(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : typeof value === "number" && Number.isSafeInteger(value) ? String(value) : undefined;
}

async function eachChat(path: string, visit: (index: number, chat: JsonObject) => void): Promise<void> {
  await pipeline(
    createReadStream(path),
    parser.asStream(),
    ignore.asStream({ filter: /^chats\.list\.\d+\.messages$/ }),
    pick.asStream({ filter: "chats.list" }),
    streamArray.asStream(),
    async source => {
      for await (const item of source) {
        if (!object(item) || typeof item.key !== "number" || !object(item.value)) throw new Error("invalid Telegram chat");
        visit(item.key, item.value);
      }
    },
  );
}

async function eachMessage(path: string, visit: (chatIndex: number, message: JsonObject) => void): Promise<void> {
  const chatIndexes: number[] = [];
  await pipeline(
    createReadStream(path),
    parser.asStream(),
    pick.asStream({
      filter: (stack, chunk) => {
        const match = stack.length === 5 && stack[0] === "chats" && stack[1] === "list"
          && typeof stack[2] === "number" && stack[3] === "messages" && typeof stack[4] === "number";
        if (match && chunk.name === "startObject") chatIndexes.push(stack[2] as number);
        return match;
      },
    }),
    streamValues.asStream(),
    async source => {
      for await (const item of source) {
        const index = chatIndexes.shift();
        if (index === undefined || !object(item) || !object(item.value)) throw new Error("invalid Telegram message");
        visit(index, item.value);
      }
    },
  );
  if (chatIndexes.length) throw new Error("incomplete Telegram messages");
}

function textOf(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return undefined;
  const parts: string[] = [];
  for (const item of value) {
    if (typeof item === "string") parts.push(item);
    else if (object(item) && typeof item.text === "string") parts.push(item.text);
    else return undefined;
  }
  return parts.join("").trim();
}

function languageOf(text: string): Language | undefined {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length < 15) return undefined;
  const cyrillic = text.match(/\p{Script=Cyrillic}/gu)?.length ?? 0;
  if (cyrillic / letters.length >= 0.65) return "ru";
  const latin = text.match(/\p{Script=Latin}/gu)?.length ?? 0;
  if (latin / letters.length < 0.9 || /[əğışçöü]/iu.test(text)) return undefined;
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  return words.filter(word => englishWords.has(word)).length >= 2 ? "en" : undefined;
}

function eligible(message: JsonObject): { text: string; language: Language } | undefined {
  if (message.type !== "message" || message.forwarded_from || message.media_type || message.file || message.photo || message.via_bot) return undefined;
  const text = textOf(message.text);
  if (!text || text.length < 25 || text.length > 240 || /^\//u.test(text)) return undefined;
  if (/https?:\/\/|www\.|\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b|\+?\d[\d\s().-]{8,}\d/iu.test(text)) return undefined;
  const language = languageOf(text);
  return language ? { text, language } : undefined;
}

function display(text: string): string {
  return text.replace(/\r?\n/gu, " ").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("|", "\\|");
}

function quote(text: string): string {
  return text.split(/\r?\n/).map(line => `> ${display(line)}`).join("\n");
}

async function newPrivateDirectory(path: string): Promise<string> {
  const absolute = resolve(path);
  await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
  await mkdir(absolute, { mode: 0o700 });
  return absolute;
}

export async function previewTelegram(sourcePath: string, outputDir: string, explicitSelfId?: string): Promise<TelegramManifest> {
  const path = resolve(sourcePath);
  const sourceStat = await stat(path);
  if (!sourceStat.isFile()) throw new Error("Telegram export must be a JSON file");
  const chats: Chat[] = [];
  await eachChat(path, (index, item) => {
    const id = stringId(item.id);
    if (!id || typeof item.type !== "string") throw new Error(`Telegram chat ${index} needs id and type`);
    chats.push({ index, id, name: typeof item.name === "string" ? item.name : "", type: item.type, sent: 0, eligible: { en: 0, ru: 0 } });
  });
  if (!chats.length) throw new Error("Telegram export contains no chats");
  if (new Set(chats.map(chat => chat.id)).size !== chats.length) throw new Error("Telegram export has duplicate chat IDs");

  const savedSenders = new Set<string>();
  const stats = chats.map(() => new Map<string, { sent: number; en: number; ru: number; latest?: string }>());
  await eachMessage(path, (index, message) => {
    const chat = chats[index];
    if (!chat) throw new Error(`message refers to unknown chat ${index}`);
    const from = stringId(message.from_id);
    if (!from) return;
    if (chat.type === "saved_messages" && message.type === "message") savedSenders.add(from);
    const bySender = stats[index]!;
    const entry = bySender.get(from) ?? { sent: 0, en: 0, ru: 0 };
    if (message.type === "message") {
      entry.sent++;
      if (typeof message.date === "string" && (!entry.latest || message.date > entry.latest)) entry.latest = message.date;
    }
    const candidate = eligible(message);
    if (candidate) entry[candidate.language]++;
    bySender.set(from, entry);
  });
  const detectedSelf = savedSenders.size === 1 ? [...savedSenders][0] : undefined;
  if (!explicitSelfId && !detectedSelf) throw new Error("could not identify the account from Saved Messages; rerun with --self-id after checking the export");
  if (explicitSelfId && detectedSelf && explicitSelfId !== detectedSelf) throw new Error("--self-id conflicts with the sender in Saved Messages");
  const selfId = explicitSelfId ?? detectedSelf!;
  for (const chat of chats) {
    const own = stats[chat.index]!.get(selfId);
    if (own) {
      chat.sent = own.sent;
      chat.eligible = { en: own.en, ru: own.ru };
      if (own.latest) chat.latest = own.latest;
    }
  }
  const manifest: TelegramManifest = {
    version: 1,
    source: { path, size: sourceStat.size, mtimeMs: sourceStat.mtimeMs },
    selfId,
    selfDetection: explicitSelfId ? "explicit" : "saved_messages",
    chats,
  };
  const directory = await newPrivateDirectory(outputDir);
  const active = chats.filter(chat => chat.sent > 0);
  const sorted = active.filter(chat => chat.eligible.ru + chat.eligible.en > 0)
    .sort((a, b) => b.eligible.ru + b.eligible.en - a.eligible.ru - a.eligible.en);
  const report = [
    "# Telegram import preview",
    "",
    `Source: ${display(path)}`,
    `Chats: ${chats.length}; chats with your sent text: ${active.length}; chats with eligible examples: ${sorted.length}. Account identified from ${manifest.selfDetection === "saved_messages" ? "Saved Messages" : "the supplied sender ID"}.`,
    "",
    "Only your outgoing plain-text messages can become examples. For the first pass, choose a few chats whose register you want Wordmanner to learn. Two or three direct chats with at least 20 candidates are a useful start; keep groups separate. Saved Messages, forwards, media captions, links, detected contact details, very short reactions, and texts over 240 characters are excluded. Every candidate remains local for review before import.",
    "",
    "| Chat ID | Name | Type | Last sent | Sent | Russian candidates | English candidates |",
    "| --- | --- | --- | --- | ---: | ---: | ---: |",
    ...sorted.map(chat => `| ${chat.id} | ${display(chat.name || "(unnamed)")} | ${chat.type} | ${chat.latest?.slice(0, 10) ?? "—"} | ${chat.sent} | ${chat.eligible.ru} | ${chat.eligible.en} |`),
    "",
    "Next: `wordmanner telegram prepare <this-directory> --chats <id,id,...> --language ru --out <new-directory>`.",
    "",
  ].join("\n");
  await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  await writeFile(join(directory, "report.md"), report, { mode: 0o600, flag: "wx" });
  return manifest;
}

function parseManifest(value: unknown): TelegramManifest {
  if (!object(value) || value.version !== 1 || !object(value.source) || typeof value.source.path !== "string"
    || typeof value.source.size !== "number" || typeof value.source.mtimeMs !== "number" || typeof value.selfId !== "string"
    || !Array.isArray(value.chats)) throw new Error("invalid Telegram preview manifest");
  for (const chat of value.chats) {
    if (!object(chat) || typeof chat.index !== "number" || typeof chat.id !== "string" || typeof chat.type !== "string") throw new Error("invalid Telegram chat in manifest");
  }
  return value as unknown as TelegramManifest;
}

export interface PrepareOptions {
  previewDir: string;
  outputDir: string;
  chatIds: string[];
  language: Language;
  audience?: string;
  limit?: number;
  perChat?: number;
}

interface Candidate {
  sample: Sample;
  chatId: string;
  chatName: string;
  date: string;
  score: number;
}

export async function prepareTelegram(options: PrepareOptions): Promise<number> {
  const manifest = parseManifest(JSON.parse(await readFile(join(options.previewDir, "manifest.json"), "utf8")) as unknown);
  const current = await stat(manifest.source.path);
  if (current.size !== manifest.source.size || current.mtimeMs !== manifest.source.mtimeMs) throw new Error("Telegram export changed since preview; run preview again");
  const ids = new Set(options.chatIds);
  if (!ids.size) throw new Error("choose at least one chat ID from report.md");
  const chats = manifest.chats.filter(chat => ids.has(chat.id));
  if (chats.length !== ids.size) throw new Error("one or more selected chat IDs are absent from the preview");
  if (chats.some(chat => chat.type === "saved_messages")) throw new Error("Saved Messages are not a conversational voice source");
  const limit = options.limit ?? 80;
  const perChat = options.perChat ?? 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500 || !Number.isSafeInteger(perChat) || perChat < 1 || perChat > 100) throw new Error("limit must be 1–500 and per-chat must be 1–100");
  const byIndex = new Map(chats.map(chat => [chat.index, chat]));
  const pools = new Map(chats.map(chat => [chat.id, [] as Candidate[]]));
  await eachMessage(manifest.source.path, (index, message) => {
    const chat = byIndex.get(index);
    if (!chat || stringId(message.from_id) !== manifest.selfId) return;
    const candidate = eligible(message);
    if (!candidate || candidate.language !== options.language) return;
    const messageId = stringId(message.id);
    if (!messageId) return;
    const id = "tg-" + createHash("sha256").update(`${chat.id}\0${messageId}`).digest("hex").slice(0, 24);
    const date = typeof message.date === "string" ? message.date : "";
    const recency = /^20\d\d/.test(date) ? Math.min(0.25, Math.max(0, (Number(date.slice(0, 4)) - 2021) * 0.04)) : 0;
    const variance = parseInt(createHash("sha256").update(id).digest("hex").slice(0, 8), 16) / 0xffffffff;
    const score = variance + recency + (candidate.text.length >= 40 && candidate.text.length <= 160 ? 0.08 : 0);
    const sample: Sample = { id, text: candidate.text, language: options.language, medium: "chat", ...(options.audience ? { audience: options.audience } : {}) };
    const pool = pools.get(chat.id)!;
    pool.push({ sample, chatId: chat.id, chatName: chat.name, date, score });
    pool.sort((a, b) => b.score - a.score || a.sample.id.localeCompare(b.sample.id));
    if (pool.length > perChat) pool.pop();
  });
  const selected: Candidate[] = [];
  const seenTexts = new Set<string>();
  for (let rank = 0; selected.length < limit && rank < perChat; rank++) {
    for (const chat of chats) {
      const candidate = pools.get(chat.id)?.[rank];
      if (!candidate) continue;
      const fingerprint = candidate.sample.text.toLocaleLowerCase().replace(/\s+/gu, " ");
      if (seenTexts.has(fingerprint)) continue;
      seenTexts.add(fingerprint);
      selected.push(candidate);
      if (selected.length === limit) break;
    }
  }
  if (!selected.length) throw new Error("no suitable authored messages found for the selected language and chats");
  const directory = await newPrivateDirectory(options.outputDir);
  await writeFile(join(directory, "samples.jsonl"), selected.map(item => JSON.stringify(item.sample)).join("\n") + "\n", { mode: 0o600, flag: "wx" });
  const review = [
    "# Review before import",
    "",
    `Selected ${selected.length} of your outgoing ${options.language.toUpperCase()} chat messages from ${chats.length} chat(s). These texts have not been imported yet. Exclude unwanted examples with \`wordmanner telegram exclude ${directory} --numbers 1,3,8\`, then run \`wordmanner telegram apply ${directory}\`. You can also edit samples.jsonl directly.`,
    "",
    ...selected.flatMap((item, index) => [
      `## ${index + 1}. ${item.sample.id}`,
      "",
      `Chat: ${display(item.chatName || item.chatId)}; date: ${display(item.date || "unknown")}`,
      "",
      quote(item.sample.text),
      "",
    ]),
  ].join("\n");
  await writeFile(join(directory, "review.md"), review, { mode: 0o600, flag: "wx" });
  return selected.length;
}

export async function applyTelegram(preparedDir: string, store = defaultStore): Promise<number> {
  const path = join(preparedDir, "samples.jsonl");
  const samples = parseJsonl(await readFile(path, "utf8"), parseSample);
  if (samples.some(sample => sample.medium !== "chat" || !sample.id.startsWith("tg-"))) throw new Error("prepared file contains non-Telegram samples");
  let excluded: unknown = [];
  try {
    excluded = JSON.parse(await readFile(join(preparedDir, "excluded.json"), "utf8")) as unknown;
  } catch (error) {
    if (!(object(error) && error.code === "ENOENT")) throw error;
  }
  if (!Array.isArray(excluded) || excluded.some(id => typeof id !== "string")) throw new Error("invalid Telegram exclusions");
  const excludedIds = new Set(excluded as string[]);
  return appendSamples(samples.filter(sample => !excludedIds.has(sample.id)), store);
}

export async function excludeTelegram(preparedDir: string, numbers: number[]): Promise<number> {
  const samples = parseJsonl(await readFile(join(preparedDir, "samples.jsonl"), "utf8"), parseSample);
  if (!numbers.length || numbers.some(number => !Number.isSafeInteger(number) || number < 1 || number > samples.length)) {
    throw new Error(`choose example numbers between 1 and ${samples.length}`);
  }
  const ids = [...new Set(numbers)].map(number => samples[number - 1]!.id);
  const target = join(preparedDir, "excluded.json");
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(ids, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  return ids.length;
}
