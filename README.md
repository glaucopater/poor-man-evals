# poor-man-evals

A minimal LLM eval harness. Runs a prompt dataset against a list of
[Groq](https://groq.com)-hosted models, scores each output with an
LLM-as-judge, and logs every run + score to [Langfuse](https://langfuse.com)
so you get traces, comparisons, and dashboards without building your own UI.

## How it works

```
src/
  instrumentation.js   Boots the Langfuse OpenTelemetry span processor (import first)
  groqClient.js         Thin wrapper around Groq's OpenAI-compatible chat completions API
  models.js              Models under test (edit this)
  dataset.js              Prompt + judging criteria pairs (edit this)
  judge.js                LLM-as-judge: scores each output 1-5 against the criteria
  runEval.js              Orchestrates: for each model x each dataset item, run + score + log
```

For every `(model, dataset item)` pair, `runEval.js`:
1. Opens a Langfuse trace/span.
2. Calls Groq with the prompt, logged as a `generation` observation (model, input, output, token usage).
3. Calls the judge model (also via Groq) to score the output 1-5 against the item's criteria.
4. Attaches the score to the trace via `langfuse.score.create(...)`.
5. Prints a summary table, including average score per model.

Open your Langfuse project afterwards to see traces per run and compare models/scores in the UI.

## Setup

```bash
npm install
cp .env.example .env
```

Fill in `.env`:

```
GROQ_API_KEY=...            # https://console.groq.com/keys
LANGFUSE_PUBLIC_KEY=...     # Langfuse project settings
LANGFUSE_SECRET_KEY=...
LANGFUSE_BASE_URL=https://cloud.langfuse.com   # or your self-hosted URL
JUDGE_MODEL=llama-3.3-70b-versatile             # optional, any Groq model id
```

## Configure your eval

- **Models to compare** — edit `src/models.js`.
- **Prompts and pass/fail criteria** — edit `src/dataset.js`. Each item is
  `{ id, input, criteria }`; `criteria` is plain English describing what a
  good response looks like, which the judge model uses to score.

## Run

```bash
npm run eval
```

Console output looks like:

```
Running qwen/qwen3.6-27b on "fib-ocaml"...
Running qwen/qwen3.6-27b on "capital-of-france"...
Running qwen/qwen3.6-27b on "sum-list-python"...

=== Eval Summary ===
[qwen/qwen3.6-27b] fib-ocaml: score=5/5 - Provides correct, idiomatic OCaml...
[qwen/qwen3.6-27b] capital-of-france: score=5/5 - Correctly states Paris...
[qwen/qwen3.6-27b] sum-list-python: score=4/5 - Works but not idiomatic...

=== Average score by model ===
qwen/qwen3.6-27b: 4.67/5 (n=3)
```

Then check your Langfuse project's Traces view (filter by trace name prefix
`eval:`) to inspect individual runs, and the Scores view to compare
`llm-judge-score` across models.

## Notes / next steps

- The judge currently reuses Groq for convenience. Swap `JUDGE_MODEL`, or
  point `judge.js` at a different provider entirely, if you want a
  stronger/independent judge than the models under test.
- Scores are numeric (1-5) LLM-judge scores. You can add deterministic
  scorers (exact match, regex, JSON schema validation, etc.) the same way —
  compute a value and call `langfuse.score.create(...)` with the trace id.
- Langfuse's own [Datasets](https://langfuse.com/docs/evaluation/dataset-runs)
  feature can replace `src/dataset.js` once you outgrow a hardcoded array —
  useful if you want to manage the eval set from the Langfuse UI instead of code.
