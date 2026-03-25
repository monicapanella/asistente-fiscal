// scripts/ingest-ley-articulos.ts
// =====================================================================
// RE-INGESTA INTELIGENTE — Ley 27/2014 IS + RD 634/2015
// Chunking por artículos con metadatos enriquecidos
// Ejecutar con: npx tsx scripts/ingest-ley-articulos.ts
// =====================================================================

import fs from 'fs'
import path from 'path'
import { createClient } from '@supabase/supabase-js'
import OpenAI from 'openai'

// ============================================
// CONFIGURACIÓN
// ============================================

const CORPUS_DIR = path.join(process.cwd(), 'corpus')

const DOCUMENTS = [
  {
    file: 'ley_27_2014_impuesto_sociedades.pdf',
    source_type: 'ley',
    source_label: 'Ley 27/2014 IS',
    // Artículos especialmente relevantes para PT
    priority_articles: [18, 15, 16, 17, 19, 20, 21],
  },
  {
    file: 'rd_634_2015_reglamento_IS.pdf',
    source_type: 'reglamento',
    source_label: 'RD 634/2015 Reglamento IS',
    // Artículos de operaciones vinculadas y acuerdos previos
    priority_articles: [13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36],
  },
]

// Parámetros de chunking
const MAX_CHUNK_CHARS = 2000        // Máximo por chunk (~500 tokens)
const MIN_CHUNK_CHARS = 100         // Mínimo para considerar un chunk válido
const SUB_CHUNK_TARGET = 1500       // Tamaño objetivo al subdividir artículos largos
const CHUNK_OVERLAP_CHARS = 150     // Overlap al subdividir artículos largos
const EMBEDDING_MODEL = 'text-embedding-3-small'
const BATCH_SIZE = 20
const DELAY_BETWEEN_BATCHES = 1000

// ============================================
// CLIENTES
// ============================================

function loadEnv() {
  const envPath = path.join(process.cwd(), '.env.local')
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf-8')
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim()
      if (trimmed && !trimmed.startsWith('#')) {
        const eqIndex = trimmed.indexOf('=')
        if (eqIndex > 0) {
          const key = trimmed.slice(0, eqIndex)
          const value = trimmed.slice(eqIndex + 1)
          if (!process.env[key]) {
            process.env[key] = value
          }
        }
      }
    }
  }
}

function getClients() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const openaiKey = process.env.OPENAI_API_KEY

  if (!supabaseUrl || !supabaseKey || !openaiKey) {
    console.error('❌ Faltan variables de entorno:')
    if (!supabaseUrl) console.error('   - NEXT_PUBLIC_SUPABASE_URL')
    if (!supabaseKey) console.error('   - SUPABASE_SERVICE_ROLE_KEY')
    if (!openaiKey) console.error('   - OPENAI_API_KEY')
    process.exit(1)
  }

  return {
    supabase: createClient(supabaseUrl, supabaseKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    }),
    openai: new OpenAI({ apiKey: openaiKey }),
  }
}

// ============================================
// EXTRACCIÓN Y LIMPIEZA DE TEXTO
// ============================================

async function extractTextFromPDF(filePath: string): Promise<string> {
  const { PDFParse } = require('pdf-parse')
  const buffer = fs.readFileSync(filePath)
  const parser = new PDFParse({ data: new Uint8Array(buffer) })
  const result = await parser.getText()
  return result.text
}

function cleanText(text: string): string {
  return text
    .replace(/\n{3,}/g, '\n\n')
    .replace(/ {2,}/g, ' ')
    .replace(/[\x00-\x09\x0B\x0C\x0E-\x1F]/g, '')
    .trim()
}

// ============================================
// PARSER INTELIGENTE POR ARTÍCULOS
// ============================================

interface ArticleChunk {
  content: string
  article_number: number | null
  article_title: string | null
  chapter: string | null
  titulo: string | null
  chunk_part: number      // 1, 2, 3... si el artículo se subdivide
  chunk_total: number     // total de partes del artículo
  is_preamble: boolean    // true si es preámbulo/exposición de motivos
  is_index: boolean       // true si es índice/sumario
}

