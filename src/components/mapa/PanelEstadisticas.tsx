'use client'

import { useState, useEffect } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  LineChart, Line, CartesianGrid,
} from 'recharts'

interface ProvinciaData {
  provincia: string
  provinciaId: string
  totalHechos: number
  totalVictimas: number
  delitos: Array<{ nombre: string; hechos: number; victimas: number }>
}

interface TendenciaData {
  anio: number
  hechos: number
  victimas: number
  variacionInteranual: number | null
}

interface DelitoData {
  nombre: string
  hechos: number
  victimas: number
}

export function PanelEstadisticas({
  provincia,
  anio,
  fuente = 'snic',
  onClose,
}: {
  provincia: ProvinciaData
  anio: number
  fuente?: 'snic' | 'sat'
  onClose: () => void
}) {
  const [tendencia, setTendencia] = useState<TendenciaData[]>([])
  const [loadingTendencia, setLoadingTendencia] = useState(false)
  const [topDelitos, setTopDelitos] = useState<DelitoData[]>([])
  const [loadingDelitos, setLoadingDelitos] = useState(false)

  // Fetch tendencia (homicidios dolosos) al seleccionar provincia
  useEffect(() => {
    async function fetchTendencia() {
      setLoadingTendencia(true)
      try {
        const params = new URLSearchParams({
          provincia_id: provincia.provinciaId,
          codigo_snic: '1',
        })
        const res = await fetch(`/api/mapa/tendencias?${params}`)
        if (res.ok) {
          const data = await res.json()
          setTendencia(data.serie || [])
        }
      } catch (err) {
        console.error('Error cargando tendencia:', err)
      } finally {
        setLoadingTendencia(false)
      }
    }
    if (provincia.provinciaId) fetchTendencia()
  }, [provincia.provinciaId])

  // Fetch top delitos para SNIC (desde materialized view)
  useEffect(() => {
    if (fuente !== 'snic') {
      setTopDelitos([])
      return
    }

    // Si la provincia ya trae delitos con datos, usarlos
    if (provincia.delitos.length > 0 && provincia.delitos[0].hechos > 0) {
      const sorted = [...provincia.delitos]
        .sort((a, b) => b.hechos - a.hechos)
        .slice(0, 10)
      setTopDelitos(sorted)
      return
    }

    // Si no (modo "Todos los delitos"), fetch del endpoint
    async function fetchTopDelitos() {
      setLoadingDelitos(true)
      try {
        const params = new URLSearchParams({
          provincia_id: provincia.provinciaId,
          anio: anio.toString(),
        })
        const res = await fetch(`/api/mapa/delitos-provincia?${params}`)
        if (res.ok) {
          const data = await res.json()
          setTopDelitos(data.delitos || [])
        }
      } catch (err) {
        console.error('Error cargando delitos:', err)
      } finally {
        setLoadingDelitos(false)
      }
    }

    if (provincia.provinciaId) fetchTopDelitos()
  }, [provincia.provinciaId, provincia.delitos, anio, fuente])

  // Etiquetas según fuente
  const fuenteLabel = fuente === 'snic'
    ? 'SNIC — Min. de Seguridad'
    : 'SAT — Homicidios dolosos'

  const badgeColor = fuente === 'snic'
    ? 'bg-green-100 text-green-800'
    : 'bg-blue-100 text-blue-800'

  const badgeText = fuente === 'snic' ? 'OFICIAL' : 'OFICIAL — SAT'

  return (
    <div className="absolute top-0 right-0 w-full sm:w-[420px] h-full bg-white/95 backdrop-blur-sm shadow-2xl z-30 overflow-y-auto">
      {/* Header */}
      <div className="sticky top-0 bg-usina-900 text-white px-6 py-4 flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold">{provincia.provincia}</h2>
          <p className="text-sm text-usina-200">
            Datos {anio} · Fuente {fuente === 'snic' ? 'SNIC' : 'SAT'}
          </p>
        </div>
        <button
          onClick={onClose}
          className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-white/20 transition"
          aria-label="Cerrar panel"
        >
          ✕
        </button>
      </div>

      {/* Resumen */}
      <div className="px-6 py-4 grid grid-cols-2 gap-4">
        <div className="bg-usina-50 rounded-xl p-4">
          <p className="text-2xl font-bold text-usina-900">
            {provincia.totalHechos.toLocaleString('es-AR')}
          </p>
          <p className="text-xs text-gray-500 mt-1">
            {fuente === 'snic' ? 'Hechos registrados' : 'Homicidios dolosos'}
          </p>
        </div>
        <div className="bg-usina-50 rounded-xl p-4">
          <p className="text-2xl font-bold text-usina-900">
            {provincia.totalVictimas.toLocaleString('es-AR')}
          </p>
          <p className="text-xs text-gray-500 mt-1">Víctimas</p>
        </div>
      </div>

      {/* ─── Contenido según fuente ─────────────────────── */}

      {fuente === 'snic' ? (
        <>
          {/* SNIC: Gráfico de barras — Top delitos */}
          <div className="px-6 py-4">
            <h3 className="text-sm font-semibold text-gray-700 mb-3">
              Principales delitos
            </h3>
            {loadingDelitos ? (
              <div className="h-[200px] flex items-center justify-center text-gray-400">
                Cargando...
              </div>
            ) : topDelitos.length > 0 ? (
              <ResponsiveContainer width="100%" height={Math.max(200, topDelitos.length * 36)}>
                <BarChart data={topDelitos} layout="vertical" margin={{ left: 10, right: 10 }}>
                  <XAxis type="number" tick={{ fontSize: 11 }} />
                  <YAxis
                    type="category"
                    dataKey="nombre"
                    width={140}
                    tick={{ fontSize: 10 }}
                    tickFormatter={(v: string) => v.length > 22 ? v.slice(0, 22) + '…' : v}
                  />
                  <Tooltip
                    formatter={(value) => [`${Number(value).toLocaleString('es-AR')}`, 'Hechos']}
                  />
                  <Bar dataKey="hechos" fill="#15305B" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <p className="text-sm text-gray-400">Sin datos de delitos</p>
            )}
          </div>
        </>
      ) : (
        <>
          {/* SAT: Resumen de homicidios dolosos */}
          <div className="px-6 py-4">
            <h3 className="text-sm font-semibold text-gray-700 mb-3">
              Detalle homicidios dolosos
            </h3>
            <div className="space-y-3">
              <div className="flex justify-between items-center py-2 border-b border-gray-100">
                <span className="text-sm text-gray-600">Total de hechos</span>
                <span className="text-sm font-bold text-usina-900">
                  {provincia.totalHechos.toLocaleString('es-AR')}
                </span>
              </div>
              <div className="flex justify-between items-center py-2 border-b border-gray-100">
                <span className="text-sm text-gray-600">Total de víctimas</span>
                <span className="text-sm font-bold text-usina-900">
                  {provincia.totalVictimas.toLocaleString('es-AR')}
                </span>
              </div>
              <div className="flex justify-between items-center py-2 border-b border-gray-100">
                <span className="text-sm text-gray-600">Promedio víctimas/hecho</span>
                <span className="text-sm font-bold text-usina-900">
                  {provincia.totalHechos > 0
                    ? (provincia.totalVictimas / provincia.totalHechos).toFixed(2)
                    : '—'}
                </span>
              </div>
            </div>
            <p className="text-xs text-gray-400 mt-4">
              Filtros detallados (sexo, arma, femicidio) disponibles próximamente.
            </p>
          </div>
        </>
      )}

      {/* Gráfico de línea: Evolución temporal (ambas fuentes) */}
      <div className="px-6 py-4 border-t border-gray-100">
        <h3 className="text-sm font-semibold text-gray-700 mb-3">
          Evolución de homicidios dolosos
        </h3>
        {loadingTendencia ? (
          <div className="h-[180px] flex items-center justify-center text-gray-400">
            Cargando...
          </div>
        ) : tendencia.length > 0 ? (
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={tendencia}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="anio" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip
                formatter={(value) => [`${Number(value).toLocaleString('es-AR')}`, 'Hechos']}
              />
              <Line
                type="monotone"
                dataKey="hechos"
                stroke="#1E427C"
                strokeWidth={2}
                dot={{ fill: '#1E427C', r: 3 }}
              />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <p className="text-sm text-gray-400">Sin datos de tendencia</p>
        )}
      </div>

      {/* Badge de confianza */}
      <div className="px-6 py-4 border-t border-gray-100">
        <div className="flex items-center gap-2">
          <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${badgeColor}`}>
            {badgeText}
          </span>
          <span className="text-xs text-gray-400">
            {fuenteLabel}
          </span>
        </div>
      </div>
    </div>
  )
}
