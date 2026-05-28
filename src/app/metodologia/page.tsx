import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'Metodología | Mapa Nacional del Delito — Usina de Justicia',
  description: 'Cómo funciona el Mapa Nacional del Delito: fuentes de datos, metodología de procesamiento y limitaciones.',
}

function Seccion({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="text-base font-bold mb-3" style={{ color: '#1E427C' }}>{titulo}</h2>
      <div className="space-y-2 text-sm text-gray-700 leading-relaxed">{children}</div>
    </section>
  )
}

function FuenteCard({
  nombre,
  organismo,
  descripcion,
  estado,
}: {
  nombre: string
  organismo: string
  descripcion: string
  estado: string
}) {
  return (
    <div className="border border-gray-200 rounded-xl p-4 bg-white">
      <div className="flex items-start justify-between gap-2 mb-1">
        <span className="font-semibold text-gray-900 text-sm">{nombre}</span>
        <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 font-medium shrink-0">
          {estado}
        </span>
      </div>
      <p className="text-xs text-gray-500 mb-2">{organismo}</p>
      <p className="text-xs text-gray-600 leading-relaxed">{descripcion}</p>
    </div>
  )
}

export default function MetodologiaPage() {
  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-2xl mx-auto px-4 py-4 flex items-center justify-between">
          <Link href="/mapa-del-delito" className="flex items-center gap-2 group">
            <svg className="w-4 h-4 text-gray-400 group-hover:text-gray-600 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            <span className="text-sm text-gray-500 group-hover:text-gray-700 transition-colors">Volver al mapa</span>
          </Link>
        </div>
      </header>

      {/* Contenido */}
      <main className="max-w-2xl mx-auto px-4 py-8">
        {/* Título */}
        <div className="mb-8">
          <div
            className="inline-flex items-center justify-center w-10 h-10 rounded-xl mb-4"
            style={{ backgroundColor: '#1E427C' }}
          >
            <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-gray-900">Metodología</h1>
          <p className="text-sm text-gray-500 mt-1">Mapa Nacional del Delito · Usina de Justicia</p>
        </div>

        {/* Sección 1 */}
        <Seccion titulo="¿Qué es el Mapa del Delito?">
          <p>
            Herramienta pública de Usina de Justicia para visualizar homicidios en Argentina.
            Combina datos oficiales con monitoreo periodístico en tiempo real, permitiendo
            analizar la distribución geográfica y temporal de la violencia letal en el país.
          </p>
        </Seccion>

        {/* Sección 2 */}
        <Seccion titulo="Fuentes de datos">
          <div className="space-y-3">
            <FuenteCard
              nombre="SNIC"
              organismo="Sistema Nacional de Información Criminal — Ministerio de Seguridad de la Nación"
              descripcion="Datos anuales 2000–2024, desagregados a nivel departamental. Cobertura nacional completa. Incluye todos los tipos de delito del catálogo oficial."
              estado="Oficial"
            />
            <FuenteCard
              nombre="SAT"
              organismo="Sistema de Alerta Temprana — Ministerio de Seguridad de la Nación"
              descripcion="Homicidios dolosos con microdatos individuales. Incluye variables de sexo, edad, modalidad del hecho, arma utilizada y vínculo víctima-victimario."
              estado="Oficial"
            />
            <FuenteCard
              nombre="Medios periodísticos"
              organismo="Pipeline automatizado — +65 medios de las 24 provincias argentinas"
              descripcion="Extracción automática de noticias sobre homicidios mediante IA (DeepSeek/Claude). Estado PRELIMINAR: procesado automáticamente, no verificado editorialmente por Usina. Actualización: diaria."
              estado="Preliminar"
            />
          </div>
        </Seccion>

        {/* Sección 3 */}
        <Seccion titulo="Metodología de procesamiento">
          <div className="space-y-3">
            <div className="bg-white border border-gray-200 rounded-xl p-4">
              <p className="text-xs font-semibold text-gray-800 mb-2">Normalización geográfica</p>
              <p className="text-xs text-gray-600">Identificadores INDEC de 5 dígitos para provincias y departamentos. Georreferenciación automática vía API Georef del IGN.</p>
            </div>
            <div className="bg-white border border-gray-200 rounded-xl p-4">
              <p className="text-xs font-semibold text-gray-800 mb-2">Filtro de homicidios (3 capas)</p>
              <ol className="text-xs text-gray-600 space-y-1 list-decimal list-inside">
                <li>Palabras clave en título: descarte inmediato de noticias de drogas/sentencias sin muertes</li>
                <li>Clasificación LLM: el modelo extrae tipo, ubicación, fecha y confianza</li>
                <li>Validación SNIC: solo códigos 0–4 (homicidio doloso, femicidio, culposo, tentativa)</li>
              </ol>
            </div>
            <div className="bg-white border border-gray-200 rounded-xl p-4">
              <p className="text-xs font-semibold text-gray-800 mb-2">Deduplicación</p>
              <p className="text-xs text-gray-600">Prevención de registros duplicados por URL fuente. Noticias de seguimiento se vinculan al hecho original como cobertura mediática.</p>
            </div>
          </div>
        </Seccion>

        {/* Sección 4 */}
        <Seccion titulo="Limitaciones y advertencias">
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 space-y-2">
            <p className="text-xs text-amber-800">
              ⚠️ Los datos <strong>PRELIMINAR</strong> son generados automáticamente por IA y pueden contener errores de clasificación o georreferenciación. Usina los revisa periódicamente.
            </p>
            <p className="text-xs text-amber-800">
              ⚠️ Los datos <strong>SNIC</strong> tienen un rezago de 1–2 años respecto del año en curso.
            </p>
            <p className="text-xs text-amber-800">
              ⚠️ Esta herramienta <strong>no reemplaza fuentes oficiales</strong>. Para decisiones de política pública, consultar directamente al Ministerio de Seguridad de la Nación.
            </p>
          </div>
        </Seccion>

        {/* Sección 5 */}
        <Seccion titulo="Sobre Usina de Justicia">
          <p>
            ONG argentina que acompaña a familias víctimas de homicidio y femicidio desde 2009.
            Trabajamos por el acceso a la justicia, la memoria de las víctimas y la transparencia
            en los datos de violencia letal.
          </p>
          <div className="flex flex-col sm:flex-row gap-2 mt-3">
            <a
              href="mailto:info@usinadejusticia.org.ar"
              className="inline-flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border border-gray-200 text-gray-600 hover:border-[#1E427C] hover:text-[#1E427C] transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
              info@usinadejusticia.org.ar
            </a>
            <a
              href="https://usinadejusticia.org.ar"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border border-gray-200 text-gray-600 hover:border-[#1E427C] hover:text-[#1E427C] transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9" />
              </svg>
              usinadejusticia.org.ar
            </a>
          </div>
        </Seccion>
      </main>
    </div>
  )
}
