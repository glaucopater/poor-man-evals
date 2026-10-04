# poor-man-evals

A minimal LLM eval harness. Runs a prompt dataset against a list of models
hosted on [Groq](https://groq.com) and [NVIDIA NIM](https://build.nvidia.com),
scores each output with an LLM-as-judge, and logs every run + score to
[Langfuse](https://langfuse.com) so you get traces, comparisons, and dashboards
without building your own UI.


![Summary in CLI](docs/demo-1.png)

![Traces on LangFuse](docs/demo-2.png)


## How it works

```
src/
  instrumentation.js   Boots the Langfuse OpenTelemetry span processor (import first)
  datasets/text.js        Text prompts + judging criteria (edit this)
  datasets/image.js       Image prompts (base64 data URLs) + criteria (edit this)
  datasets/complex_prompt.md  Captured model request (JSON), see promptRequest.js
  datasets/complex-image.js   Long prompt over an on-disk image, schema-scored
  images.js               Reads a binary image from disk into a base64 data URL
  jsonSchema.js           Dependency-free JSON Schema validator (deterministic scorer)
  promptRequest.js        Maps a captured model request onto provider parameters
  judge.js                LLM-as-judge: scores each output 1-5 against the criteria
  runEval.js              Orchestrates: for each model x each dataset item, run + score + log
  providers/              One folder per provider backend
    index.js                Registry: name -> client, plus param-name translation
    groq.js                 Groq chat completions
    nvidia.js               NVIDIA NIM chat completions
    ollama.js               Local Ollama, via its NATIVE /api/chat API
    http.js                 Shared throttle + 429/transport retry
    content.js              Normalizes a response body into plain assistant text
test/                     Unit tests (node --test), no provider calls
scripts/                  verify-langfuse-v5.mjs: end-to-end check against a mock Langfuse
```

For every `(model, dataset item)` pair, `runEval.js`:
1. Applies the run's correlating attributes (`traceName`, `sessionId`, `tags`, `metadata`) with `propagateAttributes(...)`, then opens the trace's root observation. Langfuse v5 is observations-first, so these attributes land on the root *and* on every child observation.
2. Calls the model's provider with the prompt, logged as a `generation` observation (model, input, output, token usage). Because the generation inherits the session id, per-session cost aggregation works.
3. Calls the judge model to score the output 1-5 against the item's criteria.
4. Attaches the score to the generation observation via `langfuse.score.observation(...)` (observation-level scores are what v4 evaluators target).
5. Prints a summary table, including average score per model.

Failures are scoped per item and never abort the run: a model error or a judge
error marks just that item and the loop continues. If the judge cannot produce a
verdict (call failed, or unparseable JSON), the item is recorded as **UNSCORED**
under a separate `llm-judge-error` score and excluded from the averages, rather
than being written as a numeric `0` — which would be indistinguishable from a
genuinely bad model answer. Spans and scores are flushed in a `finally`, so even
a mid-run crash ships the traces collected so far.

Open your Langfuse project afterwards to see traces per run and compare models/scores in the UI.

Each run gets one generated session id (printed as `Langfuse session: ...`), so a run's traces group together in the Sessions view.

## Langfuse version

This project targets **Langfuse v4** with **JS/TS SDK v5+** (`@langfuse/*` `^5.11.1`), which requires **Node 20+**.

Notable v4/v5 behaviours this code relies on:

- Spans are exported over OTLP/HTTP to `/api/public/otel/v1/traces` (the v4 ingestion path) by `LangfuseSpanProcessor`.
- v5 applies a smart default span filter. Every span here is created by the Langfuse SDK, so the whole trace tree is exported; pass `shouldExportSpan: () => true` to `LangfuseSpanProcessor` in `src/instrumentation.js` if you later add non-Langfuse spans.
- Trace-level attributes are set with `propagateAttributes(...)` (the v5 replacement for `updateActiveTrace()`), and propagated `metadata` must be `Record<string, string>` with values <= 200 chars — which is why the (long) judging criteria live in the root observation's input.
- `environment` / `release` come from `LANGFUSE_TRACING_ENVIRONMENT` / `LANGFUSE_RELEASE`. `src/instrumentation.js` defaults the environment to `NODE_ENV`. This matters: the score writer reads the same variable, so traces and their scores stay in one environment.
- Base64 images in image cases are uploaded as Langfuse media and replaced with a media reference in span payloads.

Run `yarn verify:langfuse` to check all of the above against a local mock endpoint (no provider calls, no writes to your project).

## Setup

```bash
yarn install        # Node 20+
cp .env.example .env
```

Fill in `.env`:

```
GROQ_API_KEY=...            # https://console.groq.com/keys
NVIDIA_API_KEY=...          # https://build.nvidia.com (only needed for provider: "nvidia" models)
OLLAMA_BASE_URL=http://localhost:11434   # no key needed; must be running (`ollama serve`)
LANGFUSE_PUBLIC_KEY=...     # Langfuse project settings
LANGFUSE_SECRET_KEY=...
LANGFUSE_BASE_URL=https://cloud.langfuse.com   # or your self-hosted v4 URL
LANGFUSE_TRACING_ENVIRONMENT=development        # optional; defaults to NODE_ENV
JUDGE_MODEL=llama-3.3-70b-versatile             # optional, any chat model id
JUDGE_PROVIDER=groq                             # optional, "groq", "nvidia" or "ollama"
```

## Configure your eval

- **Models to compare** — edit `src/models.js`. Each entry is
  `{ id, provider }`, where `provider` is `"groq"`, `"nvidia"` or `"ollama"`. A
  bare string still works and defaults to Groq. `MODELS_UNDER_TEST` drives the
  text dataset; `VISION_MODELS` (hosted) and `LOCAL_VISION_MODELS` (Ollama)
  drive the image datasets.
- **Prompts and pass/fail criteria** — edit `src/datasets/text.js` and
  `src/datasets/image.js`. Each item is `{ id, input, criteria }` (`image` items
  add a base64 `image` data URL); `criteria` is plain English describing what a
  good response looks like, which the judge model uses to score.
- **Adding a provider** — drop a module in `src/providers/` exposing `callX` and
  `listXModelIds`, then add one entry to `PROVIDERS` and one line to
  `SUPPORTED_PARAMS` in `src/providers/index.js`. Nothing else needs to change.
- **Turning a provider off** — set `ENABLED_PROVIDERS=groq` in `.env` (comma
  separated for several). Models stay in `src/models.js`; the harness just skips
  them and reports which providers it skipped.

## Images on disk

`src/datasets/image.js` inlines its base64 as a string literal, which is fine for
a 20 KB test pattern and terrible for a real photo. For anything larger, put the
binary in `src/assets/images/` and let the dataset read it:

```js
import { imageDataUrl } from "../images.js";

export const dataset = [
  {
    id: "taiji-frame-1",
    input: "Describe what you see.",
    criteria: "...",
    image: imageDataUrl("src/assets/images/complex-test.jpg"),
  },
];
```

`imageDataUrl` reads the binary and returns a `data:image/jpeg;base64,...` URL —
exactly what the `image_url` content part wants. Paths resolve against the repo
root (not `process.cwd()`), so the behaviour doesn't depend on where you run
`yarn` from. Pass `{ maxBytes }` to fail early and legibly on an oversized image;
base64 inflates by ~33%, and the resulting provider-side rejection is otherwise
opaque. **The harness does not resize or compress** — do that upstream if a model
rejects the payload.

## Running against local Ollama

Set `ENABLED_PROVIDERS=ollama` and the harness talks to your local server
instead of a hosted API. No key, no rate limit, no cost — which makes local
models a good baseline to compare hosted ones against.

```bash
# fully local, zero-cost: no Groq or NVIDIA call at all
ENABLED_PROVIDERS=ollama JUDGE_PROVIDER=ollama JUDGE_MODEL=qwen3-vl:2b yarn eval:complex
```

Ollama needs to be running (`ollama serve`) with the models in
`src/models.js` pulled; `ollama list` is the source of truth for the ids. If one
isn't pulled, the startup check fails fast and prints your local catalog.

The client deliberately targets Ollama's **native `/api/chat` API**, not its
`/v1` OpenAI-compatibility shim, because the native API is a superset for what
a structured vision eval needs:

| Capability | Ollama native | Groq / NVIDIA |
|---|---|---|
| `format` = full JSON Schema | yes | `{type: "json_object"}` only |
| `think` switch | yes | no |
| `options.repeat_penalty` | yes | no |
| Images | bare base64 in `images[]` | `image_url` content part |

All of that translation lives in `src/providers/ollama.js`; nothing else in the
harness knows Ollama has a different request format.

**Local models and truncation.** Ollama silently clamps `num_predict` to fit the
context window. A 1920x1080 image costs roughly 2.3k prompt tokens, so the
captured prompt's `num_predict: 8192` needs more than 10k of context — against a
default 8k window a verbose model gets cut off **mid-JSON**, which looks like a
wrong answer rather than a config problem. The client therefore reads Ollama's
`done_reason` and records a separate `response-truncated` score, and the summary
lists cut-off items on their own:

```
=== Truncated responses ===
  - qwen3-vl:2b (ollama) on "taiji-frame-1"
```

Raise `OLLAMA_CONTEXT_LENGTH`, or lower `num_predict` in `complex_prompt.md`, if
you see that section.

## Complex image dataset

`yarn eval:complex` runs the `complex-image` dataset: a single 1920x1080 JPEG
read from disk, with a long prompt that demands one compact JSON object back.

Two things distinguish it from `yarn eval:image`:

**The prompt is a captured request.** `src/datasets/complex_prompt.md` is a real
request exported from Ollama — which is why it's JSON despite the `.md`
extension. `src/promptRequest.js` maps Ollama's vocabulary onto the
OpenAI-compatible shape the harness speaks:

| Ollama | Mapped to |
|---|---|
| `format` (JSON Schema) | `response_format: { type: "json_schema", ... }` |
| `options.num_predict` | `max_completion_tokens` |
| `options.temperature` | `temperature` |
| `messages[].images[]` | an OpenAI `image_url` content part |
| `options.repeat_penalty` | forwarded; **only Ollama applies it** |
| `think` | forwarded; **only Ollama applies it** |

Anything a given provider can't honour is reported on startup rather than
silently ignored: a silently-dropped `num_predict` otherwise surfaces much later
as a mysteriously truncated eval. `SUPPORTED_PARAMS` in
`src/providers/index.js` lists what each provider implements, and the registry
warns once per run when a dataset hands a provider something it can't use.

The captured request references an image by absolute path from the machine it was
exported on. The dataset ignores it and uses the repo's own copy, so it runs
anywhere.

**It gets a deterministic score, not just a judge score.** When the prompt pins
down an exact output shape, "are the braces right and is every required field
present?" is an objective question, and an LLM judge is the wrong instrument for
it — judges read prose and hand a 4/5 to a malformed object. So alongside
`llm-judge-score`, every item with a schema also gets `json-schema-valid` (1/0)
from the dependency-free validator in `src/jsonSchema.js`, and the summary prints
a separate section for it:

```
=== JSON schema validity (deterministic) ===
qwen/qwen3.8-27b (groq): 1/1 responses conform
```

To add a deterministic scorer to your own dataset, set `scoreSchema` on the item
and attach `responseFormat: toResponseFormat(yourSchema)`.

## Run

```bash
yarn eval          # text dataset (default)
yarn eval:text     # text dataset
yarn eval:image    # image dataset (VISION_MODELS only)
yarn eval:complex  # complex-image dataset (VISION_MODELS only)
```

To run every dataset in one go: `yarn eval:text && yarn eval:image && yarn eval:complex`.

Console output looks like:

```
Running qwen/qwen3.8-27b (groq) on "fib-ocaml"...
Running qwen3-vl:2b (ollama) on "fib-ocaml"...
Running qwen/qwen3.8-27b (groq) on "capital-of-france"...

=== Eval Summary ===
[qwen/qwen3.8-27b (groq)] fib-ocaml: score=5/5 - Provides correct, idiomatic OCaml...
[qwen3-vl:2b (ollama)] fib-ocaml: score=4/5 - Recursive but no memoization...
[qwen/qwen3.8-27b (groq)] capital-of-france: score=5/5 - Correctly states Paris...

=== Average score by model ===
qwen/qwen3.8-27b (groq): 4.67/5 (n=3)
qwen3-vl:2b (ollama): 4.00/5 (n=3)
```

Then check your Langfuse project's Traces view (filter by trace name prefix
`eval:`) to inspect individual runs, and the Scores view to compare
`llm-judge-score` across models.

## Rate limits

Groq's free tier is strict — some models allow as few as 10-30 requests per
minute, and token-per-minute caps as low as ~1.2K-8K depending on the model
(check current limits at https://console.groq.com/docs/rate-limits or your
console's Limits page). NVIDIA NIM limits vary by plan and model. Since this
harness makes one completion call + one judge call per dataset item, it's easy
to hit a 429 once you scale up models or the dataset.

To handle this, each client shares the throttle in
`src/providers/http.js`:
- Waits at least `GROQ_MIN_REQUEST_INTERVAL_MS` / `NVIDIA_MIN_REQUEST_INTERVAL_MS`
  (default 2200ms each) between every request to that provider, including judge calls.
- On a 429, retries with exponential backoff (honoring the `Retry-After`
  header when the provider sends one — both the delay-seconds and the
  HTTP-date form) up to `GROQ_MAX_RETRIES` / `NVIDIA_MAX_RETRIES` times
  (default 5).
- Retries dropped connections (`ECONNRESET` etc.) on the same backoff, so a
  single network blip doesn't kill the run.
- Non-numeric values in these env vars fall back to the defaults instead of
  becoming `NaN`.

If you're still getting rate limited, either raise the relevant
`*_MIN_REQUEST_INTERVAL_MS` in `.env`, trim `src/models.js` / the dataset, or
move to a paid tier and lower the interval.

## Tests

```bash
yarn test              # unit tests: throttle/backoff, judge parsing, score building
yarn verify:langfuse   # end-to-end against a mock Langfuse server (no provider calls)
yarn check             # both
```

`yarn test` needs no API keys: `test/helpers/env.mjs` sets placeholder
credentials and every test stubs `globalThis.fetch`. `yarn verify:langfuse` runs
three scenarios — a healthy judge, a judge returning unparseable output, and the
complex-image dataset with its binary image and structured output — asserting on
the HTTP traffic that actually left the process, including that a total judge
failure still exports every trace.

## Troubleshooting

**NVIDIA: every model errors with `403 ... "detail":"Authorization failed"`**

This is an NVIDIA account entitlement problem, not a harness or model-id problem.
Your key can list models but not run inference. Note that NVIDIA's `GET /v1/models`
returns 200 **even with no `Authorization` header at all**, so a working model list
proves nothing — which is why the startup check also does a real 1-token
completion probe per provider.

The usual cause is a missing **"Public API Endpoints"** permission on your
personal NVIDIA organization. Request enablement on the
[NVIDIA developer forums](https://forums.developer.nvidia.com/t/383161), or use an
NVIDIA AI Enterprise org / self-hosted NIM container. Alternative: authenticate
via NVCF (`api.nvcf.nvidia.com`) with an NGC key.

Meanwhile, take NVIDIA out of the run without touching `src/models.js` by setting
`ENABLED_PROVIDERS=groq` in `.env`. Re-add `nvidia` once your key works.

**`Unknown dataset "..."`** — the id must match a `dataset id` export in
`src/datasets/`. Run `yarn eval:text`, `yarn eval:image` or `yarn eval:complex`.
Note that `node src/runEval.js --dataset` with no value exits immediately instead
of reporting `Unknown dataset "undefined"`.

**A vision model rejects the image** — check the payload size first. The
complex-image case sends ~731 KB of base64 for one 1920x1080 JPEG. Some gateways
cap request bodies and some vision models cap image dimensions, and the error may
just say "invalid image". Downscale or re-encode as JPEG quality ~80 and re-run;
`imageDataUrl(path, { maxBytes })` will at least fail early with the real number.

## Known limitations

- **The judge never sees the image.** Image items are scored from the model's
  *text* answer only — `judgeOutput` receives the prompt, the response and the
  criteria, but not the base64 image. Vision scores are therefore grades on the
  model's description, not on whether it read the image correctly. Pointing the
  judge at a vision-capable model and forwarding `item.image` is the fix if that
  matters for your eval.

## Notes / next steps

- The judge reuses Groq by default for convenience, but is provider-aware:
  set `JUDGE_PROVIDER=nvidia` (plus a matching `JUDGE_MODEL`) to run it on
  NVIDIA NIM, or point `judge.js` at a different provider entirely if you want a
  stronger judge than the models under test.
- Scores are numeric (1-5) LLM-judge scores attached to the generation
  observation. You can add deterministic scorers (exact match, regex, JSON
  schema validation, etc.) the same way — compute a value and call
  `langfuse.score.observation({ otelSpan }, ...)` with the observation you want
  to score.
- Langfuse's own [Datasets](https://langfuse.com/docs/evaluation/dataset-runs)
  feature can replace the arrays in `src/datasets/` once you outgrow them —
  useful if you want to manage the eval set from the Langfuse UI instead of code.
- Project-side v4 checks that still need a human: the **Evaluators** tab
  (legacy trace-level rules) and **Project Settings > Integrations** (blob
  storage / PostHog / Mixpanel exports). Both were empty when checked via the
  API, but the API does not expose every legacy target, so confirm in the UI
  before the v4 cutover.
