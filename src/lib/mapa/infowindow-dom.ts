/**
 * Construcción de contenido de InfoWindow como nodos DOM.
 *
 * Los InfoWindows se armaban con template strings interpolando título, medio,
 * ciudad, provincia, tipo de delito y URL — todos provenientes de scraping de
 * sitios de terceros y guardados en la base. `InfoWindow.setContent(string)`
 * interpreta ese string como HTML, así que un título como
 * `<img src=x onerror=fetch('/api/...')>` se ejecutaba en el navegador de
 * cualquier visitante del mapa: XSS almacenado.
 *
 * Acá todo dato no confiable se asigna con `textContent`, que nunca interpreta
 * markup. `setContent` acepta un `HTMLElement`, así que no hace falta serializar
 * a string en ningún momento.
 */

const USINA_AZUL = '#1E427C'

/**
 * Esquemas permitidos para los links de "Ver noticia".
 * `javascript:`, `data:` y `vbscript:` quedan afuera: los dos primeros ejecutan
 * código al hacer click.
 */
const ESQUEMAS_PERMITIDOS = ['https:', 'http:']

/**
 * Devuelve la URL si es segura para un href, o null si no.
 *
 * Se prefiere https. http se admite porque varios medios provinciales
 * argentinos todavía no tienen certificado.
 */
export function urlSegura(valor: unknown): string | null {
  if (typeof valor !== 'string' || valor.trim() === '') return null
  let parsed: URL
  try {
    parsed = new URL(valor.trim())
  } catch {
    // Rechaza relativas y basura. Una URL de cobertura siempre es absoluta.
    return null
  }
  if (!ESQUEMAS_PERMITIDOS.includes(parsed.protocol)) return null
  return parsed.toString()
}

/** Crea un elemento con estilos inline y, opcionalmente, texto. */
function crear<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  estilo: string,
  texto?: string | null
): HTMLElementTagNameMap[K] {
  const el = doc.createElement(tag)
  el.setAttribute('style', estilo)
  // textContent, nunca innerHTML: el markup queda como texto literal.
  if (texto !== undefined && texto !== null) el.textContent = texto
  return el
}

// ════════════════════════════════════════════
// PIN DE HECHO DEL PIPELINE
// ════════════════════════════════════════════

export interface DatosHechoMedio {
  titulo?: string | null
  medio?: string | null
  ciudad?: string | null
  provincia?: string | null
  tipo_delito?: string | null
  url_cobertura?: string | null
  fecha?: string | null
  esVerificado: boolean
}

export function contenidoHechoMedio(
  hecho: DatosHechoMedio,
  doc: Document = document
): HTMLElement {
  const cont = crear(doc, 'div', 'font-family:system-ui,sans-serif;max-width:260px;padding:2px;')

  // ── Fila de badge y medio ──
  const fila = crear(doc, 'div', 'display:flex;align-items:center;gap:8px;margin-bottom:8px;')

  const badgeColor = hecho.esVerificado ? '#15803D' : '#92400E'
  const badgeBg = hecho.esVerificado ? '#DCFCE7' : '#FEF3C7'
  const badge = crear(
    doc,
    'span',
    `font-size:10px;font-weight:600;padding:2px 7px;border-radius:99px;background:${badgeBg};color:${badgeColor};`,
    hecho.esVerificado ? '✓ Verificado' : '⏳ Preliminar'
  )
  fila.appendChild(badge)

  if (hecho.medio) {
    fila.appendChild(crear(doc, 'span', 'font-size:10px;color:#6B7280;', hecho.medio))
  }
  cont.appendChild(fila)

  // ── Título ──
  cont.appendChild(
    crear(
      doc,
      'p',
      'font-size:13px;font-weight:600;color:#111827;margin:0 0 4px;line-height:1.4;',
      hecho.titulo ?? 'Sin título'
    )
  )

  // ── Ubicación y fecha ──
  const partes: string[] = []
  const lugar = hecho.ciudad ?? hecho.provincia ?? '—'
  partes.push(hecho.provincia && hecho.ciudad ? `${hecho.ciudad}, ${hecho.provincia}` : lugar)
  if (hecho.fecha) partes.push(hecho.fecha)
  cont.appendChild(
    crear(doc, 'p', 'font-size:11px;color:#6B7280;margin:0;', partes.join(' · '))
  )

  // ── Tipo de delito ──
  if (hecho.tipo_delito) {
    cont.appendChild(
      crear(
        doc,
        'p',
        `font-size:11px;color:${USINA_AZUL};margin:4px 0 0;font-weight:500;`,
        hecho.tipo_delito
      )
    )
  }

  // ── Link a la noticia, solo si la URL pasa la validación ──
  const url = urlSegura(hecho.url_cobertura)
  if (url) {
    const a = crear(
      doc,
      'a',
      `display:inline-block;margin-top:8px;font-size:11px;color:${USINA_AZUL};text-decoration:underline;`,
      'Ver noticia ↗'
    )
    a.setAttribute('href', url)
    a.setAttribute('target', '_blank')
    a.setAttribute('rel', 'noopener noreferrer')
    cont.appendChild(a)
  }

  return cont
}

