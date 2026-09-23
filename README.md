# ia

App de chat (texto + voz) acessível via `https://ia.diegofnunesbr.com`,
100% local: o LLM roda no seu próprio cluster via Ollama, sem nenhuma
chamada para a internet - por isso é seguro colocar senhas/dados
sensíveis na conversa. Login em duas telas (senha, depois código TOTP,
estilo Proxmox) é feito direto no `agent-backend` (ver
`agent-backend/auth.js`), sem depender de subdomínio/SSO externo. Já
tem upload de documento/imagem com OCR local; smart home, câmeras e
impressoras ainda não estão conectadas.

Antes do deploy, troque `OWNER_NAME` em `k8s/agent-backend.yaml` pelo
seu nome/apelido (é o que o assistente usa para se referir a você),
e as credenciais de login em `k8s/secrets.local.yaml` (ver seção
Secrets) pelas suas.

## Serviços

- `web-frontend`: chat web (HTML/JS puro) com barra lateral de
  conversas (criar, trocar, excluir), botão de microfone (Web Speech
  API) e leitura das respostas em voz.
- `agent-backend`: recebe as mensagens e chama o Ollama local. O
  histórico de cada conversa fica no Postgres (tabelas
  `chat_sessions`/`chat_messages`), não em memória - sobrevive a
  restart e permite ter várias conversas separadas, como aqui no
  Claude.
- `ollama`: serve o modelo local (Qwen2.5 3B por padrão) e o modelo
  de embeddings (`nomic-embed-text`) usado pela memória.
- `postgres`: com a extensão `pgvector`, guarda os fatos permanentes
  que o assistente aprende sobre você (nomes, preferências, etc.) e o
  histórico de todas as conversas.

Nota sobre privacidade da voz: o reconhecimento de voz do navegador
(Web Speech API) no Chrome envia o áudio para os servidores da Google
- não é 100% local. Se isso for um problema para você (por causa das
senhas faladas em voz alta), me avise para trocarmos por Whisper
self-hosted.

### Sobre o isolamento de rede

Nenhum serviço tem egress externo - `k8s/network-policy.yaml` bloqueia
tudo exceto DNS e tráfego entre pods do próprio cluster.

## Build das imagens

```bash
docker build -t ia/agent-backend:latest agent-backend/
docker build -t ia/web-frontend:latest web-frontend/
```

Carregue as imagens no seu cluster (import direto se for k3s/k0s, ou
push para um registry local).

O build do `agent-backend` baixa os dados de OCR em português
(`por.traineddata.gz`) uma vez, durante o `docker build` - igual ao
`npm install`, isso roda na sua máquina, fora do cluster, e não é
afetado pela `NetworkPolicy` que trava a rede em tempo de execução.

## Modelo local (Ollama)

Depois do deploy, baixe o modelo dentro do pod do Ollama:

```bash
kubectl exec -n ia deploy/ollama -- ollama pull qwen2.5:3b-instruct
kubectl exec -n ia deploy/ollama -- ollama pull nomic-embed-text
```

Rodando `qwen2.5:3b-instruct` (padrão), CPU sem GPU, sem streaming pro
usuário final (a resposta só aparece pronta, não palavra por palavra):
~10-15s numa pergunta simples, aquecido.

Esse modelo foi escolhido deliberadamente em vez de um 7B/14B maior -
desde que essa VM passou a hospedar vários outros serviços (não só a
IA), o orçamento de CPU/RAM ficou bem mais apertado, e o 3B é o que
cabe confortavelmente nesse espaço menor. Ele comete mais deslizes de
português/precisão que os modelos maiores; se um dia sobrar mais
recursos dedicados, dá pra trocar em `k8s/agent-backend.yaml`
(`AGENT_MODEL`) em troca de mais demora e memória.

## Secrets

**Nunca edite `k8s/secrets.example.yaml` com valores reais** - ele é
só o template, e fica versionado. Copie para um arquivo à parte (já
coberto pelo `.gitignore`) e edite essa cópia:

```bash
cp k8s/secrets.example.yaml k8s/secrets.local.yaml
```

