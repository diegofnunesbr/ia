const loginScreen = document.getElementById('loginScreen')
const loginForm = document.getElementById('loginForm')
const loginUsername = document.getElementById('loginUsername')
const loginPassword = document.getElementById('loginPassword')
const loginError = document.getElementById('loginError')
const appEl = document.getElementById('app')
const logoutBtn = document.getElementById('logoutBtn')

const messagesEl = document.getElementById('messages')
const messagesScrollEl = document.getElementById('messagesScroll')
const form = document.getElementById('form')
const input = document.getElementById('input')
const sendBtn = document.getElementById('sendBtn')
const micBtn = document.getElementById('mic')
const attachBtn = document.getElementById('attach')
const fileInput = document.getElementById('fileInput')
const sessionListEl = document.getElementById('sessionList')
const newChatBtn = document.getElementById('newChat')
const sidebar = document.getElementById('sidebar')
const menuToggle = document.getElementById('menuToggle')

const CURRENT_SESSION_KEY = 'assistant-current-session-id'
let sessionId = localStorage.getItem(CURRENT_SESSION_KEY)

function newSessionId() {
  return 'web-' + crypto.randomUUID()
}

function setCurrentSession(id) {
  sessionId = id
  localStorage.setItem(CURRENT_SESSION_KEY, id)
}

async function apiCreateSession(id, title) {
  await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, title: title || null }),
  })
}

async function fetchSessions() {
  const res = await fetch('/api/sessions')
  const data = await res.json()
  return data.sessions || []
}

