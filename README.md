# Wordmanner

Writing context for AI agents: clear updates, useful code comments, stronger slide text, and messages that fit the person and situation. English and Russian are the first supported languages.

Wordmanner is an early open-source prototype. It currently provides a portable [skill](skill/wordmanner/SKILL.md), a local sample library, contextual example selection, and a blind comparison tool. It does not claim to reproduce anyone's voice automatically or beat existing products yet.

## Try it

Requires Node.js 20 or later.

```sh
npm install
npm link
wordmanner init --dry-run
wordmanner init
wordmanner samples import examples/samples.jsonl --store .wordmanner/demo-samples.jsonl
wordmanner context --language en --medium email --audience colleague --intent 'status update' --store .wordmanner/demo-samples.jsonl
```

The example messages are synthetic. Add your own **outgoing, user-authored** samples to a JSONL file with `id`, `text`, `language` (`en` or `ru`), and `medium` (`email`, `chat`, `presentation`, `article`, `technical`, `code-comment`, `general`). Optional fields are `audience`, `intent`, and `tags`. By default, imported samples live in `~/.wordmanner/samples.jsonl` so the same voice is available across projects. Set `WORDMANNER_HOME` or `--store` to choose another location. The local `.wordmanner/` directory is ignored by git for demos and private benchmarks. The CLI has no model API calls or telemetry. The `context` command prints selected sample excerpts; sharing that output with a cloud model shares those excerpts with that provider.

`init` installs the [skill](skill/wordmanner/SKILL.md) and a short persistent instruction for Claude Code, Codex, and Gemini CLI, plus a Cursor rule. It writes only Wordmanner-owned files or marked blocks. `--dry-run` lists paths first; `uninstall` removes only unedited Wordmanner content. Select a subset with `--agents claude,codex`. Local installation cannot affect browser-only chat products automatically.

## Blind comparison

```sh
wordmanner bench blind examples/benchmark-cases.jsonl --out .wordmanner/demo-run
```

Give a rater only `.wordmanner/demo-run/ballot.jsonl`, never `key.json`. See the [benchmark protocol](docs/benchmark.md). The example outputs are illustrations, not evidence of performance.

## Design and competition

- [Product plan](docs/plan.ru.md)
- [Market research and primary sources](market-research.md)

The existing [Idiolect AI](https://idiolect.app/developers/mcp) already offers profiles, MCP tools, feedback, and multi-agent integrations. Wordmanner's specific bets are agent working prose, slides, code comments, local user control, and measured quality. These are hypotheses to test, not claims of superiority.

## Development

```sh
npm test
```

MIT licensed.
