# Análisis de septiembre 2026: corte del scraping, errores y mejoras

Auditoría completa del repo hecha el 25/09/2026 (rama
`claude/scraping-error-analysis-hoh42v`): el pipeline de medios, el panel
admin, el mapa público, los datos y la CI. Todo hallazgo de este documento se
verificó leyendo el código (o corriéndolo); lo que quedó sin confirmar está
marcado como tal. La lista priorizada y viva de lo pendiente está en
[`pendientes-y-features.md`](pendientes-y-features.md).

---

## 1. Por qué no hubo scraping del 7 al 24 de septiembre

**Causa.** Desde el 06/09/2026 OpenCode Go rechaza toda request que no traiga
el header `x-opencode-session`:

```
400 Request is missing x-opencode-session and cannot be routed efficiently.
Please see https://opencode.ai/docs/go/#where-can-i-use-it
```

El pipeline no lo mandaba. Las 18 corridas diarias del 07/09 al 24/09 fallaron
en la primera llamada al LLM de cada uno de los 13 medios. La última corrida
sana fue la del **06/09** (27 notas leídas, 23 hechos, 11 nuevos, 11 coberturas).

**Por qué nadie se enteró.** El script salía siempre con código 0, así que el
workflow quedaba en verde. Cada medio degradaba "bien" de a uno (sin respuesta
del modelo, "0 noticias") y nada miraba el agregado: 13 de 13 medios sin una sola
respuesta. Estaba anotado como pendiente desde el review del PR #10
(`pendientes-y-features.md`, 1.8).

**Qué cambió.** El cliente LLM manda ahora `x-opencode-session` (un UUID
estable por consumidor dentro de cada corrida) y un User-Agent propio, que es lo
que pide la documentación de Go. Antes de empezar, el pipeline hace una llamada
de verificación: si el proveedor rechaza, la corrida falla en ~1 segundo con el
mensaje exacto del proveedor y **en rojo** (código 1), en Actions y en el panel.
Si hay un perfil de respaldo con credenciales (`OPENROUTER_API_KEY`), sigue con
ese.

**Lo que se perdió.** Las secciones de policiales solo muestran las notas
recientes, así que buena parte de esas dos semanas ya no está en las portadas.
Una corrida enfocada con más profundidad (25 notas por medio, desde el panel)
puede recuperar lo que siga publicado. Recuperar el resto requiere buscar por
fecha (ver 4.4, descubrimiento por feeds o búsqueda).

**Riesgo que queda.** OpenCode Go se define como un servicio "para agentes de
programación". El pipeline cumple lo que Go pide (header y user agent), pero su
tráfico no es de un agente de programación: si Go endurece el control, podría
bloquearlo. Por eso conviene cargar `OPENROUTER_API_KEY` como respaldo
automático (en el `.env` del agente y como secret de Actions).

---

## 2. Qué se arregló en esta rama

### Pipeline

| Problema | Antes | Ahora |
|---|---|---|
| Header de OpenCode Go | faltaba → 400 en todas las llamadas | `x-opencode-session` + User-Agent propio |
| Falla del proveedor | exit 0, workflow en verde con cero noticias | verificación inicial, corte a los 3 rechazos seguidos, exit 1 con el motivo |
| Reintentos | un 400 se repetía 3 veces por llamada | 400/401/403/404/422 no se reintentan; 429 y 5xx sí |
| `agent-browser wait` | `--load domcontentloaded` agotaba 25 s en cada página (ETIMEDOUT en 12 de 13 medios) | `wait --fn` sobre `readyState`: 0,16 s |
| Texto de cada nota | hasta 14 `get text` con timeout de 5 s cada uno; ~33 s por nota en producción | un solo `eval`: los comandos de browser de una nota suman ~1,5 s (medido contra un sitio local; aparte quedan ~3 s de esperas de cortesía) |
| Notas ya registradas | se abría la nota para descubrirlo (17 de 44 links el 6/9) | se lee el href antes del click y se descarta sin navegar |
| `PIPELINE_MAX_NOTICIAS` | se mostraba en el log y se ignoraba (corte fijo en 10) | se respeta; el panel elige la profundidad |
| Windows | el shim `.cmd` no se puede lanzar sin shell desde Node 20.12: el pipeline no corría | se usa el binario nativo; entorno con las variables que Chrome necesita |
| Fechas | `new Date('2026-01-01').getFullYear()` en una PC de Argentina daba 2025 | fechas calculadas en hora argentina |
| Pestaña que no abre | se leía la portada como nota y se cerraba el listado | se detecta y se descarta |
| Medio que no carga | la página de error de Chrome contaba como "sin noticias" | queda marcado como problema; si no abre ninguno, la corrida falla |
| Error de base en una nota | tiraba abajo el resto de la corrida | se registra y se sigue |
| Promoción a VERIFICADO | 3 notas cualesquiera (del mismo medio, o de un caso que un revisor rechazó) | 3+ notas de 2+ medios, nunca sobre un caso revisado, con `requiere_revision` o de código 0 |
| Ubicaciones | las notas sin ciudad creaban filas con `es_centroide = true`, que es la marca del catálogo de provincias | `es_centroide = false` y `fuente_ubicacion` con la precisión real |
| Georef | sin timeout ni chequeo de estado | timeout de 10 s, `res.ok`, caché de provincias |
| Chrome huérfano | si la corrida moría, el navegador quedaba abierto | cierre ordenado ante señales y cierre por inactividad |
| Deduplicador | "un joven" y "un joven de 17 años" eran la misma víctima: fusionaba homicidios distintos sin IA ni revisión | las palabras genéricas y los números no cuentan como nombre |

