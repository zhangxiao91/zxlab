import { SignalError } from "../lib/errors";

const RUBRIC_VERSION = "signal-edition-v1";
const ratingFields = [
  "informationGain",
  "personalRelevance",
  "freshness",
  "technicalBalance",
  "sourceSufficiency",
  "dailyBudgetFit",
  "leadSelection",
  "threeDayValue",
] as const;

type RatingField = typeof ratingFields[number];
type Ratings = Partial<Record<RatingField, number>>;

interface EvaluationRow {
  briefing_id: string;
  rubric_version: string;
  information_gain: number | null;
  personal_relevance: number | null;
  freshness: number | null;
  technical_balance: number | null;
  source_sufficiency: number | null;
  daily_budget_fit: number | null;
  lead_selection: number | null;
  three_day_value: number | null;
  evaluated_at: string;
}

interface EditionRow {
  briefing_id: string;
  briefing_date: string;
  prompt_version: string;
  model: string;
  generation_mode: string;
  quality_status: string;
  source_policy_version: string;
  fetched_count: number | null;
  unique_count: number | null;
  balanced_count: number | null;
  synthesis_count: number | null;
  selected_count: number;
  collection_run_id: string | null;
  duplicate_count: number | null;
  collection_fetched_count: number | null;
}

function parseRatings(value: unknown): Ratings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SignalError("INVALID_REQUEST", "ratings must be an object", 400);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !ratingFields.includes(key as RatingField))) {
    throw new SignalError("INVALID_REQUEST", "ratings contains an unknown field", 400);
  }
  const ratings: Ratings = {};
  for (const field of ratingFields) {
    const rating = record[field];
    if (rating === undefined) continue;
    if (!Number.isInteger(rating) || Number(rating) < 0 || Number(rating) > 2) {
      throw new SignalError("INVALID_REQUEST", `${field} must be an integer from 0 to 2`, 400);
    }
    ratings[field] = Number(rating);
  }
  if (Object.keys(ratings).length === 0) throw new SignalError("INVALID_REQUEST", "At least one rating is required", 400);
  return ratings;
}

function assessment(row: EvaluationRow | null): { rubricVersion: string; ratings: Ratings; evaluatedAt: string } | undefined {
  if (!row) return undefined;
  const pairs: Array<[RatingField, number | null]> = [
    ["informationGain", row.information_gain], ["personalRelevance", row.personal_relevance],
    ["freshness", row.freshness], ["technicalBalance", row.technical_balance],
    ["sourceSufficiency", row.source_sufficiency], ["dailyBudgetFit", row.daily_budget_fit],
    ["leadSelection", row.lead_selection], ["threeDayValue", row.three_day_value],
  ];
  return { rubricVersion: row.rubric_version,
    ratings: Object.fromEntries(pairs.filter(([, value]) => value !== null)) as Ratings,
    evaluatedAt: row.evaluated_at };
}

export class EvaluationModule {
  constructor(private readonly db: D1Database, private readonly now: () => Date = () => new Date()) {}

  async upsertEditionAssessment(briefingId: string, input: unknown) {
    const ratings = parseRatings((input as { ratings?: unknown } | null)?.ratings);
    const exists = await this.db.prepare("SELECT 1 present FROM briefings WHERE id=?").bind(briefingId).first<{ present: number }>();
    if (!exists) throw new SignalError("BRIEFING_NOT_FOUND", "Briefing not found", 404);
    const value = (field: RatingField) => ratings[field] ?? null;
    const evaluatedAt = this.now().toISOString();
    await this.db.prepare(`INSERT INTO briefing_evaluations
      (briefing_id, rubric_version, information_gain, personal_relevance, freshness, technical_balance,
       source_sufficiency, daily_budget_fit, lead_selection, three_day_value, evaluated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(briefing_id) DO UPDATE SET rubric_version=excluded.rubric_version,
       information_gain=excluded.information_gain, personal_relevance=excluded.personal_relevance,
       freshness=excluded.freshness, technical_balance=excluded.technical_balance,
       source_sufficiency=excluded.source_sufficiency, daily_budget_fit=excluded.daily_budget_fit,
       lead_selection=excluded.lead_selection, three_day_value=excluded.three_day_value, evaluated_at=excluded.evaluated_at`)
      .bind(briefingId, RUBRIC_VERSION, value("informationGain"), value("personalRelevance"), value("freshness"),
        value("technicalBalance"), value("sourceSufficiency"), value("dailyBudgetFit"), value("leadSelection"),
        value("threeDayValue"), evaluatedAt).run();
    const row = await this.db.prepare("SELECT * FROM briefing_evaluations WHERE briefing_id=?")
      .bind(briefingId).first<EvaluationRow>();
    return { briefingId, assessment: assessment(row) };
  }

