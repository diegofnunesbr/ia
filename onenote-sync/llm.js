// Same idea as agent-backend/llm.js - the one place this service talks to
// the local LLM runtime, so swapping it later means editing one file.
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://ollama:11434'
const EMBED_MODEL = process.env.EMBED_MODEL || 'nomic-embed-text'

export async function embed(text) {
  const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
  })
  if (!res.ok) throw new Error(`llm embeddings returned ${res.status}`)
  return (await res.json()).embedding
}
