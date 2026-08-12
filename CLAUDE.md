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
│   │   │   └── revisiones/
│   │   │       └── page.tsx             # Revisión humana de casos del pipeline
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
│   │       │   └── metricas/
│   │       │       └── route.ts         # GET → métricas del pipeline (semanas, medios, totales)
│   │       └── pipeline/
│   │           └── run/
│   │               └── route.ts         # POST → dispara pipeline (cron o manual, bearer token)
│   ├── auth.ts                          # Configuración NextAuth v5 (Google OAuth)
│   ├── middleware.ts                    # Protege /admin/* — redirige a /admin/login si no autenticado
│   ├── components/
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
│   │   ├── snic-departamentos.py        # Ingesta de departamentos desde CSV SNIC
│   │   ├── sat-homicidios.py            # Ingesta SAT (homicidios dolosos)
│   │   └── run_ingesta.sh               # Script orquestador de ingesta
│   ├── pipeline/
│   │   └── scrapear-medios.ts           # Pipeline de scraping (~45 medios activos)
│   └── sql/
│       ├── create-materialized-views.sql # ÚNICA definición de las 4 vistas materializadas
│       ├── add-performance-indexes.sql
│       ├── create-feedback.sql
│       └── create-revisiones-pipeline.sql # Tabla revisiones_pipeline (fuera de Prisma)
└── docs/
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
| `npm run pipeline:dry` | Pipeline de medios en modo dry-run (no escribe a BD) |
| `npm run pipeline:run` | Pipeline de medios en modo real |
| `npm run pipeline:medio` | Pipeline para un medio específico |
| `npm run pipeline:infobae` | Pipeline solo Infobae |
| `npm run pipeline:rosario3` | Pipeline solo Rosario3 |

Seed de Prisma: `npx prisma db seed` (ejecuta `prisma/seed.ts` vía `tsx`).

---

## 3. Variables de entorno requeridas

Definir en `.env` (nunca commitear valores reales):

```
DATABASE_URL                 # Conexión a Neon PostgreSQL (con pooler, sslmode=require)
OPENCODE_API_KEY             # API key de OpenCode Go — proveedor LLM activo
PIPELINE_PERFIL_MODELO       # "economico" (default) | "preciso" | "openrouter" | "local"
PIPELINE_DRY_RUN             # "true" / "false" — controla si el pipeline escribe a BD
PIPELINE_MAX_NOTICIAS        # Número máximo de noticias por medio
NEXT_PUBLIC_GOOGLE_MAPS_KEY  # API key de Google Maps (expuesta al browser)
AUTH_SECRET                  # Secret para NextAuth v5 (mín. 32 chars aleatorios)
GOOGLE_CLIENT_ID             # OAuth 2.0 Client ID (Google Cloud Console)
GOOGLE_CLIENT_SECRET         # OAuth 2.0 Client Secret
CRON_SECRET                  # Bearer token de /api/pipeline/run
# Opcionales — override de modelo si OpenCode Go renombra alguno:
OPENCODE_MODELO_ECONOMICO    # default: deepseek-v4-flash
OPENCODE_MODELO_PRECISO      # default: deepseek-v4-pro
# Opcionales para el perfil de respaldo "openrouter":
OPENROUTER_API_KEY           # API key de OpenRouter
OPENROUTER_MODEL             # default: deepseek/deepseek-chat-v3-0324
# Opcionales para perfil "local":
OLLAMA_BASE_URL              # URL de Ollama (ej: http://localhost:11434)
OLLAMA_MODEL                 # Nombre del modelo local (ej: llama3)
```

---

## 4. Autenticación (NextAuth v5)

- Proveedor: **Google OAuth**
- Middleware en `src/middleware.ts` protege `/admin/*` — redirige a `/admin/login` si no autenticado
- `src/auth.ts` exporta `{ handlers, auth, signIn, signOut }`
- `src/app/admin/layout.tsx` envuelve en `SessionProvider` — **obligatorio** para que `useSession` y `signOut` funcionen en Client Components bajo `/admin`
- El callback `authorized` acepta cualquier cuenta Google autenticada. Si se requiere restringir por email, hacerlo en ese callback comparando `auth.user.email` contra una lista en env vars

---

## 5. Pipeline de medios

### Flujo general
1. `scrapear-medios.ts` abre un browser headless y visita las secciones de policiales de ~45 medios
2. Por cada sitio, pide al LLM que identifique URLs de homicidios (Prompt 1)
3. Para cada URL identificada, extrae datos estructurados (Prompt 2 en `openrouter.ts`)
4. `deduplicador.ts` decide si es un hecho nuevo o cobertura de uno existente
5. Si es nuevo → inserta `HechoDelictivo` con `confianza = 'PRELIMINAR'`
6. Si es cobertura existente → solo agrega `CoberturaMediatica`

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

Los IDs de modelo de Go son overridables por env var (`OPENCODE_MODELO_ECONOMICO`, `OPENCODE_MODELO_PRECISO`): si Go renombra un modelo se corrige sin deploy. Catálogo público en `https://opencode.ai/zen/go/v1/models`.

### Few-shot automático
`openrouter.ts` consulta los últimos 3 casos verificados por humanos en `revisiones_pipeline` y los inyecta como ejemplos en cada llamada al LLM. Se cachea 5 minutos para no repetir la query en cada noticia.

### Medios activos
~45 medios con `activo: true`. Cobertura nacional + provincias clave. Clarín, La Nación y La Capital Rosario están en `activo: false` por paywall.

---

## 6. Panel de administración (`/admin`)

### `/admin/login`
Login con Google. Redirige a `/admin/dashboard` tras autenticar.

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

### `revisiones_pipeline` (tabla, fuera de Prisma)
Historial completo de revisiones humanas. Permite múltiples filas por `hecho_id` (correcciones sucesivas). Ver `scripts/sql/create-revisiones-pipeline.sql`.

---

## 7. Schema de tablas principales (Neon / Prisma)

La BD es PostgreSQL en Neon con extensión `postgis`.

### `hechos_delictivos` ← tabla principal
- `es_agregado = true` → dato anual SNIC; `false` → microdato individual (SAT, pipeline)
- `confianza`: enum `OFICIAL` | `VERIFICADO` | `PRELIMINAR`
- `requiere_revision`: flag para casos ambiguos del pipeline

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
- **SSE**: reconecta automáticamente cuando el servidor cierra la conexión (límite Vercel 270s). Usar con polling de respaldo para cubrir múltiples instancias.

---

## 10. Contexto de negocio

**Organización:** Usina de Justicia — ONG argentina de derechos de víctimas de homicidio y femicidio.

**Audiencia pública:** víctimas, familiares, periodistas, funcionarios. Mobile 4G argentino es el caso de uso crítico.

**Audiencia admin:** equipo interno de Usina (3-5 personas) que revisa y valida los casos del pipeline.

---

## 11. Estado actual del producto

- ✅ Mapa público desplegado en Vercel con datos SNIC y SAT
- ✅ Pipeline activo con ~45 medios, corriendo periódicamente
- ✅ Panel admin con revisión humana, métricas y tiempo real (SSE)
- ✅ Página de metodología en `/metodologia`
- ✅ Favicon e identidad visual de Usina
- ✅ Loading screen con logo en sección admin
- ⏳ Refactor visual: distinción más clara entre capa SNIC y capa de medios en el mapa
- ⏳ DuckDB + Parquet + H3 (optimización futura, no MVP)
