import crypto from 'node:crypto'
import express from 'express'
import multer from 'multer'
import { chat } from './llm.js'
import { initMemory, rememberFact, recallRelevant } from './memory.js'
import { extractText, imageToPdf } from './documents.js'
import {
  verifyCredentials,
  createSession,
  destroySession,
  isValidSession,
  requireAuth,
  isProxyAuthenticated,
  setSessionCookie,
  clearSessionCookie,
  getSessionToken,
} from './auth.js'
import {
  initSessions,
  ensureSession,
  listSessions,
  deleteSession,
  setTitleIfEmpty,
  getConversationForDisplay,
  getRecentMessages,
  appendMessage,
  deleteMessagesFrom,
  titleFrom,
} from './sessions.js'

const PORT = process.env.PORT || 3000
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || '' // e.g. http://assistente.home.lan/api
const MAX_HISTORY_MESSAGES = 10
const MAX_TOOL_ROUNDTRIPS = 4
const FILE_TTL_MS = 30 * 60 * 1000
const DOCUMENT_MAX_CHARS = 6000
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } })
const OWNER_NAME = process.env.OWNER_NAME || 'seu usuário'
const AI_NAME = process.env.AI_NAME || 'assistente'
const PROXY_LOGOUT_URL = process.env.PROXY_LOGOUT_URL || ''

const SYSTEM_PROMPT = `Seu nome é ${AI_NAME}. Você é o assistente pessoal de ${OWNER_NAME},
chat com texto e voz. Se perguntarem seu nome, responda "${AI_NAME}" - nunca
confunda com o nome de ${OWNER_NAME}, que é quem está conversando com você.
Roda 100% local (sem internet) - pode lidar com senhas e dados sensíveis com segurança.
Nunca invente informação: se não souber ou não tiver certeza, diga isso.
Propósito geral: responda qualquer assunto com seu próprio conhecimento,
sem precisar de ferramenta. As ferramentas abaixo são só para tarefas
específicas.

Anexo de imagem aqui no chat (clipe) já vira PDF automaticamente (link de
download aparece na interface assim que o upload termina) e também passa por
OCR local - o texto extraído chega como "[Documento anexado: ...]" na próxima
mensagem, pra você ler e comentar sobre o conteúdo. Anexo de PDF é só leitura
via OCR (não faz sentido converter um PDF em PDF).
Smart home/câmeras/impressoras: ainda não conectadas.
Fato pessoal duradouro (família, preferências) -> use remember_fact.
Às vezes a mensagem do usuário vem precedida de um lembrete automático
interno com fatos já salvos sobre ele, ou com a data/hora real agora.
Use essa informação normalmente na resposta, mas nunca cite, repita ou
mencione que recebeu um lembrete - responda direto, como se você já
soubesse.`

const TIMEZONE = process.env.TIMEZONE || 'America/Sao_Paulo'

function currentDateTime() {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: TIMEZONE,
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(new Date())
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'remember_fact',
      description: `Salva permanentemente um fato pessoal, preferência ou informação relevante sobre ${OWNER_NAME}, para lembrar em conversas futuras.`,
      parameters: {
        type: 'object',
        properties: {
          fact: {
            type: 'string',
            description: 'O fato a ser lembrado, em uma frase clara e autocontida.',
          },
        },
        required: ['fact'],
      },
    },
  },
]

// Phase: files generated for download, kept in memory only (small scale,
// single user). Expire after FILE_TTL_MS so this doesn't grow unbounded.
const files = new Map() // id -> { buffer, filename, contentType, expiresAt }

function storeFile(buffer, filename, contentType) {
  const id = crypto.randomUUID()
  files.set(id, { buffer, filename, contentType, expiresAt: Date.now() + FILE_TTL_MS })
  return id
}

setInterval(() => {
  const now = Date.now()
  for (const [id, f] of files) if (f.expiresAt < now) files.delete(id)
}, 60_000).unref()

// Text extracted from an uploaded document/image, waiting to be attached
// to the session's next chat message (consumed once, then cleared).
const pendingDocuments = new Map() // from -> { text, filename }

const KNOWN_TOOL_NAMES = new Set(TOOLS.map((t) => t.function.name))