  async summary(input: { from?: string; to?: string; limit?: number }) {
    const clauses = ["b.data_origin='real'"];
    const bindings: unknown[] = [];
    if (input.from) { clauses.push("b.briefing_date>=?"); bindings.push(input.from); }
    if (input.to) { clauses.push("b.briefing_date<=?"); bindings.push(input.to); }
    bindings.push(Math.min(Math.max(input.limit ?? 30, 1), 90));
    const result = await this.db.prepare(`SELECT b.id briefing_id, b.briefing_date, b.prompt_version, b.model,
      b.generation_mode, b.quality_status, r.source_policy_version, r.fetched_count, r.unique_count,
      r.balanced_count, r.synthesis_count, r.selected_count, r.collection_run_id,
      c.duplicate_count, c.fetched_count collection_fetched_count
      FROM briefings b JOIN briefing_runs r ON r.id=b.run_id
      LEFT JOIN collection_runs c ON c.id=r.collection_run_id
      WHERE ${clauses.join(" AND ")} ORDER BY b.briefing_date DESC, b.generated_at DESC LIMIT ?`)
      .bind(...bindings).all<EditionRow>();
    const editions = await Promise.all(result.results.map(async (row) => {
      const [families, actions, annotationCount, watchCount, memoryCandidates, evaluation] = await Promise.all([
        this.db.prepare(`SELECT ss.source_family family, COUNT(DISTINCT bic.briefing_item_id) count
          FROM briefing_item_candidates bic JOIN candidate_signals cs ON cs.id=bic.candidate_signal_id
          JOIN signal_sources ss ON ss.id=cs.source_id JOIN briefing_items bi ON bi.id=bic.briefing_item_id
          WHERE bi.briefing_id=? GROUP BY ss.source_family`).bind(row.briefing_id).all<{ family: string; count: number }>(),
        this.db.prepare(`SELECT action, COUNT(*) count FROM feedback_events
          WHERE target_id=? OR target_id IN (SELECT id FROM briefing_items WHERE briefing_id=?) GROUP BY action`)
          .bind(row.briefing_id, row.briefing_id).all<{ action: string; count: number }>(),
        this.db.prepare("SELECT COUNT(*) count FROM annotations WHERE briefing_id=?")
          .bind(row.briefing_id).first<{ count: number }>(),
        this.db.prepare("SELECT COUNT(*) count FROM watch_dossiers WHERE seed_briefing_id=?")
          .bind(row.briefing_id).first<{ count: number }>(),
        this.db.prepare(`SELECT mc.status, COUNT(*) count FROM memory_consolidation_candidates mc
          WHERE EXISTS (SELECT 1 FROM json_each(mc.source_event_ids_json) source
            JOIN annotations a ON a.id=source.value WHERE a.briefing_id=?) GROUP BY mc.status`)
          .bind(row.briefing_id).all<{ status: string; count: number }>(),
        this.db.prepare("SELECT * FROM briefing_evaluations WHERE briefing_id=?").bind(row.briefing_id).first<EvaluationRow>(),
      ]);
      const familyCounts = Object.fromEntries(families.results.map((entry) => [entry.family, entry.count]));
      const actionCounts = Object.fromEntries(actions.results.map((entry) => [entry.action, entry.count]));
      const memoryCounts = Object.fromEntries(memoryCandidates.results.map((entry) => [entry.status, entry.count]));
      const annotations = annotationCount?.count ?? 0;
      const watches = watchCount?.count ?? 0;
      const duplicateRate = row.collection_fetched_count && row.duplicate_count !== null
        ? row.duplicate_count / row.collection_fetched_count : null;
      return {
        briefingId: row.briefing_id, date: row.briefing_date, promptVersion: row.prompt_version, model: row.model,
        sourcePolicyVersion: row.source_policy_version, generationMode: row.generation_mode, qualityStatus: row.quality_status,
        counts: { fetched: row.fetched_count, unique: row.unique_count, balanced: row.balanced_count,
          synthesized: row.synthesis_count, published: row.selected_count },
        duplicateRate,
        sourceMetrics: { availability: families.results.length > 0, families: familyCounts },
        behaviorMetrics: { availability: actions.results.length > 0 || annotations > 0 || watches > 0 || memoryCandidates.results.length > 0,
          actions: actionCounts, annotations, watches, memoryCandidates: memoryCounts },
        assessment: assessment(evaluation),
      };
    }));
    return { rubricVersion: RUBRIC_VERSION, editions };
  }
}