/**
 * Detecta si un bloque de texto es parte del índice/sumario del BOE.
 * El índice tiene muchos ". . . . ." y referencias a páginas.
 */
function isIndexContent(text: string): boolean {
  const dotLines = (text.match(/\.{5,}/g) || []).length
  const totalLines = text.split('\n').length
  // Si más del 30% de las líneas tienen puntos suspensivos, es índice
  return dotLines > 3 && (dotLines / totalLines) > 0.2
}

/**
 * Detecta si un bloque es preámbulo/exposición de motivos.
 * El preámbulo aparece antes del "Artículo 1" y contiene frases como
 * "EXPOSICIÓN DE MOTIVOS" o "PREÁMBULO".
 */
function isPreambleContent(text: string): boolean {
  const markers = [
    'EXPOSICIÓN DE MOTIVOS',
    'PREÁMBULO',
    'exposición de motivos',
    'preámbulo',
  ]
  return markers.some(m => text.includes(m))
}

/**
 * Detecta el capítulo y título vigentes a partir del contexto previo.
 */
function detectChapterAndTitulo(textBefore: string): { chapter: string | null; titulo: string | null } {
  let chapter: string | null = null
  let titulo: string | null = null

  // Buscar el último "TÍTULO X" antes de esta posición
  const tituloMatches = [...textBefore.matchAll(/T[ÍI]TULO\s+([IVXLC]+)/gi)]
  if (tituloMatches.length > 0) {
    titulo = `Título ${tituloMatches[tituloMatches.length - 1][1].toUpperCase()}`
  }

  // Buscar el último "CAPÍTULO X" antes de esta posición
  const chapMatches = [...textBefore.matchAll(/CAP[ÍI]TULO\s+([IVXLC]+)/gi)]
  if (chapMatches.length > 0) {
    chapter = `Capítulo ${chapMatches[chapMatches.length - 1][1].toUpperCase()}`
  }

  return { chapter, titulo }
}

/**
 * Parser principal: divide el texto de una ley en artículos.
 * Detecta patrones como "Artículo 18." o "Artículo 18. Operaciones vinculadas."
 */
