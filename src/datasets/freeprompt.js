// A dataset mirroring the freeprompt app's image-classification prompt, so the
// same prompt can be scored across the models this harness compares, with
// traces landing in the "freeprompt" Langfuse project.
//
// The prompt and its expected output shape come from
// ../freeprompt/netlify/functions/prompts.ts (VISION_PROMPTS[0]).

import { imageDataUrl } from "../images.js";

export const id = "freeprompt";

const IMAGE_PATH = "src/assets/images/complex-test.jpg";
const image = imageDataUrl(IMAGE_PATH);

const input =
  "Describe the image in 1-2 sentences, then add the possible categories for " +
  "this image below the description. To complete add the palette of most used " +
  "colors in the image (max 5). Description, categories and palette colors " +
  "should be separated by 2 newlines, colors should be separated by a comma.";

const criteria =
  "The response must follow the requested three-part layout: a 1-2 sentence " +
  "description, then the possible categories, then a palette of at most 5 " +
  "colors written as hex codes (e.g. #DAA520), with the three parts separated " +
  "by two newlines. The description must match what is actually in the image, " +
  "the categories must be plausible for the image, and every color must be a " +
  "valid 6-digit hex code. Extra prose outside this layout is not allowed.";

export const dataset = [
  {
    id: "complex-test-image",
    input,
    criteria,
    image,
  },
];
