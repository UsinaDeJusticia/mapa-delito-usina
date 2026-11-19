# Imagen del agente del pipeline para Cloudflare Containers.
#
# Corre el MISMO agente que la computadora del equipo
# (scripts/pipeline/agente-local.ts --una-vez): encola la programada del día si
# corresponde, procesa lo pendiente en corridas_pipeline y sale. El Worker de
# cloudflare/pipeline/src/index.ts la enciende; al salir el proceso, el
# contenedor se apaga y deja de cobrar.
#
# Contexto de build: la raíz del repo (ver build_context en wrangler.jsonc y
# el .dockerignore de la raíz).

# Mirror público de la imagen oficial de Node: evita el límite de descargas
# anónimas de Docker Hub.
FROM public.ecr.aws/docker/library/node:22-bookworm-slim

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    npm_config_update_notifier=false

WORKDIR /app

# Chromium de Debian (trae todas sus librerías) y OpenSSL, que pide Prisma.
# agent-browser lo usa vía AGENT_BROWSER_EXECUTABLE_PATH, en lugar de bajar
# Chrome for Testing aparte.
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium openssl ca-certificates fonts-liberation \
 && rm -rf /var/lib/apt/lists/*
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium

# Dependencias primero, para aprovechar la caché de capas.
COPY package.json package-lock.json ./
COPY prisma ./prisma
# --include=dev: tsx y el CLI de prisma son devDependencies y NODE_ENV=production
# las omitiría.
RUN npm ci --include=dev --ignore-scripts --no-audit --no-fund \
 && npx prisma generate \
 && npm cache clean --force

# Chromium no arranca como root sin --no-sandbox, y no queremos desactivar su
# sandbox: el agente corre con un usuario sin privilegios.
RUN useradd --create-home --uid 10001 agente
USER agente

COPY --chown=agente:agente tsconfig.json ./
COPY --chown=agente:agente src ./src
COPY --chown=agente:agente scripts/pipeline ./scripts/pipeline
COPY --chown=agente:agente --chmod=755 cloudflare/pipeline/iniciar.sh ./iniciar.sh

# Cloudflare manda SIGTERM y espera hasta 15 min antes de cortar: el agente lo
# atiende (corta la corrida en curso y la marca en la base).
CMD ["./iniciar.sh"]
