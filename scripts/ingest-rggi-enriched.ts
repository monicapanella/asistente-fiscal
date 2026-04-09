// scripts/ingest-rggi-enriched.ts
// =====================================================================
// RE-INGESTA ENRIQUECIDA — RD 1065/2007 RGGI
// Basado en ingest-ley-articulos.ts con context headers enriquecidos
// para mejorar el matching semántico de artículos clave.
//
// Ejecutar con: npx tsx scripts/ingest-rggi-enriched.ts
//
// Qué hace:
//   1. Borra los 579 chunks actuales del RGGI en Supabase
//   2. Re-parsea el PDF por artículos (mismo parser que ingest-ley-articulos.ts)
//   3. Añade keywords enriquecidos a artículos clave (42 bis, 42 ter, 54 bis, etc.)
//   4. Regenera embeddings con OpenAI
//   5. Inserta los nuevos chunks en Supabase
//
// Los artículos con keywords enriquecidos tendrán context headers como:
//   --- [Título III] · [Capítulo V] · Artículo 42 bis. [...]
//       KEYWORDS: modelo 720, declaración informativa, bienes extranjero,
//       cuentas financieras extranjero, obligación información ---
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
  file: 'rd_1065_2007_rggi.pdf',
  source_type: 'rggi',
  source_label: 'RD 1065/2007 RGGI',
}

// ============================================
// MAPA DE KEYWORDS ENRIQUECIDOS POR ARTÍCULO
// Estos keywords se añaden al context header del chunk
// para que el embedding capture términos de búsqueda
// que los usuarios usan pero que el texto legal no menciona
// literalmente (ej: "modelo 720" vs "declaración informativa
// sobre bienes y derechos situados en el extranjero").
// ============================================

const ARTICLE_KEYWORDS: Record<string, string[]> = {
  // --- MODELO 720 / BIENES EN EL EXTRANJERO ---
  '42 bis': [
    'modelo 720', 'declaración informativa bienes extranjero',
    'cuentas financieras extranjero', 'obligación información',
    'DA 18ª LGT', 'titularidad cuentas bancarias extranjero',
    'saldo medio', 'saldo a 31 diciembre',
  ],
  '42 ter': [
    'modelo 720', 'declaración informativa bienes extranjero',
    'valores derechos seguros rentas extranjero',
    'acciones participaciones fondos inversión extranjero',
    'seguros vida invalidez extranjero',
  ],
  '54 bis': [
    'modelo 720', 'declaración informativa bienes extranjero',
    'bienes inmuebles extranjero', 'derechos sobre inmuebles extranjero',
    'titularidad inmuebles situados extranjero',
  ],

  // --- PROCEDIMIENTOS DE GESTIÓN E INSPECCIÓN ---
  '93': [
    'requerimiento información', 'plazo requerimiento',
    'obligación información terceros', 'art. 93 LGT',
  ],
  '95': [
    'autorización entrada domicilio', 'inspección domicilio',
    'inviolabilidad domicilio',
  ],
  '97': [
    'censo obligados tributarios', 'declaración censal',
    'modelo 036', 'modelo 037', 'alta censo',
  ],

  // --- NOTIFICACIONES ---
  '114': [
    'notificaciones tributarias', 'lugar notificación',
    'notificación electrónica', 'notificación postal',
  ],
  '115': [
    'notificación electrónica obligatoria',
    'dirección electrónica habilitada', 'DEH',
    'notificaciones telemáticas', 'sede electrónica AEAT',
  ],

  // --- INSPECCIÓN ---
  '166': [
    'inicio actuaciones inspectoras', 'comunicación inicio inspección',
    'alcance actuaciones inspectoras', 'inspección parcial general',
  ],
  '171': [
    'plazo actuaciones inspectoras', 'duración inspección',
    'dilaciones no imputables', 'interrupción justificada',
    '18 meses', '27 meses', 'ampliación plazo inspección',
  ],
  '176': [
    'actas inspección', 'acta conformidad', 'acta disconformidad',
    'acta con acuerdo', 'firma acta inspección',
  ],
  '177': [
    'acta conformidad', 'reducción sanción conformidad 30%',
    'efectos acta conformidad',
  ],
  '178': [
    'acta disconformidad', 'alegaciones acta',
    'plazo alegaciones 15 días', 'trámite audiencia inspección',
  ],

  // --- RECAUDACIÓN ---
  '59': [
    'plazos pago período voluntario', 'pago deudas tributarias',
    'período voluntario recaudación', 'carta pago',
  ],
  '62': [
    'aplazamiento fraccionamiento', 'solicitud aplazamiento',
    'garantías aplazamiento', 'interés demora aplazamiento',
  ],

  // --- COMPROBACIÓN LIMITADA ---
  '136': [
    'comprobación limitada', 'inicio comprobación limitada',
    'alcance comprobación limitada', 'propuesta liquidación',
  ],
  '137': [
    'comprobación limitada', 'resolución comprobación limitada',
    'alegaciones comprobación limitada', 'plazo resolución',
  ],

  // --- MODELO 232 (operaciones vinculadas) ---
  '13': [
    'modelo 232', 'declaración informativa operaciones vinculadas',
    'obligación documentación operaciones vinculadas',
    'umbral 250.000 euros',
  ],
  '14': [
    'modelo 232', 'contenido declaración operaciones vinculadas',
    'operaciones con paraísos fiscales',
  ],

  // --- MODELO 721 (criptomonedas extranjero) ---
  '42 quáter': [
    'modelo 721', 'criptomonedas extranjero', 'monedas virtuales',
    'declaración informativa criptoactivos', 'custodia criptomonedas',
  ],
}

