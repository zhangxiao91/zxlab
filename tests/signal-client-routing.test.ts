import assert from "node:assert/strict";
import test from "node:test";
import { signalEndpoint } from "../src/features/briefing/request-routing.ts";

test("streaming annotations keep query parameters behind the authenticated Pages gateway", () => {
  assert.equal(
    signalEndpoint(
      "/api/annotations?stream=1",
      "https://signal-api.zx-dx.xyz",
      "/api/signal",
    ),
    "/api/signal/api/annotations?stream=1",
  );
});

test("public briefing reads remain on the public Signal API", () => {
  assert.equal(
    signalEndpoint(
      "/api/briefings/latest",
      "https://signal-api.zx-dx.xyz",
      "/api/signal",
    ),
    "https://signal-api.zx-dx.xyz/api/briefings/latest",
  );
});
