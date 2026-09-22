# Benchmark protocol

The included benchmark command prepares a blind ballot; it does not generate model output or grade writing quality automatically.

1. Fix a set of tasks before writing or tuning the Wordmanner instructions. Split personal writing examples and held-out tasks by conversation thread, subject, and recipient where possible. Keep private material out of git.
2. Run the same model with the same task context in each condition. Record the model identifier, date, prompt, temperature, skill version, example IDs, response, latency, and cost. Useful conditions are raw model, built-in style, established humanizer skills, Wordmanner without examples, and Wordmanner with examples. Only compare products that were actually run.
3. Put each case on one JSONL line: `{"id":"case-1","prompt":"...","candidates":{"raw":"...","wordmanner":"..."}}`. Candidate names stay in the private key. Include the actual human response as another candidate when available and permitted.
4. Run `wordmanner bench blind cases.jsonl --out .wordmanner/run-1`. Send only `ballot.jsonl` to raters. Keep `key.json` private. Raters should judge task fit, clarity, and voice separately; ask them to mark factual errors before preferring a polished response.
5. Collect one JSONL choice per rater and case: `{"id":"case-1","chosen_label":"B","rater":"r1"}`. Run `wordmanner bench score .wordmanner/run-1/key.json ratings.jsonl`. The output is a raw win count, not a significance claim. Record abstentions and tie rules outside this simple scorer.
6. Review failures by category. Change the smallest rule that addresses a repeatable error. Evaluate on new held-out cases; do not keep tuning on the same test set.

For a public quality claim, use enough cases and raters to report uncertainty, per-language and per-medium breakdowns, factual-error rates, and negative cases where leaving text unchanged was best. A strong quality claim needs direct comparison against Idiolect AI and other relevant products under comparable access and settings.
