# A API do GoFitNow, em container.
#
# Existe desde 07/09/2026, para a saída do VPS da Hostinger. Nada aqui é
# aplicado ainda: a imagem é o primeiro passo, e o resto do caminho está em
# `infra/` na raiz do projeto.
#
# ── O QUE ESTE SERVIÇO PRECISA DE FORA ─────────────────────────────────────
#
# Quase nada, e é isso que torna o container viável sem reescrever nada:
#
#   banco       Atlas, pela rede
#   arquivos    R2 (Cloudflare), pela rede
#   sessão      Mongo + cache no Redis, pela rede
#   tempo real  socket.io com adaptador do Redis — N máquinas funcionam
#   disco       NADA é escrito localmente
#
# Não há volume, não há estado, não há sticky session (o socket.io está em
# `transports: ["websocket"]`, sem long-polling — é o polling que exige
# grude no balanceador).
#
# ── O CHROMIUM É A DECISÃO CARA DESTE ARQUIVO ──────────────────────────────
#
# O `puppeteer` baixa o próprio Chromium: são 652 MB no VPS hoje. Numa imagem
# isso é peso em todo `docker pull`, em toda task que sobe, em toda escala.
#
# Aqui ele NÃO é baixado (`PUPPETEER_SKIP_DOWNLOAD`). Vale o Chromium do sistema,
# que o Debian mantém atualizado e o `lib/pdf.js` já sabe usar — ele lê
# `PUPPETEER_EXECUTABLE_PATH` desde antes deste arquivo existir.
#
# O que se perde: o casamento exato de versão entre o puppeteer e o navegador.
# É um risco real e conhecido, e o antídoto é o `pdfDisponivel()` — se o
# navegador não abrir, a rota de baixar PDF responde 503 e o resto do sistema
# continua inteiro. Ver `PDF_DISABLED` no mesmo arquivo.

# ── ESTÁGIO 1: as dependências ─────────────────────────────────────────────
#
# Separado do runtime para o `npm ci` ficar em cache: mexer no código não refaz
# a instalação, que é a parte lenta.
FROM node:22-bookworm-slim AS deps

ENV PUPPETEER_SKIP_DOWNLOAD=true
WORKDIR /app

# Só os manifestos primeiro. Copiar o projeto inteiro aqui faria qualquer edição
# invalidar o cache do `npm ci` — o erro de Dockerfile mais comum que existe.
COPY package.json package-lock.json ./

# `npm ci` e não `npm install`: ele obedece ao lock e falha se o lock divergir,
# em vez de resolver versão nova em silêncio na hora do build.
#
# `--omit=dev` tira nodemon, o test runner e o eslint. São ~200 MB que não têm
# o que fazer em produção.
RUN npm ci --omit=dev

# ── ESTÁGIO 2: o que roda ──────────────────────────────────────────────────
FROM node:22-bookworm-slim

# O Chromium do sistema, e as fontes.
#
# `fonts-liberation` é o Arial/Times/Courier em métrica idêntica — sem ela o PDF
# sai com caixinhas no lugar das letras. `fonts-dejavu-core` cobre acento e
# símbolo; num documento em português isso não é enfeite.
#
# `--no-install-recommends` e o `rm` da lista na MESMA camada: em camadas
# separadas o cache do apt fica dentro da imagem para sempre.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        chromium \
        fonts-liberation \
        fonts-dejavu-core \
        ca-certificates \
        tini \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    # O sandbox do Chromium não inicializa no Fargate (não há user namespace), e
    # sem isto a rota de PDF falha em toda máquina nova. A válvula é do
    # ambiente, e não do código — ver lib/pdf.js.
    PUPPETEER_ARGS="--no-sandbox --disable-setuid-sandbox" \
    # A porta é a mesma do systemd hoje, para o runbook não ter uma diferença a
    # mais para explicar.
    EXPRESS_PORT=3030 \
    # `0.0.0.0` e não `127.0.0.1`: no VPS o nginx fala com o localhost, e aqui
    # quem fala é o balanceador, de fora do container. Com 127.0.0.1 o serviço
    # sobe e ninguém alcança — e o sintoma é "task unhealthy" sem log de erro.
    HOST=0.0.0.0

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# ── NÃO RODA COMO ROOT ─────────────────────────────────────────────────────
#
# A imagem do node já traz o usuário `node`. É o mesmo raciocínio do
# `User=gofitnow` no systemd — e aqui vale mais, porque o Chromium abre imagem
# que veio de upload de usuário.
USER node

EXPOSE 3030

# ── TINI COMO PID 1 ────────────────────────────────────────────────────────
#
# O Node como PID 1 não repassa sinal aos filhos, e este serviço TEM filho: o
# Chromium. Sem um init de verdade, cada deploy deixa processo de navegador
# órfão até o container ser derrubado à força — e o `SIGTERM` do ECS viraria um
# `SIGKILL` quarenta segundos depois, no meio de um PDF.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "app.js"]
