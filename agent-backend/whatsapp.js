const WHATSAPP_BRIDGE_URL = process.env.WHATSAPP_BRIDGE_URL || 'http://whatsapp-bridge:3001'
const USER_WHATSAPP_JID = process.env.USER_WHATSAPP_JID // e.g. "5511999999999@s.whatsapp.net"

export async function listGroups() {
  const res = await fetch(`${WHATSAPP_BRIDGE_URL}/groups`)
  if (!res.ok) throw new Error(`whatsapp-bridge /groups returned ${res.status}`)
  return (await res.json()).groups
}

export async function listContacts() {
  const res = await fetch(`${WHATSAPP_BRIDGE_URL}/contacts`)
  if (!res.ok) throw new Error(`whatsapp-bridge /contacts returned ${res.status}`)
  return (await res.json()).contacts
}

export async function resolveGroup(groupName) {
  const groups = await listGroups()
  const needle = groupName.trim().toLowerCase()
  return (
    groups.find((g) => g.name?.toLowerCase() === needle) ||
    groups.find((g) => g.name?.toLowerCase().includes(needle))
  )
}

// Contacts only get resolved by name for people the bridge has already
// seen (WhatsApp doesn't hand over your full phone contact list easily).
// If it looks like a phone number, ask WhatsApp for the real JID instead
// of guessing "<number>@s.whatsapp.net" - some accounts now use the
// newer "@lid" identifier, and a wrong guess sends into the void with
// no error at all.
export async function resolveContact(nameOrNumber) {
  const digits = nameOrNumber.replace(/\D/g, '')
  if (digits.length >= 10) {
    const res = await fetch(`${WHATSAPP_BRIDGE_URL}/resolve/${digits}`)
    if (!res.ok) return null
    const { jid } = await res.json()
    return { jid, name: nameOrNumber }
  }

  const contacts = await listContacts()
  const needle = nameOrNumber.trim().toLowerCase()
  return (
    contacts.find((c) => c.name?.toLowerCase() === needle) ||
    contacts.find((c) => c.name?.toLowerCase().includes(needle))
  )
}

export async function sendText(to, text) {
  const res = await fetch(`${WHATSAPP_BRIDGE_URL}/send-text`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to, text }),
  })
  if (!res.ok) throw new Error(`whatsapp-bridge /send-text returned ${res.status}`)
  return res.json()
}

export async function createGroup(name, participants) {
  const res = await fetch(`${WHATSAPP_BRIDGE_URL}/groups`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, participants }),
  })
  if (!res.ok) throw new Error(`whatsapp-bridge group creation returned ${res.status}`)
  return res.json()
}

export async function getNewMessages() {
  const res = await fetch(`${WHATSAPP_BRIDGE_URL}/messages/new`)
  if (!res.ok) throw new Error(`whatsapp-bridge /messages/new returned ${res.status}`)
  return (await res.json()).messages
}

export async function convertGroupImages(jid) {
  return fetch(`${WHATSAPP_BRIDGE_URL}/groups/${encodeURIComponent(jid)}/convert-images`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
}

export async function notifyOwner(text) {
  if (!USER_WHATSAPP_JID) throw new Error('USER_WHATSAPP_JID não configurado')
  const res = await fetch(`${WHATSAPP_BRIDGE_URL}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to: USER_WHATSAPP_JID, text }),
  })
  if (!res.ok) throw new Error(`whatsapp-bridge /send returned ${res.status}`)
  return res.json()
}
