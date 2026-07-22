import assert from "node:assert/strict";
import { createStrudelUrl, STRUDEL_ORIGIN } from "../src/lab/strudel/embed.ts";
import { STRUDEL_DREAM_TRANCE_PRESET, STRUDEL_FUTURE_BASS_PRESET, STRUDEL_HARDSTYLE_PRESET, STRUDEL_PRESETS } from "../src/lab/strudel/preset.ts";

const url = new URL(createStrudelUrl(STRUDEL_DREAM_TRANCE_PRESET));
const binary = atob(decodeURIComponent(url.hash.slice(1)));
const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
const decoded = new TextDecoder().decode(bytes);

assert.equal(url.origin, STRUDEL_ORIGIN);
assert.equal(decoded, STRUDEL_DREAM_TRANCE_PRESET);
assert.match(decoded, /setcpm\(136 \/ 4\)/);
assert.match(decoded, /arrange\(\[4, intro\], \[4, drive\], \[5, peak\], \[4, outro\]\)/);
assert.match(decoded, /s\("~ cp ~ cp"\)/);
assert.match(decoded, /s\("hh\*16"\)/);
assert.match(STRUDEL_FUTURE_BASS_PRESET, /setcpm\(144 \/ 4\)/);
assert.match(STRUDEL_FUTURE_BASS_PRESET, /arrange\([\s\S]*\[5, drop\]/);
assert.match(STRUDEL_HARDSTYLE_PRESET, /setcpm\(160 \/ 4\)/);
assert.match(STRUDEL_HARDSTYLE_PRESET, /\[6, dropB\]/);
assert.deepEqual(STRUDEL_PRESETS.map((preset) => preset.id), ["dream-trance", "future-bass", "euphoric-hardstyle"]);

for (const preset of STRUDEL_PRESETS) {
  const presetUrl = new URL(createStrudelUrl(preset.source));
  const presetBinary = atob(decodeURIComponent(presetUrl.hash.slice(1)));
  const presetBytes = Uint8Array.from(presetBinary, (character) => character.charCodeAt(0));
  const presetDecoded = new TextDecoder().decode(presetBytes);

  assert.equal(presetDecoded, preset.source, `${preset.id} source should survive URL encoding`);
  assert.doesNotMatch(presetDecoded, /\\`/, `${preset.id} must not contain escaped backticks`);
  assert.match(presetDecoded, /\n\s+(?:<|const|\.|\[)/, `${preset.id} should preserve readable multiline source`);
}

process.stdout.write("Strudel preset and URL verification passed.\n");
