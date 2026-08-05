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

## Decision sobre el incidente

El repositorio permanece publico y no se reescribe su historial. La rotacion es
el control de contencion: las credenciales presentes en el historial deben seguir
revocadas y nunca se deben reactivar ni reutilizar.
