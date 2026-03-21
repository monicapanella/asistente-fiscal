# Guía de ejecución — Re-ingesta inteligente del corpus RAG
## Proyecto: Asistente Fiscal IA · Picas de la Rosa & Asociados
## Fecha: 19 marzo 2026

---

## ¿Qué vamos a hacer?

Reemplazar los chunks genéricos del corpus en Supabase por chunks inteligentes que respetan la estructura legal de los documentos. Esto mejora significativamente la precisión del RAG.

**Antes (chunking genérico):**
- 657 chunks de Ley IS — cortados cada 1.500 caracteres, incluyendo índice/sumario inútil
- 226 chunks de RD 634/2015 — sin detección real de artículos
- 1.796 chunks de Directrices OCDE — las 551 páginas completas sin filtrar

**Después (chunking inteligente):**
- Ley IS — un chunk por artículo, sin índice ni sumario, con metadatos de artículo/capítulo/título
- RD 634/2015 — igual, un chunk por artículo con metadatos
- Directrices OCDE — solo capítulos I–IV, VII y X, con detección de párrafos OCDE numerados

**Lo que NO se toca:**
- `modulo_casos_complejos_PT_v1.0.md` (13 chunks) — se mantiene tal cual

---

## Antes de empezar — Comprobaciones previas

### 1. Verificar que los PDFs están en la carpeta corpus/

Abre Terminal y ejecuta:

```bash
cd "/Users/monicarodriguez/Library/Mobile Documents/com~apple~CloudDocs/Aplicaciones MRP/asistente-fiscal"
ls -la corpus/
```

Debes ver estos archivos:
- `ley_27_2014_impuesto_sociedades.pdf`
- `rd_634_2015_reglamento_IS.pdf`
- `directrices_ocde_pt_2022.pdf`
- `modulo_casos_complejos_PT_v1.0.md`

> **Si no ves algún PDF:** cópialo a esa carpeta antes de continuar.

### 2. Verificar que estás en la rama correcta

```bash
git status
```

Si estás en `main`, crea una rama de feature:

```bash
git checkout -b feature/rag-chunking-inteligente
```

### 3. Hacer backup de los scripts actuales (por seguridad)

```bash
cp scripts/ingest-corpus.ts scripts/ingest-corpus.ts.backup
```

---

## PASO 1 — Copiar los scripts nuevos

Descarga los dos archivos desde Claude y cópialos a la carpeta `scripts/` de tu proyecto:

- `ingest-ley-articulos.ts` → `scripts/ingest-ley-articulos.ts`
- `ingest-ocde-capitulos.ts` → `scripts/ingest-ocde-capitulos.ts`

Puedes hacerlo arrastrándolos desde la carpeta de descargas, o por terminal:

```bash
cp ~/Downloads/ingest-ley-articulos.ts scripts/
cp ~/Downloads/ingest-ocde-capitulos.ts scripts/
```

Verifica que están:

```bash
ls scripts/ingest-*.ts
```

Debes ver:
```
scripts/ingest-corpus.ts          (el original — no lo borres)
scripts/ingest-corpus.ts.backup   (la copia de seguridad)
scripts/ingest-ley-articulos.ts   (NUEVO)
scripts/ingest-ocde-capitulos.ts  (NUEVO)
scripts/ingest-markdown.ts        (el de Markdown — no lo toques)
```

---

## PASO 2 — Ejecutar Script 1: Ley IS + RD 634/2015

Este script:
1. Borra los 657 chunks viejos de la Ley IS
2. Borra los 226 chunks viejos del RD 634/2015
3. Lee los mismos PDFs pero parseando por artículos
4. Genera embeddings nuevos
5. Inserta los chunks nuevos con metadatos enriquecidos

**Ejecutar:**

```bash
npx tsx scripts/ingest-ley-articulos.ts
```

**¿Qué debes ver?** El script muestra progreso en tiempo real:

```
🚀 RE-INGESTA INTELIGENTE — Ley IS + RD 634/2015
===================================================

📄 Procesando: ley_27_2014_impuesto_sociedades.pdf
   🗑️  Borrando chunks anteriores de ley...
   ✅ 657 chunks anteriores eliminados
   📖 Extrayendo texto del PDF...
   ✅ Texto extraído: XXXXX caracteres
   🔍 Parseando artículos...
   📋 Detectados XXX artículos en el texto
   🗑️  Índice/sumario detectado — EXCLUIDO del corpus
   ✅ XXX chunks válidos
   🧠 Generando embeddings...
   💾 Insertando en Supabase...
   ✅ XXX/XXX chunks insertados
```

**Tiempo estimado:** 3-8 minutos (depende de la velocidad de la API de OpenAI).

**Si hay error:**
- Si dice "Archivo no encontrado" → verifica que los PDFs están en `corpus/`
- Si dice "Faltan variables de entorno" → verifica que `.env.local` existe con las 5 variables
- Si hay error de rate limit de OpenAI → espera 1 minuto y vuelve a ejecutar (el script borra primero, así que es seguro re-ejecutar)

