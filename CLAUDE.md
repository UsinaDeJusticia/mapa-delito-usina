# CLAUDE.md — Mapa del Delito · Usina de Justicia

Guía de referencia para trabajar en este repo. Leerla antes de tocar cualquier archivo.

---

## 1. Estructura de carpetas

```
mapa-delito-usina/
├── src/
│   ├── app/
│   │   ├── layout.tsx                   # Root layout (fuentes Geist, globals.css)
│   │   ├── page.tsx                     # Raíz "/" (redirige o landing)
│   │   ├── globals.css                  # CSS global + variables Tailwind
│   │   ├── mapa-del-delito/
│   │   │   ├── layout.tsx               # Layout de la sección mapa
│   │   │   └── page.tsx                 # Página /mapa-del-delito (carga MapaDelito via dynamic)
│   │   ├── dashboard/
│   │   │   └── page.tsx                 # Dashboard (uso interno)
│   │   └── api/
│   │       └── mapa/
│   │           ├── estadisticas/        # GET → datos por provincia (SNIC o SAT)
│   │           ├── tendencias/          # GET → serie temporal de un delito por provincia
│   │           ├── tipos-delito/        # GET → catálogo de tipos SNIC
│   │           ├── provincias/          # GET → lista de provincias con centroides
│   │           ├── delitos-provincia/   # GET → top delitos de una provincia (mv)
│   │           └── sat-opciones/        # GET → valores únicos de filtros SAT
│   ├── components/
│   │   └── mapa/
│   │       ├── MapaDelito.tsx           # Componente principal (orquesta todo)
│   │       ├── MapaDelitoWrapper.tsx    # Re-export con dynamic import (SSR=false)
│   │       ├── PanelEstadisticas.tsx    # Panel lateral de detalles de provincia
│   │       ├── SliderAnios.tsx          # Selector de año
│   │       ├── SelectorDelito.tsx       # Dropdown de tipo de delito (SNIC)
│   │       ├── SelectorFuente.tsx       # Toggle SNIC / SAT
│   │       ├── BuscadorProvincia.tsx    # Buscador de provincia con fly-to
│   │       ├── FiltroDepartamento.tsx   # Filtro de departamento (oculto, Fase 2)
│   │       ├── FiltrosSAT.tsx           # Chips de filtros SAT (sexo, arma, vínculo, lugar)
│   │       ├── capas/
│   │       │   ├── index.ts             # Re-exports de capas
│   │       │   ├── MascaraPaises.tsx    # Polígono mundial con agujero Argentina
│   │       │   ├── CapaProvincias.tsx   # Coroplético provincial (google.maps.Data)
│   │       │   ├── CapaDepartamentos.tsx# Bordes departamentales + labels (lazy)
│   │       │   └── MarcadoresCirculares.tsx # Burbujas SVG por provincia
│   │       └── hooks/
│   │           ├── useGeoJSON.ts        # Fetch + cache en memoria de GeoJSON
│   │           └── useGeolocalizacion.ts# GPS del browser, no bloquea carga
│   ├── config/
│   │   └── mapStyles.ts                 # Estilos Google Maps + helpers de color
│   ├── lib/
│   │   └── mapa/
│   │       ├── queries.ts               # Prisma client + todas las queries a BD
│   │       ├── georef.ts                # Cliente para API Georef Argentina (IGN)
│   │       ├── openrouter.ts            # Cliente OpenRouter para pipeline de medios
│   │       └── deduplicador.ts          # Deduplicación de noticias
│   └── types/
│       └── mapa.ts                      # Tipos compartidos del frontend
├── prisma/
│   ├── schema.prisma                    # Esquema completo (PostgreSQL + postgis)
│   ├── seed.ts                          # Seed de tipos de delito
│   └── seed-subcategorias.ts            # Seed de subcategorías
├── public/
│   └── data/
│       ├── provincias-poligonos.geojson # Polígonos provinciales (usado por capas)
│       ├── departamentos-poligonos.geojson # Polígonos departamentales (lazy)
│       └── provincias-argentina.geojson # Alternativo (no usado en producción)
├── scripts/
│   ├── actualizar-centroides.ts         # Actualiza centroides desde Georef
│   ├── consulta-campos.ts               # Inspección de campos en BD
│   ├── ingesta/
│   │   ├── cargar-snic.ts               # Carga datos SNIC en BD
│   │   ├── snic-departamentos.py        # Ingesta de departamentos desde CSV SNIC
│   │   ├── sat-homicidios.py            # Ingesta SAT (homicidios dolosos)
│   │   └── run_ingesta.sh               # Script orquestador de ingesta
│   ├── pipeline/
│   │   └── scrapear-medios.ts           # Pipeline de scraping de noticias
│   └── sql/
│       ├── create-materialized-views.sql# Crea mv_snic_provincia, mv_snic_provincia_delito
│       ├── create-remaining-views.sql   # mv_anios_disponibles y otras vistas
│       └── mv_sat_provincia.sql         # Vista materializada para SAT
└── docs/
    └── informe-tecnico-ingesta.md       # Documentación del proceso de ingesta
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
DATABASE_URL          # Conexión a Neon PostgreSQL (con pooler, sslmode=require)
OPENROUTER_API_KEY    # API key de OpenRouter (pipeline de medios)
OPENROUTER_MODEL      # Modelo a usar (ej: deepseek/deepseek-chat-v3-0324)
PIPELINE_DRY_RUN      # "true" / "false" — controla si el pipeline escribe a BD
PIPELINE_MAX_NOTICIAS # Número máximo de noticias por corrida
NEXT_PUBLIC_GOOGLE_MAPS_KEY  # API key de Google Maps (expuesta al browser)
```

