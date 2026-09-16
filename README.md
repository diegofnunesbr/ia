# personal-ai

App de chat (texto + voz) acessível na rede interna, 100% local: o
LLM roda no seu próprio cluster via Ollama, sem nenhuma chamada para a
internet - por isso é seguro colocar senhas/dados sensíveis na
conversa. Authelia protege o login. Já tem tool-calling ligado ao
WhatsApp (grupos, contatos, mensagens novas, enviar mensagem, criar
grupo, converter imagens em PDF), upload de documento/imagem com OCR
local, e notificação proativa via WhatsApp; smart home, câmeras e
impressoras ainda não estão conectadas.

Antes do deploy, troque `OWNER_NAME` em `k8s/agent-backend.yaml` pelo
seu nome/apelido (é o que o assistente usa para se referir a você),
e o usuário `owner`/`owner@home.lan` em `k8s/secrets.local.yaml` (ver
seção Secrets) pelo que preferir.

## Serviços

- `web-frontend`: chat web (HTML/JS puro) com barra lateral de
  conversas (criar, trocar, excluir), botão de microfone (Web Speech
  API) e leitura das respostas em voz.
- `agent-backend`: recebe as mensagens e chama o Ollama local. O
  histórico de cada conversa fica no Postgres (tabelas
  `chat_sessions`/`chat_messages`), não em memória - sobrevive a
  restart e permite ter várias conversas separadas, como aqui no
  Claude.
- `ollama`: serve o modelo local (Qwen2.5 14B por padrão) e o modelo
  de embeddings (`nomic-embed-text`) usado pela memória.
- `postgres`: com a extensão `pgvector`, guarda os fatos permanentes
  que o assistente aprende sobre você (nomes, preferências, etc.) e o
  histórico de todas as conversas.
- `whatsapp-bridge`: não é mais o canal principal (isso é o
  `web-frontend`), mas dá controle amplo do seu WhatsApp:
  - **determinística**: imagem enviada num grupo específico com
    legenda "pdf" é convertida e devolvida como PDF ali mesmo, sem
    passar pelo LLM (mais rápido e previsível).
  - **por tool-calling**, pedindo em linguagem natural no
    `web-frontend`: listar grupos e contatos, ver mensagens novas
    ("tem alguma mensagem nova?"), mandar mensagem para alguém
    ("responda o Fulano dizendo que já vou"), criar grupo, converter
    imagens recentes de um grupo em PDF (com link de download no
    chat), e avisar você mesmo no WhatsApp quando uma tarefa terminar.
  Contatos e mensagens só existem em cache de quando o bridge está
  rodando (imagens: até 50/grupo por 24h) - não dá pra buscar
  histórico de antes do bridge existir, nem contatos que nunca
  mandaram mensagem enquanto ele estava no ar.
- `image-to-pdf`: o conversor que você já tinha em
  `Pessoal/image-to-pdf/`, reaproveitado aqui como serviço interno.
- `onenote-sync`: CronJob (a cada 6h) que sincroniza as páginas do seu
  OneNote pessoal (Microsoft Graph API) para o Postgres, com
  embeddings - o assistente consulta isso via search_notes.

Nota sobre privacidade da voz: o reconhecimento de voz do navegador
(Web Speech API) no Chrome envia o áudio para os servidores da Google
- não é 100% local. Se isso for um problema para você (por causa das
senhas faladas em voz alta), me avise para trocarmos por Whisper
self-hosted.

### Sobre o isolamento de rede e o WhatsApp

O WhatsApp é um serviço na nuvem - não existe forma de usá-lo sem sair
para a internet. Por isso o isolamento é por camada de confiança, não
"tudo trancado":

- `ollama` (onde o modelo processa a conversa) continua sem nenhum
  egress externo.
- `whatsapp-bridge` e `onenote-sync` precisam falar com os servidores
  do WhatsApp e da Microsoft (Graph API), respectivamente. Nenhum dos
  dois recebe as senhas que você fala pro assistente - só trocam dados
  com o Postgres/`agent-backend` internamente.
- `agent-backend` tem uma exceção estreita (só porta 443) para a
  ferramenta `web_search` (busca na internet) - decisão consciente do
  usuário, ver `network-policy-agent-backend-egress.yaml` na seção de
  segurança abaixo para o detalhe do trade-off.

## Build das imagens

