import { pool } from './db.js'

export async function initSessions() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      title TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id SERIAL PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT,
      tool_calls JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
}

export async function ensureSession(id, title) {
  await pool.query('INSERT INTO chat_sessions (id, title) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [
    id,
    title || null,
  ])
}

export async function listSessions() {
  const { rows } = await pool.query(
    'SELECT id, title, updated_at FROM chat_sessions ORDER BY updated_at DESC'
  )
  return rows
}

export async function deleteSession(id) {
  await pool.query('DELETE FROM chat_sessions WHERE id = $1', [id])
}

export async function setTitleIfEmpty(sessionId, title) {
  await pool.query('UPDATE chat_sessions SET title = $2 WHERE id = $1 AND title IS NULL', [
    sessionId,
    title,
  ])
}

// Full transcript for a session, meant for the UI to redraw a conversation
// when the user switches back to it (only user/assistant turns, skipping
// internal tool-call bookkeeping).
// User messages are stored with internal context tags prepended
// ("[Data/hora atual: ...]", "[Memória relevante: ...]", etc.) so the
// model sees them on every future read of this history - but the user
// never typed that part, so strip it back off before showing it to
// them (matches what they see right after sending, before a reload).
const LEADING_CONTEXT_TAGS = /^(\[[^\]]*\]\n\n)+/

export async function getConversationForDisplay(sessionId) {
  const { rows } = await pool.query(
    `SELECT role, content FROM chat_messages
     WHERE session_id = $1 AND role IN ('user', 'assistant') AND content IS NOT NULL AND content <> ''
     ORDER BY id ASC`,
    [sessionId]
  )
  return rows.map((r) =>
    r.role === 'user' ? { ...r, content: r.content.replace(LEADING_CONTEXT_TAGS, '') } : r
  )
}

// Recent messages used to build the prompt sent to the model, including
// tool calls/results (capped so the context doesn't grow unbounded).
export async function getRecentMessages(sessionId, limit) {
  const { rows } = await pool.query(
    `SELECT role, content, tool_calls FROM chat_messages
     WHERE session_id = $1 ORDER BY id DESC LIMIT $2`,
    [sessionId, limit]
  )
  return rows
    .reverse()
    .map((r) => ({
      role: r.role,
      content: r.content,
      ...(r.tool_calls ? { tool_calls: r.tool_calls } : {}),
    }))
}

export async function appendMessage(sessionId, message) {
  await pool.query(
    'INSERT INTO chat_messages (session_id, role, content, tool_calls) VALUES ($1, $2, $3, $4)',
    [
      sessionId,
      message.role,
      message.content ?? null,
      message.tool_calls ? JSON.stringify(message.tool_calls) : null,
    ]
  )
  await pool.query('UPDATE chat_sessions SET updated_at = now() WHERE id = $1', [sessionId])
}

export function titleFrom(text) {
  const clean = text.trim().replace(/\s+/g, ' ')
  return clean.length > 40 ? `${clean.slice(0, 40)}…` : clean
}
