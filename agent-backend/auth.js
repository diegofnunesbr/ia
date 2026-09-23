import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import { parse as parseCookie, serialize as serializeCookie } from 'cookie'

// Single-user login (username + password) - no SSO/subdomain needed since
// everything lives behind this one origin (web-frontend's nginx proxies
// /api/ here, so the session cookie just works with the Ingress hostname).
const USERNAME = process.env.AUTH_USERNAME
const PASSWORD_HASH = process.env.AUTH_PASSWORD_HASH
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

if (!USERNAME || !PASSWORD_HASH) {
  throw new Error('AUTH_USERNAME and AUTH_PASSWORD_HASH must both be set')
}

// token -> expiresAt. In-memory only - a restart logs everyone out, which
// is an acceptable trade-off for a single-user personal tool over the
// complexity of a persisted session store.
const sessions = new Map()

setInterval(() => {
  const now = Date.now()
  for (const [token, expiresAt] of sessions) if (expiresAt < now) sessions.delete(token)
}, 60 * 60 * 1000).unref()

export function verifyCredentials(username, password) {
  if (username !== USERNAME) return false
  return bcrypt.compareSync(password, PASSWORD_HASH)
}

export function createSession() {
  const token = crypto.randomBytes(32).toString('hex')
  sessions.set(token, Date.now() + SESSION_TTL_MS)
  return token
}

export function isValidSession(token) {
  const expiresAt = sessions.get(token)
  if (!expiresAt) return false
  if (expiresAt < Date.now()) {
    sessions.delete(token)
    return false
  }
  return true
}

export function destroySession(token) {
  sessions.delete(token)
}

const SESSION_COOKIE = 'ia_session'

export function getSessionToken(req) {
  const header = req.headers.cookie
  if (!header) return null
  return parseCookie(header)[SESSION_COOKIE] || null
}

export function requireAuth(req, res, next) {
  const token = getSessionToken(req)
  if (token && isValidSession(token)) return next()
  res.status(401).json({ error: 'não autenticado' })
}

export function setSessionCookie(res, token) {
  res.setHeader(
    'Set-Cookie',
    serializeCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: SESSION_TTL_MS / 1000,
      path: '/',
    })
  )
}

export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE, '', { maxAge: 0, path: '/' }))
}