```bash
docker build -t personal-ai/agent-backend:latest agent-backend/
docker build -t personal-ai/web-frontend:latest web-frontend/
docker build -t personal-ai/whatsapp-bridge:latest whatsapp-bridge/
docker build -t personal-ai/image-to-pdf:latest ../image-to-pdf/
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
kubectl exec -n personal-ai deploy/ollama -- ollama pull qwen2.5:3b-instruct
kubectl exec -n personal-ai deploy/ollama -- ollama pull nomic-embed-text
```

Testado em CPU (6-8 cores, sem GPU), sem streaming pro usuário final
(a resposta só aparece pronta, não palavra por palavra):

| Modelo | Tempo (pergunta simples, aquecido) |
|---|---|
| `qwen2.5:14b-instruct` | ~1min13s |
| `qwen2.5:7b-instruct` | ~33s |
| `qwen2.5:3b-instruct` (padrão atual) | ~10-15s |

Mais núcleos de CPU não ajudam muito além de ~6 (o gargalo em CPU
puro é banda de memória, não contagem de núcleos - só GPU resolve de
verdade). O 3B é bem mais rápido mas comete mais deslizes de
português/precisão que o 7B - troque em `k8s/agent-backend.yaml`
(`AGENT_MODEL`) se preferir mais qualidade em troca de mais demora.

## Secrets

**Nunca edite `k8s/authelia-secret.example.yaml` com valores reais** -
ele é só o template, e fica versionado. Copie para um arquivo à parte
(já coberto pelo `.gitignore`) e edite essa cópia:

```bash
cp k8s/authelia-secret.example.yaml k8s/secrets.local.yaml
```

1. Gere os valores aleatórios da Authelia:
   ```bash
   openssl rand -hex 32   # JWT_SECRET
   openssl rand -hex 32   # SESSION_SECRET
   openssl rand -hex 32   # STORAGE_ENCRYPTION_KEY
   ```
2. Gere o hash da sua senha de login:
   ```bash
   docker run --rm authelia/authelia:4.38 authelia crypto hash generate argon2 --password 'sua-senha'
   ```
   Cole o hash em `k8s/secrets.local.yaml`, no secret
   `authelia-users` (o hash fica num Secret, não num ConfigMap, já que
   é dado sensível).
3. Preencha `k8s/secrets.local.yaml` com os valores reais
   (inclui `authelia-secrets`, `authelia-users`, `whatsapp-bridge-secrets`
   e `postgres-secrets`) e sele com kubeseal (`--scope cluster-wide`,
   sem newline espúrio via `printf '%s'`), como de costume. Depois de
   selado, o `.yaml` selado (sem dado sensível em texto puro) pode ir
   pro git normalmente.
4. `onenote-sync-secrets` (mesmo arquivo local) é a exceção - **não sele com
   kubeseal**, veja o comentário no próprio arquivo e a seção "OneNote
   pessoal" abaixo para como preenchê-lo e aplicá-lo.

## Deploy

```bash
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/network-policy.yaml
kubectl apply -f k8s/network-policy-ingress.yaml
kubectl apply -f k8s/postgres.yaml
kubectl apply -f k8s/ollama.yaml
kubectl apply -f k8s/authelia-configmap.yaml
kubectl apply -f k8s/authelia.yaml
kubectl apply -f k8s/agent-backend.yaml
kubectl apply -f k8s/web-frontend.yaml
kubectl apply -f k8s/image-to-pdf.yaml
kubectl apply -f k8s/whatsapp-bridge.yaml
kubectl apply -f k8s/onenote-sync.yaml
```

No primeiro deploy do `whatsapp-bridge`, veja os logs para o QR code
de pareamento (escaneie no WhatsApp > Aparelhos conectados):

```bash
kubectl logs -n personal-ai deploy/whatsapp-bridge -f
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
   docker build -t personal-ai/onenote-sync:latest onenote-sync/
   kubectl create job -n personal-ai onenote-sync-manual --from=cronjob/onenote-sync
   kubectl logs -n personal-ai job/onenote-sync-manual -f
   ```

Depois disso, a sincronização roda sozinha a cada 6h
(`k8s/onenote-sync.yaml`, ajuste `schedule` se quiser outro intervalo).
O refresh token se renova automaticamente a cada execução - você não
precisa repetir o login, a menos que fique mais de ~90 dias sem o
CronJob rodar (ex.: cluster desligado por muito tempo).

