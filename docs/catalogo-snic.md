# Catálogo de tipos de delito del SNIC

> Generado por `scripts/ingesta/auditar-catalogo-snic.py`.
> **No editar a mano**: los cambios se pierden en la próxima corrida.
> Para regenerarlo: `python scripts/ingesta/auditar-catalogo-snic.py`

El código SNIC de cada delito vive en cuatro lugares que tienen que decir
lo mismo. Cuando se desalinean no falla nada a la vista: los hechos se
guardan con el tipo equivocado, o se descartan en silencio.

## Estado

⚠️ **El CSV oficial no estaba disponible en esta corrida.** La comparación
contra la fuente oficial quedó pendiente; lo que sigue compara únicamente
`seed.ts`, el prompt del LLM y la whitelist del pipeline entre sí.

Para completarla, conseguí el CSV en `data/snic/snic-departamentos-anual.csv` y volvé a correr el script.

## Catálogo cargado en la base (`prisma/seed.ts`)

33 tipos de delito.

| Código | Nombre |
|---|---|
| 0 | Muerte violenta en investigación |
| 1 | Homicidios dolosos |
| 2 | Homicidios dolosos en grado de tentativa |
| 3 | Muertes en siniestros viales |
| 4 | Homicidios culposos por otros hechos |
| 5 | Lesiones dolosas |
| 6 | Lesiones culposas en siniestros viales |
| 7 | Lesiones culposas por otros hechos |
| 8 | Otros delitos contra las personas |
| 9 | Delitos contra el honor |
| 10 | Violaciones |
| 11 | Otros delitos contra la integridad sexual |
| 12 | Delitos contra el estado civil |
| 13 | Amenazas |
| 14 | Otros delitos contra la libertad |
| 15 | Robos |
| 16 | Tentativas de robo |
| 17 | Robos agravados por resultado de lesiones y/o muertes |
| 18 | Tentativas de robo agravado por resultado de lesiones y/o muertes |
| 19 | Hurtos |
| 20 | Tentativas de hurto |
| 21 | Otros delitos contra la propiedad |
| 22 | Delitos contra la seguridad pública |
| 23 | Delitos contra el orden público |
| 24 | Delitos contra la seguridad de la nación |
| 25 | Delitos contra los poderes públicos y el orden constitucional |
| 26 | Delitos contra la administración pública |
| 27 | Delitos contra la fe pública |
| 28 | Ley 23.737 (estupefacientes) |
| 29 | Otros delitos previstos en leyes especiales |
| 30 | Otros delitos s/seguridad pública |
| 31 | Suicidios consumados |
| 32 | Delitos s/Leyes Especiales |

## Vocabulario que el pipeline le ofrece al LLM

Solo un subconjunto: el pipeline busca homicidios, no todo el catálogo.

| Código | En el prompt | En SNIC_DESCRIPCION | En el catálogo |
|---|---|---|---|
| 0 | Muerte violenta en investigación | Muerte violenta en investigación | Muerte violenta en investigación |
| 1 | Homicidios dolosos | Homicidios dolosos | Homicidios dolosos |
| 2 | Homicidios dolosos en grado de tentativa | Homicidios dolosos en grado de tentativa | Homicidios dolosos en grado de tentativa |
| 3 | Muertes en siniestros viales | Muertes en siniestros viales | Muertes en siniestros viales |
| 4 | Homicidios culposos por otros hechos | Homicidios culposos por otros hechos | Homicidios culposos por otros hechos |

Códigos que el pipeline acepta al guardar: 0, 1, 2, 3, 4.
