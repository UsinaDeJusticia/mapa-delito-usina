/**
 * Cliente para la API Georef Argentina
 * Documentación: https://datosgobar.github.io/georef-ar-api/
 *
 * Uso: normalización de ubicaciones y obtención de centroides oficiales.
 */

const GEOREF_BASE = 'https://apis.datos.gob.ar/georef/api'

interface GeorefProvincia {
  id: string
  nombre: string
  centroide: { lat: number; lon: number }
}

interface GeorefDepartamento {
  id: string
  nombre: string
  centroide: { lat: number; lon: number }
  provincia: { id: string; nombre: string }
}

/**
 * Obtiene todas las provincias con sus centroides oficiales del IGN.
 */
export async function getProvinciasGeoref(): Promise<GeorefProvincia[]> {
  try {
    const res = await fetch(`${GEOREF_BASE}/provincias?campos=id,nombre,centroide&max=24`, {
      next: { revalidate: 86400 } // Cache 24 horas
    })
    if (!res.ok) throw new Error(`Georef API error: ${res.status}`)
    const data = await res.json()
    return data.provincias || []
  } catch (error) {
    console.error('Error consultando Georef provincias:', error)
    return []
  }
}

/**
 * Obtiene los departamentos de una provincia con centroides.
 */
export async function getDepartamentosGeoref(provinciaId: string): Promise<GeorefDepartamento[]> {
  try {
    // encodeURIComponent, igual que en el resto del archivo: sin esto un
    // provinciaId con `&` inyecta parámetros extra en la query. El host es
    // constante, así que no es SSRF, pero un `&max=5000` no autorizado sí.
    const res = await fetch(
      `${GEOREF_BASE}/departamentos?provincia=${encodeURIComponent(provinciaId)}&campos=id,nombre,centroide,provincia&max=100`,
      { next: { revalidate: 86400 } }
    )
    if (!res.ok) throw new Error(`Georef API error: ${res.status}`)
    const data = await res.json()
    return data.departamentos || []
  } catch (error) {
    console.error('Error consultando Georef departamentos:', error)
    return []
  }
}

/**
 * Normaliza un texto de ubicación a coordenadas.
 * Útil para el pipeline de medios (Fase 3).
 */
export async function normalizarUbicacion(
  texto: string
): Promise<{ lat: number; lon: number; provincia: string; departamento?: string } | null> {
  try {
    const res = await fetch(
      `${GEOREF_BASE}/ubicacion?direccion=${encodeURIComponent(texto)}&campos=departamento,provincia`,
    )
    if (!res.ok) return null
    const data = await res.json()
    if (!data.ubicacion) return null

    return {
      lat: data.ubicacion.lat,
      lon: data.ubicacion.lon,
      provincia: data.ubicacion.provincia?.nombre || '',
      departamento: data.ubicacion.departamento?.nombre,
    }
  } catch {
    return null
  }
}