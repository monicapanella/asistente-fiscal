// scripts/ingest-ocde-capitulos.ts
// =====================================================================
// RE-INGESTA SELECTIVA — Directrices OCDE PT 2022
// Lee PDFs individuales por capítulo (I–IV, VII, X)
// Ejecutar con: npx tsx scripts/ingest-ocde-capitulos.ts
// =====================================================================

import fs from 'fs'
import path from 'path'
import { createClient } from '@supabase/supabase-js'
import OpenAI from 'openai'

// ============================================
// CONFIGURACIÓN
// ============================================

const CORPUS_DIR = path.join(process.cwd(), 'corpus')
const CHAPTERS_DIR = CORPUS_DIR
const SOURCE_TYPE = 'directrices_ocde'
const SOURCE_LABEL = 'Directrices OCDE PT 2022'

// Capítulos a incluir — cada uno con su archivo PDF individual
const CHAPTERS = [
  {
    number: 1,
    roman: 'I',
    title: 'El principio de plena competencia',
    file: 'directrices ocde precios de transferencia 2022_extract cap I.pdf',
    description: 'Art. 9 MCOCDE, fundamento del arm\'s length principle',
  },
  {
    number: 2,
    roman: 'II',
    title: 'Métodos de precios de transferencia',
    file: 'directrices ocde precios de transferencia 2022_extract cap II.pdf',
    description: 'CUP, Precio de Reventa, Coste Incrementado, TNMM, Profit Split',
  },
  {
    number: 3,
    roman: 'III',
    title: 'Análisis de comparabilidad',
    file: 'directrices ocde precios de transferencia 2022_extract cap III.pdf',
    description: 'Factores de comparabilidad, ajustes, selección de comparables',
  },
  {
    number: 4,
    roman: 'IV',
    title: 'Procedimientos administrativos para evitar y resolver controversias',
    file: 'directrices ocde precios de transferencia 2022_extract cap IV.pdf',
    description: 'APAs, procedimientos amistosos (MAP), ajustes correlativos',
  },
  {
    number: 7,
    roman: 'VII',
    title: 'Consideraciones especiales aplicables a los servicios intragrupo',
    file: 'directrices ocde precios de transferencia 2022_extract cap VII.pdf',
    description: 'Servicios de bajo valor añadido, test de beneficio, duplicidades',
  },
  {
    number: 10,
    roman: 'X',
    title: 'Aspectos de precios de transferencia de las operaciones financieras',
    file: 'directrices ocde precios de transferencia 2022_extract cap X.pdf',
    description: 'Préstamos intragrupo, cash pooling, garantías, seguros cautivos',
  },
]

// Parámetros de chunking
const CHUNK_TARGET = 1800       // Caracteres objetivo por chunk (~450 tokens)
const CHUNK_MAX = 2200          // Máximo absoluto por chunk
const CHUNK_OVERLAP = 200       // Overlap entre chunks
const MIN_CHUNK_CHARS = 100     // Mínimo para considerar un chunk válido
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
// EXTRACCIÓN DE TEXTO
// ============================================

async function extractTextFromPDF(filePath: string): Promise<string> {
  const { PDFParse } = require('pdf-parse')
  const buffer = fs.readFileSync(filePath)
  const parser = new PDFParse({ data: new Uint8Array(buffer) })
  const result = await parser.getText()
  return result.text
}

/**
 * Limpieza de texto específica para las Directrices OCDE.
 */
function cleanOCDEText(text: string): string {
  return text
    // Eliminar headers/footers repetidos de la OCDE
    .replace(/DIRECTRICES DE LA OCDE APLICABLES EN MATERIA DE PRECIOS DE TRANSFERENCIA \d{4}\s*©.*?\n/gi, '')
    .replace(/DIRECTRICES DE LA OCDE.*?PRECIOS DE TRANSFERENCIA.*?\n/gi, '')
    .replace(/© OCDE \d{4}/g, '')
    .replace(/OECD TRANSFER PRICING GUIDELINES.*?\n/gi, '')
    // Eliminar números de página sueltos
    .replace(/^\s*\d{1,3}\s*$/gm, '')
    // Eliminar marcadores de página del PDF
    .replace(/--\s*\d+\s*of\s*\d+\s*--/g, '')
    .replace(/Página\s+\d+/g, '')
    // Eliminar líneas que son solo el título del capítulo repetido como header
    .replace(/^\s*Cap[íi]tulo\s+[IVXLC]+\.\s*$/gm, '')
    // Limpiar espacios
    .replace(/\n{3,}/g, '\n\n')
    .replace(/ {2,}/g, ' ')
    .replace(/[\x00-\x09\x0B\x0C\x0E-\x1F]/g, '')
    .trim()
}

