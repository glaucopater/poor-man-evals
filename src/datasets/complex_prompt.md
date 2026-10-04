{
  "model": "qwen3-vl:2b",
  "think": false,
  "stream": false,
  "format": {
    "type": "object",
    "properties": {
      "summary": { "type": "string" },
      "visible_posture": {
        "type": "object",
        "properties": {
          "stance": { "type": "string" },
          "weight_distribution": { "type": "string" },
          "foot_position": { "type": "string" },
          "leg_position": { "type": "string" },
          "torso_alignment": { "type": "string" },
          "head_and_gaze": { "type": "string" },
          "left_arm_and_hand": { "type": "string" },
          "right_arm_and_hand": { "type": "string" },
          "overall_alignment": { "type": "string" }
        },
        "required": [
          "stance", "weight_distribution", "foot_position", "leg_position",
          "torso_alignment", "head_and_gaze", "left_arm_and_hand",
          "right_arm_and_hand", "overall_alignment"
        ]
      },
      "visible_movement": {
        "type": "object",
        "properties": {
          "direction": { "type": "string" },
          "weight_shift": { "type": "string" },
          "stepping_motion": { "type": "string" },
          "arm_motion": { "type": "string" },
          "hand_motion": { "type": "string" },
          "torso_motion": { "type": "string" },
          "likely_phase": { "type": "string" }
        },
        "required": [
          "direction", "weight_shift", "stepping_motion", "arm_motion",
          "hand_motion", "torso_motion", "likely_phase"
        ]
      },
      "taiji_context": {
        "type": "object",
        "properties": {
          "possible_posture_or_transition": { "type": "string" },
          "apparent_intent": { "type": "string" },
          "technical_points": { "type": "array", "items": { "type": "string" } }
        },
        "required": [
          "possible_posture_or_transition", "apparent_intent", "technical_points"
        ]
      },
      "limitations": { "type": "array", "items": { "type": "string" } },
      "confidence": { "type": "number" }
    },
    "required": [
      "summary", "visible_posture", "visible_movement",
      "taiji_context", "limitations", "confidence"
    ]
  },
  "options": {
    "temperature": 0.8,
    "num_predict": 8192,
    "repeat_penalty": 1.15
  },
  "messages": [
    {
      "role": "user",
      "content": "Return one compact JSON object immediately. Do not think aloud or explain your reasoning. Describe only visible facts in this single image. Use exactly this structure: {\"summary\": string, \"visible_posture\": {\"stance\": string, \"weight_distribution\": string, \"foot_position\": string, \"leg_position\": string, \"torso_alignment\": string, \"head_and_gaze\": string, \"left_arm_and_hand\": string, \"right_arm_and_hand\": string, \"overall_alignment\": string}, \"visible_movement\": {\"direction\": string, \"weight_shift\": string, \"stepping_motion\": string, \"arm_motion\": string, \"hand_motion\": string, \"torso_motion\": string, \"likely_phase\": string}, \"taiji_context\": {\"possible_posture_or_transition\": string, \"apparent_intent\": string, \"technical_points\": [string]}, \"limitations\": [string], \"confidence\": number}. Use short factual phrases, not full sentences. Cover stance, weight, feet, legs, torso, gaze, and both arms/hands. Describe movement only if visible from posture or blur. Do not infer movement direction from one frame. Do not identify a named Tai Chi posture unless clearly visible. If something cannot be determined, say so in that field and list it in limitations. confidence is 0 to 1 for the visible description. Do not repeat observations. Return no Markdown or text outside JSON.",
      "images": [
        "${[ fs.readFile(path=b64'QzpcVXNlcnNcZ2xhdWNcZ2l0aHViXHZpZGVvLXRvLXByYWN0aWNlXHl0XGZyYW1lcy1qcGVnXHlpbHUtMDEtZmlyc3Qtc2VjdGlvblxmcmFtZV8wMDAwMDEuanBn', encoding='base64') ]}"
      ]
    }
  ]
}
