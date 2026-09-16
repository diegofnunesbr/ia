const messagesEl = document.getElementById('messages')
const form = document.getElementById('form')
const input = document.getElementById('input')
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

function addMessage(role, text, downloadUrl) {
  const el = document.createElement('div')
  el.className = `msg ${role}`
  el.textContent = text
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
  messagesEl.scrollTop = messagesEl.scrollHeight
}

function renderMessages(messages) {
  messagesEl.innerHTML = ''
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
  messagesEl.innerHTML = ''
  renderSessionList()
  sidebar.classList.remove('open')
}

newChatBtn.addEventListener('click', () => startNewSession())
menuToggle.addEventListener('click', () => sidebar.classList.toggle('open'))

function speak(text) {
  if (!('speechSynthesis' in window)) return
  const utterance = new SpeechSynthesisUtterance(text)
  utterance.lang = 'pt-BR'
  speechSynthesis.speak(utterance)
}

function addTypingIndicator() {
  const el = document.createElement('div')
  el.className = 'msg assistant typing'
  el.textContent = 'Pensando...'
  messagesEl.appendChild(el)
  messagesEl.scrollTop = messagesEl.scrollHeight
  return el
}

async function sendMessage(text) {
  if (!text.trim()) return
  addMessage('user', text)
  input.value = ''

  const typingEl = addTypingIndicator()

  try {
    const res = await fetch('/api/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: sessionId, text }),
    })
    const data = await res.json()
    const reply = data.reply || 'Desculpa, não consegui responder agora.'
    typingEl.remove()
    addMessage('assistant', reply, data.downloadUrl)
    speak(reply)
  } catch (err) {
    typingEl.remove()
    addMessage('assistant', 'Erro ao falar com o assistente.')
    console.error(err)
  } finally {
    renderSessionList()
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault()
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
    addMessage('assistant', 'Documento lido, pode perguntar sobre ele.')
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
    sendMessage(transcript)
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

// Init: restore the last open session if it still exists, otherwise start one.
;(async () => {
  const sessions = await fetchSessions()
  const stillExists = sessionId && sessions.some((s) => s.id === sessionId)

  if (stillExists) {
    renderMessages(await fetchSessionMessages(sessionId))
    renderSessionList()
  } else {
    await startNewSession()
  }
})()
