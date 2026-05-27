CREATE TABLE IF NOT EXISTS revisiones_pipeline (
  id SERIAL PRIMARY KEY,
  hecho_id INTEGER REFERENCES hechos_delictivos(id),
  url_fuente TEXT NOT NULL,
  titulo_noticia TEXT,
  texto_original TEXT,
  clasificacion_llm TEXT,
  confianza_llm INTEGER,
  clasificacion_humana TEXT CHECK (
    clasificacion_humana IN (
      'homicidio_doloso',
      'homicidio_en_ocasion_de_robo',
      'femicidio',
      'homicidio_vinculado_al_narcotrafico',
      'no_es_homicidio',
      'violencia_policial'
    )
  ),
  revisado_por TEXT,
  revisado_at TIMESTAMPTZ,
  notas TEXT,
  usar_como_ejemplo BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_revisiones_sin_revisar
ON revisiones_pipeline(hecho_id)
WHERE clasificacion_humana IS NULL;
