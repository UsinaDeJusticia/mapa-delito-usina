# CLAUDE.md — Mapa del Delito · Usina de Justicia

Guía de referencia para trabajar en este repo. Leerla antes de tocar cualquier archivo.

---

## 1. Estructura de carpetas

```
mapa-delito-usina/
├── src/
│   ├── app/
│   │   ├── layout.tsx                   # Root layout (fuentes Geist, globals.css, OG metadata, favicon)
│   │   ├── page.tsx                     # Raíz "/" (redirige o landing)
│   │   ├── globals.css                  # CSS global + variables Tailwind
│   │   ├── mapa-del-delito/
│   │   │   ├── layout.tsx               # Layout de la sección mapa
│   │   │   └── page.tsx                 # Página /mapa-del-delito (carga MapaDelito via dynamic)
│   │   ├── metodologia/
│   │   │   └── page.tsx                 # Página pública de metodología
│   │   ├── dashboard/
│   │   │   └── page.tsx                 # Dashboard público (uso interno)
│   │   ├── admin/
│   │   │   ├── layout.tsx               # Layout admin con SessionProvider (next-auth)
│   │   │   ├── loading.tsx              # Splash screen con logo Usina (muestra mientras carga)
│   │   │   ├── login/
│   │   │   │   └── page.tsx             # Login con Google OAuth
│   │   │   ├── dashboard/
│   │   │   │   └── page.tsx             # Métricas del pipeline (semanas, precisión por medio)
│   │   │   ├── revisiones/
│   │   │   │   └── page.tsx             # Revisión humana de casos del pipeline
│   │   │   └── pipeline/
│   │   │       └── page.tsx             # Control del pipeline: agente, nueva corrida, progreso, log, historial
│   │   └── api/
│   │       ├── mapa/
│   │       │   ├── estadisticas/        # GET → datos por provincia (SNIC o SAT)
│   │       │   ├── tendencias/          # GET → serie temporal de un delito por provincia
│   │       │   ├── tipos-delito/        # GET → catálogo de tipos SNIC
│   │       │   ├── provincias/          # GET → lista de provincias con centroides
│   │       │   ├── delitos-provincia/   # GET → top delitos de una provincia (mv)
│   │       │   ├── sat-opciones/        # GET → valores únicos de filtros SAT
│   │       │   └── hechos-medios/       # GET → casos del pipeline (últimos 90 días, max 500)
│   │       ├── admin/
│   │       │   ├── revisiones/
│   │       │   │   ├── route.ts         # GET pendientes + revisados 48h / POST clasificar
│   │       │   │   └── stream/
│   │       │   │       └── route.ts     # GET SSE — push en tiempo real de nuevas revisiones
│   │       │   ├── metricas/
│   │       │   │   └── route.ts         # GET → métricas del pipeline (semanas, medios, totales)
│   │       │   └── pipeline/
│   │       │       ├── route.ts         # GET estado (agentes, corridas, catálogo) / POST encolar corrida
│   │       │       └── [id]/
│   │       │           ├── route.ts     # GET corrida + log incremental (?desde=<id de línea>)
│   │       │           └── cancelar/route.ts # POST cancelar
│   │       └── pipeline/
│   │           └── run/
│   │               └── route.ts         # GET huérfana (Vercel no puede correr Chrome) — pendiente de borrar
│   ├── auth.ts                          # Configuración NextAuth v5 (Google OAuth)
│   ├── middleware.ts                    # Protege /admin/* — redirige a /admin/login si no autenticado
│   ├── components/
│   │   ├── admin/
│   │   │   └── AdminNav.tsx             # Navegación admin (Métricas · Revisiones · Pipeline · Feedback)
│   │   └── mapa/
│   │       ├── MapaDelito.tsx           # Componente principal (orquesta todo)
│   │       ├── MapaDelitoWrapper.tsx    # Re-export con dynamic import (SSR=false)
│   │       ├── PanelEstadisticas.tsx    # Panel lateral de detalles de provincia
│   │       ├── SliderAnios.tsx          # Selector de año
│   │       ├── SelectorDelito.tsx       # Dropdown de tipo de delito (SNIC)
│   │       ├── SelectorFuente.tsx       # Toggle SNIC / SAT
│   │       ├── BuscadorProvincia.tsx    # Buscador de provincia con fly-to
│   │       ├── FiltroDepartamento.tsx   # Filtro de departamento (comentado, Fase 2)
│   │       ├── FiltrosSAT.tsx           # Chips de filtros SAT — NO se autopocisiona, MapaDelito lo ubica
│   │       ├── capas/
│   │       │   ├── index.ts             # Re-exports de capas
│   │       │   ├── MascaraPaises.tsx    # Polígono mundial con agujero Argentina
│   │       │   ├── CapaProvincias.tsx   # Coroplético provincial (google.maps.Data)
│   │       │   ├── CapaDepartamentos.tsx# Bordes departamentales + labels (lazy)
│   │       │   ├── MarcadoresCirculares.tsx # Burbujas SVG por provincia
│   │       │   └── CapaHechosMedios.tsx # Pins individuales del pipeline (rojo=VERIFICADO, naranja=PRELIMINAR)
│   │       └── hooks/
│   │           ├── useGeoJSON.ts        # Fetch + cache en memoria de GeoJSON
│   │           └── useGeolocalizacion.ts# GPS del browser, no bloquea carga
│   ├── config/
│   │   ├── mapStyles.ts                 # Estilos Google Maps + helpers de color
│   │   └── modelos-pipeline.ts          # Perfiles de modelo LLM (economico/preciso/openrouter/local)
│   ├── lib/
│   │   ├── auth/
│   │   │   ├── admin.ts                 # requerirAdmin(): sesión + allowlist para /api/admin/*
│   │   │   ├── allowlist.ts             # ALLOWED_EMAILS
│   │   │   ├── origen.ts                # Chequeo de Origin en mutaciones del panel del pipeline
│   │   │   └── cron.ts                  # Bearer de rutas cron
│   │   ├── pipeline/
│   │   │   ├── browser-cmd.ts           # agent-browser sin shell: comandos validados, binario nativo, entorno mínimo
│   │   │   ├── llamada-llm.ts           # Reintentos y diagnóstico de cada llamada al LLM
│   │   │   ├── salud-llm.ts             # Salud del proveedor en la corrida (corta si cae)
│   │   │   ├── schemas-llm.ts           # Validación runtime de las respuestas del LLM
│   │   │   ├── url-segura.ts            # Destinos permitidos (anti-SSRF)
│   │   │   ├── opciones-corrida.ts      # Alcance de una corrida (panel ↔ agente ↔ script)
│   │   │   ├── corridas.ts              # Cola/historial de corridas + protocolo de eventos script → agente
│   │   │   └── fechas.ts                # Fechas en hora argentina
│   │   └── mapa/
│   │       ├── queries.ts               # Prisma singleton + todas las queries a BD
│   │       ├── georef.ts                # Cliente para API Georef Argentina (IGN)
│   │       ├── cliente-llm.ts           # Cliente LLM centralizado — único lugar que instancia OpenAI
│   │       ├── openrouter.ts            # Extracción estructurada de noticias (LLM)
│   │       ├── pipeline-runner.ts       # Lanza el pipeline como proceso hijo (usado por /api/pipeline/run)
│   │       └── deduplicador.ts          # Deduplicación de noticias con IA
│   └── types/
│       └── mapa.ts                      # Tipos compartidos del frontend
├── prisma/
│   ├── schema.prisma                    # Esquema completo (PostgreSQL + postgis)
│   ├── seed.ts                          # Seed de tipos de delito
│   └── seed-subcategorias.ts            # Seed de subcategorías
├── public/
│   ├── icon.svg                         # Logo Usina (brazo gris + U azul) — usado como favicon
│   ├── favicon.ico                      # Favicon legacy
│   └── data/
│       ├── provincias-poligonos.geojson # Polígonos provinciales (usado por capas)
│       ├── departamentos-poligonos.geojson # Polígonos departamentales (lazy, ~1.2MB)
│       └── provincias-argentina.geojson # Alternativo (no usado en producción)
├── scripts/
│   ├── actualizar-centroides.ts         # Actualiza centroides desde Georef
│   ├── consulta-campos.ts               # Inspección de campos en BD
│   ├── ingesta/
│   │   ├── archivo/
│   │   │   ├── README.md                # Por qué estos scripts no se ejecutan
│   │   │   └── cargar-snic.ts           # Código muerto: lo reemplazó snic-departamentos.py
│   │   ├── auditar-catalogo-snic.py     # Audita códigos SNIC: CSV oficial vs seed vs prompt vs pipeline
│   │   ├── snic-departamentos.py        # Ingesta de departamentos desde CSV SNIC
│   │   ├── sat-homicidios.py            # Ingesta SAT (homicidios dolosos)
│   │   └── run_ingesta.sh               # Script orquestador de ingesta
│   ├── pipeline/
│   │   ├── scrapear-medios.ts           # Pipeline de scraping (13 medios activos; alcance por argumentos)
│   │   ├── agente-local.ts              # Agente que ejecuta corridas en la PC del equipo (npm run agente)
│   │   ├── medios-config.ts             # Lista MEDIOS (compartida con health-check y panel)
│   │   ├── cargar-env.ts                # Carga .env/.env.local antes que cualquier otro módulo
│   │   ├── verificar-medios.ts          # Health-check de las URLs de los medios
│   │   └── probar-feeds.ts              # Probe de feeds RSS/sitemap
│   └── sql/
│       ├── create-materialized-views.sql # ÚNICA definición de las 4 vistas materializadas
│       ├── add-performance-indexes.sql
│       ├── create-feedback.sql
│       └── create-revisiones-pipeline.sql # Tabla revisiones_pipeline (fuera de Prisma)
└── docs/
    ├── agente-local.md                  # Instalación y operación del agente local
    ├── analisis-2026-09.md              # Auditoría de sept. 2026 (corte del scraping, errores, mejoras)
    ├── pendientes-y-features.md         # Fuente de verdad del trabajo pendiente
    ├── catalogo-snic.md                 # GENERADO — no editar a mano (ver catalogo:auditar)
    └── informe-tecnico-ingesta.md
```