// ════════════════════════════════════════════
// BURBUJA PROVINCIAL
// ════════════════════════════════════════════

export interface DatosProvincia {
  provincia?: string | null
  totalHechos?: number | null
  totalVictimas?: number | null
  delitos?: Array<{ nombre?: string | null; hechos?: number | null }> | null
}

const MAX_DELITOS_MOSTRADOS = 3

/** Formatea un número, tolerando null y valores no numéricos. */
function numero(v: unknown): string {
  return typeof v === 'number' && Number.isFinite(v) ? v.toLocaleString('es-AR') : '0'
}

export function contenidoProvincia(
  provincia: DatosProvincia,
  doc: Document = document
): HTMLElement {
  const cont = crear(
    doc,
    'div',
    'font-family:system-ui,sans-serif;min-width:200px;padding:4px 2px;'
  )

  cont.appendChild(
    crear(
      doc,
      'div',
      `font-weight:700;font-size:14px;color:${USINA_AZUL};margin-bottom:8px;border-bottom:2px solid ${USINA_AZUL};padding-bottom:6px;`,
      provincia.provincia ?? 'Sin nombre'
    )
  )

  // ── Métricas ──
  const metricas = crear(doc, 'div', 'display:flex;gap:20px;margin-bottom:8px;')
  for (const [etiqueta, valor] of [
    ['Hechos', numero(provincia.totalHechos)],
    ['Víctimas', numero(provincia.totalVictimas)],
  ] as const) {
    const bloque = crear(doc, 'div', '')
    bloque.appendChild(crear(doc, 'div', 'font-size:11px;color:#6B7280;', etiqueta))
    bloque.appendChild(
      crear(doc, 'div', 'font-size:18px;font-weight:700;color:#111827;', valor)
    )
    metricas.appendChild(bloque)
  }
  cont.appendChild(metricas)

  // ── Top delitos ──
  const delitos = (provincia.delitos ?? [])
    .slice()
    .sort((a, b) => (b.hechos ?? 0) - (a.hechos ?? 0))
    .slice(0, MAX_DELITOS_MOSTRADOS)

  if (delitos.length > 0) {
    const lista = crear(
      doc,
      'div',
      'border-top:1px solid #E5E7EB;padding-top:6px;font-size:12px;'
    )
    for (const d of delitos) {
      const fila = crear(
        doc,
        'div',
        'display:flex;justify-content:space-between;gap:12px;padding:2px 0;'
      )
      fila.appendChild(crear(doc, 'span', 'color:#374151;', d.nombre ?? 'Sin clasificar'))
      fila.appendChild(
        crear(doc, 'span', `font-weight:600;color:${USINA_AZUL};`, numero(d.hechos))
      )
      lista.appendChild(fila)
    }
    cont.appendChild(lista)
  }

  cont.appendChild(
    crear(doc, 'div', 'font-size:10px;color:#9CA3AF;margin-top:6px;', 'Click para más detalle')
  )

  return cont
}

// ════════════════════════════════════════════
// CELDA H3
// ════════════════════════════════════════════

export interface DatosCeldaH3 {
  count: number
  victimas: number
}

/**
 * Nota: esta celda solo interpola números calculados en el cliente, así que no
 * era un vector de XSS real. Se construye igual con nodos DOM para que el
 * patrón sea uniforme y para que agregar un campo de texto en el futuro no
 * reintroduzca el problema.
 */
export function contenidoCeldaH3(
  celda: DatosCeldaH3,
  doc: Document = document
): HTMLElement {
  const cont = crear(
    doc,
    'div',
    'font-family:system-ui;font-size:12px;padding:2px 4px;min-width:100px;'
  )

  const hechos = typeof celda.count === 'number' && Number.isFinite(celda.count) ? celda.count : 0
  const victimas =
    typeof celda.victimas === 'number' && Number.isFinite(celda.victimas) ? celda.victimas : 0

  cont.appendChild(
    crear(
      doc,
      'strong',
      `color:${USINA_AZUL};`,
      `${numero(hechos)} hecho${hechos === 1 ? '' : 's'}`
    )
  )
  cont.appendChild(doc.createElement('br'))
  cont.appendChild(
    crear(
      doc,
      'span',
      'color:#666;',
      `${numero(victimas)} víctima${victimas === 1 ? '' : 's'}`
    )
  )

  return cont
}