### Nuevo: agente local y panel de control

- **Agente local** (`npm run agente`): ejecuta en la computadora del equipo la
  corrida diaria (7:00, recupera si la PC estaba apagada) y las corridas que se
  piden desde el panel. Instalación: [`agente-local.md`](agente-local.md).
- **Panel `/admin/pipeline`**: corrida completa o enfocada en provincias y
  localidades, profundidad, modo prueba, progreso y log en vivo, cancelación,
  cola e historial con el motivo de cada falla.
- **GitHub Actions queda de respaldo**: corre a las 12 y solo si ese día la
  programada no se hizo.

### Otros errores verificados que se corrigieron

- **Tiempo real de revisiones**: con dos revisores, el contador de pendientes
  del otro bajaba 1 cada 4 s (el cursor del SSE perdía los microsegundos y
  re-emitía la última revisión). Ahora el cursor es el id y la reconexión
  retoma con `Last-Event-ID`.
- **Fechas corridas un día** en cada pin del mapa y en cada tarjeta de
  revisión (una columna DATE formateada en la zona del navegador).
- **Dashboard admin**: "Total scrapeados" sumaba los ~16.700 microdatos del SAT
  y contaba dos veces cada hecho corregido.
- **"0k hechos"** en el encabezado mobile del mapa para totales menores a 1.000.
- **Violeta** (`#2D1B4E`, prohibido por la paleta) en el spinner que ve todo
  visitante al entrar al mapa y en `/dashboard`.
- **`/api/admin/metricas`** con cache privada de 15 minutos: las rutas admin van
  `no-store`.

### Cómo se verificó

- 760 tests (84 nuevos; la suite tenía 676), typecheck, lint y `next build` como en la CI.
- Contra un PostgreSQL 16 real con todas las migraciones aplicadas (la nueva es
  idempotente y no genera drift con `schema.prisma`): un LLM falso que reproduce
  el 400 de producción, el circuito completo del agente, la cancelación sin
  procesos huérfanos, la programada del día sin duplicarse y las dos ramas del
  respaldo de Actions.
- El panel se manejó en un navegador real (Playwright), en escritorio y en un
  celular de 390 px.
- **No se pudo probar** contra OpenCode Go (no hay key en este entorno) ni
  contra los sitios de los medios (la red de este entorno los bloquea). La
  primera corrida real es la prueba que falta: ver 3.1.

---

## 3. Qué hacer ahora (en este orden)

1. **Mergear esta rama** a `master`. La migración de `corridas_pipeline` la
   aplica sola el workflow `migraciones.yml`.
2. **Instalar el agente** en la computadora del equipo
   ([`agente-local.md`](agente-local.md)) y lanzar desde el panel una corrida en
   **modo prueba** con un par de provincias: confirma que OpenCode Go acepta las
   requests y que los medios cargan.
3. **Cargar `OPENROUTER_API_KEY`** en el `.env` del agente y como secret de
   Actions: es el respaldo automático si Go rechaza.
4. **Probar `PIPELINE_LLM_RAZONAMIENTO=bajo`** en una corrida de prueba y
   comparar la duración con una sin él. Si mantiene la calidad, dejarlo fijo.
