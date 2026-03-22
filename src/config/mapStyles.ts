/**
 * Estilo personalizado del Mapa Nacional del Delito.
 * Paleta: azul marino Usina #1E427C + gris #A7A8AC.
 *
 * Diseño: fondo limpio, sin rutas ni POIs, bordes provinciales
 * en azul Usina, datos como protagonista visual.
 */

export const MAPA_STYLE_USINA: google.maps.MapTypeStyle[] = [
  // ══════ RESET TOTAL ══════
  {
    featureType: 'all',
    elementType: 'all',
    stylers: [{ saturation: -100 }],
  },

  // ══════ FONDO / LANDSCAPE ══════
  {
    featureType: 'landscape',
    elementType: 'geometry',
    stylers: [{ color: '#f2f0eb' }],
  },
  {
    featureType: 'landscape.man_made',
    elementType: 'geometry',
    stylers: [{ color: '#f2f0eb' }],
  },
  {
    featureType: 'landscape.natural',
    elementType: 'geometry',
    stylers: [{ color: '#eeece6' }],
  },
  {
    featureType: 'landscape.natural.landcover',
    elementType: 'geometry',
    stylers: [{ color: '#eeece6' }],
  },
  {
    featureType: 'landscape.natural.terrain',
    elementType: 'geometry',
    stylers: [{ color: '#eeece6' }],
  },

  // ══════ AGUA ══════
  {
    featureType: 'water',
    elementType: 'geometry',
    stylers: [{ color: '#d6e2ec' }],
  },
  {
    featureType: 'water',
    elementType: 'labels',
    stylers: [{ visibility: 'off' }],
  },

  // ══════ LÍMITES PROVINCIALES (lo más importante) ══════
  {
    featureType: 'administrative.province',
    elementType: 'geometry.stroke',
    stylers: [{ color: '#1E427C' }, { weight: 2.5 }, { visibility: 'on' }],
  },
  {
    featureType: 'administrative.province',
    elementType: 'labels.text.fill',
    stylers: [{ color: '#1E427C' }],
  },
  {
    featureType: 'administrative.province',
    elementType: 'labels.text.stroke',
    stylers: [{ color: '#ffffff' }, { weight: 3 }],
  },

  // ══════ BORDES PAÍS ══════
  {
    featureType: 'administrative.country',
    elementType: 'geometry.stroke',
    stylers: [{ color: '#A7A8AC' }, { weight: 1.5 }],
  },
  {
    featureType: 'administrative.country',
    elementType: 'labels',
    stylers: [{ visibility: 'off' }],
  },

  // ══════ LOCALIDADES — solo texto sutil ══════
  {
    featureType: 'administrative.locality',
    elementType: 'labels.text.fill',
    stylers: [{ color: '#888888' }],
  },
  {
    featureType: 'administrative.locality',
    elementType: 'labels.text.stroke',
    stylers: [{ color: '#ffffff' }, { weight: 2 }],
  },
  {
    featureType: 'administrative.neighborhood',
    elementType: 'labels',
    stylers: [{ visibility: 'off' }],
  },
  {
    featureType: 'administrative.land_parcel',
    elementType: 'labels',
    stylers: [{ visibility: 'off' }],
  },

  // ══════ OCULTAR TODAS LAS RUTAS ══════
  {
    featureType: 'road',
    elementType: 'geometry',
    stylers: [{ visibility: 'off' }],
  },
  {
    featureType: 'road',
    elementType: 'labels',
    stylers: [{ visibility: 'off' }],
  },
  {
    featureType: 'road.highway',
    elementType: 'all',
    stylers: [{ visibility: 'off' }],
  },
  {
    featureType: 'road.highway.controlled_access',
    elementType: 'all',
    stylers: [{ visibility: 'off' }],
  },
  {
    featureType: 'road.arterial',
    elementType: 'all',
    stylers: [{ visibility: 'off' }],
  },
  {
    featureType: 'road.local',
    elementType: 'all',
    stylers: [{ visibility: 'off' }],
  },

  // ══════ OCULTAR POIs ══════
  {
    featureType: 'poi',
    elementType: 'all',
    stylers: [{ visibility: 'off' }],
  },

  // ══════ OCULTAR TRÁNSITO ══════
  {
    featureType: 'transit',
    elementType: 'all',
    stylers: [{ visibility: 'off' }],
  },
]

/**
 * Estilo para zoom alto (nivel 12+) — muestra calles principales para contexto.
 */
export const MAPA_STYLE_USINA_ZOOM_IN: google.maps.MapTypeStyle[] = [
  ...MAPA_STYLE_USINA.filter(s => s.featureType !== 'road'),

  // Arterias principales
  {
    featureType: 'road.arterial',
    elementType: 'geometry.stroke',
    stylers: [{ color: '#d4d0c8' }, { weight: 1 }, { visibility: 'on' }],
  },
  {
    featureType: 'road.arterial',
    elementType: 'labels',
    stylers: [{ visibility: 'simplified' }],
  },
  // Autopistas/rutas
  {
    featureType: 'road.highway',
    elementType: 'geometry.stroke',
    stylers: [{ color: '#c4c0b8' }, { weight: 1.5 }, { visibility: 'on' }],
  },
  {
    featureType: 'road.highway',
    elementType: 'labels',
    stylers: [{ visibility: 'simplified' }],
  },
  // Calles locales ocultas
  {
    featureType: 'road.local',
    elementType: 'all',
    stylers: [{ visibility: 'off' }],
  },
]

