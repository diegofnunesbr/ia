import express from 'express'
import qrcode from 'qrcode-terminal'
import pino from 'pino'
import baileys from '@whiskeysockets/baileys'

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } =
  baileys

const AUTH_DIR = process.env.AUTH_DIR || '/data/auth'
const AGENT_URL = process.env.AGENT_URL || 'http://agent-backend:3000/message'
const ALLOWED_NUMBER = process.env.ALLOWED_NUMBER // e.g. "5511999999999" (only this JID is answered)
const PORT = process.env.PORT || 3001

// Deterministic media task: convert an image sent in a specific group to
// PDF and send it back instantly, without going through the LLM.
const PDF_GROUP_ID = process.env.PDF_GROUP_ID // e.g. "1203630xxxxxxxxx@g.us"
const PDF_TRIGGER_WORD = (process.env.PDF_TRIGGER_WORD || 'pdf').toLowerCase()
const IMAGE_TO_PDF_URL = process.env.IMAGE_TO_PDF_URL || 'http://image-to-pdf:8000/convert'

const logger = pino({ level: process.env.LOG_LEVEL || 'info' })

// Rolling per-group cache of recent image messages, so the agent can later
// ask "convert the images from group X" without needing full chat history
// (Baileys/WhatsApp don't expose that easily). Only images received while
// this process is running are available.
const GROUP_IMAGE_CACHE = new Map() // jid -> [{ msg, timestamp }]
const IMAGE_CACHE_MAX = 50
const IMAGE_CACHE_TTL_MS = 24 * 60 * 60 * 1000

function cacheGroupImage(jid, msg) {
  if (!msg.message?.imageMessage) return
  const cutoff = Date.now() - IMAGE_CACHE_TTL_MS
  const list = (GROUP_IMAGE_CACHE.get(jid) || []).filter((e) => e.timestamp >= cutoff)
  list.push({ msg, timestamp: Date.now() })
  GROUP_IMAGE_CACHE.set(jid, list.slice(-IMAGE_CACHE_MAX))
}

// Best-effort contact directory: WhatsApp doesn't hand over your full phone
// contact list easily through Baileys, so this fills in from whatever the
// app syncs (contacts.upsert/update) plus the display name of anyone who
// messages while the bridge is running. Good enough to resolve "fulano" to
// a JID for people you actually talk to.
const CONTACT_CACHE = new Map() // jid -> name

function cacheContact(jid, name) {
  if (!jid || !name) return
  CONTACT_CACHE.set(jid, name)
}

// Rolling cache of recent text messages per chat (DM or group), so the
// assistant can answer "any new messages?" without a real inbox API.
const MESSAGE_CACHE = new Map() // jid -> [{ text, senderName, fromMe, timestamp }]
const MESSAGE_CACHE_MAX = 100
const MESSAGE_CACHE_TTL_MS = 24 * 60 * 60 * 1000
let lastCheckedAt = Date.now()

function cacheMessage(jid, entry) {
  const cutoff = Date.now() - MESSAGE_CACHE_TTL_MS
  const list = (MESSAGE_CACHE.get(jid) || []).filter((e) => e.timestamp >= cutoff)
  list.push(entry)
  MESSAGE_CACHE.set(jid, list.slice(-MESSAGE_CACHE_MAX))
}

function extractText(msg) {
  return msg.message?.conversation || msg.message?.extendedTextMessage?.text || ''
}

let sock

