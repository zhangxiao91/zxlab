import assert from "node:assert/strict";
import { createStrudelUrl, STRUDEL_ORIGIN } from "../src/lab/strudel/embed.ts";
import { STRUDEL_TRANCE_PRESET } from "../src/lab/strudel/preset.ts";

const url = new URL(createStrudelUrl(STRUDEL_TRANCE_PRESET));
const binary = atob(decodeURIComponent(url.hash.slice(1)));
const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
const decoded = new TextDecoder().decode(bytes);

assert.equal(url.origin, STRUDEL_ORIGIN);
assert.equal(decoded, STRUDEL_TRANCE_PRESET);
assert.match(decoded, /setcpm\(138 \/ 4\)/);
assert.match(decoded, /s\("bd\*4"\)[\s\S]*bank\("RolandTR909"\)/);
assert.match(decoded, /s\("~ cp ~ cp"\)/);
assert.match(decoded, /s\("hh\*16"\)/);
assert.match(decoded, /note\("~ c2 ~ c2 ~ c2 ~ c2"\)/);
assert.match(decoded, /lpf\(sine\.range\(600, 4200\)\.slow\(16\)\)/);
assert.match(decoded, /\.delay\(\.4\)[\s\S]*\.room\(\.3\)/);

process.stdout.write("Strudel preset and URL verification passed.\n");
