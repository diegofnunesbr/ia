import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import { authenticator } from 'otplib'
import { parse as parseCookie, serialize as serializeCookie } from 'cookie'

// Single-user login replacing Authelia: password + TOTP, no SSO/subdomain
// needed since everything lives behind this one origin (web-frontend's
// nginx proxies /api/ here, so the session cookie just works with the
// Ingress hostname - no cross-domain cookie sharing to worry about).
const USERNAME = process.env.AUTH_USERNAME
const PASSWORD_HASH = process.env.AUTH_PASSWORD_HASH
const TOTP_SECRET = process.env.AUTH_TOTP_SECRET
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days, matches the old "remember me"

if (!USERNAME || !PASSWORD_HASH || !TOTP_SECRET) {
  throw new Error('AUTH_USERNAME, AUTH_PASSWORD_HASH and AUTH_TOTP_SECRET must all be set')
}

// token -> expiresAt. In-memory only - a restart logs everyone out, which
// is an acceptable trade-off for a single-user personal tool over the
// complexity of a persisted session store.
const sessions = new Map()

setInterval(() => {
  const now = Date.now()
  for (const [token, expiresAt] of sessions) if (expiresAt < now) sessions.delete(token)
}, 60 * 60 * 1000).unref()

export function verifyCredentials(username, password, totpCode) {
  if (username !== USERNAME) return false
  if (!bcrypt.compareSync(password, PASSWORD_HASH)) return false
  return authenticator.check(totpCode, TOTP_SECRET)
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

const COOKIE_NAME = 'ia_session'

function getSessionToken(req) {
  const header = req.headers.cookie
  if (!header) return null
  return parseCookie(header)[COOKIE_NAME] || null
}

export function requireAuth(req, res, next) {
  const token = getSessionToken(req)
  if (token && isValidSession(token)) return next()
  res.status(401).json({ error: 'não autenticado' })
}

export function setSessionCookie(res, token) {
  res.setHeader(
    'Set-Cookie',
    serializeCookie(COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: SESSION_TTL_MS / 1000,
      path: '/',
    })
  )
}

export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', serializeCookie(COOKIE_NAME, '', { maxAge: 0, path: '/' }))
}

export { getSessionToken }