function parseArticles(fullText: string, sourceType: string): ArticleChunk[] {
  const chunks: ArticleChunk[] = []

  // Regex para detectar inicio de artículos
  // Patrones BOE: "Artículo 18." o "Artículo 18. Título del artículo."
  // También: "Art. 18." (menos común en texto consolidado)
  const articleRegex = /(?:^|\n)\s*Art[íi]culo\s+(\d+)\s*\.\s*([^\n]*)/gi

  const matches: { index: number; number: number; title: string }[] = []
  let match: RegExpExecArray | null

  while ((match = articleRegex.exec(fullText)) !== null) {
    matches.push({
      index: match.index,
      number: parseInt(match[1]),
      title: match[2].trim().replace(/\.$/, ''),  // Quitar punto final del título
    })
  }

  console.log(`   📋 Detectados ${matches.length} artículos en el texto`)

  if (matches.length === 0) {
    // Fallback: si no se detectan artículos, usar chunking genérico
    console.log('   ⚠️  No se detectaron artículos — usando chunking genérico como fallback')
    return fallbackChunking(fullText, sourceType)
  }

  // Procesar texto ANTES del primer artículo (índice + preámbulo)
  const textBeforeFirstArticle = fullText.slice(0, matches[0].index)
  if (textBeforeFirstArticle.trim().length > MIN_CHUNK_CHARS) {
    // Dividir en secciones: índice vs preámbulo
    if (isIndexContent(textBeforeFirstArticle)) {
      console.log('   🗑️  Índice/sumario detectado — EXCLUIDO del corpus')
    }
    // Si hay preámbulo, incluirlo como chunk especial
    if (isPreambleContent(textBeforeFirstArticle)) {
      const preambleText = textBeforeFirstArticle
        .split(/(?=EXPOSICIÓN DE MOTIVOS|PREÁMBULO)/i)
        .filter(t => isPreambleContent(t) || (!isIndexContent(t) && t.trim().length > MIN_CHUNK_CHARS))
        .join('\n\n')

      if (preambleText.trim().length > MIN_CHUNK_CHARS) {
        // El preámbulo puede ser largo — subdividir si es necesario
        const preambleChunks = subdivideText(preambleText, 'Preámbulo')
        for (let i = 0; i < preambleChunks.length; i++) {
          chunks.push({
            content: preambleChunks[i],
            article_number: null,
            article_title: 'Preámbulo / Exposición de motivos',
            chapter: null,
            titulo: null,
            chunk_part: i + 1,
            chunk_total: preambleChunks.length,
            is_preamble: true,
            is_index: false,
          })
        }
        console.log(`   📝 Preámbulo incluido: ${preambleChunks.length} chunk(s)`)
      }
    }
  }

  // Procesar cada artículo
  for (let i = 0; i < matches.length; i++) {
    const current = matches[i]
    const nextIndex = i + 1 < matches.length ? matches[i + 1].index : fullText.length

    // Extraer el texto completo del artículo
    let articleText = fullText.slice(current.index, nextIndex).trim()

    // Si es muy corto, probablemente es un artículo derogado o vacío
    if (articleText.length < MIN_CHUNK_CHARS) {
      console.log(`   ⏭️  Art. ${current.number} — muy corto (${articleText.length} chars), incluido como chunk único`)
    }

    // Detectar capítulo y título del contexto previo
    const textBefore = fullText.slice(0, current.index)
    const { chapter, titulo } = detectChapterAndTitulo(textBefore)

    // Añadir encabezado de contexto al contenido del chunk
    const contextHeader = [
      titulo ? `[${titulo}]` : null,
      chapter ? `[${chapter}]` : null,
      `Artículo ${current.number}. ${current.title}`,
    ].filter(Boolean).join(' · ')

    // Si el artículo cabe en un solo chunk
    if (articleText.length <= MAX_CHUNK_CHARS) {
      chunks.push({
        content: `--- ${contextHeader} ---\n\n${articleText}`,
        article_number: current.number,
        article_title: current.title || null,
        chapter,
        titulo,
        chunk_part: 1,
        chunk_total: 1,
        is_preamble: false,
        is_index: false,
      })
    } else {
      // Artículo largo: subdividir respetando apartados
      const subChunks = subdivideArticle(articleText, contextHeader)
      for (let j = 0; j < subChunks.length; j++) {
        chunks.push({
          content: `--- ${contextHeader} (parte ${j + 1}/${subChunks.length}) ---\n\n${subChunks[j]}`,
          article_number: current.number,
          article_title: current.title || null,
          chapter,
          titulo,
          chunk_part: j + 1,
          chunk_total: subChunks.length,
          is_preamble: false,
          is_index: false,
        })
      }
    }
  }

  return chunks
}

/**
 * Subdivide un artículo largo respetando la estructura de apartados.
 * Los apartados en leyes españolas siguen el patrón:
 * "1. ", "2. ", "a) ", "b) ", etc.
 */
function subdivideArticle(text: string, contextHeader: string): string[] {
  const parts: string[] = []

  // Intentar dividir por apartados numerados (1. , 2. , etc.)
  // El patrón busca números al inicio de línea seguidos de punto
  const apartadoRegex = /(?=\n\s*\d+\.\s)/g
  const apartadoSplits = text.split(apartadoRegex).filter(t => t.trim().length > 0)

  if (apartadoSplits.length > 1) {
    // Agrupar apartados hasta llenar un chunk
    let currentPart = ''
    for (const apartado of apartadoSplits) {
      if (currentPart.length + apartado.length > SUB_CHUNK_TARGET && currentPart.length > MIN_CHUNK_CHARS) {
        parts.push(currentPart.trim())
        // Overlap: incluir el inicio del apartado anterior para contexto
        const overlapText = currentPart.slice(-CHUNK_OVERLAP_CHARS)
        currentPart = overlapText + apartado
      } else {
        currentPart += apartado
      }
    }
    if (currentPart.trim().length > MIN_CHUNK_CHARS) {
      parts.push(currentPart.trim())
    }
  }

  // Si no se pudo dividir por apartados, dividir por párrafos
  if (parts.length <= 1) {
    return subdivideText(text, contextHeader)
  }

  return parts
}

