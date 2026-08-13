import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const pageSource = new URL("../src/pages/briefing.astro", import.meta.url);
const styleSource = new URL("../src/styles/briefing.css", import.meta.url);
const watchWorkspaceSource = new URL("../src/features/briefing/components/WatchWorkspace.astro", import.meta.url);
const clientSource = new URL("../src/features/briefing/client.ts", import.meta.url);
const headerSource = new URL("../src/features/briefing/components/BriefingHeader.astro", import.meta.url);
const accessRecoverySource = new URL("../src/features/briefing/access-recovery.ts", import.meta.url);
const pendingAnnotationSource = new URL("../src/features/briefing/pending-annotation.ts", import.meta.url);

test("lead briefing heading remains in flow before the desktop reading columns become tight", async () => {
  const [page, styles] = await Promise.all([
    readFile(pageSource, "utf8"),
    readFile(styleSource, "utf8"),
  ]);

  assert.doesNotMatch(page, /pin:\s*leadHeader/);
  assert.match(
    styles,
    /@media \(max-width: 78rem\)\s*\{[\s\S]*?\.signal-item--lead\s*\{[\s\S]*?grid-template-columns:\s*1fr;/,
  );
});

test("Watch workspace keeps the 4x2 summary dense and exposes an explicit empty state", async () => {
  const [component, styles] = await Promise.all([
    readFile(watchWorkspaceSource, "utf8"),
    readFile(styleSource, "utf8"),
  ]);

  assert.match(component, /data-watch-workspace/);
  assert.match(component, /data-watch-active-count/);
  assert.match(component, /data-watch-latest-copy/);
  assert.match(component, /data-watch-quality-copy/);
  assert.match(component, /data-watch-list/);
  assert.match(component, /追踪条件与最新观察/);
  assert.match(component, /观察次数会持续累计/);
  assert.match(component, /还没有跨日追踪/);
  assert.match(component, /命中是待复核观察，不代表追踪条件已经成立/);
  assert.match(styles, /\.signal-watch-summary\s*\{[\s\S]*?grid-auto-flow:\s*dense;[\s\S]*?grid-template-columns:\s*repeat\(4,/);
  assert.match(styles, /\.signal-watch-summary__main\s*\{[\s\S]*?grid-column:\s*span 2;[\s\S]*?grid-row:\s*span 2;/);
  assert.match(styles, /\.signal-watch-summary__latest,[\s\S]*?\.signal-watch-summary__quality\s*\{[\s\S]*?grid-column:\s*span 2;[\s\S]*?grid-row:\s*span 1;/);
  assert.match(styles, /@media \(max-width: 40rem\)[\s\S]*?\.signal-watch-summary\s*\{[\s\S]*?grid-template-columns:\s*1fr;/);
  assert.match(styles, /\.signal-watch-card__details\s*\{[\s\S]*?min-width:\s*min\(28rem,\s*calc\(100vw - 18rem\)\);/);
});

test("track remains a two-step Watch action and refreshes protected cross-device state", async () => {
  const [page, client] = await Promise.all([
    readFile(pageSource, "utf8"),
    readFile(clientSource, "utf8"),
  ]);

  assert.match(page, /data-watch-confirm-template/);
  assert.match(page, /data-watch-condition/);
  assert.match(page, /data-watch-confirm-button/);
  assert.match(page, /确认后才会建立跨设备 Watch；这不是 Memory/);
  assert.match(page, /isTrackAction \? null : response\.memoryCandidate/);
  assert.match(page, /await createWatch\(\{ briefingId: seedBriefingId, briefingItemId: seedBriefingItemId, condition \}\)/);
  assert.match(page, /watches = await getWatches\(\)/);
  assert.match(page, /latest\.id !== briefingId \|\| latest\.generatedAt !== initialGeneratedAt/);
  assert.match(client, /path === "\/api\/watches"/);
  assert.match(client, /resolve\$\/\.test\(path\)/);
  assert.doesNotMatch(client, /path\.startsWith\("\/api\/watches\/"\)/);
  assert.match(client, /apiRequest<WatchesResponse>\("\/api\/watches"\)/);
  assert.match(client, /`\/api\/watches\/\$\{encodeURIComponent\(id\)\}\/resolve`/);
});

test("private annotation failures use the unified HTML access callback", async () => {
  const [client, page, recovery, pendingAnnotation] = await Promise.all([
    readFile(clientSource, "utf8"),
    readFile(pageSource, "utf8"),
    readFile(accessRecoverySource, "utf8"),
    readFile(pendingAnnotationSource, "utf8"),
  ]);
  const annotationPanel = await readFile(new URL("../src/features/briefing/components/AnnotationPanel.astro", import.meta.url), "utf8");

  assert.match(client, /export const privateAccessUrl = "\/api\/private\/session\?returnTo=\/briefing\/"/);
  assert.doesNotMatch(client, /privateAccessUrl = "\/api\/private\/signal\/api\/watches"/);
  assert.match(client, /fallbackCause instanceof SignalApiError/);
  assert.match(annotationPanel, /data-annotation-access-link/);
  assert.match(annotationPanel, /href="\/api\/private\/session\?returnTo=\/briefing\/"/);
  assert.doesNotMatch(annotationPanel, /target="_blank"/);
  assert.match(annotationPanel, /完成授权并自动继续/);
  assert.match(page, /error instanceof SignalApiError && error\.code === "SIGNAL_ACCESS_REQUIRED"/);
  assert.match(page, /new BroadcastChannel\("zxlab-private-access"\)/);
  assert.match(page, /event\.data\?\.type !== "zxlab:private-access-ready"/);
  assert.doesNotMatch(page, /window\.open/);
  assert.match(page, /window\.location\.assign\(annotationAccessLink\.href \|\| privateAccessUrl\)/);
  assert.match(page, /typeof form\.requestSubmit === "function"/);
  assert.match(page, /form\.dispatchEvent\(new Event\("submit", \{ bubbles: true, cancelable: true \}\)\)/);
  assert.match(page, /await getWatches\(\)[\s\S]*?submitAnnotationForm\(\)/);
  assert.match(page, /accessRecoveryPresentation\(error\)/);
  assert.doesNotMatch(page, /catch\s*\{\s*\/\/ Keep the preserved comment and login action visible until Access is ready\./);
  assert.match(recovery, /PRIVATE_UPSTREAM_AUTH_FAILED/);
  assert.match(recovery, /授权返回后验证失败/);
  assert.match(page, /savePendingAnnotation\(window\.sessionStorage, draft\)/);
  assert.match(page, /loadPendingAnnotation\(window\.sessionStorage\)/);
  assert.match(page, /clearPendingAnnotation\(window\.sessionStorage\)/);
  assert.match(page, /restoredAnnotation[\s\S]*?void resumePendingAnnotation\(\)/);
  assert.match(pendingAnnotation, /zxlab:pending-signal-annotation/);
  assert.match(await readFile(styleSource, "utf8"), /\.annotation-access-link\[hidden\]\s*\{\s*display:\s*none;/);
});

test("the mobile annotation and Watch confirmation panel stays above global navigation", async () => {
  const styles = await readFile(styleSource, "utf8");

  assert.match(styles, /\.annotation-menu\s*\{[\s\S]*?z-index:\s*130;/);
  assert.match(styles, /\.annotation-scrim\s*\{[^}]*z-index:\s*110;/);
  assert.match(styles, /\.annotation-panel\s*\{[^}]*z-index:\s*120;/);
});

test("legacy briefings show unknown provenance instead of claiming a verified model pass", async () => {
  const [page, header] = await Promise.all([
    readFile(pageSource, "utf8"),
    readFile(headerSource, "utf8"),
  ]);

  for (const source of [page, header]) {
    assert.match(source, /legacy-unknown[\s\S]*?历史生成方式未知/);
    assert.match(source, /unknown[\s\S]*?历史质量状态未知/);
  }
  assert.match(page, /data-briefing-quality-status=\{briefing\.qualityStatus\}/);
  assert.match(page, /activeQualityStatus = briefing\.qualityStatus/);
  assert.match(page, /activeState === "ready" \|\| activeState === "partial"[\s\S]*?`\$\{baseStatusLabel\} · \$\{qualityLabel\}`/);
});