// Función para buscar keywords por article_id (soporta "42", "42 bis", etc.)
function getKeywordsForArticle(articleId: string, variant: string | null): string[] {
  // Buscar con variante: "42 bis"
  if (variant) {
    const keyWithVariant = `${articleId} ${variant}`
    if (ARTICLE_KEYWORDS[keyWithVariant]) return ARTICLE_KEYWORDS[keyWithVariant]
  }
  // Buscar sin variante: "42"
  if (ARTICLE_KEYWORDS[articleId]) return ARTICLE_KEYWORDS[articleId]
  return []
}

// Parámetros de chunking (idénticos a ingest-ley-articulos.ts)
const MAX_CHUNK_CHARS = 2000
const MIN_CHUNK_CHARS = 100
const SUB_CHUNK_TARGET = 1500
const CHUNK_OVERLAP_CHARS = 150
const EMBEDDING_MODEL = 'text-embedding-3-small'
const BATCH_SIZE = 20
const DELAY_BETWEEN_BATCHES = 1000

// ============================================
// CLIENTES (idéntico a ingest-ley-articulos.ts)
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
    .replace(/LEGISLACIÓN CONSOLIDADA/g, '')
    .replace(/BOLETÍN OFICIAL DEL ESTADO/g, '')
    .replace(/Página \d+ de \d+/g, '')
    .replace(/cve: BOE-A-\d+-\d+/g, '')
    .replace(/Verificable en https?:\/\/www\.boe\.es/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/ {2,}/g, ' ')
    .replace(/[\x00-\x09\x0B\x0C\x0E-\x1F]/g, '')
    .trim()
}

// ============================================
// PARSER POR ARTÍCULOS (idéntico a ingest-ley-articulos.ts)
// ============================================

interface ArticleChunk {
  content: string
  article_number: number | null
  article_id: string | null
  article_variant: string | null
  article_title: string | null
  chapter: string | null
  titulo: string | null
  chunk_part: number
  chunk_total: number
  is_preamble: boolean
  is_index: boolean
  enriched_keywords: string[]   // <-- NUEVO: keywords enriquecidos
}

function isIndexContent(text: string): boolean {
  const dotLines = (text.match(/\.{5,}/g) || []).length
  const totalLines = text.split('\n').length
  return dotLines > 3 && (dotLines / totalLines) > 0.2
}

