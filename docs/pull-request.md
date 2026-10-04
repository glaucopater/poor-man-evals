# Fix judge-failure data loss, silent 0 scores, and Retry-After backoff

## Summary

A review of the harness found four correctness bugs. Two of them silently corrupt eval results, which is why this isn't just a cleanup PR.

| # | Bug | Impact |
|---|-----|--------|
| 1 | A judge failure aborted the whole run | All spans discarded |
| 2 | Unparseable judge output scored as `0` | Fake scores in averages |
| 3 | `Retry-After` date form → `NaN` backoff | Rate-limit retries fired instantly |
| 4 | `--dataset` with no value | `Unknown dataset "undefined"` |

### 1. A judge failure aborted the run and discarded every span

Model-call errors were caught per item; `judgeOutput` was not. A 429 that exhausted retries rejected out of `runOne`, escaped `main()`, and skipped `flush()` / `forceFlush()` — dropping up to 50 already-completed generations on the floor.

The model under test did its job; only the scorer failed. Judge calls now go through `runJudge()`, which turns a call failure into an unscored result, and the per-item loop has a last-resort `try/catch` so no single throw can take out the rest of the run.

### 2. Unparseable judge output was recorded as a score of `0`

```js
value: judged.score ?? 0   // parse failure == "the model was terrible"
```

Indistinguishable from a genuinely bad answer in both the Langfuse Scores view and the harness's own average. `buildJudgeScore()` now writes those under a separate categorical `llm-judge-error` score; the summary prints them as `UNSCORED`, reports the count, and excludes them from the averages with a visible note instead of silently.

### 3. `Retry-After` in HTTP-date form silently disabled the backoff

RFC 9110 allows delay-seconds *and* an HTTP-date, but `Number(header) * 1000` yields `NaN` for the date form — so the backoff sleep became a no-op at exactly the moment the provider asked us to wait.

### 4. `--dataset` with no value

Reported `Unknown dataset "undefined"`. Now says the flag requires a value and lists the available ids.

## Also included

- **`src/throttle.js`** — the throttle/retry logic duplicated across `groqClient.js` and `nvidiaClient.js` now lives in one place, so a backoff fix lands once instead of twice. It also retries transport errors (`ECONNRESET` and friends), which previously aborted the run outright, and validates its config — fixing `GROQ_MAX_RETRIES=abc` silently turning the retry loop into a no-op.
- **`src/content.js`** — `message.content` is not reliably a string: reasoning models like `gpt-oss` can return `null`, multimodal responses return an array of parts. Normalizing keeps the judge from degrading to "failed to parse" on responses that are actually fine.
- **Flush in a `finally`** so a mid-run crash still ships the traces collected so far.
- **`openai/gpt-oss-safeguard-20b` removed** from `MODELS_UNDER_TEST` — it's a content-moderation classifier with no chat completions API, so every text run 400'd on it. Moved to the reference list at the bottom of `models.js`.
- **README** — fixed the stale `qwen/qwen3.6-27b` id in the sample output; documented that the judge never sees the image, so vision scores grade the model's *description* rather than its reading of the pixels.

## Tests

New unit suite using Node's built-in runner — no new dependencies, no API keys (`test/helpers/env.mjs` sets placeholders and every test stubs `globalThis.fetch`). Covers `Retry-After` parsing, env coercion, retry exhaustion, judge JSON parsing and score construction.

`scripts/verify-langfuse-v5.mjs` gains a second end-to-end scenario where **every** judge response is unparseable, asserting the run still completes and still exports all three traces.

```
yarn test              → 22 passing
yarn verify:langfuse   → 36 passing  (was 29)
yarn check             → both
```

Happy-path trace payloads are unchanged; the only difference on the success path is that a healthy item no longer has its span level written at all.
---

## Also in this branch

### 2. Local Ollama provider + clients moved to `src/providers/`

`groqClient.js`, `nvidiaClient.js`, `ollamaClient.js` plus the shared `throttle.js`
and `content.js` now live in `src/providers/`. Ollama targets the **native**
`/api/chat` API, not the OpenAI-compat shim, because native is a superset here:
`format` takes a full JSON Schema (the shim only guarantees `json_object`), and
`think` / `repeat_penalty` exist at all. Two details that fail opaquely if wrong:
Ollama wants images as *bare* base64 in `images[]` (not an `image_url` data URL),
and its response is `{message:{}}`, not `{choices:[{message}]}` — the shared
normalizer only understood the latter, so every local response graded as empty.

The complex-image dataset runs local models first, then hosted, and truncation is
tracked via Ollama's `done_reason` so a response cut off mid-JSON is reported as a
config problem rather than a wrong answer.

### 3. The judge must not think out loud

Running locally, every item scored `UNSCORED`. "Just use a bigger judge" was tried
and is **not** the fix — measured with the real judge prompt at 1000 tokens:

| judge | thinking | tokens | verdict |
|---|---|---|---|
| `gemma4:12b` | on | 1000 (all of it) | unparseable |
| `gemma4:12b` | off | 39 | valid, score 5 |
| `qwen3.8:27b` | on | 845 | valid, score 3 |
| `qwen3.8:27b` | off | 62 | valid, score 4 |

The cause was a 300-token budget in `judge.js`: thinking models spend it
reasoning out loud, get truncated at `length`, and truncated text is not
parseable JSON. The judge now sends `think: false` where supported, and the
budget is configurable (`JUDGE_MAX_COMPLETION_TOKENS`, default 512). A truncated
judge is reported distinctly from an unparseable one — they have different fixes,
and conflating them sent me looking at the wrong thing entirely.

### 4. Validated YAML config with named profiles

`.env` had grown to 25 settings and two definitions of `JUDGE_MODEL` had drifted
into a state where the later one silently won. It was also silently permissive:
a mistyped key is read, ignored, and reported nowhere.

- `.env` — credentials only (4 keys), gitignored
- `eval.config.yaml` — settings and profiles, gitignored
- `eval.config.example.yaml` — documented template, committed

The payoff is validation, not the nesting — an unknown key is now a hard error:

```
Invalid config at "eval.config.yaml.providers.groq": unknown key
"max_retrries". (did you mean "max_retries"?) Known keys: ...
```

Named profiles address the real pain (a three-variable incantation to switch
between hosted and local): `yarn eval:complex --profile local`.

Precedence is defaults < file < `--profile` < real environment variables, so
`ENABLED_PROVIDERS=ollama yarn eval` still overrides. `src/config.js` still
projects into `process.env` and nothing else changed — deliberate, because
`new LangfuseClient()` takes no arguments and the SDK reads its keys from there.

---

## Test totals

| Suite | Before | After |
|---|---|---|
| `yarn test` | — | **96** passing (config, throttle, judge, schema, provider translations) |
| `yarn verify:langfuse` | 29 | **50** passing (3 scenarios: healthy, judge failure, complex-image) |

Verified end to end against the real local runtime: `qwen3-vl:2b` under test,
`qwen3.8:27b` judging, real 1920x1080 image → `llm-judge-score=4`,
`json-schema-valid=1`, `response-truncated=0`.
