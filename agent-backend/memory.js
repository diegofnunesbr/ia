import { pool } from './db.js'

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://ollama:11434'
const EMBED_MODEL = process.env.EMBED_MODEL || 'nomic-embed-text'
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