/**
 * Subdivide texto genérico respetando párrafos.
 */
function subdivideText(text: string, label: string): string[] {
  const parts: string[] = []
  let start = 0

  while (start < text.length) {
    let end = start + SUB_CHUNK_TARGET

    if (end < text.length) {
      // Buscar punto de corte natural
      const lastParagraph = text.lastIndexOf('\n\n', end)
      if (lastParagraph > start + SUB_CHUNK_TARGET * 0.4) {
        end = lastParagraph
      } else {
        const lastSentence = text.lastIndexOf('. ', end)
        if (lastSentence > start + SUB_CHUNK_TARGET * 0.4) {
          end = lastSentence + 1
        }
      }
    } else {
      end = text.length
    }

    const part = text.slice(start, end).trim()
    if (part.length > MIN_CHUNK_CHARS) {
      parts.push(part)
    }

    start = end - CHUNK_OVERLAP_CHARS
    if (start < 0) start = 0
    if (end >= text.length) break
  }

  return parts.length > 0 ? parts : [text]
}

/**
 * Fallback: chunking genérico si no se detectan artículos.
 */
function fallbackChunking(text: string, sourceType: string): ArticleChunk[] {
  const textChunks = subdivideText(text, sourceType)
  return textChunks.map((content, i) => ({
    content,
    article_number: null,
    article_title: null,
    chapter: null,
    titulo: null,
    chunk_part: i + 1,
    chunk_total: textChunks.length,
    is_preamble: false,
    is_index: false,
  }))
}

// ============================================
// EMBEDDINGS
// ============================================

async function generateEmbeddings(openai: OpenAI, texts: string[]): Promise<number[][]> {
  const embeddings: number[][] = []

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE)
    console.log(`    📊 Embeddings ${i + 1}-${Math.min(i + BATCH_SIZE, texts.length)} de ${texts.length}...`)

    const response = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: batch,
    })

    for (const item of response.data) {
      embeddings.push(item.embedding)
    }

    if (i + BATCH_SIZE < texts.length) {
      await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES))
    }
  }

  return embeddings
}

// ============================================
// FUNCIÓN PRINCIPAL
// ============================================

