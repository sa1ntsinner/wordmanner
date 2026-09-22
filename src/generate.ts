import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseJsonl } from "./sample.js";
import { renderContext, selectExamples, type ContextQuery } from "./context.js";
import { languages, media, type Language, type Medium } from "./sample.js";
import { defaultStore, loadSamples } from "./store.js";
import { defaultNotes, loadNotes, matchingNotes } from "./notes.js";

function execute(command: string, args: string[], cwd?: string, timeoutMs = 180_000): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = execFile(command, args, { cwd, timeout: timeoutMs, maxBuffer: 1_000_000, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        rejectPromise(new Error(`process failed (${String(error.code ?? error.signal ?? "unknown")}): ${stderr.trim().slice(-500)}`));
      } else {
        resolvePromise(stdout);
      }
    });
    child.stdin?.end();
  });
}

interface GenerationCase {
  id: string;
  prompt: string;
  candidates: Record<string, string>;
  language?: Language;
  medium?: Medium;
  audience?: string;
  intent?: string;
}

function parseGenerationCase(value: unknown): GenerationCase {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("case must be an object");
  const item = value as Record<string, unknown>;
  if (typeof item.id !== "string" || !item.id.trim() || typeof item.prompt !== "string" || !item.prompt.trim()) {
    throw new Error("case needs id and prompt");
  }
  if (item.candidates !== undefined && (typeof item.candidates !== "object" || item.candidates === null || Array.isArray(item.candidates))) {
    throw new Error("candidates must be an object");
  }
  const candidates = (item.candidates ?? {}) as Record<string, unknown>;
  if (Object.values(candidates).some(text => typeof text !== "string" || !text.trim())) throw new Error("candidate texts must be non-empty strings");
  if (item.reference !== undefined) {
    if (typeof item.reference !== "string" || !item.reference.trim() || "human" in candidates) throw new Error("reference must be non-empty and distinct from candidates.human");
    candidates.human = item.reference;
  }
  const result: GenerationCase = { id: item.id, prompt: item.prompt, candidates: candidates as Record<string, string> };
  if (item.language !== undefined) {
    if (!languages.includes(item.language as Language)) throw new Error("invalid language");
    result.language = item.language as Language;
  }
  if (item.medium !== undefined) {
    if (!media.includes(item.medium as Medium)) throw new Error("invalid medium");
    result.medium = item.medium as Medium;
  }
  for (const field of ["audience", "intent"] as const) {
    if (item[field] !== undefined) {
      if (typeof item[field] !== "string") throw new Error(`${field} must be a string`);
      result[field] = item[field];
    }
  }
  return result;
}

export interface GenerateOptions {
  input: string;
  output: string;
  name: string;
  command: string;
  commandArgs: string[];
  cwd?: string;
  wordmanner?: boolean;
  store?: string;
  notes?: string;
  timeoutMs?: number;
}

export async function generateCandidates(options: GenerateOptions): Promise<number> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(options.name)) throw new Error("candidate name must be 1–100 letters, digits, dots, underscores or hyphens");
  const absolute = resolve(options.output);
  try {
    await lstat(absolute);
    throw new Error(`output already exists: ${absolute}`);
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
  }
  const cases = parseJsonl(await readFile(options.input, "utf8"), parseGenerationCase);
  if (!cases.length) throw new Error("input contains no cases");
  const ids = new Set<string>();
  for (const item of cases) {
    if (ids.has(item.id)) throw new Error(`duplicate case id: ${item.id}`);
    if (options.name in item.candidates) throw new Error(`candidate ${options.name} already exists for ${item.id}`);
    if (options.wordmanner && (!item.language || !item.medium)) throw new Error(`Wordmanner needs language and medium for ${item.id}`);
    ids.add(item.id);
  }

  const samples = options.wordmanner ? await loadSamples(options.store ?? defaultStore) : [];
  const notes = options.wordmanner ? await loadNotes(options.notes ?? defaultNotes) : [];
  for (const item of cases) {
    let prompt = item.prompt;
    if (options.wordmanner) {
      const query: ContextQuery = {
        language: item.language!,
        medium: item.medium!,
        ...(item.audience ? { audience: item.audience } : {}),
        ...(item.intent ? { intent: item.intent } : {}),
      };
      prompt = `${renderContext(query, selectExamples(samples, query), matchingNotes(notes, query.language, query.medium))}\n\nTASK:\n${item.prompt}`;
    }
    let output: string;
    try {
      output = (await execute(options.command, [...options.commandArgs, prompt], options.cwd, options.timeoutMs)).trim();
    } catch (error) {
      throw new Error(`generation failed for ${item.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!output) throw new Error(`generation returned empty text for ${item.id}`);
    item.candidates[options.name] = output;
  }

  await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
  const temporary = `${absolute}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, cases.map(item => JSON.stringify(item)).join("\n") + "\n", { mode: 0o600, flag: "wx" });
    await link(temporary, absolute);
  } catch (error) {
    throw error;
  } finally {
    await rm(temporary, { force: true });
  }
  return cases.length;
}