---

## 2. Scripts disponibles (`package.json`)

| Script | Descripción |
|---|---|
| `npm run dev` | Next.js en modo desarrollo |
| `npm run build` | Build de producción |
| `npm run start` | Servidor de producción |
| `npm run lint` | ESLint |
| `npm run georef:actualizar` | Actualiza centroides desde API Georef (IGN) |
| `npm run catalogo:auditar` | Audita el catálogo SNIC y regenera `docs/catalogo-snic.md` |
| `npm run catalogo:verificar` | Igual, sin escribir; exit 1 si hay desalineaciones |
| `npm run test:catalogo` | Tests del auditor (Python `unittest`) |
| `npm run pipeline:dry` | Pipeline de medios en modo dry-run (no escribe a BD) |
| `npm run pipeline:run` | Pipeline de medios en modo real |
| `npm run pipeline:medio` | Pipeline para un medio específico |
| `npm run pipeline:infobae` | Pipeline solo Infobae |
| `npm run pipeline:rosario3` | Pipeline solo Rosario3 |
| `npm run agente` | Agente local: corrida diaria + corridas pedidas desde `/admin/pipeline` (ver `docs/agente-local.md`) |
| `npm run typecheck` | `tsc --noEmit` (incluye `scripts/`) |
| `npm test` | Tests TS (`node --test`) |

