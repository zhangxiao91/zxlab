import assert from "node:assert/strict";
import test from "node:test";
import { parseCommand } from "../src/commands.js";

test("recognizes commands while ignoring surrounding whitespace", () => {
  assert.equal(parseCommand("  /reset\n"), "reset");
  assert.equal(parseCommand("/HELP"), "help");
  assert.equal(parseCommand("/status"), "status");
});

test("does not treat command-like prose as a command", () => {
  assert.equal(parseCommand("/reset now"), undefined);
  assert.equal(parseCommand("hello"), undefined);
});