> `NEXT_PUBLIC_GOOGLE_MAPS_KEY` **no está en `.env` todavía** — el componente lo lee con `process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY`. Hay que agregarlo.

---

## 4. Schema de tablas principales (Neon / Prisma)

La BD es PostgreSQL en Neon con extensión `postgis`.

### `fuentes`
Registros de las fuentes de datos (SNIC, SAT, medios, Usina).
- Campos clave: `nombre`, `tipo` (enum: OFICIAL/PERIODISTICA/CIUDADANA/USINA/ACADEMICA), `frecuencia`, `activa`.

### `tipos_delito`
Catálogo de tipos de delito según clasificación SNIC.
- Campos clave: `codigo_snic` (unique), `nombre`, `categoria` (enum), `activo`.

### `sub_tipos_delito`
Subcategorías (femicidio, robo seguido de muerte, etc.) vinculadas a `tipos_delito`.

### `ubicaciones`
Ubicaciones normalizadas con IDs INDEC.
- Campos clave: `provincia`, `provincia_id`, `departamento`, `departamento_id`, `latitud`, `longitud`, `es_centroide`.
- Índices en `provincia_id`, `departamento_id`, `(latitud, longitud)`.

### `hechos_delictivos` ← tabla principal
Hecho delictivo individual o agregado (SNIC).
- Relaciones: `tipo_delito_id → tipos_delito`, `ubicacion_id → ubicaciones`, `fuente_id → fuentes`, `caso_usina_id → casos_usina`.
- Campos SAT: `victimaSexo`, `victimaEdad`, `medioComision`, `vinculoVictimaVictimario`, `lugarHecho`, `femicidio`.
- `es_agregado = true` → dato anual SNIC; `false` → microdato individual (SAT, pipeline).
- Índices compuestos: `(anio)`, `(anio, tipo_delito_id)`, `(ubicacion_id)`.

### `estadisticas_agregadas`
Cache de estadísticas anuales por provincia/departamento/delito.
- Unique: `(anio, provincia_id, departamento_id, tipo_delito_id)`.

### `casos_usina`
Casos acompañados por Usina de Justicia. Requiere `consentimiento = true` para publicar.

### `coberturas_mediaticas`
Notas periodísticas vinculadas a un `hecho_delictivo_id`.
- `url` es unique (deduplicación). Enum `tipo_cobertura`: HECHO_INICIAL, DETENCION, SENTENCIA, etc.

### Vistas materializadas (SQL, no en Prisma)
| Vista | Descripción |
|---|---|
| `mv_snic_provincia` | Totales SNIC por provincia y año (~600 filas) |
| `mv_snic_provincia_delito` | Totales SNIC por provincia, año y tipo de delito |
| `mv_sat_provincia` | Totales SAT (homicidios dolosos) por provincia y año |
| `mv_anios_disponibles` | Años disponibles por fuente (`snic` / `sat`) |

Estas vistas deben refrescarse con `REFRESH MATERIALIZED VIEW` después de cada ingesta.

---

## 5. Componentes de mapa — qué hace cada uno

### `MapaDelito.tsx` — orquestador principal
Estado global del mapa: año, tipo de delito, fuente (SNIC/SAT), filtros SAT, provincia seleccionada. Contiene `fetchDatos` que llama a `/api/mapa/estadisticas` y cancela fetches anteriores con `AbortController`. Renderiza `APIProvider` + `Map` de `@vis.gl/react-google-maps` y monta todas las capas y controles.

### `MapaDelitoWrapper.tsx`
Re-export de `MapaDelito` con `next/dynamic` y `ssr: false`. Necesario porque Google Maps requiere `window`. Usarlo siempre en páginas que hacen SSR.

### `PanelEstadisticas.tsx`
Panel lateral derecho (420px en desktop, fullscreen en mobile). Muestra hechos y víctimas de la provincia seleccionada. Hace dos fetches adicionales: tendencia histórica (`/api/mapa/tendencias`) y top delitos (`/api/mapa/delitos-provincia`). Usa Recharts: `BarChart` para delitos, `LineChart` para evolución.

