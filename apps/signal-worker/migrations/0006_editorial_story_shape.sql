ALTER TABLE briefing_items ADD COLUMN item_type TEXT NOT NULL DEFAULT 'brief' CHECK (item_type IN ('lead', 'brief'));
ALTER TABLE briefing_items ADD COLUMN lede TEXT;
ALTER TABLE briefing_items ADD COLUMN nut_graf TEXT;
ALTER TABLE briefing_items ADD COLUMN key_facts_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE briefing_items ADD COLUMN broader_context TEXT;
ALTER TABLE briefing_items ADD COLUMN implications TEXT;
ALTER TABLE briefing_items ADD COLUMN counterpoint TEXT;
ALTER TABLE briefing_items ADD COLUMN watch_next TEXT;
ALTER TABLE briefing_items ADD COLUMN zxlab_relevance TEXT;
