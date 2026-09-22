#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { writeBlindRun, scoreRun } from "./benchmark.js";
import { renderContext, selectExamples } from "./context.js";
import { generateCandidates } from "./generate.js";
import { agents, applyIntegration, planIntegration, type Agent } from "./integration.js";
import { languages, media, type Language, type Medium } from "./sample.js";
import { addNote, defaultNotes, loadNotes, matchingNotes } from "./notes.js";
import { defaultStore, importSamples, loadSamples } from "./store.js";
import { applyTelegram, excludeTelegram, prepareTelegram, previewTelegram } from "./telegram.js";

const help = `wordmanner — writing context for AI agents

Commands:
  wordmanner samples import <file.jsonl> [--store <path>]
  wordmanner samples inspect [--store <path>]
  wordmanner notes add --text <preference> [--language en|ru] [--medium <medium>] [--file <path>]
  wordmanner notes list [--file <path>]
  wordmanner telegram preview <result.json> [--out <new-directory>] [--self-id <sender-id>]
  wordmanner telegram prepare <preview-directory> --chats <id,id,...> --language en|ru [--out <new-directory>] [--audience <text>] [--limit <count>] [--per-chat <count>]
  wordmanner telegram exclude <prepared-directory> --numbers <1,3,...>
  wordmanner telegram apply <prepared-directory> [--store <path>]
  wordmanner context --language en|ru --medium <medium> [--audience <text>] [--intent <text>] [--topic <text>] [--store <path>] [--notes <path>]
  wordmanner bench blind <cases.jsonl> --out <new-directory> [--seed <text>]
  wordmanner bench generate <cases.jsonl> --name <variant> --out <new-file> [--cwd <dir>] [--wordmanner] [--store <path>] [--notes <path>] -- <executable> [args...]
  wordmanner bench score <key.json> <ratings.jsonl>
  wordmanner init [--agents claude,codex,gemini,cursor] [--root <path>] [--dry-run]
  wordmanner uninstall [--agents claude,codex,gemini,cursor] [--root <path>] [--dry-run]

Media: ${media.join(", ")}
Local samples default to ~/.wordmanner/samples.jsonl (override with WORDMANNER_HOME or --store). Context output contains excerpts of selected samples.`;

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`--${name} needs a value`);
  args.splice(index, 2);
  return value;
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function noExtras(args: string[]): void {
  if (args.length) throw new Error(`unexpected arguments: ${args.join(" ")}`);
}