// ============================================
// CHUNKING INTELIGENTE POR PÁRRAFOS OCDE
// ============================================

interface OCDEChunk {
  content: string
  chapter_number: number
  chapter_title: string
  chapter_roman: string
  paragraph_start: string | null
  paragraph_end: string | null
  chunk_index: number
}

/**
 * Detecta párrafos numerados de la OCDE (ej: "1.6", "10.147", "2.18")
 * y agrupa en chunks de tamaño adecuado.
 */
function parseOCDEParagraphs(text: string, chapter: typeof CHAPTERS[0]): OCDEChunk[] {
  const chunks: OCDEChunk[] = []

  // Los párrafos OCDE empiezan con número de capítulo.número de párrafo
  // Ej: "1.6 El principio de plena competencia..."
  // Ej: "10.147 En el caso de garantías financieras..."
  const paraRegex = /(?:^|\n)\s*(\d{1,2}\.\d{1,3})\s+/g

  const paragraphs: { index: number; number: string }[] = []
  let match: RegExpExecArray | null

  while ((match = paraRegex.exec(text)) !== null) {
    paragraphs.push({ index: match.index, number: match[1] })
  }

  if (paragraphs.length === 0) {
    console.log(`   ⚠️  Cap. ${chapter.roman}: sin párrafos numerados — chunking por tamaño`)
    return chunkBySize(text, chapter)
  }

  console.log(`   📋 Cap. ${chapter.roman}: ${paragraphs.length} párrafos numerados detectados`)

  // Texto antes del primer párrafo (introducción del capítulo)
  const textBeforeFirst = text.slice(0, paragraphs[0]?.index || 0).trim()
  let chunkIndex = 0

  if (textBeforeFirst.length > MIN_CHUNK_CHARS) {
    const contextHeader = `[Directrices OCDE 2022 · Capítulo ${chapter.roman}. ${chapter.title} · Introducción]`
    chunks.push({
      content: `${contextHeader}\n\n${textBeforeFirst}`,
      chapter_number: chapter.number,
      chapter_title: chapter.title,
      chapter_roman: chapter.roman,
      paragraph_start: null,
      paragraph_end: null,
      chunk_index: chunkIndex++,
    })
  }

  // Agrupar párrafos en chunks de tamaño adecuado
  let currentChunkText = ''
  let currentParaStart: string | null = null
  let currentParaEnd: string | null = null

  for (let i = 0; i < paragraphs.length; i++) {
    const para = paragraphs[i]
    const nextIndex = i + 1 < paragraphs.length ? paragraphs[i + 1].index : text.length
    const paraText = text.slice(para.index, nextIndex).trim()

    if (!currentParaStart) currentParaStart = para.number

    // ¿Cabe este párrafo en el chunk actual?
    if (currentChunkText.length + paraText.length > CHUNK_MAX && currentChunkText.length > MIN_CHUNK_CHARS) {
      // Guardar chunk actual
      const contextHeader = `[Directrices OCDE 2022 · Capítulo ${chapter.roman}. ${chapter.title} · Párrafos ${currentParaStart}–${currentParaEnd}]`
      chunks.push({
        content: `${contextHeader}\n\n${currentChunkText.trim()}`,
        chapter_number: chapter.number,
        chapter_title: chapter.title,
        chapter_roman: chapter.roman,
        paragraph_start: currentParaStart,
        paragraph_end: currentParaEnd,
        chunk_index: chunkIndex++,
      })

      // Empezar nuevo chunk con overlap
      const overlapText = currentChunkText.slice(-CHUNK_OVERLAP)
      currentChunkText = overlapText + '\n\n' + paraText
      currentParaStart = para.number
    } else {
      currentChunkText += (currentChunkText ? '\n\n' : '') + paraText
    }
    currentParaEnd = para.number
  }

  // Guardar último chunk
  if (currentChunkText.trim().length > MIN_CHUNK_CHARS) {
    const paraLabel = currentParaStart && currentParaEnd
      ? `Párrafos ${currentParaStart}–${currentParaEnd}`
      : 'Final del capítulo'
    const contextHeader = `[Directrices OCDE 2022 · Capítulo ${chapter.roman}. ${chapter.title} · ${paraLabel}]`
    chunks.push({
      content: `${contextHeader}\n\n${currentChunkText.trim()}`,
      chapter_number: chapter.number,
      chapter_title: chapter.title,
      chapter_roman: chapter.roman,
      paragraph_start: currentParaStart,
      paragraph_end: currentParaEnd,
      chunk_index: chunkIndex++,
    })
  }

  return chunks
}

