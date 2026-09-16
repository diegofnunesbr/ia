import { pool } from './db.js'

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://ollama:11434'
const EMBED_MODEL = process.env.EMBED_MODEL || 'nomic-embed-text'
const EMBED_DIMENSIONS = 768

// Defensive - the table is normally created by the onenote-sync CronJob,
// but that may not have run yet on a fresh deploy. Same definition as
// onenote-sync/db.js.
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

async function embed(text) {
  const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
  })
  if (!res.ok) throw new Error(`ollama embeddings returned ${res.status}`)
  const data = await res.json()
  return data.embedding
}

// Searches the OneNote pages synced by onenote-sync. Table is created by
// that job (initNotes there), not here - this module only reads.
export async function searchNotes(query, limit = 5) {
  const embedding = await embed(query)
  const { rows } = await pool.query(
    'SELECT title, content FROM notes ORDER BY embedding <=> $1 LIMIT $2',
    [JSON.stringify(embedding), limit]
  )
  return rows
}