Seed de Prisma: `npx prisma db seed` (ejecuta `prisma/seed.ts` vía `tsx`).

---

## 3. Variables de entorno requeridas

Definir en `.env` (nunca commitear valores reales):

```
DATABASE_URL                 # Conexión a Neon PostgreSQL (con pooler, sslmode=require)
OPENCODE_API_KEY             # API key de OpenCode Go — proveedor LLM activo
PIPELINE_PERFIL_MODELO       # "economico" (default) | "preciso" | "openrouter" | "local"
PIPELINE_DRY_RUN             # "true" / "false" — solo corridas manuales por consola (panel y programada deciden solas)
PIPELINE_MAX_NOTICIAS        # Notas por medio (default 10, máx. 25)
NEXT_PUBLIC_GOOGLE_MAPS_KEY  # API key de Google Maps (expuesta al browser)
AUTH_SECRET                  # Secret para NextAuth v5 (mín. 32 chars aleatorios)
GOOGLE_CLIENT_ID             # OAuth 2.0 Client ID (Google Cloud Console)
GOOGLE_CLIENT_SECRET         # OAuth 2.0 Client Secret
ALLOWED_EMAILS               # Emails con acceso a /admin, separados por coma
CRON_SECRET                  # Bearer token de las rutas cron (refresh-views)
# Opcionales — override de modelo si OpenCode Go renombra alguno:
OPENCODE_MODELO_ECONOMICO    # default: deepseek-v4-flash
OPENCODE_MODELO_PRECISO      # default: deepseek-v4-pro
# Opcionales para el perfil de respaldo "openrouter":
OPENROUTER_API_KEY           # API key de OpenRouter
OPENROUTER_MODEL             # default: deepseek/deepseek-chat-v3-0324
# Opcionales para perfil "local":
OLLAMA_BASE_URL              # URL de Ollama (ej: http://localhost:11434)
OLLAMA_MODEL                 # Nombre del modelo local (ej: llama3)
# Opcionales del pipeline:
PIPELINE_PERFIL_RESPALDO     # Perfil al que caer si el principal no responde (default: openrouter si hay key)
PIPELINE_LLM_RAZONAMIENTO    # bajo | desactivado | alto | max (vacío = el del proveedor)
PIPELINE_LLM_TIMEOUT_MS      # Timeout por request al LLM (default del SDK: 10 min)
PIPELINE_SNAPSHOT_MAX_CHARS  # Cuánto de cada portada ve el LLM (código: 3000; workflow y agente: 10000)
# Agente local (solo en la computadora que scrapea):
PIPELINE_AGENTE_NOMBRE       # Nombre en el panel (default: hostname)
PIPELINE_AGENTE_HORA         # Corrida diaria, hora argentina (default 07:00; "no" = sin programada)
PIPELINE_AGENTE_INTERVALO_S  # Cada cuánto mira la cola (default 15)
```

