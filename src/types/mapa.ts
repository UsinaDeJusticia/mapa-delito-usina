// Tipos compartidos para el Mapa Nacional del Delito
// Estos tipos complementan los generados por Prisma para uso en el frontend

export interface HechoDelictivoConRelaciones {
  id: string
  tipoDelito: {
    id: string
    codigoSnic: number
    nombre: string
    categoria: string
  }
  fechaHecho: Date
  horaHecho: Date | null
  anio: number
  mes: number | null
  ubicacion: {
    id: string
    provincia: string
    departamento: string | null
    latitud: number
    longitud: number
  }
  cantidadVictimas: number
  cantidadHechos: number
  medioUtilizado: string | null
  franjaHoraria: string | null
  fuente: {
    nombre: string
    tipo: string
  }
  confianza: string
  urlFuente: string | null
  esCasoUsina: boolean
}

export interface EstadisticaProvincia {
  provinciaId: string
  provincia: string
  anio: number
  cantidadHechos: number
  cantidadVictimas: number | null
  tasaPor100k: number | null
  poblacion: number | null
}

export interface FiltrosMapa {
  anioDesde?: number
  anioHasta?: number
  provincia?: string
  tipoDelitoId?: string
  confianza?: string
  soloUsina?: boolean
}

export interface DatosZona {
  ubicacion: {
    provincia: string
    departamento: string | null
  }
  resumen: {
    totalHechos: number
    totalVictimas: number
    tasaPor100k: number | null
    variacionInteranual: number | null
  }
  ultimosHechos: HechoDelictivoConRelaciones[]
  rankingProvincial: number | null
}