5. **Regenerar el Parquet público del SAT** (workflow `regenerar-parquet.yml`) y
   decidir la precisión de sus coordenadas: ver 4.1, es un tema de privacidad.
6. Una **corrida enfocada con 25 notas por medio** para recuperar lo que siga
   publicado de las dos semanas sin scraping.

---

## 4. Pendientes verificados

Prioridad: **P0** privacidad o datos incorrectos publicados, **P1** errores con
impacto, **P2** experiencia de uso y rendimiento, **P3** evolución.

### 4.1 Privacidad y datos publicados

- **P0 — El Parquet público del SAT permite reidentificar víctimas.**
  `public/data/hechos_sat.parquet` (se sirve con CORS `*`) todavía tiene la
  columna `id`: el commit 7c3970a la sacó del SQL pero el archivo no se
  regeneró. Además 8.704 de sus 16.734 filas tienen una coordenada única (7
  decimales, nivel radio censal, no "centroide provincial" como dice el
  comentario del export), junto con sexo de la víctima, arma, vínculo y
  contexto. Regenerar ya y decidir: redondear coordenadas, agregar por celda H3
  suprimiendo las celdas chicas, o retirar el archivo. Agregar un test que lea
  el Parquet commiteado, no solo el SQL.
- **P0 — Centroides de respaldo del SAT en la provincia equivocada.**
  `scripts/ingesta/sat-homicidios.py` (`PROVINCIAS_CENTROIDES`): Buenos Aires
  cae en La Pampa, Tucumán en Misiones, Santa Fe en La Rioja, Salta en Formosa,
  Catamarca en Jujuy, La Rioja en Catamarca y Neuquén en Río Negro. Los hechos
  del SAT sin coordenadas se ubican ahí (capa H3 y Parquet). Tomar el centroide
  del GeoJSON del IGN y reingerir.
- **P0 (decisión) — El aviso de femicidios contradice los datos.**
  `PanelEstadisticas.tsx` y `/metodologia` dicen que en el modo SAT "los
  femicidios se cuentan aparte y no están incluidos en este total", pero
  `mv_sat_provincia.total_hechos` es un `COUNT(*)` que los incluye. Quien siga
  la instrucción los cuenta dos veces. Definir el criterio y alinear vista,
  Parquet, panel y metodología; mostrar "incluye N femicidios".
- **P1 (decisión) — Qué se publica del pipeline.** `/api/mapa/hechos-medios`
  oculta el código 0 y lo rechazado, pero muestra los `requiere_revision`
  (incluidos los posibles duplicados cuando falla el deduplicador) y los códigos
  2, 3 y 4 (tentativas, siniestros viales, culposos). Los pins PRELIMINAR no
  tienen ninguna advertencia en el mapa ni en el InfoWindow, y la leyenda no
  dice "últimos 90 días".
- **P1 — Filas `es_centroide = true` creadas por el pipeline.** El código ya no
  las crea, pero las existentes siguen apareciendo en `getProvincias()`
  (`/api/mapa/provincias`, buscador) y `actualizar-centroides.ts` puede mover una
  de ellas en lugar de la canónica. Revisar con
  `SELECT u.id, u.provincia, u.departamento FROM ubicaciones u WHERE u.es_centroide AND EXISTS (SELECT 1 FROM hechos_delictivos hd JOIN fuentes f ON f.id = hd.fuente_id WHERE hd.ubicacion_id = u.id AND f.tipo = 'PERIODISTICA') AND NOT EXISTS (SELECT 1 FROM hechos_delictivos hd JOIN fuentes f ON f.id = hd.fuente_id WHERE hd.ubicacion_id = u.id AND f.tipo <> 'PERIODISTICA');`
  y pasar a `false` solo las que devuelva.

### 4.2 Pipeline y calidad de datos

- **P1 — Notas de juicios, detenciones o aniversarios crean hechos con fecha
  de hoy.** El prompt de extracción pide "usá la fecha actual" si no hay fecha,
  y `fechaPublicacion` guarda la hora del scraping. Leer `article:published_time`,
  pasárselo al modelo y no crear un hecho nuevo si la fecha es nula o muy
  anterior a la publicación (vincular o mandar a revisión).
