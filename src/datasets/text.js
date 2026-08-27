// Each item is a single eval case: a prompt sent to every model under test,
// plus the criteria the judge model uses to score the response.
export const dataset = [
  {
    id: "fib-ocaml",
    input: "Generate a fibonacci function in OCaml.",
    criteria:
      "The response must contain syntactically valid OCaml code that defines a function computing Fibonacci numbers, with correct logic (recursive or iterative).",
  },
  {
    id: "capital-of-france",
    input: "What is the capital of France?",
    criteria: "The response must clearly and correctly state that Paris is the capital of France.",
  },
  {
    id: "sum-list-python",
    input: "Write a Python function that sums a list of integers.",
    criteria:
      "The response must contain a correct, idiomatic Python function that returns the sum of a list of integers.",
  },
];