function detectChapterAndTitulo(textBefore: string): { chapter: string | null; titulo: string | null } {
  let chapter: string | null = null
  let titulo: string | null = null

  const tituloMatches = [...textBefore.matchAll(/T[ÍI]TULO\s+([IVXLC]+(?:\s+[A-Z])?)/gi)]
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

  const articleRegex = /(?:^|\n)\s*Art[íi]culo\s+(\d+(?:-\d+)?)\s*(bis|ter|qu[aá]ter|quinquies|sexies|septies|octies|nonies|decies)?\s*\.\s*([^\n]*)/gi

  const matches: { index: number; articleId: string; number: number; variant: string | null; title: string }[] = []
  let match: RegExpExecArray | null

  while ((match = articleRegex.exec(fullText)) !== null) {
    const articleId = match[1]
    const baseNumber = parseInt(articleId.split('-')[0])
    matches.push({
      index: match.index,
      articleId,
      number: baseNumber,
      variant: match[2] ? match[2].toLowerCase() : null,
      title: match[3].trim().replace(/\.$/, ''),
    })
  }

  console.log(`   📋 Detectados ${matches.length} artículos en el texto`)

  if (matches.length === 0) {
    console.log('   ⚠️  No se detectaron artículos — usando chunking genérico')
    return fallbackChunking(fullText)
  }

  // Excluir texto pre-articulado
  const preChars = fullText.slice(0, matches[0].index).trim().length
  if (preChars > MIN_CHUNK_CHARS) {
    console.log(`   🗑️  Texto pre-articulado (${preChars.toLocaleString()} chars) — EXCLUIDO`)
  }

  let enrichedCount = 0

  for (let i = 0; i < matches.length; i++) {
    const current = matches[i]
    const nextIndex = i + 1 < matches.length ? matches[i + 1].index : fullText.length

    const articleText = fullText.slice(current.index, nextIndex).trim()

    const textBefore = fullText.slice(matches[0].index, current.index)
    const { chapter, titulo } = detectChapterAndTitulo(textBefore)

    const artLabel = current.variant
      ? `Artículo ${current.articleId} ${current.variant}`
      : `Artículo ${current.articleId}`

    // Buscar keywords enriquecidos para este artículo
    const keywords = getKeywordsForArticle(current.articleId, current.variant)
    if (keywords.length > 0) enrichedCount++

    // Construir context header (CON keywords si existen)
    let contextHeader = [
      titulo ? `[${titulo}]` : null,
      chapter ? `[${chapter}]` : null,
      `${artLabel}. ${current.title}`,
    ].filter(Boolean).join(' · ')

    if (keywords.length > 0) {
      contextHeader += `\nKEYWORDS: ${keywords.join(', ')}`
    }

    if (articleText.length <= MAX_CHUNK_CHARS) {
      chunks.push({
        content: `--- ${contextHeader} ---\n\n${articleText}`,
        article_number: current.number,
        article_id: current.articleId,
        article_variant: current.variant,
        article_title: current.title || null,
        chapter,
        titulo,
        chunk_part: 1,
        chunk_total: 1,
        is_preamble: false,
        is_index: false,
        enriched_keywords: keywords,
      })
    } else {
      const subChunks = subdivideArticle(articleText, contextHeader)
      for (let j = 0; j < subChunks.length; j++) {
        chunks.push({
          content: `--- ${contextHeader} (parte ${j + 1}/${subChunks.length}) ---\n\n${subChunks[j]}`,
          article_number: current.number,
          article_id: current.articleId,
          article_variant: current.variant,
          article_title: current.title || null,
          chapter,
          titulo,
          chunk_part: j + 1,
          chunk_total: subChunks.length,
          is_preamble: false,
          is_index: false,
          enriched_keywords: keywords,
        })
      }
    }
  }

  console.log(`   🔑 Artículos con keywords enriquecidos: ${enrichedCount}`)

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
    return subdivideText(text)
  }

  return parts
}

function subdivideText(text: string): string[] {
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
  const textChunks = subdivideText(text)
  return textChunks.map((content, i) => ({
    content,
    article_number: null,
    article_id: null,
    article_variant: null,
    article_title: null,
    chapter: null,
    titulo: null,
    chunk_part: i + 1,
    chunk_total: textChunks.length,
    is_preamble: false,
    is_index: false,
    enriched_keywords: [],
  }))
}

