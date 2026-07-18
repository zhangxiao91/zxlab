INSERT INTO memory_items (
  id, namespace, kind, content, importance, confidence, source_type, source_id,
  status, created_at, updated_at, expires_at
) VALUES
  ('memory_seed_briefing_funding', 'briefing', 'preference', '用户通常不关注只有融资金额、缺少产品或技术进展的新闻。', 0.72, 0.78, 'seed', 'memory-mvp-example', 'active', '2026-07-18T00:00:00.000Z', '2026-07-18T00:00:00.000Z', NULL),
  ('memory_seed_zxlab_runtime', 'zxlab', 'decision', 'zxlab 的新后端能力应优先兼容 Cloudflare Workers 运行时。', 0.9, 0.95, 'seed', 'memory-mvp-example', 'active', '2026-07-18T00:00:00.000Z', '2026-07-18T00:00:00.000Z', NULL);
