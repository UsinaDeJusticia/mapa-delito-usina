'use client'

import { useEffect, useState } from 'react'
import { signOut } from 'next-auth/react'
import Link from 'next/link'

interface Metricas {
  totales: {
    totalPipeline: number
    verificados: number
    preliminares: number
    revisados: number
    pendientes: number
  }
  semanas: Array<{
    semana: string
    scrapeados: number
    verificados: number
    preliminares: number
    falsosPositivos: number
  }>
  medios: Array<{
    medio: string
    total: number
    verificados: number
    falsosPositivos: number
    precision: number | null
  }>
}

function Stat({ label, valor, sub, color = 'text-[#1E427C]' }: {
  label: string
  valor: number | string
  sub?: string
  color?: string
}) {
  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm px-4 py-3">
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className={`text-2xl font-bold ${color}`}>{typeof valor === 'number' ? valor.toLocaleString('es-AR') : valor}</p>
      {sub && <p className="text-[10px] text-gray-400 mt-0.5">{sub}</p>}
    </div>
  )
}

function BarraPrecision({ valor, total }: { valor: number; total: number }) {
  const ancho = Math.min(100, valor)
  const color = valor >= 70 ? '#15803D' : valor >= 40 ? '#D97706' : '#DC2626'
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${ancho}%`, backgroundColor: color }} />
      </div>
      <span className="text-[10px] font-semibold w-8 text-right" style={{ color }}>{valor}%</span>
      <span className="text-[10px] text-gray-400 w-8 text-right">{total}</span>
    </div>
  )
}

export default function AdminDashboard() {
  const [metricas, setMetricas] = useState<Metricas | null>(null)
  const [cargando, setCargando] = useState(true)

  useEffect(() => {
    fetch('/api/admin/metricas')
      .then(r => { if (!r.ok) throw new Error(String(r.status)); return r.json() })
      .then(d => setMetricas(d))
      .catch(() => setMetricas(null))
      .finally(() => setCargando(false))
  }, [])

  const precisionGlobal = metricas && metricas.totales.revisados > 0
    ? Math.round((metricas.totales.verificados / metricas.totales.revisados) * 100)
    : null

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="font-bold text-[#1E427C] text-sm sm:text-base">Pipeline — Métricas</h1>
            <Link href="/admin/revisiones"
              className="text-xs text-gray-500 border border-gray-200 rounded-lg px-2.5 py-1 hover:border-[#1E427C] hover:text-[#1E427C] transition-colors">
              Revisiones {metricas?.totales.pendientes ? `(${metricas.totales.pendientes})` : ''}
            </Link>
          </div>
          <button
            onClick={() => signOut({ callbackUrl: '/admin/login' })}
            className="text-xs text-gray-500 hover:text-gray-700 px-3 py-1.5 rounded-lg border border-gray-200 transition-colors"
          >
            Cerrar sesión
          </button>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-6 space-y-6">
        {cargando ? (
          <div className="flex justify-center py-20">
            <div className="w-8 h-8 border-2 border-[#1E427C] border-t-transparent rounded-full animate-spin" />
          </div>
        ) : metricas ? (
          <>
            {/* Tarjetas de resumen */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Stat label="Total scrapeados" valor={metricas.totales.totalPipeline} sub="desde el inicio" />
              <Stat
                label="Verificados"
                valor={metricas.totales.verificados}
                sub="revisados y confirmados"
                color="text-green-700"
              />
              <Stat
                label="Pendientes"
                valor={metricas.totales.pendientes}
                sub="sin revisión humana"
                color={metricas.totales.pendientes > 0 ? 'text-amber-600' : 'text-gray-400'}
              />
              <Stat
                label="Precisión IA"
                valor={precisionGlobal !== null ? `${precisionGlobal}%` : '—'}
                sub={`sobre ${metricas.totales.revisados} revisados`}
                color={precisionGlobal !== null && precisionGlobal >= 70 ? 'text-green-700' : 'text-amber-600'}
              />
            </div>

            {/* Tabla últimas semanas */}
            {metricas.semanas.length > 0 && (
              <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
                <div className="px-4 py-3 border-b border-gray-100">
                  <h2 className="text-sm font-semibold text-gray-700">Actividad semanal</h2>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-gray-50 text-gray-500 text-[10px] uppercase tracking-wide">
                        <th className="px-4 py-2 text-left">Semana</th>
                        <th className="px-4 py-2 text-right">Scrapeados</th>
                        <th className="px-4 py-2 text-right text-green-700">Verificados</th>
                        <th className="px-4 py-2 text-right text-amber-600">Preliminares</th>
                        <th className="px-4 py-2 text-right text-red-600">Falsos +</th>
                        <th className="px-4 py-2 text-right">Precisión</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {metricas.semanas.map(s => {
                        const revisadosSemana = s.verificados + s.falsosPositivos
                        const precision = revisadosSemana > 0
                          ? Math.round((s.verificados / revisadosSemana) * 100)
                          : null
                        return (
                          <tr key={s.semana} className="hover:bg-gray-50 transition-colors">
                            <td className="px-4 py-2.5 font-medium text-gray-700">{s.semana}</td>
                            <td className="px-4 py-2.5 text-right text-gray-600">{s.scrapeados}</td>
                            <td className="px-4 py-2.5 text-right font-semibold text-green-700">{s.verificados}</td>
                            <td className="px-4 py-2.5 text-right text-amber-600">{s.preliminares}</td>
                            <td className="px-4 py-2.5 text-right text-red-600">{s.falsosPositivos}</td>
                            <td className="px-4 py-2.5 text-right">
                              {precision !== null
                                ? <span className={precision >= 70 ? 'text-green-700 font-semibold' : 'text-amber-600'}>{precision}%</span>
                                : <span className="text-gray-300">—</span>
                              }
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Precisión por medio */}
            {metricas.medios.length > 0 && (
              <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
                <div className="px-4 py-3 border-b border-gray-100">
                  <h2 className="text-sm font-semibold text-gray-700">Precisión por medio <span className="text-xs font-normal text-gray-400">(últimos 30 días)</span></h2>
                  <p className="text-[10px] text-gray-400 mt-0.5">Porcentaje de artículos que resultaron ser homicidios reales</p>
                </div>
                <div className="divide-y divide-gray-50">
                  {metricas.medios.map(m => (
                    <div key={m.medio} className="px-4 py-2.5 flex items-center gap-3">
                      <span className="text-xs font-medium text-gray-700 w-40 truncate shrink-0">{m.medio}</span>
                      <div className="flex-1">
                        {m.precision !== null
                          ? <BarraPrecision valor={m.precision} total={m.total} />
                          : <span className="text-[10px] text-gray-300">sin revisiones · {m.total} total</span>
                        }
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : (
          <p className="text-center text-gray-500 py-20">Error cargando métricas.</p>
        )}
      </main>
    </div>
  )
}
