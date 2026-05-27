# Auditoría de Medios — Pipeline de Scraping

Fecha: 2026-05-27

## Estado actual

El pipeline (`scripts/pipeline/scrapear-medios.ts`) define **10 medios** en el array `MEDIOS`.
Ninguno tiene un flag `activo: true/false` — todos están disponibles pero solo Infobae
y Rosario3 tienen scripts dedicados en `package.json` y han sido validados previamente.

**Objetivo**: activar hasta 36 medios (26 por configurar, más los 10 actuales).

---

## GRUPO A — Sin paywall (activar)

Medios con sección policial de acceso público, sin login requerido.

| ID | Nombre | URL policial | Provincia | Estado |
|----|--------|-------------|-----------|--------|
| `rosario3` | Rosario3 | rosario3.com/policiales/ | Santa Fe | ✅ VALIDADO (script dedicado) |
| `infobae` | Infobae | infobae.com/sociedad/policiales/ | Nacional | ✅ VALIDADO (script dedicado) |
| `ellitoral` | El Litoral | ellitoral.com/sucesos | Santa Fe | ⏳ Pendiente dry-run |
| `lmneuquen` | LM Neuquén | lmneuquen.com/policiales/ | Neuquén | ⏳ Pendiente dry-run |
| `norte` | Diario Norte | diarionorte.com/seccion/policiales/ | Chaco | ⏳ Pendiente dry-run |
| `eltribuno` | El Tribuno | eltribuno.com/salta/policiales | Salta | ⏳ Pendiente dry-run |
| `eldia` | El Día (La Plata) | eldia.com/seccion/policiales/ | Buenos Aires | ⏳ Pendiente dry-run |
| `lavoz` | La Voz del Interior | lavoz.com.ar/sucesos/ | Córdoba | ⏳ Pendiente dry-run |

---

## GRUPO B — Con paywall o restricción de acceso

Medios que requieren sesión activa o tienen muros de pago. Dejar para después.

| ID | Nombre | Motivo | Estado |
|----|--------|--------|--------|
| `clarin` | Clarín | Paywall después de N artículos gratuitos; sección policiales con acceso reducido | 🔒 BLOQUEADO |
| `lanacion` | LA NACION | Paywall suscripción; contenido policial restringido | 🔒 BLOQUEADO |

---

## Medios adicionales a configurar (Fase 3)

Los siguientes medios están identificados como objetivo para completar los 36 totales.
Requieren agregar su `MedioConfig` al array `MEDIOS` en `scrapear-medios.ts` antes de testear.

### Provinciales sin paywall (candidatos)

| Nombre | URL sugerida | Provincia |
|--------|-------------|-----------|
| Diario El Tribuno (Jujuy) | eltribuno.com/jujuy/policiales | Jujuy |
| El Patagónico | elpatagonico.com/policiales/ | Chubut |
| Río Negro | rionegro.com.ar/policiales/ | Río Negro |
| La Mañana de Neuquén | lmneuquen.com | Neuquén |
| Diario Uno (Mendoza) | diariouno.com.ar/policiales/ | Mendoza |
| El Esquiú (Catamarca) | elesquiu.com/policiales/ | Catamarca |
| El Ancasti (Catamarca) | elancasti.com.ar | Catamarca |
| Nuevo Diario (Santiago del Estero) | nuevodiarioweb.com.ar | Santiago del Estero |
| El Liberal | elliberal.com.ar | Santiago del Estero |
| Panorama (Tucumán) | panoramatucuman.com | Tucumán |
| La Gaceta (Tucumán) | lagaceta.com.ar/policiales/ | Tucumán |
| Diario Época (Corrientes) | diariopoca.com | Corrientes |
| Misiones Online | misionesonline.net/policiales/ | Misiones |
| Ahora Formosa | ahoraformosa.com | Formosa |
| El Cronista del Norte | - | Formosa |
| Debate | debate.com.ar | Chaco |

---

## Notas de implementación

### Cómo agregar un medio nuevo

1. Agregar entrada al array `MEDIOS` en `scrapear-medios.ts`:
   ```typescript
   { id: 'nuevo-id', nombre: 'Nombre Medio', url: 'https://url/policiales/', tipo: 'provincial', provincia: 'Nombre Provincia' },
   ```

2. Testear con dry-run:
   ```bash
   npm run pipeline:medio -- --medio=nuevo-id
   # Con PIPELINE_DRY_RUN=true en .env
   ```

3. Validar que extrae al menos 1 noticia. Si pasa → VALIDADO, si no → BLOQUEADO.

### Limitación de entorno

El pipeline requiere `agent-browser` CLI con Chromium instalado.
En entornos headless/CI sin browser, el dry-run falla en la etapa de scraping.
Para ejecutar los tests de validación, usar una máquina con Chrome disponible.

---

## Historial de validaciones

| Fecha | Medio | Resultado | Notas |
|-------|-------|-----------|-------|
| (anterior) | infobae | ✅ VALIDADO | Script dedicado en package.json |
| (anterior) | rosario3 | ✅ VALIDADO | Script dedicado en package.json |
| 2026-05-27 | ellitoral, lmneuquen, norte, eltribuno, eldia, lavoz | ⏳ PENDIENTE | agent-browser disponible (v0.21.4) pero Chrome no instalable — red restringida en entorno CI |

## Resultado dry-run 2026-05-27

```
agent-browser 0.21.4 ✅ instalado
Chrome ❌ no disponible — error descargando desde googlechromelabs.github.io
```

**Acción requerida**: ejecutar desde máquina con Chrome instalado:
```bash
PIPELINE_DRY_RUN=true PIPELINE_MAX_NOTICIAS=3 npm run pipeline:dry
```

El pipeline fue actualizado con el flag `activo` en cada medio:
- `activo: true` → Grupo A (8 medios sin paywall)  
- `activo: false` → Grupo B (clarin, lanacion — paywall)
Los medios inactivos se omiten automáticamente salvo que se invoquen con `--medio=id`.