// Finds every balanced {...} object in the text (not a regex - a naive
// non-greedy regex breaks on nested braces like `"arguments": {...}`).
function extractJsonObjects(text) {
  const objects = []
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue
    let depth = 0
    for (let j = i; j < text.length; j++) {
      if (text[j] === '{') depth++
      else if (text[j] === '}') {
        depth--
        if (depth === 0) {
          try {
            objects.push(JSON.parse(text.slice(i, j + 1)))
          } catch {
            // not valid JSON after all - ignore
          }
          break
        }
      }
    }
  }
  return objects
}

// Some Qwen builds under Ollama write the tool call as literal text in
// the message content ("<tool_call>{...}</tool_call>" or bare JSON)
// instead of the structured tool_calls field we ask for - this recovers
// it so the call still actually runs instead of being shown to the user
// as raw text.
function extractFallbackToolCalls(content) {
  if (!content) return null
  const calls = extractJsonObjects(content)
    .filter((obj) => KNOWN_TOOL_NAMES.has(obj.name))
    .map((obj) => ({ function: { name: obj.name, arguments: obj.arguments || {} } }))
  return calls.length ? calls : null
}

async function runTool(name, args) {
  if (name === 'remember_fact') {
    if (!args.fact) return { error: 'fact é obrigatório' }
    await rememberFact(args.fact)
    return { ok: true, saved: args.fact }
  }

  return { error: `ferramenta desconhecida: ${name}` }
}


const app = express()
app.use(express.json())

app.get('/health', (_req, res) => res.json({ ok: true }))

app.post('/login', (req, res) => {
  const { username, password } = req.body || {}
  if (!username || !password) {
    return res.status(400).json({ error: 'username e password são obrigatórios' })
  }
  if (!verifyCredentials(username, password)) {
    return res.status(401).json({ error: 'credenciais inválidas' })
  }
  setSessionCookie(res, createSession())
  res.json({ ok: true })
})

app.get('/me', (req, res) => {
  if (isProxyAuthenticated(req)) return res.json({ authenticated: true })
  const token = getSessionToken(req)
  res.json({ authenticated: Boolean(token) && isValidSession(token) })
})

app.post('/logout', (req, res) => {
  const token = getSessionToken(req)
  if (token) destroySession(token)
  clearSessionCookie(res)
  if (isProxyAuthenticated(req) && PROXY_LOGOUT_URL) {
    return res.json({ ok: true, redirect: PROXY_LOGOUT_URL })
  }
  res.json({ ok: true })
})

app.use(requireAuth)

async function buildUserContent(from, text) {
  let userContent = `[Data/hora atual: ${currentDateTime()}]\n\n${text}`

  const pendingDoc = pendingDocuments.get(from)
  if (pendingDoc) {
    pendingDocuments.delete(from)
    const truncated = pendingDoc.text.slice(0, DOCUMENT_MAX_CHARS)
    userContent = `[Documento anexado (${pendingDoc.filename}): ${truncated}]\n\n${userContent}`
  }

  try {
    const relevant = await recallRelevant(text)
    if (relevant.length) {
      userContent = `[Memória relevante: ${relevant.join('; ')}]\n\n${userContent}`
    }
  } catch (err) {
    console.error('memory recall failed, continuing without it', err)
  }

  return userContent
}

async function generateAssistantReply(from, signal) {
  let downloadUrl
  for (let round = 0; round < MAX_TOOL_ROUNDTRIPS; round++) {
    const recent = await getRecentMessages(from, MAX_HISTORY_MESSAGES)
    const message = await chat([{ role: 'system', content: SYSTEM_PROMPT }, ...recent], TOOLS, signal)

    if (!message.tool_calls?.length) {
      const fallback = extractFallbackToolCalls(message.content)
      if (fallback) {
        message.tool_calls = fallback
        message.content = ''
      }
    }

    if (!message.tool_calls?.length) {
      await appendMessage(from, { role: 'assistant', content: message.content })
      return { reply: message.content?.trim(), downloadUrl }
    }

    await appendMessage(from, message)

    for (const call of message.tool_calls) {
      const args =
        typeof call.function.arguments === 'string'
          ? JSON.parse(call.function.arguments || '{}')
          : call.function.arguments || {}

      const result = await runTool(call.function.name, args)
      if (result.downloadUrl) downloadUrl = result.downloadUrl

      await appendMessage(from, { role: 'tool', content: JSON.stringify(result) })
    }
  }

  return { reply: 'Não consegui concluir isso em tempo hábil, pode tentar de novo?', downloadUrl }
}

