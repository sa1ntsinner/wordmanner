import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseJsonl } from "./sample.js";

interface Case {
  id: string;
  prompt: string;
  candidates: Record<string, string>;
}

interface BallotCase {
  id: string;
  prompt: string;
  candidates: { label: string; text: string }[];
}

interface KeyCase {
  id: string;
  labels: Record<string, string>;
}

interface Rating {
  id: string;
  chosen_label: string;
  rater?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseCase(value: unknown): Case {
  if (!record(value) || typeof value.id !== "string" || !value.id.trim() || typeof value.prompt !== "string" || !value.prompt.trim() || !record(value.candidates)) {
    throw new Error("case needs id, prompt, and candidates");
  }
  const entries = Object.entries(value.candidates);
  if (entries.length < 2 || entries.length > 8 || entries.some(([name, text]) => !name.trim() || typeof text !== "string" || !text.trim())) {
    throw new Error("candidates must contain 2–8 named, non-empty texts");
  }
  if (new Set(entries.map(([name]) => name.toLowerCase())).size !== entries.length) throw new Error("candidate names must be unique");
  return { id: value.id, prompt: value.prompt, candidates: value.candidates as Record<string, string> };
}

function orderFor(seed: string, id: string, name: string): string {
  return createHash("sha256").update(`${seed}\0${id}\0${name}`).digest("hex");
}

export function blindCases(cases: Case[], seed: string): { ballot: BallotCase[]; key: KeyCase[] } {
  const ids = new Set<string>();
  const ballot: BallotCase[] = [];
  const key: KeyCase[] = [];
  for (const item of cases) {
    if (ids.has(item.id)) throw new Error(`duplicate case id: ${item.id}`);
    ids.add(item.id);
    const names = Object.keys(item.candidates).sort((a, b) => orderFor(seed, item.id, a).localeCompare(orderFor(seed, item.id, b)));
    const candidates: BallotCase["candidates"] = [];
    const labels: Record<string, string> = {};
    names.forEach((name, index) => {
      const label = String.fromCharCode(65 + index);
      candidates.push({ label, text: item.candidates[name]! });
      labels[label] = name;
    });
    ballot.push({ id: item.id, prompt: item.prompt, candidates });
    key.push({ id: item.id, labels });
  }
  return { ballot, key };
}

export async function writeBlindRun(inputPath: string, outputDir: string, seed: string = randomUUID()): Promise<number> {
  const cases = parseJsonl(await readFile(inputPath, "utf8"), parseCase);
  if (!cases.length) throw new Error("benchmark contains no cases");
  const { ballot, key } = blindCases(cases, seed);
  await mkdir(dirname(outputDir), { recursive: true, mode: 0o700 });
  await mkdir(outputDir, { recursive: false, mode: 0o700 });
  await writeFile(join(outputDir, "ballot.jsonl"), ballot.map(item => JSON.stringify(item)).join("\n") + "\n", { mode: 0o600, flag: "wx" });
  await writeFile(join(outputDir, "key.json"), JSON.stringify({ version: 1, seed, cases: key }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  return cases.length;
}

function parseRating(value: unknown): Rating {
  if (!record(value) || typeof value.id !== "string" || typeof value.chosen_label !== "string") {
    throw new Error("rating needs id and chosen_label");
  }
  if (value.rater !== undefined && typeof value.rater !== "string") throw new Error("rater must be a string");
  const rating: Rating = { id: value.id, chosen_label: value.chosen_label };
  if (typeof value.rater === "string") rating.rater = value.rater;
  return rating;
}

export async function scoreRun(keyPath: string, ratingsPath: string): Promise<{ total: number; wins: Record<string, number> }> {
  const rawKey: unknown = JSON.parse(await readFile(keyPath, "utf8"));
  if (!record(rawKey) || rawKey.version !== 1 || !Array.isArray(rawKey.cases)) throw new Error("invalid benchmark key");
  const key = new Map<string, Record<string, string>>();
  for (const item of rawKey.cases) {
    if (!record(item) || typeof item.id !== "string" || !record(item.labels) || Object.values(item.labels).some(label => typeof label !== "string") || key.has(item.id)) {
      throw new Error("invalid benchmark key case");
    }
    key.set(item.id, item.labels as Record<string, string>);
  }
  const ratings = parseJsonl(await readFile(ratingsPath, "utf8"), parseRating);
  if (!ratings.length) throw new Error("ratings contain no choices");
  const unique = new Set<string>();
  const wins: Record<string, number> = {};
  for (const rating of ratings) {
    const name = key.get(rating.id)?.[rating.chosen_label];
    if (!name) throw new Error(`unknown case or label: ${rating.id}/${rating.chosen_label}`);
    const pair = `${rating.rater ?? "default"}\0${rating.id}`;
    if (unique.has(pair)) throw new Error(`duplicate rating for ${rating.id} by ${rating.rater ?? "default"}`);
    unique.add(pair);
    wins[name] = (wins[name] ?? 0) + 1;
  }
  return { total: ratings.length, wins };
}
