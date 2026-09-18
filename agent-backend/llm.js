// Single point of contact with the local LLM runtime (Ollama). Everything
// else in the app calls chat()/embed() without knowing what's behind them -
// swapping Ollama for a different runtime (vLLM, llama.cpp server, etc.)
// means changing this one file, not every place that talks to a model.

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://ollama:11434'
const CHAT_MODEL = process.env.AGENT_MODEL || 'qwen2.5:3b-instruct'
const EMBED_MODEL = process.env.EMBED_MODEL || 'nomic-embed-text'

// Streams the response (rather than waiting for it buffered) specifically
// so cancellation works: with a buffered response, the runtime doesn't
// reliably notice the caller gave up mid-generation and keeps computing
// regardless. Closing the connection via `signal` here actually stops it.
export async function chat(messages, tools, signal) {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: CHAT_MODEL,
      messages,
      tools,
      stream: true,
      options: {
        // Caps worst-case latency - an unbounded response can ramble on
        // for a long time on CPU. Raised from 400 since summarizing a
        // big tool result can need more room to actually finish the
        // thought.
        num_predict: 700,
        // Ollama's default (2048) is too small for our system prompt +
        // tool schemas alone, before any conversation history - going
        // over it forces an expensive context shift (or a runner
        // restart) mid-request instead of just prefilling once. Raised
        // again from 8192 for headroom against large tool results. The
        // KV cache cost of a bigger window is trivial (well under 1GB
        // even at this size).
        num_ctx: 16384,
      },
    }),
    signal,
  })
  if (!res.ok) throw new Error(`llm chat returned ${res.status}`)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const message = { role: 'assistant', content: '' }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop()

    for (const line of lines) {
      if (!line.trim()) continue
      const chunk = JSON.parse(line)
      if (chunk.message?.content) message.content += chunk.message.content
      if (chunk.message?.tool_calls) message.tool_calls = chunk.message.tool_calls
    }
  }

  return message
}

export async function embed(text) {
  const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
  })
  if (!res.ok) throw new Error(`llm embeddings returned ${res.status}`)
  const data = await res.json()
  return data.embedding
}
