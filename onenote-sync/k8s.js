// Minimal in-cluster Kubernetes API client - just enough to patch one
// Secret (the rotating refresh token). Avoids pulling in a full client
// library for a single PATCH call.
import fs from 'node:fs'

const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount'
const API = `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT}`

function readSA(file) {
  return fs.readFileSync(`${SA_DIR}/${file}`, 'utf8').trim()
}

export async function patchSecret(name, stringData) {
  const token = readSA('token')
  const namespace = readSA('namespace')

  const data = Object.fromEntries(
    Object.entries(stringData).map(([k, v]) => [k, Buffer.from(v).toString('base64')])
  )

  const res = await fetch(`${API}/api/v1/namespaces/${namespace}/secrets/${name}`, {
    method: 'PATCH',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/merge-patch+json',
    },
    body: JSON.stringify({ data }),
  })

  if (!res.ok) {
    throw new Error(`failed to patch secret ${name}: ${res.status} ${await res.text()}`)
  }
}
