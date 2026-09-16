// Single point of contact with the local LLM runtime (Ollama). Everything
// else in the app calls chat()/embed() without knowing what's behind them -
// swapping Ollama for a different runtime (vLLM, llama.cpp server, etc.)
// means changing this one file, not every place that talks to a model.

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://ollama:11434'
const CHAT_MODEL = process.env.AGENT_MODEL || 'qwen2.5:14b-instruct'
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
      // Caps worst-case latency - an unbounded response can ramble on for
      // a long time on CPU. 400 tokens is plenty for a chat answer.
      options: { num_predict: 400 },
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
