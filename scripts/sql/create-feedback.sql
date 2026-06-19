CREATE TABLE IF NOT EXISTS feedback (
  id          SERIAL PRIMARY KEY,
  categoria   TEXT NOT NULL CHECK (categoria IN ('sugerencia', 'error', 'mejora')),
  mensaje     TEXT NOT NULL,
  autor       TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback (created_at DESC);
