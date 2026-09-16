import { convert as htmlToText } from 'html-to-text'
import { patchSecret } from './k8s.js'
import { initNotes, getKnownModifiedTimes, upsertNote } from './db.js'
import { embed } from './llm.js'

const CLIENT_ID = process.env.ONENOTE_CLIENT_ID
const REFRESH_TOKEN = process.env.ONENOTE_REFRESH_TOKEN
const SECRET_NAME = process.env.ONENOTE_SECRET_NAME || 'onenote-sync-secrets'
const TENANT = 'consumers'
const CONTENT_MAX_CHARS = 8000

if (!CLIENT_ID || !REFRESH_TOKEN) {
  console.error('ONENOTE_CLIENT_ID e ONENOTE_REFRESH_TOKEN são obrigatórios')
  process.exit(1)
}

async function refreshAccessToken() {
  const res = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: REFRESH_TOKEN,
      scope: 'offline_access Notes.Read',
    }),
  })
  if (!res.ok) throw new Error(`token refresh failed: ${res.status} ${await res.text()}`)
  return res.json()
}

async function listPages(accessToken) {
  const pages = []
  let url =
    'https://graph.microsoft.com/v1.0/me/onenote/pages?$top=100&$select=id,title,lastModifiedDateTime'

  while (url) {
    const res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } })
    if (!res.ok) throw new Error(`list pages failed: ${res.status} ${await res.text()}`)
    const data = await res.json()
    pages.push(...data.value)
    url = data['@odata.nextLink']
  }

  return pages
}

async function fetchPageText(accessToken, pageId) {
  const res = await fetch(`https://graph.microsoft.com/v1.0/me/onenote/pages/${pageId}/content`, {
    headers: { authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) throw new Error(`fetch page content failed: ${res.status} ${await res.text()}`)
  const html = await res.text()
  return htmlToText(html, { wordwrap: false }).trim().slice(0, CONTENT_MAX_CHARS)
}

async function main() {
  console.log('renovando access token...')
  const tokens = await refreshAccessToken()

  // Microsoft rotates the refresh token on every use - persist the new one
  // right away, before doing anything else that could fail.
  await patchSecret(SECRET_NAME, { 'refresh-token': tokens.refresh_token })
  console.log('refresh token atualizado no secret')

  await initNotes()
  const known = await getKnownModifiedTimes()

  console.log('listando páginas do OneNote...')
  const pages = await listPages(tokens.access_token)
  console.log(`${pages.length} páginas encontradas`)

  let synced = 0
  let skipped = 0

  for (const page of pages) {
    const knownModified = known.get(page.id)
    if (knownModified && knownModified >= page.lastModifiedDateTime) {
      skipped++
      continue
    }

    try {
      const text = await fetchPageText(tokens.access_token, page.id)
      if (!text) continue
      const embedding = await embed(`${page.title}\n\n${text}`)
      await upsertNote(page.id, page.title, text, embedding, page.lastModifiedDateTime)
      synced++
    } catch (err) {
      console.error(`falha ao sincronizar página "${page.title}":`, err.message)
    }
  }

  console.log(`sincronização concluída: ${synced} atualizadas, ${skipped} sem mudança`)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('sync failed', err)
    process.exit(1)
  })
