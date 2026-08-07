import assert from "node:assert/strict";
import test from "node:test";
import { D1RunRepository } from "./d1-repository.ts";

test("run deletion scopes every evidence-related delete to the owning profile", async () => {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          statements.push({ sql, values });
          return {};
        },
      };
    },
    async batch() {
      return [{}, {}, {}, {}, {}, { meta: { changes: 1 } }];
    },
  } as unknown as D1Database;
  const deleted = await new D1RunRepository(db).delete("run-1", "profile-owner");
  assert.equal(deleted, true);
  for (const statement of statements.slice(1)) {
    assert.match(statement.sql, /profile_id = \?/);
    assert.ok(statement.values.includes("profile-owner"));
  }
});
