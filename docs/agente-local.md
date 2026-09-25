# Agente local del pipeline

El agente corre en una computadora del equipo y ejecuta ahí el scraping de
medios: con su navegador, su conexión y su CPU. Reemplaza a GitHub Actions como
motor principal (Actions queda de respaldo).

Hace dos cosas:

1. **La corrida diaria programada** (por defecto a las 7:00, hora argentina).
   Si la computadora estaba apagada a esa hora, la hace apenas se enciende.
2. **Las corridas que se piden desde el panel** `/admin/pipeline`: completas o
   enfocadas en las provincias y localidades donde hay conflictos serios.

El panel y el agente se comunican por la base de datos (Neon): el panel deja
la corrida en una cola y el agente la toma. La computadora **no necesita** ser
accesible desde internet ni abrir puertos; alcanza con que tenga conexión.

---

## 1. Instalación (una sola vez)

Requisitos: [Node.js 22](https://nodejs.org) y git.

```bash
git clone https://github.com/UsinaDeJusticia/mapa-delito-usina.git
cd mapa-delito-usina
npm ci
npx agent-browser install        # descarga el Chrome que usa el pipeline
```

Crear un archivo `.env` en la carpeta del proyecto (nunca se sube al
repositorio) con, como mínimo:

```bash
DATABASE_URL=postgresql://...      # la misma base de producción (Neon)
OPENCODE_API_KEY=...               # proveedor LLM
```

Y aplicar las migraciones si todavía no se aplicaron (el workflow
`migraciones.yml` lo hace solo al mergear a master):

```bash
npx prisma migrate deploy
```

## 2. Probar que anda

```bash
npm run agente
```

En la consola tiene que aparecer `Agente "<nombre>" iniciando` y, en el panel
`/admin/pipeline`, **Agente conectado**. Para una prueba sin escribir en la
base: en el panel, "Enfocar en zonas", elegir una provincia, tildar **Modo
prueba** e "Iniciar corrida". El log aparece en vivo en el panel y en la consola.

Para cortarlo: `Ctrl+C` (si hay una corrida en curso, se cancela y se cierra
el navegador).

## 3. Dejarlo corriendo solo

El agente tiene que estar abierto para tomar las corridas del panel. Lo más
simple es que arranque solo al iniciar sesión.

**Windows** (Programador de tareas):

1. Abrir "Programador de tareas" → "Crear tarea…".
2. General: nombre `Agente Usina`; marcar "Ejecutar solo cuando el usuario haya iniciado sesión".
3. Desencadenadores: "Al iniciar la sesión".
4. Acciones: programa `cmd.exe`, argumentos
   `/c cd /d C:\ruta\a\mapa-delito-usina && node --import tsx scripts\pipeline\agente-local.ts >> agente.log 2>&1`
5. Condiciones: desmarcar "Iniciar la tarea solo si el equipo está conectado a la corriente alterna" si es una notebook.
6. Configuración: marcar "Si la tarea ya se está ejecutando: no iniciar una nueva instancia".

**macOS** (launchd): crear `~/Library/LaunchAgents/org.usina.agente.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>org.usina.agente</string>
  <key>WorkingDirectory</key><string>/ruta/a/mapa-delito-usina</string>
  <key>ProgramArguments</key><array>
    <string>/usr/local/bin/node</string><string>--import</string><string>tsx</string>
    <string>scripts/pipeline/agente-local.ts</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/ruta/a/mapa-delito-usina/agente.log</string>
  <key>StandardErrorPath</key><string>/ruta/a/mapa-delito-usina/agente.log</string>
</dict></plist>
```

y activarlo con `launchctl load ~/Library/LaunchAgents/org.usina.agente.plist`
(la ruta de `node` sale de `which node`).

**Linux** (systemd de usuario): `~/.config/systemd/user/agente-usina.service`:

```ini
[Unit]
Description=Agente local del pipeline de Usina
After=network-online.target

[Service]
WorkingDirectory=/ruta/a/mapa-delito-usina
ExecStart=/usr/bin/node --import tsx scripts/pipeline/agente-local.ts
Restart=on-failure

[Install]
WantedBy=default.target
```

`systemctl --user enable --now agente-usina`.

> Para un servicio conviene `node --import tsx …` en lugar de `npm run agente`:
> es un solo proceso, y la señal de apagado del sistema le llega directo (a
> través de `npm`/`npx` no siempre se reenvía).

**Si no querés dejarlo abierto**: `npm run agente -- --una-vez` procesa lo que
haya en la cola (y la programada del día si ya pasó la hora) y termina. Se
puede agendar así con el programador de tareas, pero entonces las corridas del
panel esperan hasta la próxima ejecución.

## 4. Configuración (`.env`)

| Variable | Default | Para qué |
|---|---|---|
| `PIPELINE_AGENTE_NOMBRE` | nombre de la computadora | Cómo aparece en el panel |
| `PIPELINE_AGENTE_HORA` | `07:00` | Hora de la corrida diaria (hora argentina). `no` = sin programada |
| `PIPELINE_AGENTE_INTERVALO_S` | `15` | Cada cuántos segundos mira la cola |
| `PIPELINE_MAX_NOTICIAS` | `10` | Notas por medio en la programada (el panel elige las suyas) |
| `PIPELINE_SNAPSHOT_MAX_CHARS` | `10000` | Cuánto de cada portada ve el LLM |
| `PIPELINE_PERFIL_MODELO` | `economico` | `economico` · `preciso` · `openrouter` · `local` |
| `PIPELINE_PERFIL_RESPALDO` | `openrouter` si hay `OPENROUTER_API_KEY` | A qué perfil caer si el principal no responde |
| `PIPELINE_LLM_RAZONAMIENTO` | (vacío) | `bajo`/`desactivado` acelera mucho a deepseek-v4-flash; ver abajo |
| `AGENT_BROWSER_HEADED` | `false` | `true` muestra el navegador mientras trabaja |

**Sobre `PIPELINE_LLM_RAZONAMIENTO`**: `deepseek-v4-flash` "piensa" por defecto
con esfuerzo alto; en la corrida del 6/9 una sola identificación llegó a 13.190
tokens y 6 minutos. Con `bajo` debería bajar mucho el tiempo de cada corrida.
Es opcional porque no se pudo probar contra OpenCode Go sin la key: si el
proveedor no acepta el parámetro, el pipeline lo detecta en la verificación
inicial y sigue sin él (queda anotado en el log).

## 5. Qué pasa si…

- **La computadora estaba apagada a las 7**: el agente hace la programada al
  encenderse. Si a las 12 todavía no se hizo, la hace GitHub Actions.
- **Se apaga o se suspende a mitad de una corrida**: el panel la marca "sin
  señal del agente" a los 10 minutos; al volver a arrancar, el agente la cierra
  como fallida. Lo que ya se había guardado queda guardado.
- **Cancelo desde el panel**: el agente corta la corrida en unos segundos y
  cierra el navegador.
- **El proveedor LLM rechaza las llamadas** (como el 400 de `x-opencode-session`
  del 7 al 24/9): la corrida falla en segundos con el mensaje exacto del
  proveedor, en rojo en el panel y en Actions. Si hay perfil de respaldo con
  credenciales, sigue con ese.
- **Hay dos agentes** (dos computadoras): no se pisan. Cada corrida la toma
  uno solo y la programada del día se hace una sola vez.

## 6. Límites conocidos

- OpenCode Go está pensado para "agentes de programación". El pipeline manda el
  header y el user agent que Go pide, pero su tráfico no es de un agente de
  programación: si Go endurece el control, podría bloquearlo. Conviene tener
  cargado `OPENROUTER_API_KEY` como respaldo.
- El agente ejecuta una corrida por vez. Las demás esperan en la cola (máximo 5).
