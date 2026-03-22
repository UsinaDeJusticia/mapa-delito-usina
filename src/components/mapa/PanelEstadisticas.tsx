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

export function PanelEstadisticas({
  provincia,
  anio,
  onClose,
}: {
  provincia: ProvinciaData
  anio: number
  onClose: () => void
}) {
  const [tendencia, setTendencia] = useState<TendenciaData[]>([])
  const [loadingTendencia, setLoadingTendencia] = useState(false)

  // Fetch tendencia al seleccionar provincia
  useEffect(() => {
    async function fetchTendencia() {
      setLoadingTendencia(true)
      try {
        const params = new URLSearchParams({
          provincia_id: provincia.provinciaId,
          codigo_snic: '1', // Homicidios dolosos por default
        })
        const res = await fetch(`/api/mapa/tendencias?${params}`)
        if (res.ok) {
          const data = await res.json()
          setTendencia(data.serie)
        }
      } catch (err) {
        console.error('Error cargando tendencia:', err)
      } finally {
        setLoadingTendencia(false)
      }
    }
    if (provincia.provinciaId) fetchTendencia()
  }, [provincia.provinciaId])

  // Top 5 delitos de la provincia
  const topDelitos = [...provincia.delitos]
    .sort((a, b) => b.hechos - a.hechos)
    .slice(0, 5)

  return (
    <div className="absolute top-0 right-0 w-full sm:w-[420px] h-full bg-white/95 backdrop-blur-sm shadow-2xl z-30 overflow-y-auto">
      {/* Header */}
      <div className="sticky top-0 bg-usina-900 text-white px-6 py-4 flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold">{provincia.provincia}</h2>
          <p className="text-sm text-usina-200">Datos {anio} · Fuente SNIC</p>
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
          <p className="text-xs text-gray-500 mt-1">Hechos registrados</p>
        </div>
        <div className="bg-usina-50 rounded-xl p-4">
          <p className="text-2xl font-bold text-usina-900">
            {provincia.totalVictimas.toLocaleString('es-AR')}
          </p>
          <p className="text-xs text-gray-500 mt-1">Víctimas</p>
        </div>
      </div>

      {/* Gráfico de barras: Top 5 delitos */}
      <div className="px-6 py-4">
        <h3 className="text-sm font-semibold text-gray-700 mb-3">
          Principales delitos
        </h3>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={topDelitos} layout="vertical" margin={{ left: 10, right: 10 }}>
            <XAxis type="number" tick={{ fontSize: 11 }} />
            <YAxis
              type="category"
              dataKey="nombre"
              width={140}
              tick={{ fontSize: 10 }}
              tickFormatter={(v: string) => v.length > 20 ? v.slice(0, 20) + '…' : v}
            />
            <Tooltip
              formatter={(value) => [`${Number(value).toLocaleString('es-AR')}`, 'Hechos']}
            />
            <Bar dataKey="hechos" fill="#15305B" radius={[0, 4, 4, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Gráfico de línea: Evolución temporal */}
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
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
            OFICIAL
          </span>
          <span className="text-xs text-gray-400">
            Datos del SNIC — Ministerio de Seguridad de la Nación
          </span>
        </div>
      </div>
    </div>
  )
}