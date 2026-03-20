// scripts/ingest-lgt-completa.ts
// =====================================================================
// INGESTA COMPLETA — Ley 58/2003 General Tributaria
// Chunking por artículos con metadatos enriquecidos
// Ejecutar con: npx tsx scripts/ingest-lgt-completa.ts
// =====================================================================
// Alineado con ingest-ley-articulos.ts (mismo patrón de parser,
// embeddings, limpieza, metadatos y estructura de inserción)
// =====================================================================

import fs from 'fs'
import path from 'path'
import { createClient } from '@supabase/supabase-js'
import OpenAI from 'openai'

// ============================================
// CONFIGURACIÓN
// ============================================

const CORPUS_DIR = path.join(process.cwd(), 'corpus')

const DOCUMENT = {
  file: 'ley_58_2003_general_tributaria.pdf',
  source_type: 'lgt',
  source_label: 'Ley 58/2003 General Tributaria',
  source_file_label: 'ley_58_2003_general_tributaria.pdf',
  priority_articles: [66, 67, 68, 69, 70, 93, 99, 100, 101, 102, 103, 104, 141, 142, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153, 154, 155, 156, 157, 158, 159, 191, 192, 193, 194, 195, 196, 197, 198, 199, 200, 201, 202, 203, 204, 205, 206],
}

const MAX_CHUNK_CHARS = 2000
const MIN_CHUNK_CHARS = 100
const SUB_CHUNK_TARGET = 1500
const CHUNK_OVERLAP_CHARS = 150
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
    .replace(/Página \d+/g, '')
    .replace(/BOLETÍN OFICIAL DEL ESTADO/g, '')
    .replace(/LEGISLACIÓN CONSOLIDADA/g, '')
    .trim()
}

// ============================================
// PARSER INTELIGENTE POR ARTÍCULOS
// ============================================

interface ArticleChunk {
  content: string
  article_number: number | null
  article_variant: string | null
  article_title: string | null
  chapter: string | null
  titulo: string | null
  chunk_part: number
  chunk_total: number
  is_preamble: boolean
  is_index: boolean
}

function isIndexContent(text: string): boolean {
  const dotLines = (text.match(/\.{5,}/g) || []).length
  const totalLines = text.split('\n').length
  return dotLines > 3 && (dotLines / totalLines) > 0.2
}

function isPreambleContent(text: string): boolean {
  const markers = ['EXPOSICIÓN DE MOTIVOS', 'PREÁMBULO', 'exposición de motivos', 'preámbulo']
  return markers.some(m => text.includes(m))
}

function detectChapterAndTitulo(textBefore: string): { chapter: string | null; titulo: string | null } {
  let chapter: string | null = null
  let titulo: string | null = null

  const tituloMatches = [...textBefore.matchAll(/T[ÍI]TULO\s+([IVXLC]+)/gi)]
  if (tituloMatches.length > 0) {
    titulo = `Título ${tituloMatches[tituloMatches.length - 1][1].toUpperCase()}`
  }

  const chapMatches = [...textBefore.matchAll(/CAP[ÍI]TULO\s+([IVXLC]+)/gi)]
  if (chapMatches.length > 0) {
    chapter = `Capítulo ${chapMatches[chapMatches.length - 1][1].toUpperCase()}`
  }

  return { chapter, titulo }
}

