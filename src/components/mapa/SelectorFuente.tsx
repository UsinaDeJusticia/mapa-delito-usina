'use client'

interface SelectorFuenteProps {
  value: 'snic' | 'sat'
  onChange: (fuente: 'snic' | 'sat') => void
}

export function SelectorFuente({ value, onChange }: SelectorFuenteProps) {
  return (
    <div className="bg-white/95 backdrop-blur-sm rounded-xl shadow-lg flex overflow-hidden text-xs sm:text-sm">
      <button
        onClick={() => onChange('snic')}
        className={`px-3 py-2 sm:px-4 sm:py-2.5 font-medium transition-colors ${
          value === 'snic'
            ? 'bg-[#1E427C] text-white'
            : 'text-gray-500 hover:text-[#1E427C] hover:bg-gray-50'
        }`}
        title="Sistema Nacional de Información Criminal — Todos los delitos, 2000-2024"
      >
        SNIC
      </button>
      <button
        onClick={() => onChange('sat')}
        className={`px-3 py-2 sm:px-4 sm:py-2.5 font-medium transition-colors ${
          value === 'sat'
            ? 'bg-[#1E427C] text-white'
            : 'text-gray-500 hover:text-[#1E427C] hover:bg-gray-50'
        }`}
        title="Sistema de Alerta Temprana — Homicidios dolosos, 2017-2024"
      >
        SAT
      </button>
    </div>
  )
}
