import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import { authenticator } from 'otplib'
import { parse as parseCookie, serialize as serializeCookie } from 'cookie'

// Single-user login: password, then TOTP as a separate step (Proxmox-style
// two-screen flow) - no SSO/subdomain needed since everything lives behind
// this one origin (web-frontend's nginx proxies /api/ here, so the session
// cookie just works with the Ingress hostname).
const USERNAME = process.env.AUTH_USERNAME
const PASSWORD_HASH = process.env.AUTH_PASSWORD_HASH
const TOTP_SECRET = process.env.AUTH_TOTP_SECRET
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days, matches the old "remember me"
const PENDING_TOTP_TTL_MS = 5 * 60 * 1000 // window to enter the TOTP code after password step

if (!USERNAME || !PASSWORD_HASH || !TOTP_SECRET) {
  throw new Error('AUTH_USERNAME, AUTH_PASSWORD_HASH and AUTH_TOTP_SECRET must all be set')
}

// token -> expiresAt. In-memory only - a restart logs everyone out, which
// is an acceptable trade-off for a single-user personal tool over the
// complexity of a persisted session store.
const sessions = new Map()

// pendingToken -> expiresAt. Proves the password step already passed;
// doesn't grant access on its own, only lets the holder attempt the TOTP step.
const pendingTotp = new Map()

setInterval(() => {
  const now = Date.now()
  for (const [token, expiresAt] of sessions) if (expiresAt < now) sessions.delete(token)
  for (const [token, expiresAt] of pendingTotp) if (expiresAt < now) pendingTotp.delete(token)
}, 60 * 60 * 1000).unref()

export function verifyPassword(username, password) {
  if (username !== USERNAME) return false
  return bcrypt.compareSync(password, PASSWORD_HASH)
}

export function createPendingTotp() {
  const token = crypto.randomBytes(32).toString('hex')
  pendingTotp.set(token, Date.now() + PENDING_TOTP_TTL_MS)
  return token
}

export function verifyTotp(pendingToken, code) {
  const expiresAt = pendingTotp.get(pendingToken)
  if (!expiresAt || expiresAt < Date.now()) {
    pendingTotp.delete(pendingToken)
    return false
  }
  if (!authenticator.check(code, TOTP_SECRET)) return false
  pendingTotp.delete(pendingToken)
  return true
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
const PENDING_COOKIE = 'ia_pending_totp'

function getCookie(req, name) {
  const header = req.headers.cookie
  if (!header) return null
  return parseCookie(header)[name] || null
}

export function getSessionToken(req) {
  return getCookie(req, SESSION_COOKIE)
}

export function getPendingTotpToken(req) {
  return getCookie(req, PENDING_COOKIE)
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
      sameSite: 'lax',
      maxAge: SESSION_TTL_MS / 1000,
      path: '/',
    })
  )
}

export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE, '', { maxAge: 0, path: '/' }))
}

export function setPendingTotpCookie(res, token) {
  res.setHeader(
    'Set-Cookie',
    serializeCookie(PENDING_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: PENDING_TOTP_TTL_MS / 1000,
      path: '/',
    })
  )
}

export function clearPendingTotpCookie(res) {
  res.setHeader('Set-Cookie', serializeCookie(PENDING_COOKIE, '', { maxAge: 0, path: '/' }))
}