async function main() {
  console.log('🚀 RE-INGESTA INTELIGENTE — Ley IS + RD 634/2015')
  console.log('===================================================')
  console.log('  Modo: Chunking por artículos con metadatos enriquecidos')
  console.log('  Acción: Borrar chunks viejos → Insertar nuevos')
  console.log('===================================================\n')

  loadEnv()
  const { supabase, openai } = getClients()

  let totalInserted = 0
  let totalDeleted = 0
  let totalErrors = 0

  for (const doc of DOCUMENTS) {
    const filePath = path.join(CORPUS_DIR, doc.file)

    console.log(`\n📄 Procesando: ${doc.file}`)
    console.log(`   Tipo: ${doc.source_type} (${doc.source_label})`)

    if (!fs.existsSync(filePath)) {
      console.error(`   ❌ Archivo no encontrado: ${filePath}`)
      console.error(`   💡 Verifica que el PDF está en la carpeta: ${CORPUS_DIR}`)
      totalErrors++
      continue
    }

    // ── PASO 1: Borrar chunks viejos de esta fuente ──
    console.log(`   🗑️  Borrando chunks anteriores de ${doc.source_type}...`)
    const { error: deleteError, count: deleteCount } = await supabase
      .from('documents')
      .delete({ count: 'exact' })
      .eq('source_file', doc.file)

    if (deleteError) {
      console.error(`   ❌ Error al borrar: ${deleteError.message}`)
      console.error('   ⚠️  ABORTANDO este documento para evitar duplicados')
      totalErrors++
      continue
    }
    console.log(`   ✅ ${deleteCount || 0} chunks anteriores eliminados`)
    totalDeleted += (deleteCount || 0)

    // ── PASO 2: Extraer texto del PDF ──
    console.log('   📖 Extrayendo texto del PDF...')
    let rawText: string
    try {
      rawText = await extractTextFromPDF(filePath)
    } catch (err) {
      console.error(`   ❌ Error al leer PDF: ${err}`)
      totalErrors++
      continue
    }
    const cleanedText = cleanText(rawText)
    console.log(`   ✅ Texto extraído: ${cleanedText.length} caracteres`)

    // ── PASO 3: Parsear artículos ──
    console.log('   🔍 Parseando artículos...')
    const articleChunks = parseArticles(cleanedText, doc.source_type)

    // Excluir chunks de índice
    const validChunks = articleChunks.filter(c => !c.is_index)
    console.log(`   ✅ ${validChunks.length} chunks válidos (${articleChunks.length - validChunks.length} descartados como índice)`)

    // Estadísticas de artículos detectados
    const uniqueArticles = new Set(validChunks.filter(c => c.article_number).map(c => c.article_number))
    console.log(`   📋 Artículos únicos detectados: ${uniqueArticles.size}`)

    if (doc.priority_articles) {
      const found = doc.priority_articles.filter(a => uniqueArticles.has(a))
      const missing = doc.priority_articles.filter(a => !uniqueArticles.has(a))
      console.log(`   ✅ Artículos prioritarios encontrados: ${found.join(', ')}`)
      if (missing.length > 0) {
        console.log(`   ⚠️  Artículos prioritarios NO encontrados: ${missing.join(', ')}`)
      }
    }

    // ── PASO 4: Generar embeddings ──
    console.log('   🧠 Generando embeddings...')
    const texts = validChunks.map(c => c.content)
    let embeddings: number[][]
    try {
      embeddings = await generateEmbeddings(openai, texts)
    } catch (err) {
      console.error(`   ❌ Error al generar embeddings: ${err}`)
      totalErrors++
      continue
    }

    // ── PASO 5: Insertar en Supabase ──
    console.log('   💾 Insertando en Supabase...')
    let insertedCount = 0

    for (let i = 0; i < validChunks.length; i++) {
      const chunk = validChunks[i]

      // Construir título descriptivo
      let title = doc.source_label
      if (chunk.article_number) {
        title += ` — Art. ${chunk.article_number}`
        if (chunk.article_title) title += `. ${chunk.article_title}`
        if (chunk.chunk_total > 1) title += ` (${chunk.chunk_part}/${chunk.chunk_total})`
      } else if (chunk.is_preamble) {
        title += ' — Preámbulo'
        if (chunk.chunk_total > 1) title += ` (${chunk.chunk_part}/${chunk.chunk_total})`
      }

      const record = {
        source_file: doc.file,
        source_type: doc.source_type,
        title,
        content: chunk.content,
        chapter: chunk.chapter,
        section: chunk.article_number ? `Art. ${chunk.article_number}` : null,
        page_start: null,
        page_end: null,
        chunk_index: i,
        embedding: JSON.stringify(embeddings[i]),
      }

      const { error } = await supabase.from('documents').insert(record)

      if (error) {
        console.error(`   ❌ Error insertando chunk ${i}: ${error.message}`)
        totalErrors++
      } else {
        insertedCount++
      }
    }

    console.log(`   ✅ ${insertedCount}/${validChunks.length} chunks insertados`)
    totalInserted += insertedCount
  }

  // ============================================
  // RESUMEN
  // ============================================
  console.log('\n===================================================')
  console.log('📊 RESUMEN DE RE-INGESTA (Ley IS + RD 634/2015)')
  console.log('===================================================')
  console.log(`   Chunks eliminados (viejos):  ${totalDeleted}`)
  console.log(`   Chunks insertados (nuevos):  ${totalInserted}`)
  console.log(`   Errores:                     ${totalErrors}`)

  // Verificación final
  const { count } = await supabase
    .from('documents')
    .select('*', { count: 'exact', head: true })

  console.log(`   Total documentos en Supabase: ${count}`)
  console.log('\n✅ Re-ingesta de leyes completada.')
}

main().catch(err => {
  console.error('❌ Error fatal:', err)
  process.exit(1)
})