app.post('/message', async (req, res) => {
  const { from, text } = req.body || {}
  if (!from || !text) return res.status(400).json({ error: 'missing from/text' })

  await ensureSession(from)
  await setTitleIfEmpty(from, titleFrom(text))

  const userContent = await buildUserContent(from, text)
  const userMessageId = await appendMessage(from, { role: 'user', content: userContent })

  const controller = new AbortController()
  req.on('close', () => controller.abort())

  try {
    const result = await generateAssistantReply(from, controller.signal)
    res.json({ ...result, userMessageId })
  } catch (err) {
    if (err.name === 'AbortError') {
      console.log('message cancelled by client, generation stopped')
      return
    }
    console.error('agent failed', err)
    if (!res.headersSent) res.status(500).json({ error: 'agent failed' })
  }
})

app.post('/sessions/:id/messages/:messageId/edit', async (req, res) => {
  const { id, messageId } = req.params
  const { text } = req.body || {}
  if (!text) return res.status(400).json({ error: 'missing text' })

  await deleteMessagesFrom(id, Number(messageId))

  const userContent = await buildUserContent(id, text)
  await appendMessage(id, { role: 'user', content: userContent })

  const controller = new AbortController()
  req.on('close', () => controller.abort())

  try {
    const result = await generateAssistantReply(id, controller.signal)
    res.json(result)
  } catch (err) {
    if (err.name === 'AbortError') {
      console.log('message cancelled by client, generation stopped')
      return
    }
    console.error('agent failed', err)
    if (!res.headersSent) res.status(500).json({ error: 'agent failed' })
  }
})

app.get('/sessions', async (_req, res) => {
  res.json({ sessions: await listSessions() })
})

app.post('/sessions', async (req, res) => {
  const { id, title } = req.body || {}
  if (!id) return res.status(400).json({ error: 'missing id' })
  await ensureSession(id, title || null)
  res.json({ ok: true })
})

app.get('/sessions/:id/messages', async (req, res) => {
  res.json({ messages: await getConversationForDisplay(req.params.id) })
})

app.delete('/sessions/:id', async (req, res) => {
  await deleteSession(req.params.id)
  res.json({ ok: true })
})

app.post('/upload', upload.single('file'), async (req, res) => {
  const { from } = req.body || {}
  if (!from || !req.file) return res.status(400).json({ error: 'missing from/file' })

  try {
    const text = await extractText(req.file.buffer, req.file.mimetype)
    if (text) pendingDocuments.set(from, { text, filename: req.file.originalname })

    let downloadUrl
    if (req.file.mimetype.startsWith('image/')) {
      const pdfBuffer = await imageToPdf(req.file.buffer, req.file.mimetype)
      const filename = req.file.originalname.replace(/\.[^.]+$/, '') + '.pdf'
      const id = storeFile(pdfBuffer, filename, 'application/pdf')
      downloadUrl = `${PUBLIC_BASE_URL}/files/${id}`
    }

    if (!text && !downloadUrl) {
      return res.status(422).json({
        error: 'não consegui extrair texto desse arquivo (ex.: PDF escaneado sem camada de texto)',
      })
    }
    res.json({ ok: true, preview: text?.slice(0, 200), downloadUrl })
  } catch (err) {
    console.error('document extraction failed', err)
    res.status(500).json({ error: 'falha ao processar o arquivo' })
  }
})

app.get('/files/:id', (req, res) => {
  const file = files.get(req.params.id)
  if (!file) return res.status(404).send('not found')
  res.setHeader('content-type', file.contentType)
  res.setHeader('content-disposition', `attachment; filename="${file.filename}"`)
  res.send(file.buffer)
})

Promise.all([initMemory(), initSessions()])
  .then(() => app.listen(PORT, () => console.log(`agent-backend listening on ${PORT}`)))
  .catch((err) => {
    console.error('failed to init database', err)
    process.exit(1)
  })