async function startSocket() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)

  sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('contacts.upsert', (contacts) => {
    for (const c of contacts) cacheContact(c.id, c.name || c.notify)
  })
  sock.ev.on('contacts.update', (updates) => {
    for (const c of updates) cacheContact(c.id, c.name || c.notify)
  })

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update
    if (qr) {
      logger.info('Scan the QR code below with WhatsApp (Linked devices):')
      qrcode.generate(qr, { small: true })
    }
    if (connection === 'close') {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
      logger.warn({ shouldReconnect }, 'connection closed')
      if (shouldReconnect) startSocket()
    } else if (connection === 'open') {
      logger.info('WhatsApp connection open')
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    for (const msg of messages) {
      const jid = msg.key.remoteJid
      if (!jid) continue

      if (msg.pushName) {
        const senderJid = msg.key.participant || jid
        cacheContact(senderJid, msg.pushName)
      }

      const text = extractText(msg)
      if (text) {
        cacheMessage(jid, {
          text,
          senderName: msg.pushName || jid,
          fromMe: !!msg.key.fromMe,
          timestamp: Date.now(),
        })
      }

      if (msg.key.fromMe) continue

      if (jid.endsWith('@g.us')) {
        cacheGroupImage(jid, msg)
        if (PDF_GROUP_ID && jid === PDF_GROUP_ID) {
          await handleImageToPdf(msg, jid)
        }
        continue
      }

      if (ALLOWED_NUMBER && jid !== `${ALLOWED_NUMBER}@s.whatsapp.net`) {
        logger.warn({ jid }, 'ignoring message from non-allowed number')
        continue
      }

      if (!text) continue

      try {
        const res = await fetch(AGENT_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ from: jid, text }),
        })
        const data = await res.json()
        if (data?.reply) {
          await sock.sendMessage(jid, { text: data.reply })
        }
      } catch (err) {
        logger.error({ err }, 'failed to reach agent-backend')
        await sock.sendMessage(jid, {
          text: 'Desculpa, tive um problema pra processar isso agora.',
        })
      }
    }
  })
}

async function handleImageToPdf(msg, jid) {
  const imageMessage = msg.message?.imageMessage
  if (!imageMessage) return

  // Only the owner can trigger this inside the group - otherwise anyone
  // else in the group could spend your CPU/bandwidth converting images.
  if (ALLOWED_NUMBER) {
    const senderJid = msg.key.participant
    if (senderJid !== `${ALLOWED_NUMBER}@s.whatsapp.net`) return
  }

  const caption = (imageMessage.caption || '').toLowerCase()
  if (!caption.includes(PDF_TRIGGER_WORD)) return

  try {
    const buffer = await downloadMediaMessage(msg, 'buffer', {})

    const form = new FormData()
    form.append(
      'files',
      new Blob([buffer], { type: imageMessage.mimetype || 'image/jpeg' }),
      'imagem.jpg'
    )
    form.append('page_size', 'Original')
    form.append('margin', '0')
    form.append('quality', 'high')

    const res = await fetch(IMAGE_TO_PDF_URL, { method: 'POST', body: form })
    if (!res.ok) throw new Error(`image-to-pdf returned ${res.status}`)
    const pdfBuffer = Buffer.from(await res.arrayBuffer())

    await sock.sendMessage(
      jid,
      { document: pdfBuffer, mimetype: 'application/pdf', fileName: 'imagem.pdf' },
      { quoted: msg }
    )
    logger.info({ jid }, 'sent converted pdf')
  } catch (err) {
    logger.error({ err }, 'failed to convert image to pdf')
    await sock.sendMessage(
      jid,
      { text: 'Não consegui converter essa imagem para PDF agora.' },
      { quoted: msg }
    )
  }
}

startSocket().catch((err) => {
  logger.error({ err }, 'failed to start whatsapp socket')
  process.exit(1)
})

// HTTP endpoint so the agent-backend (e.g. scheduled reminders) can push
// proactive messages back out through WhatsApp.
const app = express()
app.use(express.json())

app.post('/send', async (req, res) => {
  const { to, text } = req.body || {}
  if (!to || !text) return res.status(400).json({ error: 'missing to/text' })
  try {
    await sock.sendMessage(to, { text })
    res.json({ ok: true })
  } catch (err) {
    logger.error({ err }, 'failed to send message')
    res.status(500).json({ error: 'send failed' })
  }
})

