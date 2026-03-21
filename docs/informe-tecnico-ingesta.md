# Informe Técnico de Ingesta - Task 2

## Estado del Script

El script `cargar-snic.ts` procesa dos tipos de archivos CSV del SNIC:

### Lógica Actual

1. **snic-pais.csv**: Lectura de `indice_tiempo` como año, parseo de columnas `delito_XX_hechos` y `delito_XX_victimas`
2. **snic-provincia.csv**: Patrón `delito_XX_hechos_PROVINCIA` y `delito_XX_victi_PROVINCIA`

### Regex Implementados

```typescript
// Validación de columnas provincia
function esColumnaDelitoProvincia(columna: string): boolean {
  return /^delito_\d+_(hechos|victi)_.+$/.test(columna)
}

// Extracción de código y provincia
function extraerCodigoDelitoProvincia(columna: string): { codigo: number; provincia: string } | null {
  const match = columna.match(/^delito_(\d+)_(hechos|victi)_(.+)$/)
  if (!match) return null
  return { codigo: parseInt(match[1], 10), provincia: match[3] }
}
```

### Procesamiento con Papaparse

```typescript
const resultado = Papa.parse(contenido.trim(), {
  header: true,
  skipEmptyLines: true,
  transformHeader: (header) => header.replace(/^\uFEFF/, '').trim(),
})
```

---

## Conflicto de Esquema

### Error: PrismaClientValidationError

El modelo `Ubicacion` en `schema.prisma` exige:

```prisma
latitud         Decimal @db.Decimal(10, 7)  // OBLIGATORIO
longitud        Decimal @db.Decimal(10, 7)  // OBLIGATORIO
```

### Problema

El dataset **Total País** (`snic-pais.csv`) no posee coordenadas geográficas por naturaleza. Es un agregado nacional.

### Solución Actual Implementada

Se modificó `obtenerOuCrearUbicacion` para crear una ubicación lógica "Total País":

```typescript
if (!provinciaId) {
  return prisma.ubicacion.upsert({
    where: { id: 'ubicacion-argentina' },
    update: {},
    create: {
      id: 'ubicacion-argentina',
      provincia: 'Total País',
      esCentroide: true,  // ← Falta latitud y longitud
    },
  })
}
```

**Esto genera error** porque Prisma validará que `latitud` y `longitud` son required.

---

## Estructura de Datos

### Encabezados snic-provincia.csv

```
indice_tiempo,delito_01_victi_buenos_aires,delito_01_victi_caba,delito_01_victi_catamarca,...
```

### Ejemplo de Procesamiento

| Columna entrada | Código extraído | Provincia normalizada |
|-----------------|-----------------|----------------------|
| `delito_01_victi_buenos_aires` | 1 | `buenos_aires` → ID `06` |
| `delito_15_hechos_cordoba` | 15 | `cordoba` → ID `20` |

### Mapeo de Provincias

```typescript
const PROVINCIA_POR_NOMBRE: Record<string, string> = {
  'buenos_aires': '06',
  'caba': '01',
  'catamarca': '02',
  // ... 24 jurisdicciones
}
```

---

## Puntos Críticos

### 1. Riesgo de Coordenadas Arbitrarias

Si se usan coordenadas arbitrarias para "Total País" (ej. centroide de Argentina), esto afectaría:

- **Visualización**: El mapa mostraría un punto en el centro del país
- **Agregación**: Incorrecto para datos que son por definición nacionales
- **Consultas**: Confusión entre datos geográficos y datos agregados

### 2. Alternativas de Solución

**Opción A**: Modificar `schema.prisma` para hacer latitud/longitud opcionales
```prisma
latitud         Decimal? @db.Decimal(10, 7)  // Nullable
longitud        Decimal? @db.Decimal(10, 7)  // Nullable
```

**Opción B**: Manejar "Total País" como entidad lógica sin representación física
- Crear `Ubicacion` con `provincia: 'Total País'`
- Mantener `latitud: 0` y `longitud: 0` como哨兵 values
- Documentar en comentario que `esCentroide: true` indica agregado

### 3. Recomendación

Se sugiere **Opción B** por:
- Mantiene integridad del schema existente
- Permite filtrar/filtros por `provincia = 'Total País'`
- Es consistente con el uso de `esCentroide` para indicar datos agregados

---

## Archivos Involucrados

- `scripts/ingesta/cargar-snic.ts` - Script de ingesta
- `prisma/schema.prisma` - Modelo de datos
- `data/snic/snic-pais.csv` - Dataset nacional
- `data/snic/snic-provincia.csv` - Dataset provincial