---

## 4. Autenticación (NextAuth v5)

- Proveedor: **Google OAuth**
- Middleware en `src/middleware.ts` protege `/admin/*` — redirige a `/admin/login` si no autenticado
- `src/auth.ts` exporta `{ handlers, auth, signIn, signOut }`
- `src/app/admin/layout.tsx` envuelve en `SessionProvider` — **obligatorio** para que `useSession` y `signOut` funcionen en Client Components bajo `/admin`
- Acceso restringido por **allowlist** (`ALLOWED_EMAILS`, `src/lib/auth/allowlist.ts`): se evalúa al iniciar sesión y en cada request (`authorized` y `requerirAdmin`), así que sacar un email corta el acceso sin esperar a que venza el token
- Las rutas `/api/admin/*` **no** pasan por el middleware (redirigiría con HTML): cada handler llama a `requerirAdmin()` y responde 401. Las mutaciones del panel del pipeline exigen además `Origin` de la misma página (`src/lib/auth/origen.ts`)

---

## 5. Pipeline de medios

### Dónde corre
- **Agente local** (`scripts/pipeline/agente-local.ts`, `npm run agente`) en la computadora del equipo: corrida diaria a las 7 (hora argentina, recupera si la PC estaba apagada) y las corridas que se encolan desde `/admin/pipeline`. Panel y agente se hablan por la tabla `corridas_pipeline`; la PC no necesita puertos abiertos. Ver `docs/agente-local.md`.
- **GitHub Actions** (`pipeline.yml`) es respaldo: corre a las 12 con `--solo-si-no-corrio-hoy` y solo trabaja si la programada del día no se hizo.
- Vercel no corre el pipeline (necesita Chrome y tarda más que una función serverless).

### Flujo general
0. Verifica que el proveedor LLM acepte requests (`verificarProveedorLLM`); si no, prueba el perfil de respaldo; si tampoco, sale con código 1 en segundos
1. `scrapear-medios.ts` abre un browser headless (agent-browser, sesión propia por corrida) y visita las secciones de policiales de los medios del alcance pedido
2. Por cada sitio, pide al LLM que identifique los links de homicidios en el snapshot (Prompt 1; con `--foco` prioriza esas localidades)
3. Lee el href de cada link: los destinos prohibidos y las notas ya registradas se descartan sin navegar
4. Para cada nota, extrae título y texto en un solo `eval` y datos estructurados con el LLM (Prompt 2 en `openrouter.ts`)
5. `deduplicador.ts` decide si es un hecho nuevo o cobertura de uno existente
6. Si es nuevo → inserta `HechoDelictivo` con `confianza = 'PRELIMINAR'`
7. Si es cobertura existente → agrega `CoberturaMediatica`; con 3+ coberturas de 2+ medios, sin revisión humana, sin `requiere_revision` y fuera del código 0, promueve a `VERIFICADO`

