import assert from "node:assert/strict";
import test from "node:test";
import { splitText } from "../src/text-splitter.js";

test("splits on newlines before sentence endings", () => {
  assert.deepEqual(splitText("第一段\n第二段很长", 4), ["第一段\n", "第二段很", "长"]);
});

test("does not split Unicode surrogate pairs", () => {
  const chunks = splitText("甲😀乙😀丙", 2);
  assert.deepEqual(chunks, ["甲😀", "乙😀", "丙"]);
  assert.equal(chunks.join(""), "甲😀乙😀丙");
});

test("prefers sentence boundaries", () => {
  assert.deepEqual(splitText("你好。今天怎么样", 5), ["你好。", "今天怎么样"]);
});
