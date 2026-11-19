/**
 * Worker que enciende el agente del pipeline en un Cloudflare Container.
 *
 * El contenedor corre el MISMO agente que la computadora del equipo
 * (scripts/pipeline/agente-local.ts --una-vez): encola la programada del día si
 * ya es la hora, procesa lo pendiente en corridas_pipeline y sale. Al salir el
 * proceso, el contenedor se apaga y deja de cobrar.
 *
 * Quién lo enciende:
 * - Cron Triggers (ver wrangler.jsonc): la corrida diaria a las 07:05 hora
 *   argentina y un segundo intento a las 10:05 por si la primera no arrancó.
 *   El agente no duplica la programada: la clave única del día lo impide.
 * - El panel /admin/pipeline: después de encolar una corrida hace
 *   POST /despertar con el token compartido (PIPELINE_NUBE_TOKEN en Vercel,
 *   DESPERTAR_TOKEN acá).
 *
 * El Worker NO consulta la base: así Neon no se despierta cada pocos minutos
 * solo para preguntar si hay trabajo.
 *
 * Respaldo: si nada de esto funciona, GitHub Actions corre a las 12 con
 * --solo-si-no-corrio-hoy y abre un issue si falla.
 */
import { DurableObject } from 'cloudflare:workers'

export interface Env {
  AGENTE: DurableObjectNamespace<AgentePipeline>
  // Secrets (wrangler secret put / workflow de deploy)
  DATABASE_URL: string
  OPENCODE_API_KEY: string
  DESPERTAR_TOKEN: string
  OPENROUTER_API_KEY?: string
  // Variables (wrangler.jsonc → vars)
  INSTANCIA?: Instancia
  OPENCODE_MODELO_ECONOMICO?: string
  PIPELINE_LLM_RAZONAMIENTO?: string
  PIPELINE_MAX_NOTICIAS?: string
  PIPELINE_SNAPSHOT_MAX_CHARS?: string
}

/** Tope de una encendida. Las corridas reales duran 5–30 min; Actions corta a 120. */
const TOPE_MS = 150 * 60 * 1000
/** Margen para que el agente cierre la corrida tras el SIGTERM antes de destruir. */
const GRACIA_MS = 5 * 60 * 1000
/** El contenedor sigue vivo aunque el Durable Object quede inactivo. */
const INACTIVIDAD_MS = TOPE_MS + GRACIA_MS + 60 * 1000

type Instancia = 'lite' | 'basic' | 'standard-1' | 'standard-2' | 'standard-3' | 'standard-4'

type Resultado =
  | { estado: 'encendido'; motivo: string }
  | { estado: 'ya-corriendo'; desde: string | null }

export class AgentePipeline extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // Tras un deploy el Durable Object reinicia sin timeout: se vuelve a poner
    // para no matar una corrida en curso.
    if (ctx.container?.running) {
      ctx.blockConcurrencyWhile(() => ctx.container!.setInactivityTimeout(INACTIVIDAD_MS))
    }
  }

  async encender(motivo: string): Promise<Resultado> {
    const contenedor = this.ctx.container!
    if (contenedor.running) {
      return { estado: 'ya-corriendo', desde: (await this.ctx.storage.get<string>('inicio')) ?? null }
    }

    const env: Record<string, string> = {
      DATABASE_URL: this.env.DATABASE_URL,
      OPENCODE_API_KEY: this.env.OPENCODE_API_KEY,
      PIPELINE_AGENTE_NOMBRE: 'cloudflare',
      PIPELINE_AGENTE_BAJO_DEMANDA: '1',
      PIPELINE_ORIGEN_ENCENDIDO: motivo,
    }
    for (const clave of [
      'OPENROUTER_API_KEY',
      'OPENCODE_MODELO_ECONOMICO',
      'PIPELINE_LLM_RAZONAMIENTO',
      'PIPELINE_MAX_NOTICIAS',
      'PIPELINE_SNAPSHOT_MAX_CHARS',
    ] as const) {
      const valor = this.env[clave]
      if (valor) env[clave] = valor
    }

    contenedor.start({
      image: contenedor.images.base,
      instance: this.env.INSTANCIA ?? 'standard-1',
      enableInternet: true,
      env,
    })
    await contenedor.setInactivityTimeout(INACTIVIDAD_MS)

    const inicio = new Date().toISOString()
    await this.ctx.storage.put({ inicio, motivo, fase: 'corriendo' })
    await this.ctx.storage.setAlarm(Date.now() + TOPE_MS)

    // Solo para el log del Worker: monitor() mantiene vivo al Durable Object
    // hasta 15 min, pero el contenedor sigue gracias al timeout de inactividad.
    this.ctx.waitUntil(
      contenedor.monitor().then(
        () => console.log(`agente terminó bien (${motivo})`),
        error => console.error(`agente terminó con error (${motivo}): ${String(error)}`),
      ),
    )
    console.log(`agente encendido (${motivo})`)
    return { estado: 'encendido', motivo }
  }

  /** Salvavidas: una encendida no puede pasar de TOPE_MS. */
  async alarm(): Promise<void> {
    const contenedor = this.ctx.container!
    if (!contenedor.running) {
      await this.ctx.storage.put('fase', 'apagado')
      return
    }
    const fase = await this.ctx.storage.get<string>('fase')
    if (fase === 'corriendo') {
      console.warn('agente superó el tope: SIGTERM')
      contenedor.signal(15) // SIGTERM: el agente marca la corrida y sale
      await this.ctx.storage.put('fase', 'deteniendo')
      await this.ctx.storage.setAlarm(Date.now() + GRACIA_MS)
      return
    }
    console.error('agente no salió tras el SIGTERM: se destruye')
    await contenedor.destroy('superó el tope de duración')
    await this.ctx.storage.put('fase', 'apagado')
  }
}

function agente(env: Env) {
  // Un solo agente a la vez en toda la cuenta: siempre el mismo nombre.
  return env.AGENTE.getByName('pipeline')
}

/** Comparación en tiempo constante para el token del panel. */
function mismoToken(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a)
  const eb = new TextEncoder().encode(b)
  if (ea.length !== eb.length) return false
  let diferencia = 0
  for (let i = 0; i < ea.length; i++) diferencia |= ea[i] ^ eb[i]
  return diferencia === 0
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname !== '/despertar') {
      return new Response('Agente del pipeline de Usina de Justicia.\n', { status: 404 })
    }
    if (request.method !== 'POST') {
      return new Response('Método no permitido\n', { status: 405, headers: { Allow: 'POST' } })
    }
    const recibido = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ?? ''
    if (!env.DESPERTAR_TOKEN || !mismoToken(recibido, env.DESPERTAR_TOKEN)) {
      return new Response('No autorizado\n', { status: 401 })
    }
    const resultado = await agente(env).encender('panel')
    return Response.json(resultado, { headers: { 'Cache-Control': 'no-store' } })
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const resultado = await agente(env).encender(`cron ${controller.cron}`)
    console.log(JSON.stringify(resultado))
  },
} satisfies ExportedHandler<Env>