## Imagem → PDF pelo WhatsApp

1. Antes de configurar `pdf-group-id` no secret, faça o deploy e mande
   qualquer mensagem no grupo desejado - o log do bridge vai mostrar o
   JID (`message from unconfigured group ...`).
2. Preencha `pdf-group-id` no secret (ver seção Secrets) com esse JID
   e reaplique/resele.
3. Envie uma imagem nesse grupo com a legenda `pdf` - o bot responde
   na hora com o PDF já convertido, como documento.

A palavra-gatilho é configurável via `PDF_TRIGGER_WORD` (padrão: `pdf`).

## Converter imagens pedindo no chat

Sem precisar configurar `pdf-group-id`: no `web-frontend`, basta pedir
algo como "acesse o grupo Pessoal do WhatsApp e converta as imagens
para PDF". O assistente lista os grupos, resolve o nome, converte as
imagens em cache daquele grupo e responde com um link de download na
própria conversa (o arquivo fica disponível por 30 minutos).

Requisitos: o modelo configurado em `AGENT_MODEL` precisa suportar
tool-calling no Ollama (Qwen2.5 e Llama 3.1 suportam). Se o modelo
ignorar as ferramentas ou alucinar o nome do grupo, verifique se o
`ollama pull` baixou a versão `-instruct` correta.

## Controlar o WhatsApp pelo chat

Exemplos do que já dá para pedir no `web-frontend`:

- "Tem alguma mensagem nova?" - lista o que chegou desde a última vez
  que você perguntou (em qualquer conversa, individual ou grupo).
- "Responda o Fulano dizendo que já estou chegando" - resolve o
  contato pelo nome (ou aceita um número direto) e manda a mensagem.
- "Cria um grupo chamado Viagem com o Fulano e a Ciclana" - passe os
  números de telefone dos participantes.
- "Me avisa no WhatsApp quando terminar de converter essas imagens" -
  o assistente conclui a tarefa e manda uma mensagem para você mesmo
  (`USER_WHATSAPP_JID`, o mesmo número de `ALLOWED_NUMBER`).

Limite real: como o WhatsApp não expõe sua agenda de contatos
completa, o assistente só resolve pelo nome quem já apareceu no cache
de contatos (mensagens recebidas, ou o que o WhatsApp sincronizou). Um
número de telefone direto sempre funciona. Antes de mandar mensagem ou
criar grupo, o assistente foi instruído a confirmar o destinatário com
você - vale conferir a resposta antes de considerar concluído.

## Documentos e imagens no chat (OCR local)

O botão 📎 no `web-frontend` sobe uma imagem ou PDF; o `agent-backend`
extrai o texto localmente (Tesseract para imagem, leitura direta de
texto para PDF) e anexa automaticamente à sua próxima pergunta - ex.:
suba a foto de uma conta e pergunte "quanto é e quando vence".

Limitações: PDF escaneado sem camada de texto (só imagem dentro do
PDF) não é lido ainda; e o OCR está configurado para português
(`OCR_LANG=por`).

Ajuste `ia.home` e `auth.ia.home` no DNS local (ou `/etc/hosts`) para
o IP do seu ingress-nginx.

`k8s/network-policy.yaml` bloqueia todo egress externo do namespace
(só permite DNS e tráfego entre pods do cluster) - é o que garante que
nada saia para a internet.

## Segurança (hardening antes do deploy)

- **`k8s/network-policy-agent-backend-egress.yaml`**: exceção
  deliberada e estreita ao bloqueio de internet do
  `network-policy.yaml` - libera só a porta 443 (HTTPS) saindo do
  `agent-backend`, exclusivamente para a ferramenta `web_search`
  (busca via DuckDuckGo). NetworkPolicy padrão não filtra por domínio,
  só IP/porta, então isso não restringe para *qual* site na internet;
  o que limita é o system prompt instruindo o modelo a nunca incluir
  dados sensíveis na query de busca. Opção consciente do usuário -
  esse serviço não tem mais isolamento total de internet.
- **`k8s/network-policy-ingress.yaml`**: cada serviço só aceita
  conexão de quem realmente precisa falar com ele (ex.: só
  `agent-backend` pode chamar `ollama`/`postgres`; só `web-frontend` e
  `whatsapp-bridge` podem chamar `agent-backend`). Antes, qualquer
  coisa já dentro do cluster/rede conseguia chamar essas rotas
  direto, pulando o login da Authelia. Ajuste o label
  `kubernetes.io/metadata.name: ingress-nginx` nesse arquivo se o seu
  namespace do ingress-nginx tiver outro nome.