function flag(args: string[], name: string): boolean {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

function importDirectory(stage: string): string {
  return join(dirname(defaultStore), "imports", `${stage}-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`);
}

async function run(args: string[]): Promise<void> {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(help);
    return;
  }
  const command = args.shift();
  if (command === "telegram") {
    const action = args.shift();
    if (action === "preview") {
      const input = required(args.shift(), "Telegram result.json");
      const output = option(args, "out") ?? importDirectory("telegram-preview");
      const selfId = option(args, "self-id");
      noExtras(args);
      const manifest = await previewTelegram(input, output, selfId);
      console.log(`Previewed ${manifest.chats.length} chats. Review ${resolve(output, "report.md")} to choose chat IDs. No messages were imported.`);
      return;
    }
    if (action === "prepare") {
      const previewDir = required(args.shift(), "preview directory");
      const outputDir = option(args, "out") ?? importDirectory("telegram-review");
      const chatIds = required(option(args, "chats"), "--chats").split(",").map(id => id.trim());
      const language = required(option(args, "language"), "--language");
      const audience = option(args, "audience");
      const limit = option(args, "limit");
      const perChat = option(args, "per-chat");
      noExtras(args);
      if (!languages.includes(language as Language)) throw new Error(`invalid language: ${language}`);
      const count = await prepareTelegram({ previewDir, outputDir, chatIds, language: language as Language,
        ...(audience ? { audience } : {}), ...(limit ? { limit: Number(limit) } : {}), ...(perChat ? { perChat: Number(perChat) } : {}) });
      console.log(`Prepared ${count} local examples. Review ${resolve(outputDir, "review.md")} and edit samples.jsonl before applying.`);
      return;
    }
    if (action === "apply") {
      const preparedDir = required(args.shift(), "prepared directory");
      const store = option(args, "store") ?? defaultStore;
      noExtras(args);
      const count = await applyTelegram(preparedDir, store);
      console.log(`Imported ${count} reviewed Telegram examples into ${store}`);
      return;
    }
    if (action === "exclude") {
      const preparedDir = required(args.shift(), "prepared directory");
      const numbers = required(option(args, "numbers"), "--numbers").split(",").map(number => Number(number.trim()));
      noExtras(args);
      const count = await excludeTelegram(preparedDir, numbers);
      console.log(`Excluded ${count} example${count === 1 ? "" : "s"} from import. Original review files remain unchanged.`);
      return;
    }
  }
  if (command === "notes") {
    const action = args.shift();
    if (action === "add") {
      const content = required(option(args, "text"), "--text");
      const language = option(args, "language");
      const medium = option(args, "medium");
      const file = option(args, "file") ?? defaultNotes;
      noExtras(args);
      if (language && !languages.includes(language as Language)) throw new Error(`invalid language: ${language}`);
      if (medium && !media.includes(medium as Medium)) throw new Error(`invalid medium: ${medium}`);
      const note = await addNote(content, language as Language | undefined, medium as Medium | undefined, file);
      console.log(`Saved writing preference ${note.id} in ${file}`);
      return;
    }
    if (action === "list") {
      const file = option(args, "file") ?? defaultNotes;
      noExtras(args);
      console.log(JSON.stringify(await loadNotes(file), null, 2));
      return;
    }
  }
  if (command === "init" || command === "uninstall") {
    const selected = (option(args, "agents") ?? agents.join(",")).split(",");
    const root = option(args, "root") ?? ".";
    const dryRun = flag(args, "dry-run");
    noExtras(args);
    if (selected.some(agent => !agents.includes(agent as Agent))) throw new Error(`agents must be a comma-separated subset of ${agents.join(", ")}`);
    const changes = await planIntegration(root, selected as Agent[], command);
    if (!dryRun) await applyIntegration(changes);
    console.log(`${dryRun ? "Would " : ""}${command === "init" ? "install" : "remove"} ${changes.length} file change${changes.length === 1 ? "" : "s"}:`);
    for (const change of changes) console.log(`  ${change.action} ${change.path}`);
    return;
  }
  if (command === "samples") {
    const action = args.shift();
    if (action === "import") {
      const input = required(args.shift(), "input file");
      const store = option(args, "store") ?? defaultStore;
      noExtras(args);
      const count = await importSamples(resolve(input), resolve(store));
      console.log(`Imported ${count} sample${count === 1 ? "" : "s"} into ${store}`);
      return;
    }
    if (action === "inspect") {
      const store = option(args, "store") ?? defaultStore;
      noExtras(args);
      const samples = await loadSamples(store);
      const counts: Record<string, number> = {};
      for (const sample of samples) counts[`${sample.language}/${sample.medium}`] = (counts[`${sample.language}/${sample.medium}`] ?? 0) + 1;
      console.log(JSON.stringify({ total: samples.length, by_context: counts }, null, 2));
      return;
    }
  }
  if (command === "context") {
    const language = required(option(args, "language"), "--language");
    const medium = required(option(args, "medium"), "--medium");
    const audience = option(args, "audience");
    const intent = option(args, "intent");
    const topic = option(args, "topic");
    const store = option(args, "store") ?? defaultStore;
    const notes = option(args, "notes") ?? defaultNotes;
    noExtras(args);
    if (!languages.includes(language as Language)) throw new Error(`invalid language: ${language}`);
    if (!media.includes(medium as Medium)) throw new Error(`invalid medium: ${medium}`);
    const query = {
      language: language as Language,
      medium: medium as Medium,
      ...(audience ? { audience } : {}),
      ...(intent ? { intent } : {}),
      ...(topic ? { topic } : {}),
    };
    console.log(renderContext(query, selectExamples(await loadSamples(store), query), matchingNotes(await loadNotes(notes), query.language, query.medium)));
    return;
  }
  if (command === "bench") {
    const action = args.shift();
    if (action === "generate") {
      const separator = args.indexOf("--");
      if (separator < 0) throw new Error("bench generate needs -- <executable> [args...] after its options");
      const commandLine = args.splice(separator + 1);
      args.pop();
      const input = required(args.shift(), "cases file");
      const name = required(option(args, "name"), "--name");
      const output = required(option(args, "out"), "--out");
      const cwd = option(args, "cwd");
      const store = option(args, "store");
      const notes = option(args, "notes");
      const wordmanner = flag(args, "wordmanner");
      noExtras(args);
      const executable = required(commandLine.shift(), "executable");
      const count = await generateCandidates({ input, output, name, command: executable, commandArgs: commandLine, ...(cwd ? { cwd } : {}), ...(store ? { store } : {}), ...(notes ? { notes } : {}), wordmanner });
      console.log(`Generated ${count} ${name} candidate${count === 1 ? "" : "s"} in ${output}`);
      return;
    }
    if (action === "blind") {
      const input = required(args.shift(), "cases file");
      const output = required(option(args, "out"), "--out");
      const seed = option(args, "seed");
      noExtras(args);
      const count = await writeBlindRun(input, output, seed);
      console.log(`Prepared ${count} blind cases in ${output}. Give raters ballot.md or ballot.jsonl; keep key.json private.`);
      return;
    }
    if (action === "score") {
      const key = required(args.shift(), "key file");
      const ratings = required(args.shift(), "ratings file");
      noExtras(args);
      console.log(JSON.stringify(await scoreRun(key, ratings), null, 2));
      return;
    }
  }
  throw new Error(`unknown command\n\n${help}`);
}

run(process.argv.slice(2)).catch(error => {
  console.error(`wordmanner: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
