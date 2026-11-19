# Pipeline en Cloudflare

Las corridas del pipeline de medios corren en **Cloudflare Containers**, así no
dependen de que la computadora del equipo esté encendida. El sitio sigue en
Vercel: acá solo vive el scraping.

## Cómo funciona

```
Cron 07:05 y 10:05 (hora AR) ─┐
                              ├─► Worker usina-pipeline-medios ─► contenedor (Node + Chromium)
Panel /admin/pipeline ────────┘     (cloudflare/pipeline/src)       agente-local.ts --una-vez
   POST /despertar + token                                           │
                                                                     ▼
                                                     corridas_pipeline (Neon) ◄── panel
```

- El contenedor corre **el mismo agente** que la computadora
  (`scripts/pipeline/agente-local.ts --una-vez`): encola la programada del día si
  ya es la hora, procesa lo pendiente y **sale**. Al salir, el contenedor se apaga
  y deja de cobrar.
- El Worker **no consulta la base**: no despierta a Neon cada pocos minutos.
- Una sola corrida a la vez (un único Durable Object, `pipeline`). Tope de 150
  minutos por encendida: después manda SIGTERM y, a los 5 minutos, lo destruye.
- Chromium arranca con su sandbox; si el host no lo permite, `iniciar.sh` cae a
  `--no-sandbox` y lo deja en el log (el contenedor es una VM efímera).
- Respaldo: GitHub Actions a las 12 (`pipeline.yml`, con aviso por issue si falla).

## Deploy

Automático con `.github/workflows/pipeline-cloudflare.yml` cuando cambia algo del
pipeline en `master` (también se puede correr a mano desde Actions). En un PR solo
construye y prueba la imagen.

Secrets de GitHub que necesita:

| Secret | Para qué |
|---|---|
| `CLOUDFLARE_API_TOKEN` | wrangler (permisos: Workers Scripts, Containers, Account Settings read) |
| `CLOUDFLARE_ACCOUNT_ID` | cuenta de Cloudflare |
| `DATABASE_URL`, `OPENCODE_API_KEY` | los recibe el contenedor (ya existían) |
| `PIPELINE_NUBE_TOKEN` | token compartido panel ↔ Worker (cualquier texto largo y aleatorio) |
| `OPENROUTER_API_KEY` | opcional, perfil de respaldo del LLM |

Variables de entorno en **Vercel** (para que el panel despierte al agente):

| Variable | Valor |
|---|---|
| `PIPELINE_NUBE_URL` | URL del Worker, p. ej. `https://usina-pipeline-medios.<subdominio>.workers.dev` |
| `PIPELINE_NUBE_TOKEN` | el mismo valor que el secret de GitHub |

Sin esas dos variables el panel encola igual; la corrida la toma el próximo cron
de Cloudflare, el agente de la computadora (si está prendido) o el respaldo de
Actions.

## Costo

Plan Workers Paid (USD 5/mes) + uso del contenedor `standard-1` (½ vCPU, 4 GiB).
Con corridas de ~30 min por día el extra es de centavos; en el peor caso (120 min
todos los días), unos USD 4/mes. El LLM (OpenCode Go) se paga aparte, igual que
antes. Ver el consumo en el panel de Cloudflare → Containers.

## Operación

- **Ver logs**: panel de Cloudflare → Workers → `usina-pipeline-medios` → Logs, o
  el log de cada corrida en `/admin/pipeline` (lo escribe el agente en la base).
- **Correr ya**: encolar desde `/admin/pipeline`.
- **Cambiar modelo o profundidad**: `vars` en `cloudflare/pipeline/wrangler.jsonc`.
- **Apagar**: borrar los `crons` de `wrangler.jsonc` (o el Worker desde el panel).