// Used by the agent-backend to resolve a group name (e.g. "Pessoal") to a JID.
app.get('/groups', async (_req, res) => {
  try {
    const groups = await sock.groupFetchAllParticipating()
    const list = Object.values(groups).map((g) => ({ jid: g.id, name: g.subject }))
    res.json({ groups: list })
  } catch (err) {
    logger.error({ err }, 'failed to fetch groups')
    res.status(500).json({ error: 'failed to fetch groups' })
  }
})

// Best-effort contact list, built from what WhatsApp has synced plus
// whoever has messaged while the bridge was running (see CONTACT_CACHE).
app.get('/contacts', (_req, res) => {
  const contacts = [...CONTACT_CACHE.entries()].map(([jid, name]) => ({ jid, name }))
  res.json({ contacts })
})

// Messages received since the last time this was called (across every
// chat, DM or group). Meant for "do I have anything new?" style questions.
app.get('/messages/new', (_req, res) => {
  const since = lastCheckedAt
  const now = Date.now()
  const messages = []

  for (const [jid, entries] of MESSAGE_CACHE) {
    for (const entry of entries) {
      if (entry.fromMe) continue
      if (entry.timestamp <= since) continue
      messages.push({ jid, ...entry })
    }
  }

  lastCheckedAt = now
  messages.sort((a, b) => a.timestamp - b.timestamp)
  res.json({ messages })
})

app.post('/send-text', async (req, res) => {
  const { to, text } = req.body || {}
  if (!to || !text) return res.status(400).json({ error: 'missing to/text' })
  try {
    await sock.sendMessage(to, { text })
    res.json({ ok: true })
  } catch (err) {
    logger.error({ err, to }, 'failed to send text')
    res.status(500).json({ error: 'send failed' })
  }
})

app.post('/groups', async (req, res) => {
  const { name, participants } = req.body || {}
  if (!name || !Array.isArray(participants) || participants.length === 0) {
    return res.status(400).json({ error: 'missing name/participants' })
  }
  try {
    const participantJids = participants.map((p) =>
      p.includes('@') ? p : `${p.replace(/\D/g, '')}@s.whatsapp.net`
    )
    const group = await sock.groupCreate(name, participantJids)
    res.json({ jid: group.id, name })
  } catch (err) {
    logger.error({ err, name }, 'failed to create group')
    res.status(500).json({ error: 'group creation failed' })
  }
})

// Converts the cached recent images of a group into a single PDF and
// returns the PDF bytes directly (the caller - agent-backend - is
// responsible for storing it and handing the user a download link).
app.post('/groups/:jid/convert-images', async (req, res) => {
  const jid = decodeURIComponent(req.params.jid)
  const limit = Number(req.body?.limit) || IMAGE_CACHE_MAX
  const cached = (GROUP_IMAGE_CACHE.get(jid) || []).slice(-limit)

  if (cached.length === 0) {
    return res.status(404).json({ error: 'no recent images cached for this group' })
  }

  try {
    const form = new FormData()
    for (const [i, entry] of cached.entries()) {
      const buffer = await downloadMediaMessage(entry.msg, 'buffer', {})
      const mimetype = entry.msg.message?.imageMessage?.mimetype || 'image/jpeg'
      form.append('files', new Blob([buffer], { type: mimetype }), `imagem-${i + 1}.jpg`)
    }
    form.append('page_size', 'Original')
    form.append('margin', '0')
    form.append('quality', 'high')

    const convertRes = await fetch(IMAGE_TO_PDF_URL, { method: 'POST', body: form })
    if (!convertRes.ok) throw new Error(`image-to-pdf returned ${convertRes.status}`)
    const pdfBuffer = Buffer.from(await convertRes.arrayBuffer())

    res.setHeader('content-type', 'application/pdf')
    res.send(pdfBuffer)
  } catch (err) {
    logger.error({ err, jid }, 'failed to convert group images')
    res.status(500).json({ error: 'conversion failed' })
  }
})

app.get('/health', (_req, res) => res.json({ ok: true }))

app.listen(PORT, () => logger.info(`whatsapp-bridge HTTP listening on ${PORT}`))