// ============================================
// EMBEDDINGS (idéntico)
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
  console.log('🚀 RE-INGESTA ENRIQUECIDA — RD 1065/2007 RGGI')
  console.log('===================================================')
  console.log('  Modo: Chunking por artículos + keywords enriquecidos')
  console.log(`  Keywords mapeados: ${Object.keys(ARTICLE_KEYWORDS).length} artículos`)
  console.log('===================================================\n')

  loadEnv()
  const { supabase, openai } = getClients()

  const filePath = path.join(CORPUS_DIR, DOCUMENT.file)

  if (!fs.existsSync(filePath)) {
    console.error(`❌ Archivo no encontrado: ${filePath}`)
    console.error(`💡 Verifica que el PDF está en: ${CORPUS_DIR}`)
    process.exit(1)
  }

  // ── PASO 1: Borrar chunks viejos del RGGI ──
  console.log('🗑️  Borrando chunks anteriores del RGGI...')
  const { error: deleteError, count: deleteCount } = await supabase
    .from('documents')
    .delete({ count: 'exact' })
    .eq('source_file', DOCUMENT.file)

  // Si no borró por source_file, intentar por source_type
  if (deleteCount === 0) {
    console.log('   ⚠️  No se encontraron por source_file, intentando por source_type...')
    const { error: deleteError2, count: deleteCount2 } = await supabase
      .from('documents')
      .delete({ count: 'exact' })
      .eq('source_type', DOCUMENT.source_type)

    if (deleteError2) {
      console.error(`❌ Error al borrar: ${deleteError2.message}`)
      process.exit(1)
    }
    console.log(`✅ ${deleteCount2 || 0} chunks anteriores eliminados (por source_type)`)
  } else {
    if (deleteError) {
      console.error(`❌ Error al borrar: ${deleteError.message}`)
      process.exit(1)
    }
    console.log(`✅ ${deleteCount || 0} chunks anteriores eliminados`)
  }

  // ── PASO 2: Extraer texto del PDF ──
  console.log('\n📖 Extrayendo texto del PDF...')
  let rawText: string
  try {
    rawText = await extractTextFromPDF(filePath)
  } catch (err) {
    console.error(`❌ Error al leer PDF: ${err}`)
    process.exit(1)
  }
  const cleanedText = cleanText(rawText)
  console.log(`✅ Texto extraído: ${cleanedText.length.toLocaleString()} caracteres`)

  // ── PASO 3: Parsear artículos con keywords enriquecidos ──
  console.log('\n🔍 Parseando artículos con keywords enriquecidos...')
  const articleChunks = parseArticles(cleanedText)

  const validChunks = articleChunks.filter(c => !c.is_index)
  console.log(`✅ ${validChunks.length} chunks válidos (${articleChunks.length - validChunks.length} descartados)`)

  const uniqueArticles = new Set(
    validChunks
      .filter(c => c.article_number)
      .map(c => `${c.article_id || c.article_number}${c.article_variant ? ' ' + c.article_variant : ''}`)
  )
  console.log(`📋 Artículos únicos detectados: ${uniqueArticles.size}`)

  // Verificar que los artículos clave del modelo 720 se detectaron
  const keyArticles = ['42 bis', '42 ter', '54 bis']
  for (const ka of keyArticles) {
    const found = validChunks.some(c => {
      const fullId = c.article_id + (c.article_variant ? ' ' + c.article_variant : '')
      return fullId === ka
    })
    console.log(`   ${found ? '✅' : '❌'} Art. ${ka}: ${found ? 'ENCONTRADO' : 'NO ENCONTRADO'}`)
  }

  // Mostrar muestra de chunks enriquecidos
  const enrichedChunks = validChunks.filter(c => c.enriched_keywords.length > 0)
  console.log(`\n🔑 Chunks con keywords enriquecidos: ${enrichedChunks.length}`)
  for (const ec of enrichedChunks.slice(0, 3)) {
    const artLabel = ec.article_id + (ec.article_variant ? ' ' + ec.article_variant : '')
    console.log(`   · Art. ${artLabel}: ${ec.enriched_keywords.slice(0, 3).join(', ')}...`)
  }

  // ── PASO 4: Generar embeddings ──
  console.log('\n🧠 Generando embeddings...')
  const texts = validChunks.map(c => c.content)
  let embeddings: number[][]
  try {
    embeddings = await generateEmbeddings(openai, texts)
  } catch (err) {
    console.error(`❌ Error al generar embeddings: ${err}`)
    process.exit(1)
  }

  // ── PASO 5: Insertar en Supabase ──
  console.log('\n💾 Insertando en Supabase...')
  let insertedCount = 0
  let errorCount = 0

  for (let i = 0; i < validChunks.length; i++) {
    const chunk = validChunks[i]

    const artId = chunk.article_id || (chunk.article_number ? String(chunk.article_number) : null)
    const artLabel = artId
      ? (chunk.article_variant ? `Art. ${artId} ${chunk.article_variant}` : `Art. ${artId}`)
      : null

    let title = DOCUMENT.source_label
    if (artLabel) {
      title += ` — ${artLabel}`
      if (chunk.article_title) title += `. ${chunk.article_title}`
      if (chunk.chunk_total > 1) title += ` (${chunk.chunk_part}/${chunk.chunk_total})`
    } else if (chunk.is_preamble) {
      title += ' — Preámbulo'
      if (chunk.chunk_total > 1) title += ` (${chunk.chunk_part}/${chunk.chunk_total})`
    }

    const sectionLabel = artLabel || (chunk.is_preamble ? 'Preámbulo' : null)

    const record = {
      source_file: DOCUMENT.file,
      source_type: DOCUMENT.source_type,
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
  }

  // ============================================
  // RESUMEN
  // ============================================
  console.log('\n===================================================')
  console.log('📊 RESUMEN DE RE-INGESTA ENRIQUECIDA — RGGI')
  console.log('===================================================')
  console.log(`   Chunks eliminados (viejos):   ${deleteCount || 0}`)
  console.log(`   Chunks insertados (nuevos):   ${insertedCount}`)
  console.log(`   Chunks con keywords extra:    ${enrichedChunks.length}`)
  console.log(`   Errores:                      ${errorCount}`)

  // Verificación final
  const { count } = await supabase
    .from('documents')
    .select('*', { count: 'exact', head: true })

  console.log(`   Total documentos en Supabase: ${count}`)
  console.log('\n✅ Re-ingesta RGGI enriquecida completada.')
  console.log('')
  console.log('📌 SIGUIENTE PASO:')
  console.log('   Probar en producción: "modelo 720 bienes extranjero sanciones"')
  console.log('   El asistente debería recuperar chunks de los arts. 42 bis/ter y 54 bis del RGGI')
}

main().catch(err => {
  console.error('❌ Error fatal:', err)
  process.exit(1)
})
