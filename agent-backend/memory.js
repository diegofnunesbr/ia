import { pool } from './db.js'
import { embed } from './llm.js'

const EMBED_DIMENSIONS = 768

export async function initMemory() {
  await pool.query('CREATE EXTENSION IF NOT EXISTS vector')
  await pool.query(`
    CREATE TABLE IF NOT EXISTS memories (
      id SERIAL PRIMARY KEY,
      content TEXT NOT NULL,
      embedding vector(${EMBED_DIMENSIONS}),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
}

export async function rememberFact(content) {
  const embedding = await embed(content)
  await pool.query('INSERT INTO memories (content, embedding) VALUES ($1, $2)', [
    content,
    JSON.stringify(embedding),
  ])
}

export async function recallRelevant(query, limit = 5) {
  const embedding = await embed(query)
  const { rows } = await pool.query(
    'SELECT content FROM memories ORDER BY embedding <=> $1 LIMIT $2',
    [JSON.stringify(embedding), limit]
  )
  return rows.map((r) => r.content)
}
