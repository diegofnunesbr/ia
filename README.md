# ia

App de chat (texto + voz) acessível via `https://ia.diegofnunesbr.com`,
100% local: o LLM roda no seu próprio cluster via Ollama, sem nenhuma
chamada para a internet - por isso é seguro colocar senhas/dados
sensíveis na conversa. Login + 2FA (senha + TOTP com QR code) são
feitos pelo Authelia (`k8s/authelia.yaml`), na frente de tudo via
Ingress (`auth-url`/`auth-signin`) - o `agent-backend` não faz auth
própria. Já tem upload de documento/imagem com OCR local; smart home,
câmeras e impressoras ainda não estão conectadas.

Antes do deploy, troque `OWNER_NAME` em `k8s/agent-backend.yaml` pelo
seu nome/apelido (é o que o assistente usa para se referir a você),
e os dados do seu usuário em `k8s/secrets.local.yaml` (ver seção
Secrets) pelos seus.

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

1. Gere os três segredos aleatórios do Authelia:
   ```bash
   openssl rand -hex 32   # JWT_SECRET
   openssl rand -hex 32   # SESSION_SECRET
   openssl rand -hex 32   # STORAGE_ENCRYPTION_KEY
   ```
2. Gere o hash argon2 da sua senha de login (usa a própria imagem do
   Authelia, não precisa estar com nada rodando ainda):
   ```bash
   docker run --rm authelia/authelia:4.38 authelia crypto hash generate argon2 --password 'sua-senha'
   ```
   Preencha o campo `password` do usuário em `authelia-users` (dentro
   de `users_database.yml`) com o hash gerado.
3. Preencha `k8s/secrets.local.yaml` com os valores reais (inclui
   `authelia-secrets`, `authelia-users` e `postgres-secrets`) e sele
   com `kubeseal --scope cluster-wide --controller-name sealed-secrets
   --controller-namespace kube-system` (sem newline espúrio via
   `printf '%s'`), como de costume. Depois de selado, o `.yaml` selado
   (sem dado sensível em texto puro) pode ir pro git normalmente.
4. O QR code do TOTP aparece no próprio Authelia, no primeiro login em
   `https://auth.ia.diegofnunesbr.com` - não precisa configurar nada
   manualmente, só escanear com seu app autenticador.

## Pré-requisitos

- `ingress-nginx` e `cert-manager` instalados (repositórios `argocd` e
  `cert-manager`) e DNS `ia.diegofnunesbr.com` **e**
  `auth.ia.diegofnunesbr.com` apontando pro node (repositório `dns`)

## Deploy

```bash
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/network-policy.yaml
kubectl apply -f k8s/network-policy-ingress.yaml
kubectl apply -f k8s/secrets.local.yaml
kubectl apply -f k8s/authelia-configmap.yaml
kubectl apply -f k8s/authelia.yaml
kubectl apply -f k8s/postgres.yaml
kubectl apply -f k8s/ollama.yaml
kubectl apply -f k8s/agent-backend.yaml
kubectl apply -f k8s/web-frontend.yaml
```

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
- **Login + 2FA obrigatório**: Authelia (`k8s/authelia.yaml`) fica na
  frente de `ia.diegofnunesbr.com` via forward-auth do ingress-nginx
  (`auth-url`/`auth-signin`) - nenhuma requisição chega no
  `web-frontend`/`agent-backend` sem passar por senha + TOTP antes.
  Hash da senha (argon2) e segredos ficam em Secret (`authelia-users`,
  `authelia-secrets`), nunca em texto puro no código - compensação
  necessária por sair de "só rede local" pra um domínio público
  (`ia.diegofnunesbr.com`) resolvendo pro mesmo IP privado.

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
