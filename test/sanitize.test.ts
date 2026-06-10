import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeWritable } from "../src/util.js";

// Security regression tests for the mass-assignment / prototype-pollution guard.
test("strips prototype-pollution keys (own) in both modes", () => {
  for (const mode of ["create", "update"] as const) {
    // JSON.parse creates an OWN, enumerable __proto__ key (the real attack vector).
    const dirty = JSON.parse('{"a":1,"__proto__":{"x":1},"constructor":2,"prototype":3}');
    const out = sanitizeWritable(dirty, mode);
    assert.equal(out.a, 1, "keeps legitimate keys");
    assert.ok(!Object.hasOwn(out, "__proto__"), "drops __proto__");
    assert.ok(!Object.hasOwn(out, "constructor"), "drops constructor");
    assert.ok(!Object.hasOwn(out, "prototype"), "drops prototype");
  }
});

test("update mode blocks tenancy/identity re-homing; create keeps enterprise_id", () => {
  const row = { candidate_name: "X", enterprise_id: "e1", id: "i1", linkedin_norm: "n", created_at: "t" };

  const upd = sanitizeWritable(row, "update");
  assert.equal(upd.candidate_name, "X");
  assert.ok(!Object.hasOwn(upd, "enterprise_id"), "update strips enterprise_id (no cross-tenant re-home)");
  assert.ok(!Object.hasOwn(upd, "linkedin_norm"), "update strips the dedupe key");
  assert.ok(!Object.hasOwn(upd, "id"), "update strips id");
  assert.ok(!Object.hasOwn(upd, "created_at"), "update strips timestamps");

  const cre = sanitizeWritable(row, "create");
  assert.equal(cre.enterprise_id, "e1", "create keeps enterprise_id (needed to insert)");
  assert.ok(!Object.hasOwn(cre, "id"), "create still strips server-owned id");
});

test("does not mutate the input object", () => {
  const row = { id: "i1", a: 1 };
  const out = sanitizeWritable(row, "update");
  assert.ok(Object.hasOwn(row, "id"), "original is untouched");
  assert.ok(!Object.hasOwn(out, "id"), "copy is sanitized");
});