**Código de salida**: 0 si la corrida es confiable (aunque no encuentre nada), 1 si no (proveedor caído, corrida abortada por `salud-llm`, el browser no abrió ningún medio). Del 7 al 24/9/2026 el script salía siempre con 0 y el workflow quedó en verde 18 días sin una llamada exitosa: no volver a tragarse fallas sistémicas.

**Alcance** (`src/lib/pipeline/opciones-corrida.ts`, compartido por panel, agente y script): `--medios=a,b` · `--provincias=Santa Fe,Chaco` · `--incluir-nacionales` · `--incluir-no-verificados` · `--foco=Rosario,...` · `--max-noticias=N` · `--dry-run`. `--medio=X` sigue funcionando.

**Fechas**: todo día calendario se calcula en hora argentina (`src/lib/pipeline/fechas.ts`); el pipeline corre tanto en UTC (Actions) como en una PC de Argentina.

### Perfiles de modelo (`src/config/modelos-pipeline.ts`)
| Perfil | Proveedor | Modelo | USD / 1M entrada |
|---|---|---|---|
| `economico` (default) | OpenCode Go | `deepseek-v4-flash` | 0.14 |
| `preciso` | OpenCode Go | `deepseek-v4-pro` | 0.435 |
| `openrouter` | OpenRouter | DeepSeek V3 | 0.14 |
| `local` | Ollama | configurable | 0 |

Se cambia de perfil con `PIPELINE_PERFIL_MODELO`. Un valor inválido cae a `economico`.

**El cliente LLM se crea en un solo lugar**: `src/lib/mapa/cliente-llm.ts`. Los tres consumidores (`openrouter.ts`, `deduplicador.ts`, `scrapear-medios.ts`) lo usan vía `crearClienteLLM(titulo)`. **No instanciar `OpenAI` en otro lado** — la lógica de proveedor, baseURL y API key vive ahí. `credencialFaltante()` devuelve el nombre de la env var que falta para que quien llame decida si aborta o degrada.

Los tres proveedores hablan la API de OpenAI. OpenCode Go expone `/zen/go/v1` (compatible), Ollama publica la suya bajo `/v1`, y solo OpenRouter recibe los headers de atribución `HTTP-Referer` / `X-Title`.

**OpenCode Go exige el header `x-opencode-session`** desde el 06/09/2026 (sin él responde 400). `crearClienteLLM` manda un UUID estable por consumidor dentro de cada proceso (así Go rutea al mismo proveedor y aprovecha el caché de prompts) y un User-Agent propio (`usina-mapa-delito/1.0`). No crear clientes por fuera de `crearClienteLLM` o se pierden los dos.

Todas las llamadas pasan por `obtenerContenidoLLM` (`src/lib/pipeline/llamada-llm.ts`): reintenta vacíos y 429/5xx, no reintenta 400/401/403/404/422, y anota cada resultado en `salud-llm.ts`, que corta la corrida ante 3 rechazos seguidos del proveedor. Los parámetros de razonamiento opcionales salen de `parametrosExtraLLM()` (ver `PIPELINE_LLM_RAZONAMIENTO`).

Los IDs de modelo de Go son overridables por env var (`OPENCODE_MODELO_ECONOMICO`, `OPENCODE_MODELO_PRECISO`): si Go renombra un modelo se corrige sin deploy. Catálogo público en `https://opencode.ai/zen/go/v1/models`.

### Few-shot automático
`openrouter.ts` consulta los últimos 3 casos verificados por humanos en `revisiones_pipeline` y los inyecta como ejemplos en cada llamada al LLM. Se cachea 5 minutos para no repetir la query en cada noticia.

### Medios activos
13 medios con `activo: true`, uno fuerte por región (`scripts/pipeline/medios-config.ts`). El resto está en `activo: false`: una corrida enfocada del panel puede sumar los no verificados de una provincia. Clarín, La Nación y La Capital Rosario están desactivados por paywall y nunca entran en una corrida por provincia.

