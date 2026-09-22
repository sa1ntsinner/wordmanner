import { randomUUID } from "node:crypto";
import { readFile, mkdir, writeFile, rename, lstat, rm, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseJsonl, parseSample, type Sample } from "./sample.js";

export const defaultStore = join(process.env.WORDMANNER_HOME ?? join(homedir(), ".wordmanner"), "samples.jsonl");

export async function loadSamples(path = defaultStore): Promise<Sample[]> {
  try {
    const input = await readFile(path, "utf8");
    const samples = parseJsonl(input, parseSample);
    assertUnique(samples);
    return samples;
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function assertUnique(samples: Sample[]): void {
  const ids = new Set<string>();
  for (const sample of samples) {
    if (ids.has(sample.id)) throw new Error(`duplicate sample id: ${sample.id}`);
    ids.add(sample.id);
  }
}

export async function importSamples(inputPath: string, storePath = defaultStore): Promise<number> {
  const incoming = parseJsonl(await readFile(inputPath, "utf8"), parseSample);
  return appendSamples(incoming, storePath);
}

export async function appendSamples(incoming: Sample[], storePath = defaultStore): Promise<number> {
  if (incoming.length === 0) throw new Error("input contains no samples");
  const existing = await loadSamples(storePath);
  const combined = [...existing, ...incoming];
  assertUnique(combined);

  const absolute = resolve(storePath);
  try {
    if ((await lstat(absolute)).isSymbolicLink()) throw new Error("sample store must not be a symlink");
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
  if (absolute === resolve(defaultStore)) await chmod(dirname(absolute), 0o700);
  const temporary = `${absolute}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, combined.map(sample => JSON.stringify(sample)).join("\n") + "\n", { mode: 0o600, flag: "wx" });
    await rename(temporary, absolute);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return incoming.length;
}
