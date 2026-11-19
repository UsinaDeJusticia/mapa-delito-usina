#!/bin/sh
# Arranque del agente dentro del contenedor de Cloudflare.
#
# Sandbox de Chromium: se intenta CON sandbox. Si el kernel del host no
# permite los user namespaces que necesita (pasó en los runners de GitHub
# desde agosto de 2026), se cae a --no-sandbox y se deja dicho en el log. El
# contenedor es una VM efímera y exclusiva de esta corrida, el mismo criterio
# que se usa en .github/workflows/pipeline.yml.
set -eu

if chromium --headless=new --disable-gpu --dump-dom about:blank >/dev/null 2>/tmp/sandbox.log; then
  echo "🧪 Chromium arranca con su sandbox"
else
  echo "⚠️ Chromium no arranca con sandbox en este host; se usa --no-sandbox"
  tail -3 /tmp/sandbox.log || true
  export AGENT_BROWSER_ARGS="--no-sandbox"
fi

exec node --import tsx scripts/pipeline/agente-local.ts --una-vez
