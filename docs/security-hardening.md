# Refuerzo de seguridad

Este documento registra los controles permanentes y las mejoras posteriores a
la eliminacion de un `.env` real del control de versiones. Nunca debe contener
secretos, strings de conexion ni credenciales parcialmente censuradas.

## Controles permanentes

- Nunca commitear `.env` ni sus variantes por entorno. Mantener solo valores de
  ejemplo en `.env.example`.
- Tratar toda credencial commiteada en un repositorio publico como comprometida
  y rotarla antes de eliminar el archivo de Git.
- Ingresar secretos mediante prompts interactivos ocultos. No incluir valores en
  argumentos, historial, salida de procesos, issues ni chats.
- Revisar `git status` antes de cada push y confirmar que no haya archivos de
  entorno trackeados.
- En produccion usar `prisma migrate deploy`. Nunca ejecutar `prisma migrate dev`
  ni `prisma migrate reset` contra la base compartida.
- Validar el pipeline de medios con `pipeline:dry`. La ruta `/api/pipeline/run`
  inicia el pipeline en modo produccion y no es una prueba inocua.
- Los endpoints protegidos deben fallar si su secret no esta configurado. La
  salida interna de procesos queda en logs del servidor, no en respuestas HTTP.

## Mejoras planificadas

1. Reemplazar la conexion de propietario usada en runtime por un rol de minimo
   privilegio. Reservar el rol de migraciones para GitHub Actions mediante un
   secret separado, por ejemplo `MIGRATION_DATABASE_URL`.
2. Proteger `master`, exigiendo pull requests y checks exitosos antes del merge.
3. Habilitar secret scanning y push protection en GitHub para el repositorio
   publico.
4. Configurar limites de gasto, alertas de uso y una frecuencia documentada de
   rotacion para las credenciales de base de datos y proveedores LLM.
5. Fijar la version del package manager y usar un unico lockfile autoritativo en
   desarrollo y CI para no eludir accidentalmente controles de supply chain.
6. Auditar y actualizar las dependencias reportadas por `npm audit` sin usar
   actualizaciones forzadas que puedan introducir cambios incompatibles.
7. Serializar la promocion de hechos con coberturas concurrentes y agregar una
   prueba que ejecute dos inserciones simultaneas sobre el mismo hecho.
8. Hacer que una falla sistemica del proveedor LLM marque la corrida como fallida
   en lugar de producir un resumen exitoso con contadores en cero.
9. Coordinar migraciones y despliegue para que el codigo nuevo no reciba trafico
   antes de que el esquema requerido este aplicado.

## Vulnerabilidades de npm aceptadas (y por qué)

`npm audit --omit=dev --json` reporta hoy dos cadenas en severidad `high` (más
el aviso `moderate` de `next` que arrastra la de `postcss`). Ninguna de las dos
es explotable en producción: ambas requieren un insumo (CSS o config) que solo
el propio equipo controla, nunca un visitante del sitio.

| Cadena | Severidad | Dónde corre | Input | Por qué no es explotable en producción | Cuándo se cierra |
|---|---|---|---|---|---|
| `postcss@8.4.31`, copia interna de `next@15.5.25` | high | build time (`next build` procesa Tailwind + `globals.css`) | CSS propio del repo | Los CVE (GHSA-qx2v-qp2m-jg93 XSS en stringify; GHSA-6g55-p6wh-862q / GHSA-fxqj-rqcc-2cmp / GHSA-r28c-9q8g-f849 lectura de archivos vía `sourceMappingURL`) requieren CSS controlado por un atacante entrando al stringifier. Nadie externo mete CSS en nuestro build. | Migración a Next 16 (proyecto aparte, fuera de esta ronda) |
| `deepmerge-ts@7.1.5` vía `@prisma/config` vía `prisma` (CLI) | high | build/CI time (`prisma generate`, `prisma migrate`) — `@prisma/config` hace `await import("deepmerge-ts")` para mergear `prisma.config` | archivo de config propio | GHSA-ggr8-5vv4-36mx es stack exhaustion al mergear un objeto recursivo; el único input es nuestro propio config. `@prisma/client` (el runtime que corre en producción) no lo usa en absoluto. | No hay fix upstream: `@prisma/config` pinea `deepmerge-ts@7.1.5` exacto hasta la 7.10.0 (ya un major de Prisma). Se revisa en cada bump de Prisma. |

Notas:

- `sharp` **ya quedó resuelto**: el bump de `next` a `15.5.25` trajo
  `sharp@0.35.4` (verificado con `npm ls sharp`), que no tiene los CVE
  anteriores. No requiere ninguna acción más.
- `npm audit fix --force` propone bajar `prisma` a `6.12.0` para "resolver"
  `deepmerge-ts`. Es un artefacto del resolver de npm buscando cualquier árbol
  sin el aviso, no una solución real — **no hacerlo**: es un downgrade de
  major que no toca la causa (la CLI de Prisma sigue important-eando
  `deepmerge-ts` en versiones futuras también) y puede romper el schema o los
  comandos de migración.

## Decision sobre el incidente

El repositorio permanece publico y no se reescribe su historial. La rotacion es
el control de contencion: las credenciales presentes en el historial deben seguir
revocadas y nunca se deben reactivar ni reutilizar.
