// A complex image-analysis dataset: the model must return a single structured
// JSON object describing what it sees.
//
// This is the "real photo from disk" variant of the image dataset. The image is
// a 1920x1080 JPEG (~548 KB, ~731 KB once base64-encoded), so it is read from
// src/assets/images/ at runtime rather than inlined as a base64 literal -- an
// inline literal would make this file a ~730 KB unreadable diff.
//
// The prompt itself lives in `complex_prompt.md`, which is a captured Ollama
// request in JSON form. `loadPromptRequest` maps it onto the OpenAI-compatible
// shape this harness speaks (schema -> response_format, num_predict ->
// max_completion_tokens). See ../../README.md#complex-image-dataset.

import { loadPromptRequest, toResponseFormat } from "../promptRequest.js";
import { imageDataUrl, describeDataUrl } from "../images.js";

export const id = "complex-image";

const IMAGE_PATH = "src/assets/images/complex-test.jpg";

const request = loadPromptRequest("src/datasets/complex_prompt.md");

// Diagnostics are collected rather than logged at import time: runEval imports
// every dataset module up front, so printing here would nag on every unrelated
// run. main() prints these only if this dataset is the one selected.
export const notes = [];

// The captured request references an absolute path from the machine it was
// exported on. We deliberately ignore it and use the repo's own copy of the
// image: a dataset that only runs on one laptop is not a dataset.
for (const referenced of request.referencedImages) {
  if (referenced !== "(inline data URL)") {
    notes.push(
      `complex_prompt.md references an external image (${referenced}); using the repo copy at ${IMAGE_PATH} instead.`
    );
  }
}

for (const warning of request.warnings) {
  notes.push(warning);
}

const image = imageDataUrl(IMAGE_PATH);

const criteria =
  `The response must be a single JSON object with no Markdown fences and no prose ` +
  `outside it. It must contain every field the prompt demands: ` +
  `summary, visible_posture (with stance, weight_distribution, foot_position, ` +
  `leg_position, torso_alignment, head_and_gaze, left_arm_and_hand, ` +
  `right_arm_and_hand, overall_alignment), visible_movement (direction, ` +
  `weight_shift, stepping_motion, arm_motion, hand_motion, torso_motion, ` +
  `likely_phase), taiji_context (possible_posture_or_transition, apparent_intent, ` +
  `technical_points), limitations and confidence. ` +
  `Descriptions must be limited to what is visibly supported by the frame, must ` +
  `not invent movement direction from a single still image, and must not name a ` +
  `specific Tai Chi posture unless it is clearly recognisable. Undeterminable ` +
  `details belong in limitations.`;

export const dataset = [
  {
    id: "taiji-frame-1",
    input: request.prompt,
    criteria,
    image,
    // Applied to every model call for this item; see runEval.js.
    options: request.options,
    // Turns the prompt's schema into an OpenAI response_format, and enables the
    // deterministic `json-schema-valid` score alongside the LLM judge.
    responseFormat: toResponseFormat(request.schema),
    scoreSchema: request.schema,
  },
];

// Exported for the startup summary line and for tests.
export const IMAGE_INFO = {
  path: IMAGE_PATH,
  encodedSize: describeDataUrl(image),
};

notes.push(`1 case, image ${IMAGE_PATH} (${IMAGE_INFO.encodedSize} base64-encoded).`);

// The captured prompt asks for num_predict=8192. Against a smaller context
// window Ollama silently clamps it, and a verbose model then gets cut off
// mid-JSON -- which looks like a wrong answer rather than a config problem.
// Measured on this machine: a 1920x1080 image costs ~2.3k prompt tokens, so
// 8192 output tokens needs >10k of context.
if (request.options.max_completion_tokens >= 8192) {
  notes.push(
    `the prompt requests num_predict=${request.options.max_completion_tokens}, which needs ` +
      `more context than a default 8k window once the image is tokenized (~2.3k tokens for ` +
      `a 1920x1080 image). If responses come back cut off, raise OLLAMA_CONTEXT_LENGTH ` +
      `(currently ${process.env.OLLAMA_CONTEXT_LENGTH ?? "unset"}) or lower num_predict in ` +
      `complex_prompt.md. Cut-off responses are reported separately in the summary.`
  );
}