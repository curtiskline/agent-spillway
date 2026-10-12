import { SpillwayError } from "./contracts.js";

/** Reject ambiguous wire JSON before object parsing erases duplicate keys. */
export function parseStrictJson(text: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new SpillwayError("INVALID_JSON", "Invalid JSON.");
  }
  const stack: { object: boolean; keyExpected: boolean; keys: Set<string> }[] =
    [];
  for (const token of text.match(/"(?:\\.|[^"\\])*"|[{}:,]|\[|\]/g) ?? []) {
    if (token === "{" || token === "[")
      stack.push({
        object: token === "{",
        keyExpected: token === "{",
        keys: new Set(),
      });
    else if (token === "}" || token === "]") stack.pop();
    else if (token === ":") {
      const parent = stack.at(-1);
      if (parent?.object) parent.keyExpected = false;
    } else if (token === ",") {
      const parent = stack.at(-1);
      if (parent?.object) parent.keyExpected = true;
    } else {
      const parent = stack.at(-1);
      if (parent?.object && parent.keyExpected) {
        const key = JSON.parse(token) as string;
        if (parent.keys.has(key))
          throw new SpillwayError(
            "INVALID_JSON",
            "Duplicate JSON keys are not allowed.",
          );
        parent.keys.add(key);
      }
    }
  }
  return value;
}