export function crearMarcadorProvincia(
  map: google.maps.Map,
  provincia: { nombre: string; lat: number; lng: number; total: number; tasa: number }
) {
  const radio = Math.max(24, Math.min(60, Math.sqrt(provincia.total) * 0.8))
  const color = obtenerColorPorTasa(provincia.tasa)

  const marker = new google.maps.Marker({
    position: { lat: provincia.lat, lng: provincia.lng },
    map,
    icon: {
      path: google.maps.SymbolPath.CIRCLE,
      fillColor: color,
      fillOpacity: 0.85,
      strokeColor: '#ffffff',
      strokeWeight: 2,
      scale: radio / 2,
    },
    label: {
      text: provincia.total >= 1000
        ? `${(provincia.total / 1000).toFixed(1)}k`
        : provincia.total.toString(),
      color: '#ffffff',
      fontSize: `${Math.max(11, radio / 3)}px`,
      fontWeight: '600',
    },
    title: provincia.nombre,
    zIndex: 10,
  })

  return marker
}

export function crearMarcadorHecho(
  map: google.maps.Map,
  hecho: { id: string; lat: number; lng: number; codigoSnic: number; titulo: string; fecha: Date; confianza: string; }
) {
  const color = obtenerColorPorTipo(hecho.codigoSnic)
  const esReciente = (Date.now() - hecho.fecha.getTime()) < 48 * 60 * 60 * 1000

  const marker = new google.maps.Marker({
    position: { lat: hecho.lat, lng: hecho.lng },
    map,
    icon: {
      path: google.maps.SymbolPath.CIRCLE,
      fillColor: color,
      fillOpacity: 1,
      strokeColor: esReciente ? color : '#ffffff',
      strokeWeight: esReciente ? 4 : 2.5,
      scale: esReciente ? 16 : 12,
    },
    title: hecho.titulo,
    zIndex: esReciente ? 100 : 50,
  })

  marker.addListener('click', () => {
    const infoWindow = new google.maps.InfoWindow({
      content: `
        <div style="font-family: sans-serif; max-width: 260px;">
          <h3 style="margin: 0 0 6px; font-size: 14px; color: #1E427C;">${hecho.titulo.slice(0, 80)}</h3>
          <p style="margin: 0 0 4px; font-size: 12px; color: #666;">
            ${hecho.fecha.toLocaleDateString('es-AR')}
          </p>
          <span style="
            display: inline-block;
            padding: 2px 8px;
            border-radius: 10px;
            font-size: 10px;
            background: ${hecho.confianza === 'VERIFICADO' ? '#E8EDF4' : '#FEF3C7'};
            color: ${hecho.confianza === 'VERIFICADO' ? '#1E427C' : '#92400E'};
          ">${hecho.confianza}</span>
        </div>
      `,
    })
    infoWindow.open(map, marker)
  })

  return marker
}

/**
 * Color de marcador provincial según tasa de delitos.
 * Escala: azul Usina claro → azul Usina oscuro → rojo para zonas críticas.
 */
export function obtenerColorPorTasa(tasa: number): string {
  if (tasa < 3)  return '#C5D1E4'   // heat-1: bajo (azul claro Usina)
  if (tasa < 5)  return '#9BB1CF'   // heat-2
  if (tasa < 7)  return '#4A71A5'   // heat-3
  if (tasa < 10) return '#1E427C'   // heat-4: medio (azul primario)
  if (tasa < 15) return '#15305B'   // heat-5: alto (azul oscuro)
  if (tasa < 20) return '#B91C1C'   // heat-6: muy alto (rojo)
  return '#991B1B'                   // heat-7: crítico (rojo oscuro)
}

/**
 * Color de hecho individual según tipo de delito.
 * Homicidios en rojo (urgencia), robos en azul Usina (marca),
 * otros tipos en colores diferenciados.
 */
export function obtenerColorPorTipo(codigoSnic: number): string {
  switch (codigoSnic) {
    case 1:  return '#DC2626'  // Homicidio doloso → rojo
    case 2:  return '#F97316'  // Tentativa homicide → naranja
    case 5:  return '#EAB308'  // Lesiones dolosas → amarillo
    case 10: return '#EC4899'  // Violación → rosa
    case 15: return '#1E427C'  // Robo → azul Usina (marca)
    case 17: return '#991B1B'  // Robo con violencia → rojo oscuro
    case 19: return '#4A71A5'  // Hurto → azul Usina medio
    case 28: return '#14B8A6'  // Estupefacientes → teal
    default: return '#A7A8AC'  // Otros → gris Usina
  }
}

/**
 * Opciones base del mapa.
 */
export const ZOOM_THRESHOLD = 12
export const marcadoresProvincias: google.maps.Marker[] = []
export const marcadoresHechos: google.maps.Marker[] = []

export function configurarCapasPorZoom(map: google.maps.Map) {
  map.addListener('zoom_changed', () => {
    const zoom = map.getZoom() || 5

    map.setOptions({
      styles: zoom >= ZOOM_THRESHOLD ? MAPA_STYLE_USINA_ZOOM_IN : MAPA_STYLE_USINA,
    })

    const mostrarProvincias = zoom < ZOOM_THRESHOLD
    const mostrarHechos = zoom >= ZOOM_THRESHOLD

    for (const m of marcadoresProvincias) {
      m.setMap(mostrarProvincias ? map : null)
    }
    for (const m of marcadoresHechos) {
      m.setMap(mostrarHechos ? map : null)
    }
  })
}

export const MAPA_OPTIONS_BASE: google.maps.MapOptions = {
  center: { lat: -38.4161, lng: -63.6167 },
  zoom: 5,
  minZoom: 4,
  maxZoom: 16,
  mapTypeControl: false,
  streetViewControl: false,
  fullscreenControl: true,
  zoomControl: true,
  restriction: {
    latLngBounds: {
      north: -20,
      south: -56,
      east: -52,
      west: -76,
    },
    strictBounds: false,
  },
}