/**
 * Chunking por tamaño con contexto de capítulo (fallback).
 */
function chunkBySize(text: string, chapter: typeof CHAPTERS[0]): OCDEChunk[] {
  const chunks: OCDEChunk[] = []
  let start = 0
  let index = 0

  while (start < text.length) {
    let end = start + CHUNK_TARGET

    if (end < text.length) {
      const lastParagraph = text.lastIndexOf('\n\n', end)
      if (lastParagraph > start + CHUNK_TARGET * 0.4) {
        end = lastParagraph
      } else {
        const lastSentence = text.lastIndexOf('. ', end)
        if (lastSentence > start + CHUNK_TARGET * 0.4) {
          end = lastSentence + 1
        }
      }
    } else {
      end = text.length
    }

    const content = text.slice(start, end).trim()
    if (content.length > MIN_CHUNK_CHARS) {
      const contextHeader = `[Directrices OCDE 2022 · Capítulo ${chapter.roman}. ${chapter.title}]`
      chunks.push({
        content: `${contextHeader}\n\n${content}`,
        chapter_number: chapter.number,
        chapter_title: chapter.title,
        chapter_roman: chapter.roman,
        paragraph_start: null,
        paragraph_end: null,
        chunk_index: index++,
      })
    }

    start = end - CHUNK_OVERLAP
    if (start < 0) start = 0
    if (end >= text.length) break
  }

  return chunks
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
  console.log('🚀 RE-INGESTA SELECTIVA — Directrices OCDE PT 2022')
  console.log('=====================================================')
  console.log('  Capítulos: I, II, III, IV, VII, X (PDFs individuales)')
  console.log('  Acción: Borrar TODOS los chunks OCDE → Insertar selectivamente')
  console.log('=====================================================\n')

  loadEnv()
  const { supabase, openai } = getClients()

  // Verificar que la carpeta de capítulos existe
  if (!fs.existsSync(CHAPTERS_DIR)) {
    console.error(`❌ Carpeta de capítulos no encontrada: ${CHAPTERS_DIR}`)
    process.exit(1)
  }

  // ── PASO 1: Borrar TODOS los chunks OCDE actuales ──
  console.log('🗑️  Borrando TODOS los chunks de Directrices OCDE...')
  const { error: deleteError, count: deleteCount } = await supabase
    .from('documents')
    .delete({ count: 'exact' })
    .eq('source_type', 'directrices_ocde')

  if (deleteError) {
    console.error(`❌ Error al borrar: ${deleteError.message}`)
    process.exit(1)
  }
  console.log(`✅ ${deleteCount || 0} chunks anteriores eliminados\n`)

  // ── PASO 2: Procesar cada capítulo ──
  let totalInserted = 0
  let totalChunks = 0
  let totalErrors = 0

  for (const chapter of CHAPTERS) {
    const filePath = path.join(CHAPTERS_DIR, chapter.file)

    console.log(`\n📖 Capítulo ${chapter.roman}: ${chapter.title}`)
    console.log(`   📁 ${chapter.file}`)
    console.log(`   ${chapter.description}`)

    if (!fs.existsSync(filePath)) {
      console.error(`   ❌ Archivo no encontrado: ${filePath}`)
      totalErrors++
      continue
    }

    // Extraer texto del PDF del capítulo
    console.log('   📄 Extrayendo texto...')
    let rawText: string
    try {
      rawText = await extractTextFromPDF(filePath)
    } catch (err) {
      console.error(`   ❌ Error al leer PDF: ${err}`)
      totalErrors++
      continue
    }

    const cleanedText = cleanOCDEText(rawText)
    console.log(`   ✅ Texto extraído: ${cleanedText.length} caracteres`)

    if (cleanedText.length < MIN_CHUNK_CHARS) {
      console.log(`   ⚠️  Texto insuficiente — capítulo omitido`)
      continue
    }

    // Parsear párrafos y crear chunks
    console.log('   ✂️  Parseando párrafos OCDE...')
    const chapterChunks = parseOCDEParagraphs(cleanedText, chapter)
    console.log(`   ✅ ${chapterChunks.length} chunks generados`)
    totalChunks += chapterChunks.length

    // Generar embeddings
    console.log('   🧠 Generando embeddings...')
    const texts = chapterChunks.map(c => c.content)
    let embeddings: number[][]
    try {
      embeddings = await generateEmbeddings(openai, texts)
    } catch (err) {
      console.error(`   ❌ Error al generar embeddings: ${err}`)
      totalErrors++
      continue
    }

    // Insertar en Supabase
    console.log('   💾 Insertando en Supabase...')
    let insertedCount = 0

    for (let i = 0; i < chapterChunks.length; i++) {
      const chunk = chapterChunks[i]

      let title = `${SOURCE_LABEL} — Cap. ${chunk.chapter_roman}. ${chunk.chapter_title}`
      if (chunk.paragraph_start && chunk.paragraph_end) {
        title += ` (§${chunk.paragraph_start}–${chunk.paragraph_end})`
      }

      let section: string | null = null
      if (chunk.paragraph_start && chunk.paragraph_end) {
        section = `§${chunk.paragraph_start}–${chunk.paragraph_end}`
      }

      const record = {
        source_file: chapter.file,
        source_type: SOURCE_TYPE,
        title,
        content: chunk.content,
        chapter: `Capítulo ${chunk.chapter_roman}`,
        section,
        page_start: null,
        page_end: null,
        chunk_index: chunk.chunk_index,
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

    console.log(`   ✅ ${insertedCount}/${chapterChunks.length} chunks insertados`)
    totalInserted += insertedCount
  }

  // ============================================
  // RESUMEN
  // ============================================
  console.log('\n=====================================================')
  console.log('📊 RESUMEN DE RE-INGESTA (Directrices OCDE)')
  console.log('=====================================================')
  console.log(`   Chunks eliminados (viejos):    ${deleteCount || 0}`)
  console.log(`   Capítulos procesados:          ${CHAPTERS.length}`)
  console.log(`   Chunks generados (nuevos):     ${totalChunks}`)
  console.log(`   Chunks insertados con éxito:   ${totalInserted}`)
  console.log(`   Errores:                       ${totalErrors}`)

  if (deleteCount && deleteCount > totalInserted) {
    const reduction = Math.round((1 - totalInserted / deleteCount) * 100)
    console.log(`   📉 Reducción del corpus OCDE:  ~${reduction}% (${deleteCount} → ${totalInserted} chunks)`)
  }

  const { count } = await supabase
    .from('documents')
    .select('*', { count: 'exact', head: true })

  console.log(`\n   📦 Total documentos en Supabase: ${count}`)
  console.log('\n✅ Re-ingesta de Directrices OCDE completada.')
  console.log('💡 Verificar en Supabase con:')
  console.log("   SELECT chapter, COUNT(*) FROM documents WHERE source_type = 'directrices_ocde' GROUP BY chapter ORDER BY chapter;")
}

main().catch(err => {
  console.error('❌ Error fatal:', err)
  process.exit(1)
})
