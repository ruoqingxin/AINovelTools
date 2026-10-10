import assert from "node:assert/strict";
import { test } from "node:test";
import { assertNoDrift, contractSchema, prefixDefinitions, renderTypes, transformSchema } from "./generate-ipc-types.mjs";

const ref = (name) => ({ $ref: `#/definitions/${name}` });
const object = (properties, required = Object.keys(properties), definitions = {}) => ({
  type: "object", properties, required, additionalProperties: false, definitions,
});
const fixture = {
  requests: object({ save: ref("Args_save") }, ["save"], {
    Args_save: object({ input: ref("Example"), expectedVersion: { type: "integer" } }),
    Example: object({
      title: { type: "string" },
      default: { type: "string" },
      note: { type: ["string", "null"], default: null },
    }, ["title", "default"]),
  }),
  responses: object({ save: ref("Example") }, ["save"], {
    Example: object({
      title: { type: "string" },
      default: { type: "string" },
      note: { type: ["string", "null"] },
      payload: true,
    }),
    Kind: { type: "string", enum: ["PENDING_REVIEW", "NEEDS_INPUT"] },
  }),
  errors: object({ save: { type: "string" } }),
  events: object({ chunk: object({ taskId: { type: "string" }, chunk: { type: "string" } }) }),
};

test("input references are namespaced without mutating the Rust schema", () => {
  const before = structuredClone(fixture.requests);
  const prefixed = prefixDefinitions(fixture.requests, "Input");
  assert.deepEqual(fixture.requests, before);
  assert.equal(prefixed.properties.save.$ref, "#/definitions/InputArgs_save");
  assert.equal(prefixed.definitions.InputArgs_save.properties.input.$ref, "#/definitions/InputExample");
});

test("schema metadata transformation preserves actual title/default fields and JSON examples", () => {
  const schema = object({ title: { type: "string" }, default: { type: "string" } });
  schema.default = { title: "data", default: "data", $ref: "not a schema reference" };
  const copy = transformSchema(schema, (node) => { delete node.title; });
  assert.ok(copy.properties.title);
  assert.ok(copy.properties.default);
  assert.deepEqual(copy.default, schema.default);
});

test("contracts retain requiredness, enum values and both schema directions", () => {
  const schema = contractSchema(fixture);
  assert.ok(schema.definitions.InputExample.properties.title);
  assert.ok(schema.definitions.InputExample.properties.default);
  assert.deepEqual(schema.definitions.InputExample.required, ["title", "default"]);
  assert.ok(schema.definitions.Example.required.includes("note"));
  assert.deepEqual(schema.definitions.Kind.enum, ["PENDING_REVIEW", "NEEDS_INPUT"]);
});

test("TypeScript generation is deterministic and preserves nullable/optional/unknown distinctions", async () => {
  const first = await renderTypes(fixture);
  assert.equal(first, await renderTypes(fixture));
  assert.match(first, /export type InputExample =/);
  assert.match(first, /note\?: string \| null/);
  assert.match(first, /note: string \| null/);
  assert.match(first, /expectedVersion: number/);
  assert.match(first, /payload: unknown/);
  assert.match(first, /"PENDING_REVIEW" \| "NEEDS_INPUT"/);
  assert.doesNotMatch(first, /\bany\b/);
});

test("drift gate fails on edited fields or absent generated output", async () => {
  const expected = await renderTypes(fixture);
  assertNoDrift(expected, expected);
  assert.throws(() => assertNoDrift(expected.replace("expectedVersion: number", "expectedVersion?: number"), expected), /have drifted/);
  assert.throws(() => assertNoDrift("", expected), /have drifted/);
});

test("fixed Rust arrays remain tuples rather than literal values or unbounded arrays", async () => {
  const contract = structuredClone(fixture);
  contract.responses.definitions.Tuple = { type: "array", items: { type: "string" }, minItems: 3, maxItems: 3 };
  const result = await renderTypes(contract);
  assert.match(result, /export type Tuple = \[\s*string,\s*string,\s*string\s*\]/);
});
