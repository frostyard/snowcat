import assert from "node:assert/strict";
import test from "node:test";

import db from "../src/db.ts";

// src/db.ts is the Flue persistence adapter for the app's SQLite store. Its
// only statement is `export default sqlite("./data/flue.db")`, which Flue loads
// through the virtual:flue/db convention, so no other test imports it and it
// would otherwise be absent from the coverage denominator entirely (Node's
// --test-coverage-include does not force-include a never-loaded module). This
// test imports it so the module is measured — sqlite() is lazy (it opens no
// database until migrate()/connect() is called), so importing it has no
// filesystem side effect — and pins the adapter's shape.
test("src/db.ts exports a Flue SQLite persistence adapter", () => {
  assert.equal(typeof db, "object");
  assert.ok(db);
  assert.equal(typeof db.migrate, "function");
  assert.equal(typeof db.connect, "function");
  assert.equal(typeof db.close, "function");
});
