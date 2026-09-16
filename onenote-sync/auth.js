// One-time interactive login (device code flow) to get a refresh token for
// the OneNote sync job. Run this locally with `node auth.js` - it opens no
// browser automatically, just prints a URL/code for you to enter manually.
// The printed refresh token goes into the onenote-sync-secrets Secret
// (see README), the sync job takes it from there.

const CLIENT_ID = process.env.ONENOTE_CLIENT_ID
const SCOPES = 'offline_access Notes.Read'
const TENANT = 'consumers' // personal Microsoft account

if (!CLIENT_ID) {
  console.error('Defina ONENOTE_CLIENT_ID (o Application (client) ID do app registrado no Azure AD).')
  process.exit(1)
}

async function startDeviceFlow() {
  const res = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/devicecode`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, scope: SCOPES }),
  })
  if (!res.ok) throw new Error(`devicecode request failed: ${res.status} ${await res.text()}`)
  return res.json()
}

async function pollForToken(deviceCode, intervalSec) {
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    client_id: CLIENT_ID,
    device_code: deviceCode,
  })

  while (true) {
    await new Promise((r) => setTimeout(r, intervalSec * 1000))

    const res = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    })
    const data = await res.json()

    if (res.ok) return data
    if (data.error === 'authorization_pending') continue
    if (data.error === 'slow_down') {
      intervalSec += 5
      continue
    }
    throw new Error(`token request failed: ${data.error} - ${data.error_description}`)
  }
}

const flow = await startDeviceFlow()
console.log(flow.message)
console.log('\nAguardando você fazer login...')

const tokens = await pollForToken(flow.device_code, flow.interval || 5)

console.log('\nLogin ok. Guarde este refresh token no secret onenote-sync-secrets (campo refresh-token):\n')
console.log(tokens.refresh_token)
