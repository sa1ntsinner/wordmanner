import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyIntegration, planIntegration } from "../src/integration.js";

test("installer is idempotent and uninstall restores unrelated instructions", async () => {
  const root = await mkdtemp(join(tmpdir(), "wordmanner-init-"));
  try {
    const original = "# Project\n\nKeep this note.\n";
    await writeFile(join(root, "AGENTS.md"), original);
    const selected = ["claude", "codex", "gemini", "cursor"] as const;
    const dryRun = await planIntegration(root, [...selected], "init");
    assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), original);
    assert.equal(dryRun.length, 7);
    await applyIntegration(dryRun);
    assert.deepEqual(await planIntegration(root, [...selected], "init"), []);
    assert.match(await readFile(join(root, ".agents/skills/wordmanner/SKILL.md"), "utf8"), /wordmanner:managed/);
    assert.match(await readFile(join(root, ".cursor/rules/wordmanner.mdc"), "utf8"), /alwaysApply: true/);
    await applyIntegration(await planIntegration(root, [...selected], "uninstall"));
    assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), original);
    assert.deepEqual(await planIntegration(root, [...selected], "uninstall"), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installer refuses conflicting files before writing anything", async () => {
  const root = await mkdtemp(join(tmpdir(), "wordmanner-conflict-"));
  try {
    const path = join(root, ".claude/skills/wordmanner/SKILL.md");
    await (await import("node:fs/promises")).mkdir(join(root, ".claude/skills/wordmanner"), { recursive: true });
    await writeFile(path, "Someone else's skill\n");
    await assert.rejects(planIntegration(root, ["claude", "codex"], "init"), /different content/);
    assert.equal(await readFile(path, "utf8"), "Someone else's skill\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