async function fetchSessionMessages(id) {
  const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/messages`)
  const data = await res.json()
  return data.messages || []
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

// Small, dependency-free markdown renderer covering what the model
// actually produces (code blocks, inline code, bold, italic) - escapes
// HTML first so nothing the model writes can inject markup.
function markdownToHtml(text) {
  const codeBlocks = []
  let safe = escapeHtml(text).replace(/```[\w-]*\n?([\s\S]*?)```/g, (_, code) => {
    codeBlocks.push(code.trim())
    return `@@CB@@${codeBlocks.length - 1}@@CB@@`
  })

  safe = safe
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>')

  safe = safe.replace(
    /@@CB@@(\d+)@@CB@@/g,
    (_, i) => `<div class="code-block"><button type="button" class="copy-btn">Copiar</button><pre><code>${codeBlocks[i]}</code></pre></div>`
  )

  return safe
}

// Event delegation because code blocks are injected via innerHTML, not
// created with addEventListener attached individually.
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.copy-btn')
  if (!btn) return
  const code = btn.parentElement.querySelector('code')
  try {
    await navigator.clipboard.writeText(code.textContent)
    const original = btn.textContent
    btn.textContent = 'Copiado!'
    setTimeout(() => { btn.textContent = original }, 1500)
  } catch (err) {
    console.error('copy failed', err)
  }
})

function addMessage(role, text, downloadUrl) {
  document.getElementById('emptyState')?.remove()

  const el = document.createElement('div')
  el.className = `msg ${role}`
  if (role === 'assistant') {
    el.innerHTML = markdownToHtml(text)
  } else {
    el.textContent = text
  }
  if (downloadUrl) {
    const link = document.createElement('a')
    link.href = downloadUrl
    link.textContent = '⬇ Baixar arquivo'
    link.className = 'download-link'
    link.target = '_blank'
    el.appendChild(document.createElement('br'))
    el.appendChild(link)
  }
  messagesEl.appendChild(el)
  messagesScrollEl.scrollTop = messagesScrollEl.scrollHeight
}

function resetMessages() {
  messagesEl.innerHTML = '<div id="emptyState" class="empty-state"><p>Como posso ajudar hoje?</p></div>'
}

function renderMessages(messages) {
  resetMessages()
  for (const m of messages) addMessage(m.role, m.content)
}

async function renderSessionList() {
  const sessions = await fetchSessions()
  sessionListEl.innerHTML = ''

  for (const s of sessions) {
    const item = document.createElement('div')
    item.className = 'session-item' + (s.id === sessionId ? ' active' : '')

    const title = document.createElement('span')
    title.className = 'title'
    title.textContent = s.title || 'Nova conversa'
    item.appendChild(title)

    const delBtn = document.createElement('button')
    delBtn.className = 'delete-btn'
    delBtn.textContent = '🗑'
    delBtn.title = 'Excluir conversa'
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation()
      if (!confirm('Excluir essa conversa?')) return
      await fetch(`/api/sessions/${encodeURIComponent(s.id)}`, { method: 'DELETE' })
      if (s.id === sessionId) await startNewSession()
      renderSessionList()
    })
    item.appendChild(delBtn)

    item.addEventListener('click', () => switchToSession(s.id))
    sessionListEl.appendChild(item)
  }
}

async function switchToSession(id) {
  setCurrentSession(id)
  renderMessages(await fetchSessionMessages(id))
  renderSessionList()
  sidebar.classList.remove('open')
}

async function startNewSession() {
  const id = newSessionId()
  await apiCreateSession(id)
  setCurrentSession(id)
  resetMessages()
  renderSessionList()
  sidebar.classList.remove('open')
}

newChatBtn.addEventListener('click', () => startNewSession())
menuToggle.addEventListener('click', () => sidebar.classList.toggle('open'))

// Strips markdown so the text-to-speech doesn't read out symbols like
// "asterisco asterisco" or "crase crase crase python" - the screen keeps
// the original formatted text, only the spoken version is cleaned up.
function stripMarkdownForSpeech(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' (veja o código na tela) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/\n{2,}/g, '. ')
    .trim()
}

function speak(text) {
  if (!('speechSynthesis' in window)) return
  const utterance = new SpeechSynthesisUtterance(stripMarkdownForSpeech(text))
  utterance.lang = 'pt-BR'
  speechSynthesis.speak(utterance)
}

function addTypingIndicator() {
  const el = document.createElement('div')
  el.className = 'msg assistant typing'
  el.textContent = 'Pensando...'
  messagesEl.appendChild(el)
  messagesScrollEl.scrollTop = messagesScrollEl.scrollHeight
  return el
}

let waitingForReply = false
let activeController = null

// While waiting for a reply, the send button becomes a stop button in the
// same spot - same pattern as ChatGPT's stop-generating button.
function setWaiting(waiting) {
  waitingForReply = waiting
  input.disabled = waiting
  sendBtn.title = waiting ? 'Parar' : 'Enviar'
  sendBtn.classList.toggle('stop', waiting)
}

async function sendMessage(text, viaVoice = false) {
  if (!text.trim()) return
  // Ollama only handles one request at a time (OLLAMA_NUM_PARALLEL=1) -
  // sending another message before the first finishes just queues it up
  // and makes both take longer, with no feedback why.
  if (waitingForReply) return

  setWaiting(true)
  addMessage('user', text)
  input.value = ''

  const controller = new AbortController()
  activeController = controller
  const typingEl = addTypingIndicator()

  try {
    const res = await fetch('/api/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: sessionId, text }),
      signal: controller.signal,
    })
    const data = await res.json()
    const reply = data.reply || 'Desculpa, não consegui responder agora.'
    typingEl.remove()
    addMessage('assistant', reply, data.downloadUrl)
    if (viaVoice) speak(reply)
  } catch (err) {
    typingEl.remove()
    if (err.name === 'AbortError') {
      addMessage('assistant', 'Cancelado.')
    } else {
      addMessage('assistant', 'Erro ao falar com o assistente.')
      console.error(err)
    }
  } finally {
    activeController = null
    setWaiting(false)
    input.focus()
    renderSessionList()
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault()
  if (waitingForReply) {
    activeController?.abort()
    return
  }
  sendMessage(input.value)
})

attachBtn.addEventListener('click', () => fileInput.click())

fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0]
  fileInput.value = ''
  if (!file) return

  addMessage('user', `📎 ${file.name}`)
  const formData = new FormData()
  formData.append('from', sessionId)
  formData.append('file', file)

  try {
    const res = await fetch('/api/upload', { method: 'POST', body: formData })
    const data = await res.json()
    if (!res.ok) {
      addMessage('assistant', data.error || 'Não consegui ler esse arquivo.')
      return
    }
    const message = data.downloadUrl
      ? 'Convertido para PDF - já pode baixar. Também posso responder sobre o conteúdo.'
      : 'Documento lido, pode perguntar sobre ele.'
    addMessage('assistant', message, data.downloadUrl)
  } catch (err) {
    addMessage('assistant', 'Erro ao enviar o arquivo.')
    console.error(err)
  }
})

// Voice input via the browser's SpeechRecognition API.
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
let recognition
let recording = false

if (SpeechRecognition) {
  recognition = new SpeechRecognition()
  recognition.lang = 'pt-BR'
  recognition.interimResults = false
  recognition.maxAlternatives = 1

  recognition.onresult = (event) => {
    const transcript = event.results[0][0].transcript
    sendMessage(transcript, true)
  }

  recognition.onend = () => {
    recording = false
    micBtn.classList.remove('recording')
  }

  micBtn.addEventListener('click', () => {
    if (recording) {
      recognition.stop()
      return
    }
    recording = true
    micBtn.classList.add('recording')
    recognition.start()
  })
} else {
  micBtn.disabled = true
  micBtn.title = 'Reconhecimento de voz não suportado neste navegador'
}

// Restores the last open session if it still exists, otherwise starts one.
// Only runs once the login gate below confirms there's a valid session.
async function initApp() {
  const sessions = await fetchSessions()
  const stillExists = sessionId && sessions.some((s) => s.id === sessionId)

  if (stillExists) {
    renderMessages(await fetchSessionMessages(sessionId))
    renderSessionList()
  } else {
    await startNewSession()
  }
}

function showLogin() {
  loginScreen.hidden = false
  appEl.hidden = true
}

function showApp() {
  loginScreen.hidden = true
  appEl.hidden = false
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  loginError.hidden = true
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: loginUsername.value,
        password: loginPassword.value,
      }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      loginError.textContent = data.error || 'Falha ao entrar.'
      loginError.hidden = false
      return
    }
    loginPassword.value = ''
    showApp()
    await initApp()
  } catch (err) {
    loginError.textContent = 'Erro ao falar com o servidor.'
    loginError.hidden = false
    console.error(err)
  }
})

logoutBtn.addEventListener('click', async () => {
  try {
    await fetch('/api/logout', { method: 'POST' })
  } catch (err) {
    console.error(err)
  }
  location.reload()
})

// Init: check whether there's already a valid session cookie before
// showing anything - avoids a flash of the chat UI for a logged-out visitor.
;(async () => {
  try {
    const res = await fetch('/api/me')
    const data = await res.json()
    if (data.authenticated) {
      showApp()
      await initApp()
      return
    }
  } catch (err) {
    console.error(err)
  }
  showLogin()
})()
