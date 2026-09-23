#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

CTX="${KUBE_CONTEXT:-k0s}"
K="kubectl --context=$CTX"
SEALED=k8s/agent-backend-auth-secrets.sealed.yaml
USERNAME_B64=$($K -n ia get secret agent-backend-auth-secrets -o jsonpath='{.data.username}') \
  || { echo "Sem acesso ao ia pelo contexto '$CTX' (ver README do repositório argocd, seção do kubeconfig)."; exit 1; }

read -rsp "Nova senha de login do ia: " PW; echo
read -rsp "Confirme a senha: " PW2; echo
[ -n "$PW" ] && [ "$PW" = "$PW2" ] || { echo "Senhas vazias ou diferentes."; exit 1; }

HASH=$(printf '%s' "$PW" | htpasswd -niBC 10 "" | tr -d ':\n' | sed 's/^\$2y/\$2a/')

git pull --ff-only

cat <<EOF | kubeseal --context "$CTX" --controller-name sealed-secrets --controller-namespace kube-system \
  --scope cluster-wide --format yaml > "$SEALED"
apiVersion: v1
kind: Secret
metadata:
  name: agent-backend-auth-secrets
  namespace: ia
type: Opaque
data:
  username: $USERNAME_B64
  password-hash: $(printf '%s' "$HASH" | base64 -w0)
EOF

git add "$SEALED"
git commit -m "rotate ia login password"
git push

REV=$(git rev-parse HEAD)
$K -n argocd annotate application ia argocd.argoproj.io/refresh=hard --overwrite >/dev/null
echo "Aguardando o Argo CD sincronizar $REV..."
STATUS=""
for _ in $(seq 1 60); do
  STATUS=$($K -n argocd get application ia -o jsonpath='{.status.sync.status} {.status.sync.revision}')
  [[ "$STATUS" == "Synced $REV" ]] && break
  sleep 5
done
[[ "$STATUS" == "Synced $REV" ]] || { echo "Timeout esperando o sync. Rode o restart manualmente depois."; exit 1; }

sleep 5
$K -n ia rollout restart deployment/agent-backend
$K -n ia rollout status deployment/agent-backend --timeout=300s
echo "Pronto. Login em https://ia.diegofnunesbr.com"