---

## PASO 3 — Ejecutar Script 2: Directrices OCDE

Este script:
1. Borra los 1.796 chunks viejos de las Directrices OCDE
2. Lee SOLO las páginas de los capítulos I–IV, VII y X
3. Detecta párrafos numerados OCDE como unidades semánticas
4. Genera embeddings nuevos
5. Inserta chunks con metadatos de capítulo y párrafo

**Ejecutar:**

```bash
npx tsx scripts/ingest-ocde-capitulos.ts
```

**¿Qué debes ver?**

```
🚀 RE-INGESTA SELECTIVA — Directrices OCDE PT 2022
=====================================================
  Capítulos: Prefacio/Glosario + I, II, III, IV, VII, X

🗑️  Borrando TODOS los chunks de Directrices OCDE...
✅ 1796 chunks anteriores eliminados

📖 Capítulo I: El principio de plena competencia
   📄 Extrayendo páginas 29–80...
   📋 Cap. I: XX párrafos numerados detectados
   ✅ XX chunks generados
   ...

📊 RESUMEN DE RE-INGESTA (Directrices OCDE)
=====================================================
   Chunks eliminados (viejos):    1796
   Chunks insertados (nuevos):    ~XXX
   📉 Reducción del corpus OCDE:  ~XX%
```

**Tiempo estimado:** 5-12 minutos.

---

## PASO 4 — Verificar en Supabase

Entra en Supabase → SQL Editor y ejecuta:

```sql
-- Conteo por fuente (confirmar la nueva distribución)
SELECT source_type, COUNT(*) as chunks 
FROM documents 
GROUP BY source_type 
ORDER BY chunks DESC;
```

**Lo que debes ver aproximadamente:**

| source_type | chunks |
|---|---|
| directrices_ocde | ~400-600 (antes: 1796) |
| ley | ~150-250 (antes: 657) |
| reglamento | ~80-150 (antes: 226) |
| modulo_casos_complejos | 13 (sin cambios) |

```sql
-- Verificar metadatos de la Ley IS (deben tener artículos)
SELECT title, section, chapter, LEFT(content, 80) as preview
FROM documents 
WHERE source_type = 'ley' AND section IS NOT NULL
ORDER BY section
LIMIT 10;
```

```sql
-- Verificar metadatos OCDE (deben tener capítulos y párrafos)
SELECT title, chapter, section, LEFT(content, 80) as preview
FROM documents 
WHERE source_type = 'directrices_ocde'
ORDER BY chapter, chunk_index
LIMIT 10;
```

```sql
-- Verificar que el Art. 18 LIS está bien ingestado
SELECT title, section, LEFT(content, 200) as preview
FROM documents 
WHERE source_type = 'ley' AND section = 'Art. 18';
```

---

## PASO 5 — Commit y deploy

Si todo se ve bien en Supabase:

```bash
git add scripts/ingest-ley-articulos.ts scripts/ingest-ocde-capitulos.ts
git commit -m "feat: scripts de re-ingesta inteligente — chunking por artículos y capítulos OCDE"
git push origin feature/rag-chunking-inteligente
```

> **Nota:** Los scripts de ingesta no afectan al deploy de la aplicación (no se ejecutan en producción). Pero es bueno tenerlos en el repo por si necesitas re-ejecutarlos en el futuro.

Después del push, puedes mergear a main cuando quieras (estos scripts no cambian el comportamiento de la app, solo el contenido de la base de datos).

---

## ¿Qué ha cambiado en el RAG después de esto?

**Para el usuario (Picas de la Rosa) no cambia nada visible** — la app sigue funcionando igual, misma URL, mismo chat.

**Lo que mejora por debajo:**

1. **Menos ruido:** Se eliminan ~1.200 chunks irrelevantes (índices, sumarios, capítulos OCDE no relevantes)
2. **Mejor contexto:** Cada chunk lleva un encabezado que dice exactamente de dónde viene (artículo, capítulo, párrafo)
3. **Respuestas más precisas:** Cuando el RAG recupera un chunk del Art. 18 LIS, el LLM sabe que es el Art. 18 — no tiene que adivinarlo
4. **Citas más fiables:** Los metadatos de `section` y `chapter` permiten generar citas más específicas

---

## Si algo sale mal — Cómo volver atrás

Los scripts originales (`ingest-corpus.ts` y `ingest-corpus.ts.backup`) siguen en su sitio. Para restaurar el corpus original:

```bash
# Borrar todo el contenido actual
# (cuidado: esto borra TODOS los documentos, incluido el módulo de casos complejos)

# Opción segura: borrar solo lo que hemos cambiado
# Ejecutar en Supabase SQL Editor:
DELETE FROM documents WHERE source_type IN ('ley', 'reglamento', 'directrices_ocde');

# Luego re-ejecutar el script original:
npx tsx scripts/ingest-corpus.ts
```