- **P1 — Búsqueda de candidatos del deduplicador.** Compara la provincia con
  `contains` sobre el texto crudo del LLM (distingue tildes: "Cordoba" no
  encuentra "Córdoba"), exige el mismo código SNIC (un caso que entró como 0 y
  después se informa como 1 nunca matchea), y si el `ILIKE` por nombre encuentra
  algo reemplaza a la búsqueda por fechas. Georreferenciar antes y filtrar por
  `provincia_id`, agrupar los códigos 0/1/2, usar `unaccent`.
- **P1 — Sin control de país.** Un crimen en otro país o provincia se ubica en
  el centroide de la provincia del medio (se usa `provinciaOrigen` como
  respaldo sin marcar revisión). Agregar `pais` al prompt y descartar lo que no
  sea Argentina.
- **P2 — URLs sin normalizar.** La misma nota con `?utm=`, `#` o versión AMP
  cuenta como otra cobertura (y puede disparar la promoción).
- **P2 — Campos que nunca se llenan.** `medioUtilizado` y `direccion` quedan
  siempre en null (`openrouter.ts`, `mapearRespuesta`); `tipoCobertura` sale de
  una regex que casi siempre matchea algo y nada la lee.
- **P2 — Ejemplos few-shot incompletos.** Los ejemplos de respuesta solo traen
  4 campos y se toman las 3 últimas revisiones sin mezclar positivos y
  negativos: una tanda de rechazos deja solo ejemplos negativos. El manual pide
  marcar "noticia repetida" como "No es homicidio", lo que convierte un
  homicidio real en ejemplo negativo: falta una acción "Duplicado".
- **P2 — Georef por localidad.** Se busca la ciudad en `/departamentos`: una
  localidad que no es cabecera ("Villa Gobernador Gálvez") cae al centroide de
  la provincia. Probar `/localidades` antes.
- **P2 — Tiempo de corrida.** Aun con los arreglos del browser, el LLM domina:
  ver `PIPELINE_LLM_RAZONAMIENTO` (sección 3). El snapshot se manda completo
  (menús y botones); mandar solo las líneas `- link` bajaría tokens.

### 4.3 Panel admin (revisores)

- **P1 — El polling borra lo cargado con "Cargar más".** Cada 30 s la página
  reemplaza la lista por la página 1; la paginación por OFFSET además saltea
  casos a medida que la cola se achica. Paginar por cursor y fusionar.
- **P1 — Los errores se ven como "No hay casos pendientes".** Un 500, una sesión
  vencida o un corte de red muestran la cola vacía (`if (!res.ok) return`).
  Mismo problema en Feedback.
- **P1 — Concurrencia entre revisores.** El POST no comprueba si el caso ya se
  revisó: si dos personas abren la misma tarjeta, la segunda pisa en silencio a
  la primera (por ejemplo, borra la marca de femicidio). Responder 409.
- **P1 — La tarjeta oculta la sugerencia de femicidio del modelo** (la consulta
  no trae `femicidio` ni `nombre_victima`) y clasificar otra cosa la borra sin
  aviso.
- **P2 — "Revisados recientes" sale ordenado por UUID** (`DISTINCT ON` sin
  reordenar) y con más de 50 revisiones en 48 h muestra 50 arbitrarias.
- **P2 — "Precisión IA" mal definida**: el numerador incluye las promociones
  automáticas, puede pasar de 100 %. Guardar la predicción del modelo en
  `clasificacion_llm` (la columna existe y nunca se escribe) y medir
  confirmados / (confirmados + rechazados).
- **P2 — Login**: sin `pages.error`, quien queda afuera de la allowlist ve la
  página de error en inglés de Auth.js; el login fija el destino y pierde los
  enlaces directos.
- **P2 — La estrella de "ejemplo"** queda desincronizada después de una corrección.

### 4.4 Mapa público

- **P1 — Ante un error de carga se muestran cifras de otro año.** `useMapaData`
  conserva los datos anteriores y el banner de error depende de una constante
  `null` (`MapaDelito.tsx`): con 4G inestable, 2019 muestra las cifras de 2024.
- **P1 — El panel de provincia no se actualiza** al cambiar año, delito o
  filtros (guarda una copia de la provincia del click), y sus dos fetch no se
  cancelan.
- **P1 — Año fuera de rango al cambiar de fuente** (`handleFuenteChange` no lo
  ajusta: de SNIC 2010 a SAT el mapa queda vacío sin mensaje).
- **P1 — DuckDB-WASM bloquea la primera vista.** Mientras carga (unos 34 MB) no
  se consulta la API y el overlay tapa los controles; las consultas usan rutas
  relativas que el worker no resuelve y una de ellas lee
  `snic_provincia_delito.parquet`, que no existe. Pedir primero la API y cargar
  DuckDB solo para la capa H3.