function parseArticles(fullText: string): ArticleChunk[] {
  const chunks: ArticleChunk[] = []

  // Regex soporta artículos bis/ter/quáter de la LGT
  const articleRegex = /(?:^|\n)\s*Art[íi]culo\s+(\d+)\s*(bis|ter|qu[aá]ter)?\s*\.\s*([^\n]*)/gi

  const matches: { index: number; number: number; variant: string | null; title: string }[] = []
  let match: RegExpExecArray | null

  while ((match = articleRegex.exec(fullText)) !== null) {
    matches.push({
      index: match.index,
      number: parseInt(match[1]),
      variant: match[2] ? match[2].trim().toLowerCase() : null,
      title: match[3].trim().replace(/\.$/, ''),
    })
  }

  // Deduplicar
  const seen = new Set<string>()
  const uniqueMatches = matches.filter(m => {
    const key = `${m.number}${m.variant || ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  console.log(`   📋 Detectados ${uniqueMatches.length} artículos en el texto`)

  if (uniqueMatches.length === 0) {
    console.log('   ⚠️  No se detectaron artículos — usando chunking genérico como fallback')
    return fallbackChunking(fullText)
  }

  // Texto antes del primer artículo
  const textBeforeFirstArticle = fullText.slice(0, uniqueMatches[0].index)
  if (textBeforeFirstArticle.trim().length > MIN_CHUNK_CHARS) {
    if (isIndexContent(textBeforeFirstArticle)) {
      console.log('   🗑️  Índice/sumario detectado — EXCLUIDO del corpus')
    }
    if (isPreambleContent(textBeforeFirstArticle)) {
      const preambleText = textBeforeFirstArticle
        .split(/(?=EXPOSICIÓN DE MOTIVOS|PREÁMBULO)/i)
        .filter(t => isPreambleContent(t) || (!isIndexContent(t) && t.trim().length > MIN_CHUNK_CHARS))
        .join('\n\n')

      if (preambleText.trim().length > MIN_CHUNK_CHARS) {
        const preambleChunks = subdivideText(preambleText, 'Preámbulo')
        for (let i = 0; i < preambleChunks.length; i++) {
          chunks.push({
            content: preambleChunks[i],
            article_number: null,
            article_variant: null,
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
  for (let i = 0; i < uniqueMatches.length; i++) {
    const current = uniqueMatches[i]
    const nextIndex = i + 1 < uniqueMatches.length ? uniqueMatches[i + 1].index : fullText.length

    let articleText = fullText.slice(current.index, nextIndex).trim()

    if (articleText.length < MIN_CHUNK_CHARS) {
      console.log(`   ⏭️  Art. ${current.number}${current.variant || ''} — muy corto (${articleText.length} chars), incluido como chunk único`)
    }

    const textBefore = fullText.slice(0, current.index)
    const { chapter, titulo } = detectChapterAndTitulo(textBefore)

    const artLabel = current.variant
      ? `Artículo ${current.number} ${current.variant}`
      : `Artículo ${current.number}`

    const contextHeader = [
      titulo ? `[${titulo}]` : null,
      chapter ? `[${chapter}]` : null,
      `${artLabel}. ${current.title}`,
    ].filter(Boolean).join(' · ')

    if (articleText.length <= MAX_CHUNK_CHARS) {
      chunks.push({
        content: `--- ${contextHeader} ---\n\n${articleText}`,
        article_number: current.number,
        article_variant: current.variant,
        article_title: current.title || null,
        chapter,
        titulo,
        chunk_part: 1,
        chunk_total: 1,
        is_preamble: false,
        is_index: false,
      })
    } else {
      const subChunks = subdivideArticle(articleText, contextHeader)
      for (let j = 0; j < subChunks.length; j++) {
        chunks.push({
          content: `--- ${contextHeader} (parte ${j + 1}/${subChunks.length}) ---\n\n${subChunks[j]}`,
          article_number: current.number,
          article_variant: current.variant,
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

function subdivideArticle(text: string, contextHeader: string): string[] {
  const parts: string[] = []
  const apartadoRegex = /(?=\n\s*\d+\.\s)/g
  const apartadoSplits = text.split(apartadoRegex).filter(t => t.trim().length > 0)

  if (apartadoSplits.length > 1) {
    let currentPart = ''
    for (const apartado of apartadoSplits) {
      if (currentPart.length + apartado.length > SUB_CHUNK_TARGET && currentPart.length > MIN_CHUNK_CHARS) {
        parts.push(currentPart.trim())
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

  if (parts.length <= 1) {
    return subdivideText(text, contextHeader)
  }
  return parts
}

function subdivideText(text: string, label: string): string[] {
  const parts: string[] = []
  let start = 0

  while (start < text.length) {
    let end = start + SUB_CHUNK_TARGET
    if (end < text.length) {
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

function fallbackChunking(text: string): ArticleChunk[] {
  const textChunks = subdivideText(text, 'LGT')
  return textChunks.map((content, i) => ({
    content,
    article_number: null,
    article_variant: null,
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
  console.log('🚀 INGESTA COMPLETA — Ley 58/2003 General Tributaria')
  console.log('===================================================')
  console.log('  Modo: Chunking por artículos con metadatos enriquecidos')
  console.log('  Incluye: 282 artículos (LGT completa)')
  console.log('  Sirve para: Asistente PT + futuro Asistente Fiscal')
  console.log('===================================================\n')

  loadEnv()
  const { supabase, openai } = getClients()

  const doc = DOCUMENT
  const filePath = path.join(CORPUS_DIR, doc.file)

  console.log(`📄 Procesando: ${doc.file}`)
  console.log(`   Tipo: ${doc.source_type} (${doc.source_label})`)

  if (!fs.existsSync(filePath)) {
    console.error(`   ❌ Archivo no encontrado: ${filePath}`)
    console.error(`   💡 Copia el PDF a la carpeta: ${CORPUS_DIR}`)
    console.error(`   cp ~/Downloads/BOE-A-2003-23186-consolidado.pdf ${CORPUS_DIR}/`)
    process.exit(1)
  }

  // ── PASO 1: Borrar chunks viejos de LGT ──
  console.log(`   🗑️  Borrando chunks anteriores de ${doc.source_type}...`)
  const { error: deleteError, count: deleteCount } = await supabase
    .from('documents')
    .delete({ count: 'exact' })
    .eq('source_type', doc.source_type)

  if (deleteError) {
    console.error(`   ❌ Error al borrar: ${deleteError.message}`)
    console.error('   ⚠️  ABORTANDO para evitar duplicados')
    process.exit(1)
  }
  console.log(`   ✅ ${deleteCount || 0} chunks anteriores eliminados`)

  // ── PASO 2: Extraer texto del PDF ──
  console.log('   📖 Extrayendo texto del PDF...')
  let rawText: string
  try {
    rawText = await extractTextFromPDF(filePath)
  } catch (err) {
    console.error(`   ❌ Error al leer PDF: ${err}`)
    process.exit(1)
  }
  const cleanedText = cleanText(rawText)
  console.log(`   ✅ Texto extraído: ${cleanedText.length} caracteres`)

  // ── PASO 3: Parsear artículos ──
  console.log('   🔍 Parseando artículos...')
  const articleChunks = parseArticles(cleanedText)

  const validChunks = articleChunks.filter(c => !c.is_index)
  console.log(`   ✅ ${validChunks.length} chunks válidos (${articleChunks.length - validChunks.length} descartados como índice)`)

  const uniqueArticles = new Set(validChunks.filter(c => c.article_number).map(c => `${c.article_number}${c.article_variant || ''}`))
  console.log(`   📋 Artículos únicos detectados: ${uniqueArticles.size}`)

  const found = doc.priority_articles.filter(a => uniqueArticles.has(String(a)))
  const missing = doc.priority_articles.filter(a => !uniqueArticles.has(String(a)))
  console.log(`   ✅ Artículos prioritarios PT encontrados: ${found.length}/${doc.priority_articles.length}`)
  if (missing.length > 0) {
    console.log(`   ⚠️  Artículos prioritarios NO encontrados: ${missing.join(', ')}`)
  }

  // ── PASO 4: Generar embeddings ──
  console.log('   🧠 Generando embeddings...')
  const texts = validChunks.map(c => c.content)
  let embeddings: number[][]
  try {
    embeddings = await generateEmbeddings(openai, texts)
  } catch (err) {
    console.error(`   ❌ Error al generar embeddings: ${err}`)
    process.exit(1)
  }

  // ── PASO 5: Insertar en Supabase ──
  console.log('   💾 Insertando en Supabase...')
  let insertedCount = 0
  let errorCount = 0

  for (let i = 0; i < validChunks.length; i++) {
    const chunk = validChunks[i]

    let title = doc.source_label
    if (chunk.article_number) {
      const artLabel = chunk.article_variant
        ? `Art. ${chunk.article_number} ${chunk.article_variant}`
        : `Art. ${chunk.article_number}`
      title += ` — ${artLabel}`
      if (chunk.article_title) title += `. ${chunk.article_title}`
      if (chunk.chunk_total > 1) title += ` (${chunk.chunk_part}/${chunk.chunk_total})`
    } else if (chunk.is_preamble) {
      title += ' — Preámbulo'
      if (chunk.chunk_total > 1) title += ` (${chunk.chunk_part}/${chunk.chunk_total})`
    }

    const sectionLabel = chunk.article_number
      ? (chunk.article_variant
          ? `Art. ${chunk.article_number} ${chunk.article_variant}`
          : `Art. ${chunk.article_number}`)
      : null

    const record = {
      source_file: doc.source_file_label,
      source_type: doc.source_type,
      title,
      content: chunk.content,
      chapter: chunk.chapter,
      section: sectionLabel,
      page_start: null,
      page_end: null,
      chunk_index: i,
      embedding: JSON.stringify(embeddings[i]),
    }

    const { error } = await supabase.from('documents').insert(record)

    if (error) {
      console.error(`   ❌ Error insertando chunk ${i}: ${error.message}`)
      errorCount++
    } else {
      insertedCount++
    }

    if ((i + 1) % 50 === 0) {
      console.log(`   📊 Progreso: ${insertedCount}/${validChunks.length} insertados`)
    }
  }

  // ============================================
  // RESUMEN
  // ============================================
  console.log('\n===================================================')
  console.log('📊 RESUMEN DE INGESTA — LGT Completa')
  console.log('===================================================')
  console.log(`   Chunks eliminados (viejos):  ${deleteCount || 0}`)
  console.log(`   Chunks insertados (nuevos):  ${insertedCount}`)
  console.log(`   Errores:                     ${errorCount}`)

  const { count } = await supabase
    .from('documents')
    .select('*', { count: 'exact', head: true })

  console.log(`   Total documentos en Supabase: ${count}`)
  console.log('\n✅ Ingesta LGT completada.')
  console.log('\n📌 SIGUIENTE PASO:')
  console.log("   Añadir 'lgt': 'Ley 58/2003 General Tributaria' al mapeo sourceLabel en route.ts")
}

main().catch(err => {
  console.error('❌ Error fatal:', err)
  process.exit(1)
})