1. Gere o hash da sua senha de login e o segredo do TOTP usando a
   própria imagem do `agent-backend` (já tem `bcryptjs`/`otplib`; roda
   antes do deploy, não depende do pod existir). `read -s` evita a senha
   ecoar ou ficar no histórico do shell:
   ```bash
   docker run --rm -it ia/agent-backend:latest sh -c '
     read -s -p "Senha: " PW; echo
     PW="$PW" node -e "console.log(require(\"bcryptjs\").hashSync(process.env.PW, 10))"
   '
   docker run --rm ia/agent-backend:latest node -e \
     "console.log(require('otplib').authenticator.generateSecret())"
   ```
   Adicione o segredo TOTP no seu app autenticador via **entrada
   manual** (não precisa de QR code - todo app TOTP aceita digitar o
   segredo base32 direto).
2. Preencha `k8s/secrets.local.yaml` com os valores reais (inclui
   `agent-backend-auth-secrets` e `postgres-secrets`), sele cada Secret
   e junte tudo em `k8s/secrets.sealed.yaml` (esse vai pro git, é de lá
   que o Argo CD aplica):
   ```bash
   kubeseal --scope cluster-wide --controller-name sealed-secrets \
     --controller-namespace kube-system --format yaml \
     < k8s/secrets.local.yaml > k8s/secrets.sealed.yaml
   git add k8s/secrets.sealed.yaml && git commit -m "rotate ia secrets" && git push
   ```
   Se o `kubeseal` só selar o primeiro documento do arquivo, sele um
   Secret por vez e junte os resultados separados por `---`.

## Pré-requisitos

- ArgoCD instalado (repositório `argocd`), com o Sealed Secrets do
  `core-config`
- `ingress-nginx` e `cert-manager` instalados (repositórios `argocd` e
  `cert-manager`) e DNS `ia.diegofnunesbr.com` apontando pro node
  (repositório `dns`)
- Imagens `ia/agent-backend:latest` e `ia/web-frontend:latest` já
  importadas no containerd do k0s (seção "Build das imagens")

## Deploy

Tudo em `k8s/` (menos `secrets.example.yaml`) é aplicado pelo Argo CD:

```bash
kubectl apply -f applications/argocd.ia.yaml
```

**Lembrete:** a Application aponta pro GitHub, não pro clone local -
mudança em `k8s/` só tem efeito depois de `git push`. Imagem nova (mesma
tag `latest`) não é detectada pelo Argo CD: depois de rebuild + import,
rode `kubectl -n ia rollout restart deployment/<nome>`.

## Documentos e imagens no chat (OCR local)

O botão 📎 no `web-frontend` sobe uma imagem ou PDF; o `agent-backend`
extrai o texto localmente (Tesseract para imagem, leitura direta de
texto para PDF) e anexa automaticamente à sua próxima pergunta - ex.:
suba a foto de uma conta e pergunte "quanto é e quando vence".

Limitações: PDF escaneado sem camada de texto (só imagem dentro do
PDF) não é lido ainda; e o OCR está configurado para português
(`OCR_LANG=por`).

Acesse via `https://ia.diegofnunesbr.com` - certificado real (Let's
Encrypt, renovado automaticamente pelo cert-manager).

`k8s/network-policy.yaml` bloqueia todo egress externo do namespace
(só permite DNS e tráfego entre pods do cluster) - é o que garante que
nada saia para a internet.

## Segurança (hardening antes do deploy)

- **`k8s/network-policy-ingress.yaml`**: cada serviço só aceita
  conexão de quem realmente precisa falar com ele (ex.: só
  `agent-backend` pode chamar `ollama`/`postgres`; só `web-frontend`
  pode chamar `agent-backend`). Antes, qualquer coisa já dentro do
  cluster/rede conseguia chamar essas rotas direto, pulando o login.
  Ajuste o label `kubernetes.io/metadata.name: ingress-nginx` nesse
  arquivo se o seu namespace do ingress-nginx tiver outro nome.
- **Login + 2FA obrigatório**: senha e código TOTP (em telas
  separadas) são checados em `agent-backend/auth.js`, gate próprio
  (sem depender de Authelia/SSO externo nem de um subdomínio à parte).
  Hash e segredo TOTP ficam em Secret (`agent-backend-auth-secrets`),
  nunca em texto puro no código - compensação necessária por sair de
  "só rede local" pra um domínio público (`ia.diegofnunesbr.com`)
  resolvendo pro mesmo IP privado.

