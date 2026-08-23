PRAGMA foreign_keys = ON;

CREATE TABLE research_artifact_versions (
  artifact_id TEXT PRIMARY KEY,
  artifact_kind TEXT NOT NULL CHECK (artifact_kind IN (
    'normalized_daily_history.v1',
    'financial_statement.v1',
    'official_filing_identity.v1'
  )),
  schema_version TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  logical_key TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_version TEXT NOT NULL,
  source_as_of TEXT NOT NULL,
  first_observed_at TEXT NOT NULL,
  first_retrieved_at TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  blob_key TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  payload_json TEXT NOT NULL,
  warnings_json TEXT NOT NULL,
  UNIQUE (artifact_kind, logical_key, content_digest),
  UNIQUE (blob_key)
);

CREATE INDEX idx_research_artifact_versions_asof
  ON research_artifact_versions (
    subject_id,
    artifact_kind,
    source_as_of DESC,
    first_observed_at DESC,
    logical_key
  );

CREATE TABLE research_artifact_observations (
  observation_id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  provider_retrieved_at TEXT NOT NULL,
  FOREIGN KEY (artifact_id) REFERENCES research_artifact_versions (artifact_id)
);

CREATE INDEX idx_research_artifact_observations_artifact
  ON research_artifact_observations (artifact_id, observed_at DESC);

CREATE TABLE research_artifact_relations (
  from_artifact_id TEXT NOT NULL,
  relation_type TEXT NOT NULL CHECK (relation_type IN ('corroborated_by', 'derived_from')),
  to_artifact_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (from_artifact_id, relation_type, to_artifact_id),
  FOREIGN KEY (from_artifact_id) REFERENCES research_artifact_versions (artifact_id),
  FOREIGN KEY (to_artifact_id) REFERENCES research_artifact_versions (artifact_id)
);

CREATE TABLE financial_statement_cells (
  artifact_id TEXT NOT NULL,
  statement_type TEXT NOT NULL CHECK (statement_type IN ('income', 'cash_flow', 'balance_sheet')),
  report_period_start TEXT NOT NULL,
  report_period_end TEXT NOT NULL,
  period_basis TEXT NOT NULL CHECK (period_basis IN ('quarter', 'year_to_date', 'fiscal_year')),
  report_type_code TEXT NOT NULL,
  data_state TEXT NOT NULL,
  metric_id TEXT NOT NULL,
  value_decimal TEXT NOT NULL,
  unit TEXT NOT NULL CHECK (unit = 'CNY'),
  PRIMARY KEY (artifact_id, metric_id),
  FOREIGN KEY (artifact_id) REFERENCES research_artifact_versions (artifact_id)
);

CREATE INDEX idx_financial_statement_cells_period
  ON financial_statement_cells (report_period_end DESC, metric_id, artifact_id);

CREATE TABLE official_filing_versions (
  artifact_id TEXT PRIMARY KEY,
  filing_id TEXT NOT NULL,
  report_period_end TEXT NOT NULL,
  report_type TEXT NOT NULL CHECK (report_type IN ('quarterly', 'semiannual', 'annual')),
  title TEXT NOT NULL,
  published_at TEXT NOT NULL,
  filing_url TEXT NOT NULL,
  FOREIGN KEY (artifact_id) REFERENCES research_artifact_versions (artifact_id),
  UNIQUE (filing_id)
);

CREATE INDEX idx_official_filing_versions_period
  ON official_filing_versions (report_period_end DESC, published_at DESC);
