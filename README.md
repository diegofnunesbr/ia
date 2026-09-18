# ia

App de chat (texto + voz) acessível na rede interna, 100% local: o
LLM roda no seu próprio cluster via Ollama, sem nenhuma chamada para a
internet - por isso é seguro colocar senhas/dados sensíveis na
conversa. Login (usuário + senha) é feito direto no `agent-backend`
(ver `agent-backend/auth.js`) - acessível via HTTP puro por IP, sem
precisar de domínio nem certificado (2FA pode ser adicionado depois,
deixado de fora por enquanto pra manter simples). Já tem upload de
documento/imagem com OCR local; smart home, câmeras e impressoras
ainda não estão conectadas.

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
- `onenote-sync`: CronJob (a cada 6h) que sincroniza as páginas do seu
  OneNote pessoal (Microsoft Graph API) para o Postgres, com
  embeddings - o assistente consulta isso via search_notes.

Nota sobre privacidade da voz: o reconhecimento de voz do navegador
(Web Speech API) no Chrome envia o áudio para os servidores da Google
- não é 100% local. Se isso for um problema para você (por causa das
senhas faladas em voz alta), me avise para trocarmos por Whisper
self-hosted.

### Sobre o isolamento de rede

- `agent-backend` e `ollama` (onde ficam senhas e dados sensíveis da
  conversa) continuam sem nenhum egress externo.
- `onenote-sync` é a única exceção - precisa falar com a Microsoft
  (Graph API). Não recebe as senhas que você fala pro assistente - só
  troca dados com o Postgres/`agent-backend` internamente (conteúdo do
  OneNote).

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

1. Gere o hash da sua senha de login (rode dentro do pod, ele já tem
   `bcryptjs` instalado):
   ```bash
   kubectl exec -n ia deploy/agent-backend -- node -e \
     "console.log(require('bcryptjs').hashSync('sua-senha', 10))"
   ```
2. Preencha `k8s/secrets.local.yaml` com os valores reais (inclui
   `agent-backend-auth-secrets` e `postgres-secrets`) e sele com kubeseal (`--scope cluster-wide`,
   sem newline espúrio via `printf '%s'`), como de costume. Depois de
   selado, o `.yaml` selado (sem dado sensível em texto puro) pode ir
   pro git normalmente.
3. `onenote-sync-secrets` (mesmo arquivo local) é a exceção - **não sele com
   kubeseal**, veja o comentário no próprio arquivo e a seção "OneNote
   pessoal" abaixo para como preenchê-lo e aplicá-lo.

## Deploy

```bash
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/network-policy.yaml
kubectl apply -f k8s/network-policy-ingress.yaml
kubectl apply -f k8s/postgres.yaml
kubectl apply -f k8s/ollama.yaml
kubectl apply -f k8s/agent-backend.yaml
kubectl apply -f k8s/web-frontend.yaml
kubectl apply -f k8s/web-frontend-ingress-allow.yaml
kubectl apply -f k8s/onenote-sync.yaml
```

## OneNote pessoal

1. **Registre um app no Azure AD** (portal.azure.com → Entra ID → App
   registrations → New registration):
   - Supported account types: "Personal Microsoft accounts only".
   - Authentication → Advanced settings → "Allow public client flows": Yes
     (necessário para o login por device code).
   - API permissions → Add → Microsoft Graph → Delegated → adicione
     `Notes.Read` e `offline_access`.
   - Anote o "Application (client) ID".
2. **Login único** (na sua máquina, não no cluster):
   ```bash
   cd onenote-sync
   npm install
   ONENOTE_CLIENT_ID=<seu-client-id> npm run auth
   ```
   Siga a URL/código impressos para autorizar. No final, o script
   imprime um refresh token.
3. Preencha `client-id` e `refresh-token` em `k8s/secrets.local.yaml`
   (a cópia local, não o `.example.yaml` - ver seção Secrets), no
   bloco `onenote-sync-secrets`, e aplique **direto, sem kubeseal**:
   ```bash
   kubectl apply -f k8s/secrets.local.yaml
   ```
   (isso reaplica todos os secrets daquele arquivo - se os outros já
   estiverem selados/aplicados separadamente, extraia só o bloco do
   `onenote-sync-secrets` para um arquivo à parte antes de aplicar)
4. Build da imagem e primeira sincronização manual, para validar antes
   de esperar pelo cron:
   ```bash
   docker build -t ia/onenote-sync:latest onenote-sync/
   kubectl create job -n ia onenote-sync-manual --from=cronjob/onenote-sync
   kubectl logs -n ia job/onenote-sync-manual -f
   ```

Depois disso, a sincronização roda sozinha a cada 6h
(`k8s/onenote-sync.yaml`, ajuste `schedule` se quiser outro intervalo).
O refresh token se renova automaticamente a cada execução - você não
precisa repetir o login, a menos que fique mais de ~90 dias sem o
CronJob rodar (ex.: cluster desligado por muito tempo).

## Documentos e imagens no chat (OCR local)

O botão 📎 no `web-frontend` sobe uma imagem ou PDF; o `agent-backend`
extrai o texto localmente (Tesseract para imagem, leitura direta de
texto para PDF) e anexa automaticamente à sua próxima pergunta - ex.:
suba a foto de uma conta e pergunte "quanto é e quando vence".

Limitações: PDF escaneado sem camada de texto (só imagem dentro do
PDF) não é lido ainda; e o OCR está configurado para português
(`OCR_LANG=por`).

Acesse direto pelo IP do node, HTTP puro (ex.: `http://192.168.0.5:30277/`)
- `web-frontend` é exposto via NodePort simples, sem ingress-nginx/TLS
nem domínio.

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
- **Login obrigatório**: senha (hash bcrypt) checada em
  `agent-backend/auth.js`, gate próprio (sem depender de Authelia/SSO
  externo) - funciona por IP puro, sem domínio nem certificado. Hash
  fica em Secret (`agent-backend-auth-secrets`), nunca em texto puro
  no código. Sem 2FA por enquanto (rede local confiável) - fica como
  possível melhoria futura.

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
