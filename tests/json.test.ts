import { expect, it } from "vitest";
import { parseStrictJson } from "../src/json.js";

it("rejects duplicate wire keys including escaped keys and nested arrays", () => {
  for (const text of [
    '{"verdict":"reject","verdict":"accept"}',
    '{"verdict":"reject","ver\\u0064ict":"accept"}',
    '{"reports":[{"resultSha":"old","resultSha":"new"}]}',
  ])
    expect(() => parseStrictJson(text)).toThrow("Duplicate JSON keys");
});
it("preserves separate object keys and JSON-looking string values", () => {
  const input = {
    reports: [{ verdict: "accept" }, { verdict: "reject" }],
    text: '{"a":1,"a":2}',
    count: 2,
  };
  expect(parseStrictJson(JSON.stringify(input))).toEqual(input);
  expect(() => parseStrictJson('{"a":1,}')).toThrow("Invalid JSON");
});

it("rejects valid JSON numbers that overflow finite numeric contracts", () => {
  expect(() => parseStrictJson('{"costUsd":1e400}')).toThrow("Invalid JSON");
});