---

## 6. Panel de administración (`/admin`)

### `/admin/login`
Login con Google. Redirige a `/admin/revisiones` tras autenticar (fijo: no respeta el destino original, ver pendientes).

### `/admin/dashboard`
Métricas del pipeline: totales, actividad semanal (8 semanas), precisión por medio (30 días). Link a revisiones con contador de pendientes.

### `/admin/revisiones`
Revisión humana de casos del pipeline. Flujo:
- **Pendientes**: hechos con `confianza = 'PRELIMINAR'` y sin entrada en `revisiones_pipeline`
- **Acciones**: Homicidio doloso / En ocasión de robo / Femicidio / Narcotráfico / No es homicidio
- **Al confirmar**: `confianza` pasa a `'VERIFICADO'`, se actualiza `tipo_delito_id`
- **Al rechazar**: queda `PRELIMINAR` sin revisión pendiente (no reaparece en la cola)
- **Revisados recientes**: muestra los últimos 48h con quién clasificó y cuándo
- **Corregir**: cualquier revisor puede sobrescribir. Si VERIFICADO → no_es_homicidio, vuelve a PRELIMINAR
- **Tiempo real**: SSE en `/api/admin/revisiones/stream` pushea eventos cada 4s; polling de respaldo cada 30s

### `/admin/pipeline`
Control del pipeline:
- **Agente local**: conectado o no, última señal, hora de la programada, modelo
- **Nueva corrida**: todos los medios activos o enfocada en provincias (+ nacionales, + no verificados), localidades a priorizar, notas por medio (5–25), modo prueba. Muestra antes qué medios va a recorrer. Máximo 5 corridas en cola
- **En curso**: barra de progreso, contadores, log en vivo (solo líneas nuevas cada 3 s) y cancelación (el agente corta el árbol de procesos y cierra el navegador)
- **Historial**: programadas, del panel, de Actions y de consola, con el motivo de cada falla

### `revisiones_pipeline` (tabla, fuera de Prisma)
Historial completo de revisiones humanas. Permite múltiples filas por `hecho_id` (correcciones sucesivas). Ver `scripts/sql/create-revisiones-pipeline.sql`.

---

## 7. Schema de tablas principales (Neon / Prisma)

La BD es PostgreSQL en Neon con extensión `postgis`.

### `hechos_delictivos` ← tabla principal
- `es_agregado = true` → dato anual SNIC; `false` → microdato individual (SAT, pipeline)
- `confianza`: enum `OFICIAL` | `VERIFICADO` | `PRELIMINAR`
- `requiere_revision`: flag para casos ambiguos del pipeline

### `corridas_pipeline` / `corridas_pipeline_lineas` / `agentes_pipeline`
Cola e historial de corridas (estado `pendiente | en_curso | completada | fallida | cancelada`, origen `panel | programada | github-actions | cli`, parámetros, progreso, resumen, latido), su log línea por línea (se borra a los 30 días) y el latido de cada agente. `clave_unica = 'programada:AAAA-MM-DD'` evita duplicar la corrida del día. Acceso solo vía `src/lib/pipeline/corridas.ts`.

### `coberturas_mediaticas`
Notas periodísticas vinculadas a un `hecho_delictivo_id`. `url` es unique (deduplicación).

### Vistas materializadas (SQL, no en Prisma)
| Vista | Descripción |
|---|---|
| `mv_snic_provincia` | Totales SNIC por provincia y año |
| `mv_snic_provincia_delito` | Totales SNIC por provincia, año y tipo de delito |
| `mv_sat_provincia` | Totales SAT (homicidios dolosos) por provincia y año |
| `mv_anios_disponibles` | Años disponibles por fuente (`snic` / `sat`) |

Refrescar con `REFRESH MATERIALIZED VIEW` después de cada ingesta.

---

## 8. Componentes de mapa

### `MapaDelito.tsx` — orquestador principal
Estado global: año, tipo de delito, fuente (SNIC/SAT), filtros SAT, provincia seleccionada, `controlesExpandidos` (panel mobile). `fetchDatos` cancela fetches anteriores con `AbortController`. Timeouts de animación guardados en `flyTimersRef` para cleanup correcto.