- **2FA obrigatório na Authelia**: a política mudou de `one_factor`
  para `two_factor`. No primeiro login, ela vai pedir para registrar
  um app autenticador (Google Authenticator, Aegis, etc.) via QR code
  antes de liberar o acesso.
- **Hash de senha em Secret, não ConfigMap**: `users_database.yml`
  saiu do `authelia-config` (ConfigMap) e virou o secret
  `authelia-users`, selado como os demais.
- **Checagem exata do número no WhatsApp**: o `whatsapp-bridge`
  comparava o JID com `startsWith`, o que permitia (na teoria) que um
  número com prefixo igual passasse pela checagem. Agora é comparação
  exata do JID completo.
- **Gatilho de PDF no grupo restrito a você**: só quem tem o número em
  `ALLOWED_NUMBER` consegue disparar a conversão por legenda dentro do
  grupo - antes, qualquer membro do grupo conseguia.
- **Proteção contra prompt injection via WhatsApp**: como o assistente
  agora manda mensagem e cria grupo, o system prompt deixa explícito
  que conteúdo de mensagens de terceiros é dado a reportar, nunca uma
  instrução a executar - sem isso, alguém poderia tentar manipular o
  modelo através do texto de uma mensagem recebida.

## Hardware (revisão antes do primeiro deploy)

Antes só o `ollama` tinha `resources` definido; os demais serviços
podiam consumir CPU/RAM sem limite algum, o que é arriscado dividindo
o mesmo host com suas outras VMs no Proxmox. Agora todos os
deployments têm `requests`/`limits`, e o `ollama` especificamente
ficou mais enxuto sem perder capacidade:

- `OLLAMA_NUM_PARALLEL=1`: uma requisição por vez (você é o único
  usuário, não precisa de mais).
- `OLLAMA_MAX_LOADED_MODELS=2`: mantém o modelo de chat e o de
  embeddings carregados ao mesmo tempo, evitando ficar descarregando e
  recarregando a cada mensagem (isso seria bem mais lento e usaria
  mais disco/CPU do que manter os dois residentes).
- `OLLAMA_KEEP_ALIVE=10m`: descarrega o modelo da RAM depois de 10 min
  sem uso, devolvendo a memória para o host quando você não está
  usando o assistente. Custa alguns segundos de recarga na primeira
  mensagem depois de um período ocioso - aumente esse valor se isso
  incomodar.
- Requisição de CPU/RAM do `ollama` reduzida (de 4 CPU/12Gi para 2
  CPU/10Gi) e o teto (`limits`) de CPU também caiu (de 8 para 6) -
  ainda é suficiente para o Qwen2.5 14B, só reserva menos de garantia
  quando ocioso.
- PVCs superdimensionados reduzidos: `ollama-models` de 30Gi para 15Gi
  (o modelo ocupa ~10Gi) e `postgres-data` de 5Gi para 2Gi (uso real é
  bem menor para um único usuário).
- Imagem do `ollama` fixada em `0.3.14` em vez de `latest`, para não
  atualizar sozinha sem você perceber.

**Verificação pós-deploy**: com as `NetworkPolicy` de ingress, existe
uma chance pequena do seu CNI (k0s costuma vir com kube-router)
bloquear o `readinessProbe`/`livenessProbe` do kubelet junto com o
resto do tráfego. Depois do deploy, rode `kubectl get pods -n
personal-ai` - se algum pod ficar preso em "not ready" apesar de
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
  kubectl exec -n personal-ai deploy/postgres -- psql -U assistant -d assistant -c "SELECT content, created_at FROM memories ORDER BY created_at DESC;"
  ```
- Para apagar um fato errado, use `DELETE FROM memories WHERE id = <id>;`
  no mesmo `psql`.

## Próximas fases

- Lembretes agendados (CronJob) usando o mesmo Postgres.
- Conectores: Tuya local (tinytuya), câmeras ONVIF, impressoras IPP/CUPS.
- GPU passthrough no Proxmox, se algum dia comprar uma placa dedicada
  (ganho de velocidade real, não só 2-3x como trocar de modelo deu).
- OCR de PDF escaneado (hoje só funciona PDF com camada de texto).
