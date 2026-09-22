import { readFile, mkdir, writeFile, rm, lstat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const agents = ["claude", "codex", "gemini", "cursor"] as const;
export type Agent = (typeof agents)[number];

interface Change {
  path: string;
  action: "write" | "delete";
  content?: string;
}

const begin = "<!-- wordmanner:start -->";
const end = "<!-- wordmanner:end -->";
const pointer = `${begin}
For writing-heavy tasks, use the Wordmanner skill. Match language, audience, and medium; keep facts intact. Make agent updates only when they add a real finding or decision. In code, comment on non-obvious reasons or constraints rather than narrating the implementation.
${end}`;

function generatedSkill(source: string): string {
  const anchor = "---\n\n# Wordmanner";
  if (!source.includes(anchor)) throw new Error("Wordmanner skill template changed unexpectedly");
  return source.replace(anchor, "---\n\n<!-- wordmanner:managed -->\n\n# Wordmanner");
}
const cursorRule = `---
description: Use Wordmanner for agent prose, messages, slides, technical explanations, and code comments.
alwaysApply: true
---

${pointer}
`;

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error(`refusing to change a symlink: ${path}`);
    return await readFile(path, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function ownBlock(content: string): { start: number; finish: number; block: string } | undefined {
  const start = content.indexOf(begin);
  const finish = content.indexOf(end);
  if (start < 0 && finish < 0) return undefined;
  if (start < 0 || finish < 0 || finish < start || content.indexOf(begin, start + begin.length) >= 0 || content.indexOf(end, finish + end.length) >= 0) {
    throw new Error("malformed Wordmanner block; edit it manually");
  }
  const after = finish + end.length;
  return { start, finish: after, block: content.slice(start, after) };
}

function withBlock(current: string | undefined): string {
  if (current === undefined) return `${pointer}\n`;
  const block = ownBlock(current);
  if (block) {
    if (block.block !== pointer) throw new Error("Wordmanner block was edited; preserve it and resolve manually");
    return current;
  }
  return `${current}\n${pointer}\n`;
}

function withoutBlock(current: string): string | undefined {
  const block = ownBlock(current);
  if (!block) return current;
  if (block.block !== pointer) throw new Error("Wordmanner block was edited; preserve it and resolve manually");
  if (block.start === 0 && current.slice(block.finish) === "\n") return undefined;
  if (current[block.start - 1] === "\n" && current.slice(block.finish) === "\n") return current.slice(0, block.start - 1);
  throw new Error("Wordmanner block moved; preserve it and resolve manually");
}

async function addOwnedFile(changes: Change[], path: string, content: string): Promise<void> {
  const current = await readIfExists(path);
  if (current === content) return;
  if (current !== undefined) throw new Error(`file already exists with different content: ${path}`);
  changes.push({ path, action: "write", content });
}

async function removeOwnedFile(changes: Change[], path: string, content: string): Promise<void> {
  const current = await readIfExists(path);
  if (current === undefined) return;
  if (current !== content) throw new Error(`installed file was edited; preserve it and resolve manually: ${path}`);
  changes.push({ path, action: "delete" });
}

async function addBlock(changes: Change[], path: string): Promise<void> {
  const current = await readIfExists(path);
  const updated = withBlock(current);
  if (updated !== current) changes.push({ path, action: "write", content: updated });
}

async function removeBlock(changes: Change[], path: string): Promise<void> {
  const current = await readIfExists(path);
  if (current === undefined) return;
  const updated = withoutBlock(current);
  if (updated === current) return;
  changes.push(updated === undefined ? { path, action: "delete" } : { path, action: "write", content: updated });
}

export async function planIntegration(root: string, selected: Agent[], mode: "init" | "uninstall"): Promise<Change[]> {
  const directory = resolve(root);
  const source = await readFile(fileURLToPath(new URL("../../skill/wordmanner/SKILL.md", import.meta.url)), "utf8");
  const skill = generatedSkill(source);
  const changes: Change[] = [];
  const owned = mode === "init" ? addOwnedFile : removeOwnedFile;
  const block = mode === "init" ? addBlock : removeBlock;
  for (const agent of [...new Set(selected)]) {
    if (agent === "claude") {
      await owned(changes, join(directory, ".claude/skills/wordmanner/SKILL.md"), skill);
      await block(changes, join(directory, "CLAUDE.md"));
    } else if (agent === "codex") {
      await owned(changes, join(directory, ".agents/skills/wordmanner/SKILL.md"), skill);
      await block(changes, join(directory, "AGENTS.md"));
    } else if (agent === "gemini") {
      await owned(changes, join(directory, ".gemini/skills/wordmanner/SKILL.md"), skill);
      await block(changes, join(directory, "GEMINI.md"));
    } else if (agent === "cursor") {
      await owned(changes, join(directory, ".cursor/rules/wordmanner.mdc"), cursorRule);
    }
  }
  return changes;
}

export async function applyIntegration(changes: Change[]): Promise<void> {
  for (const change of changes) {
    if (change.action === "delete") {
      await rm(change.path);
    } else {
      await mkdir(dirname(change.path), { recursive: true });
      await writeFile(change.path, change.content!, "utf8");
    }
  }
}
