'use client'

export function SliderAnios({
  anios,
  anioSeleccionado,
  onChange,
}: {
  anios: number[]
  anioSeleccionado: number
  onChange: (anio: number) => void
}) {
  if (anios.length === 0) return null

  const min = anios[0]
  const max = anios[anios.length - 1]

  return (
    <div className="bg-white/95 backdrop-blur-sm rounded-xl shadow-lg px-4 py-3 flex items-center gap-3">
      <span className="text-xs text-gray-500 min-w-[32px]">{min}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={anioSeleccionado}
        onChange={(e) => onChange(parseInt(e.target.value))}
        className="w-32 sm:w-48 accent-usina-900"
        aria-label="Seleccionar año"
      />
      <span className="text-xs text-gray-500 min-w-[32px]">{max}</span>
      <span className="text-base font-bold text-usina-900 min-w-[48px] text-center">
        {anioSeleccionado}
      </span>
    </div>
  )
}