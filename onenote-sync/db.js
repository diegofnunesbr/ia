import pg from 'pg'

export const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL || 'postgresql://assistant:assistant@postgres:5432/assistant',
})

const EMBED_DIMENSIONS = 768

export async function initNotes() {
  await pool.query('CREATE EXTENSION IF NOT EXISTS vector')
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      embedding vector(${EMBED_DIMENSIONS}),
      source_modified_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
}

// id -> source_modified_at, so the sync job can skip re-embedding pages
// that haven't changed on the OneNote side since the last run.
export async function getKnownModifiedTimes() {
  const { rows } = await pool.query('SELECT id, source_modified_at FROM notes')
  return new Map(rows.map((r) => [r.id, r.source_modified_at.toISOString()]))
}

export async function upsertNote(id, title, content, embedding, sourceModifiedAt) {
  await pool.query(
    `INSERT INTO notes (id, title, content, embedding, source_modified_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (id) DO UPDATE
       SET title = EXCLUDED.title, content = EXCLUDED.content,
           embedding = EXCLUDED.embedding,
           source_modified_at = EXCLUDED.source_modified_at, updated_at = now()`,
    [id, title, content, JSON.stringify(embedding), sourceModifiedAt]
  )
}