## Hardware

Essa VM deixou de ser dedicada só a esse projeto e passou a hospedar
vários outros serviços (ArgoCD, Jenkins, Nextcloud, Samba, etc.), então
o `ollama` foi redimensionado pro mínimo que ainda roda o 3B + o
modelo de embeddings confortavelmente, em vez de aproveitar toda a
VM:

- `OLLAMA_NUM_PARALLEL=1`: uma requisição por vez (você é o único
  usuário, não precisa de mais).
- `OLLAMA_MAX_LOADED_MODELS=2`: mantém o modelo de chat e o de
  embeddings carregados ao mesmo tempo, evitando ficar descarregando e
  recarregando a cada mensagem.
- `OLLAMA_KEEP_ALIVE=60m`: descarrega o modelo da RAM depois de 60min
  sem uso, devolvendo a memória pros outros serviços do cluster.
  Custa alguns segundos de recarga na primeira mensagem depois de um
  período ocioso - ajuste esse valor se incomodar.
- `requests`: 500m CPU / 3Gi RAM - o mínimo estimado pra manter os dois
  modelos residentes (3B + embeddings) com folga de KV cache. `limits`:
  2 CPU / 5Gi RAM, só como teto de segurança, não reserva de verdade.
  Esses números são uma estimativa inicial - se notar OOM ou lentidão,
  ajuste pra cima.
- Imagem do `ollama` fixada em `0.3.14` em vez de `latest`, para não
  atualizar sozinha sem você perceber.

**Verificação pós-deploy**: com as `NetworkPolicy` de ingress, existe
uma chance pequena do seu CNI (k0s costuma vir com kube-router)
bloquear o `readinessProbe`/`livenessProbe` do kubelet junto com o
resto do tráfego. Depois do deploy, rode `kubectl get pods -n
ia` - se algum pod ficar preso em "not ready" apesar de
funcionar (veja os logs), o ajuste é adicionar uma exceção para o
CIDR dos nós na `NetworkPolicy` daquele serviço.

## Múltiplas conversas

Igual aqui no Claude: dá para ter várias conversas separadas (botão
"+ Nova conversa" na barra lateral), trocar entre elas, e excluir
qualquer uma (🗑, com confirmação) - a exclusão apaga a conversa e
todas as mensagens dela do Postgres, sem volta.

O título de cada conversa é gerado automaticamente a partir da sua
primeira mensagem. A memória permanente (seção abaixo, os fatos sobre
você) é compartilhada entre todas as conversas - só o histórico de
mensagens é por conversa. No mobile/tela estreita, a barra lateral
fica escondida atrás do botão ☰.

## Memória permanente

O assistente lembra de fatos entre conversas diferentes e depois de
restarts - não é fine-tuning (o modelo em si não muda), é RAG: cada
fato relevante que você conta (ex.: "meu pai é Fulano") é guardado no
Postgres com um embedding (`nomic-embed-text`), e antes de cada
resposta o sistema busca os fatos mais relevantes para aquela pergunta
e injeta no contexto do modelo.

- O modelo decide sozinho quando salvar algo (ferramenta
  `remember_fact`), guiado pelo system prompt.
- Não precisa pedir explicitamente "lembre disso" - basta contar o
  fato normalmente na conversa.
- Para ver o que já foi salvo:
  ```bash
  kubectl exec -n ia deploy/postgres -- psql -U assistant -d assistant -c "SELECT content, created_at FROM memories ORDER BY created_at DESC;"
  ```
- Para apagar um fato errado, use `DELETE FROM memories WHERE id = <id>;`
  no mesmo `psql`.

## Próximas fases

- Lembretes agendados (CronJob) usando o mesmo Postgres.
- Conectores: Tuya local (tinytuya), câmeras ONVIF, impressoras IPP/CUPS.
- GPU passthrough no Proxmox, se algum dia comprar uma placa dedicada
  (ganho de velocidade real, não só 2-3x como trocar de modelo deu).
- OCR de PDF escaneado (hoje só funciona PDF com camada de texto).