### `SelectorFuente.tsx`
Toggle SNIC / SAT. Al cambiar a SAT limpia el tipo de delito seleccionado.

### `SelectorDelito.tsx`
Dropdown de tipos de delito (solo visible en modo SNIC). Carga desde `/api/mapa/tipos-delito`. Agrupa por `categoria`.

### `SliderAnios.tsx`
Control de año. Se muestra solo cuando `aniosDisponibles.length > 0`.

### `BuscadorProvincia.tsx`
Input de búsqueda por nombre de provincia. Al seleccionar hace "fly-to" con efecto zoom-out → pan → zoom-in. Muestra toast de instrucción.

### `FiltroDepartamento.tsx`
Filtro por departamento. **Actualmente comentado** en `MapaDelito.tsx` — Fase 2.

### `FiltrosSAT.tsx`
Barra de chips de filtros SAT (Sexo, Arma, Vínculo, Lugar). Carga opciones desde `/api/mapa/sat-opciones` una sola vez al activar fuente SAT. Solo visible cuando `fuente === 'sat'`.

### `capas/MascaraPaises.tsx`
Polígono mundial con "agujero" en cada provincia argentina. Oculta labels y bordes de países vecinos. Opacidad 0.93. Lee el mismo GeoJSON de provincias.

### `capas/CapaProvincias.tsx`
Coroplético provincial usando `google.maps.Data`. Colorea provincias según cantidad de hechos (intensidad relativa). Aplica opacidad decreciente al hacer zoom para no tapar labels de Google. Dispara `onProvinciaClick` y `onProvinciaHover`.

### `capas/CapaDepartamentos.tsx`
Bordes y labels de departamentos. **Lazy loading**: no carga el GeoJSON hasta que zoom ≥ 6 o hay provincia seleccionada. Soporta `destacados` (lista de IDs a resaltar en rojo). Límite de 80 labels simultáneos para performance mobile. `QUILMES_DEPTO_ID = '06658'` está hardcodeado como destacado en `MapaDelito.tsx`.

### `capas/MarcadoresCirculares.tsx`
Burbujas SVG circulares por provincia. Radio y color proporcional al total de hechos. En modo SAT con filtros activos, usa paleta naranja en vez de azul. `InfoWindow` al hover con top 3 delitos. Click abre `PanelEstadisticas`.

### `hooks/useGeoJSON.ts`
Fetch de GeoJSON con cache en memoria (Map estático a nivel módulo). Soporta `habilitado: boolean` para carga condicional/lazy. Exporta `precargarGeoJSON()` para prefetch silencioso en background.

### `hooks/useGeolocalizacion.ts`
GPS del browser. Timeout de 8s; si no llega, el mapa sigue con la vista nacional. Solo mueve el mapa si el usuario está dentro del bounding box de Argentina.

---

## 6. Convenciones de imports

```typescript
// Alias de paths (tsconfig.json: "paths": { "@/*": ["./src/*"] })
import { algo } from '@/components/mapa/...'
import { algo } from '@/lib/mapa/queries'
import { algo } from '@/config/mapStyles'
import { algo } from '@/types/mapa'

// Named exports para la mayoría de componentes
export function CapaProvincias(...) {}   // Named
export default function MapaDelito(...) {} // Default solo en componentes de página/ruta

// Re-exports en capas/index.ts
export { MascaraPaises } from './MascaraPaises'

// Siempre 'use client' en componentes que usan hooks o Google Maps
'use client'
```

### Convenciones adicionales
- **Fuentes**: los APIs de Neon se consultan desde rutas de API (`src/app/api/`), nunca directo desde el cliente.
- **Prisma client**: singleton exportado desde `@/lib/mapa/queries` como `prisma`. No instanciar en otro lado.
- **Raw SQL**: usar `prisma.$queryRaw` con template literals (seguro) para queries a vistas materializadas. Solo usar `prisma.$queryRawUnsafe` cuando los parámetros son dinámicos (como en `getEstadisticasSATFiltrado`).
- **Colores**: paleta azul Usina `#1E427C`. Clases Tailwind disponibles: `text-usina-{50..900}`, `bg-usina-{50..900}`, `heat-{1..7}`. No usar colores arbitrarios si hay clase Tailwind equivalente.
- **Español**: todos los nombres de componentes, variables de UI y comentarios van en español. Tipos TypeScript y keys de objetos van en inglés o camelCase español.
- **GeoJSON en `public/data/`**: servidos estáticamente vía `/data/nombre.geojson`. No moverlos.
- **IDs de provincias**: código INDEC de 2 dígitos con cero a la izquierda (`'06'` = Buenos Aires). Siempre `padStart(2, '0')` al normalizar desde BD.