- **P2 — Escala y leyenda.** El color es hechos absolutos (Buenos Aires siempre
  "peor" por población); la leyenda dice "Menor/Mayor" sin números y no cambia
  con los filtros. Tasas cada 100 mil habitantes y cortes numéricos.
- **P2 — Mobile.** `h-screen` con `overflow-hidden` deja la leyenda debajo de la
  barra del navegador (usar `h-dvh`); el input del buscador de 14 px hace zoom en
  iPhone; áreas táctiles de 14–40 px; textos de 8–10 px en gris claro.
- **P2 — La cámara salta sola.** Se pide la ubicación al cargar y se hace zoom
  aunque la persona ya esté navegando; pedirla solo desde el botón.
- **P2 — Burbujas superpuestas** en la vista nacional (La Plata/CABA,
  Paraná/Santa Fe): usar el centroide del polígono.
- **P2 — `/dashboard` es pública y está rota** (los selects no hacen nada):
  borrarla o moverla a `/admin`. El botón "Revisar" (admin) es visible para el
  público y Quilmes aparece resaltado sin explicación.
- **P2 — Ya medidos en el plan de agosto y todavía presentes**: Recharts en el
  paquete inicial, 500 pins sin agrupar, slider sin debounce, fuente Geist que
  se descarga y no se usa.

### 4.5 Seguridad, CI y mantenimiento

- **P1 — `POST /api/admin/revisiones` sin validación runtime**: la clasificación
  no tiene lista blanca (la frena el CHECK de la base con un 500), el UPDATE no
  filtra `es_agregado` (con un request armado se puede tocar un microdato del
  SAT) y `notas` no tiene largo máximo.
- **P2 — `/api/pipeline/run` quedó huérfana**: nadie la llama (Vercel no puede
  correr Chrome y la corta a los 5 minutos), responde GET aunque la doc dice
  POST y su respuesta de error incluye stderr. El agente local la reemplaza:
  borrarla junto con `pipeline-runner.ts`.
- **P2 — CI que da verde fallando**: `auditar-csp.yml`, `probar-feeds.yml` y
  `verificar-medios.yml` usan `| tee` con el shell por defecto (sin pipefail):
  el paso toma el código de `tee`. Usar `shell: bash`. La CI de PR no corre
  `npm run lint`.

---

## 5. Mejoras de experiencia recomendadas (no son errores)

Para el público (periodistas, familias, funcionarios):

1. Guardar la vista en la URL con un botón "Compartir" (cita exacta de una vista).
2. Un ícono de información junto a SNIC, SAT y Prensa (qué cuenta cada una,
   cobertura y años): hoy está solo en `title`, invisible en pantallas táctiles.
3. "Actualizado al…" y rangos de datos visibles.
4. Mensajes con salida cuando no hay datos ("SAT cubre 2017–2024 · Ir a 2024").
5. En mobile, el panel de provincia como hoja inferior a media altura.

Para el equipo de revisión:

1. "Deshacer" durante unos segundos después de clasificar.
2. Atajos de teclado (1–6 clasificar, J/K navegar, O abrir la fuente).
3. Filtros por provincia, medio, fecha y "solo requiere revisión".
4. Acciones "Duplicado de…" y "Saltear".
5. Contador de pendientes en la navegación admin.

Para el pipeline:

1. **Descubrimiento por búsqueda para las zonas en foco** (propuesta, requiere
   decisión): además de recorrer las portadas de los medios configurados, buscar
   "homicidio + localidad" en un agregador de noticias y procesar esos
   resultados. Cubriría medios que no están en la lista y permitiría recuperar
   notas viejas, pero cambia la política de fuentes (medios no verificados).
2. Descubrimiento por feeds RSS/sitemap (plan de agosto, Etapa 4): baja mucho el
   costo de identificación.

---

## 6. Decisiones que necesitan al equipo

- Criterio de conteo de femicidios en el modo SAT (4.1).
- Qué se publica del pipeline antes de la revisión humana (4.1).
- Precisión de las coordenadas del Parquet público del SAT (4.1).
- Seguir con OpenCode Go (riesgo de bloqueo) o pasar OpenRouter a principal.
- Mantener GitHub Actions como respaldo diario o desactivarlo del todo.
- Sumar descubrimiento por búsqueda para las zonas en foco (5).