**Layout mobile**: fila superior siempre visible (título + SNIC/SAT + botón expandir). Panel expandible debajo con buscador, slider, stats y filtros SAT/selector delito según la fuente activa.

**FiltrosSAT**: se renderiza DENTRO del panel de controles (no se auto-posiciona). En mobile va en el panel expandible; en desktop en la segunda fila. Esto evita el overlap con el panel expandido.

**Botón "Revisar"**: flotante en `bottom-[72px] right-4`, encima del botón de recentrar.

### `capas/CapaHechosMedios.tsx`
Pins individuales del pipeline. Rojo (`#C0392B`) = VERIFICADO, naranja (`#E67E22`) = PRELIMINAR. InfoWindow con detalles al click. Toggle en la leyenda.

### `FiltrosSAT.tsx`
Chips de filtros (Sexo, Arma, Vínculo, Lugar). **No tiene posicionamiento propio** — su padre decide dónde lo ubica. Carga opciones una sola vez desde `/api/mapa/sat-opciones`.

---

## 9. Convenciones

- **Prisma client**: singleton exportado desde `@/lib/mapa/queries` como `prisma`. **No instanciar en otro lado** — agota el connection pool de Neon.
- **Raw SQL**: `prisma.$queryRaw` con template literals para vistas materializadas. `prisma.$queryRawUnsafe` solo con parámetros dinámicos validados.
- **Cache-Control en rutas públicas**: `public, s-maxage=3600, stale-while-revalidate=86400` para SNIC; `s-maxage=300, stale-while-revalidate=600` para datos del pipeline.
- **Cache-Control en rutas admin**: siempre `no-store`.
- **Paleta**: `#1E427C` (primario), `#A7A8AC` (secundario). **NUNCA violeta/púrpura.**
- **Español**: nombres de componentes, variables de UI y comentarios. Tipos TypeScript en inglés/camelCase.
- **GeoJSON**: servidos desde `public/data/`. No moverlos. Departamentos (~1.2MB) solo se cargan en zoom ≥ 6.
- **IDs de provincias**: código INDEC 2 dígitos con cero (`'06'` = Buenos Aires). Siempre `padStart(2, '0')`.
- **SSE**: reconecta automáticamente cuando el servidor cierra la conexión (límite Vercel 270s). Usar con polling de respaldo para cubrir múltiples instancias. El cursor es un id entero y cada evento lleva `id:` (el navegador retoma con `Last-Event-ID`); nunca un timestamp de JS, que pierde los microsegundos de Postgres.
- **Columnas DATE en el cliente** (`fecha_hecho`): formatear con `timeZone: 'UTC'`. En la zona del navegador (UTC-3) la medianoche UTC cae el día anterior.
- **Procesos externos**: siempre `execFile`/`spawn` con array de argumentos y `shell: false` (ver `browser-cmd.ts`). En Windows no se pueden lanzar `.cmd` sin shell: apuntar al binario nativo.

---

## 10. Contexto de negocio

**Organización:** Usina de Justicia — ONG argentina de derechos de víctimas de homicidio y femicidio.

**Audiencia pública:** víctimas, familiares, periodistas, funcionarios. Mobile 4G argentino es el caso de uso crítico.

**Audiencia admin:** equipo interno de Usina (3-5 personas) que revisa y valida los casos del pipeline.

---

## 11. Estado actual del producto

- ✅ Mapa público desplegado en Vercel con datos SNIC y SAT
- ✅ Pipeline con 13 medios activos, corriendo a diario desde el agente local (Actions de respaldo)
- ✅ Panel admin con revisión humana, métricas, tiempo real (SSE) y control del pipeline (`/admin/pipeline`)
- ✅ Página de metodología en `/metodologia`
- ✅ Favicon e identidad visual de Usina
- ✅ Loading screen con logo en sección admin
- ⏳ Refactor visual: distinción más clara entre capa SNIC y capa de medios en el mapa
- ⏳ DuckDB + Parquet + H3 (optimización futura, no MVP)
- ⏳ Pendientes priorizados de la auditoría de sept. 2026: `docs/pendientes-y-features.md` (evidencia en `docs/analisis-2026-09.md`)
