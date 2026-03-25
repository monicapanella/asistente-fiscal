// scripts/ingest-ley-articulos.ts
// =====================================================================
// INGESTA UNIVERSAL — Leyes y Reglamentos BOE
// Chunking por artículos con metadatos enriquecidos
// Soporte CLI para ingesta selectiva por grupo o source_type
//
// Uso:
//   npx tsx scripts/ingest-ley-articulos.ts --all           # Todo
//   npx tsx scripts/ingest-ley-articulos.ts --only pt        # Solo PT
//   npx tsx scripts/ingest-ley-articulos.ts --only fiscal    # Solo fiscal
//   npx tsx scripts/ingest-ley-articulos.ts --only lirpf     # Un source_type
//   npx tsx scripts/ingest-ley-articulos.ts --only lirpf,liva  # Varios
//   npx tsx scripts/ingest-ley-articulos.ts --dry-run --only fiscal  # Sin insertar
// =====================================================================

import fs from 'fs'
import path from 'path'
import { createClient } from '@supabase/supabase-js'
import OpenAI from 'openai'

// ============================================
// CONFIGURACIÓN DE DOCUMENTOS
// ============================================

const CORPUS_DIR = path.join(process.cwd(), 'corpus')

interface DocumentConfig {
  file: string
  source_type: string
  source_label: string
  group: 'pt' | 'fiscal'           // Para filtro --only pt / --only fiscal
  priority_articles?: number[]      // Artículos que se verifican en el log
}

const DOCUMENTS: DocumentConfig[] = [
  // ── GRUPO PT (ya ingestados — solo re-ejecutar si se quiere re-ingestar) ──
  {
    file: 'ley_27_2014_impuesto_sociedades.pdf',
    source_type: 'ley',
    source_label: 'Ley 27/2014 IS',
    group: 'pt',
    priority_articles: [18, 15, 16, 17, 19, 20, 21],
  },
  {
    file: 'rd_634_2015_reglamento_IS.pdf',
    source_type: 'reglamento',
    source_label: 'RD 634/2015 Reglamento IS',
    group: 'pt',
    priority_articles: [13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36],
  },

  // ── GRUPO FISCAL (nuevos — pendientes de ingesta) ──
  {
    file: 'ley_35_2006_irpf.pdf',
    source_type: 'lirpf',
    source_label: 'Ley 35/2006 IRPF',
    group: 'fiscal',
  },
  {
    file: 'ley_37_1992_iva.pdf',
    source_type: 'liva',
    source_label: 'Ley 37/1992 IVA',
    group: 'fiscal',
  },
  {
    file: 'rd_1065_2007_rggi.pdf',
    source_type: 'rggi',
    source_label: 'RD 1065/2007 RGGI',
    group: 'fiscal',
  },
  {
    file: 'rd_439_2007_rirpf.pdf',
    source_type: 'rirpf',
    source_label: 'RD 439/2007 Reglamento IRPF',
    group: 'fiscal',
  },
  {
    file: 'dl_1_2024_codigo_tributario_cat.pdf',
    source_type: 'tributos_cedidos_cat',
    source_label: 'DL 1/2024 Código Tributario Catalunya',
    group: 'fiscal',
  },
  {
    file: 'rd_1624_1992_riva.pdf',
    source_type: 'riva',
    source_label: 'RD 1624/1992 Reglamento IVA',
    group: 'fiscal',
  },
  {
    file: 'ley_29_1987_isd.pdf',
    source_type: 'lisd',
    source_label: 'Ley 29/1987 ISD',
    group: 'fiscal',
  },
  {
    file: 'rdl_1_1993_itp_ajd.pdf',
    source_type: 'litp',
    source_label: 'RDL 1/1993 ITP y AJD',
    group: 'fiscal',
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
// PARSEO DE ARGUMENTOS CLI
// ============================================

interface CLIArgs {
  filter: 'all' | string[]    // 'all', ['pt'], ['fiscal'], ['lirpf'], ['lirpf','liva']...
  dryRun: boolean
}

function parseCLIArgs(): CLIArgs {
  const args = process.argv.slice(2)
  let filter: 'all' | string[] = 'all'
  let dryRun = false

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--all') {
      filter = 'all'
    } else if (args[i] === '--only' && args[i + 1]) {
      const value = args[i + 1]
      filter = value.split(',').map(s => s.trim().toLowerCase())
      i++
    } else if (args[i] === '--dry-run') {
      dryRun = true
    }
  }

  // Si no se pasa ningún argumento, mostrar ayuda
  if (args.length === 0) {
    console.log('⚠️  No se especificó qué ingestar. Uso:')
    console.log('')
    console.log('  npx tsx scripts/ingest-ley-articulos.ts --all              # Todo (PT + Fiscal)')
    console.log('  npx tsx scripts/ingest-ley-articulos.ts --only pt          # Solo grupo PT')
    console.log('  npx tsx scripts/ingest-ley-articulos.ts --only fiscal      # Solo grupo Fiscal')
    console.log('  npx tsx scripts/ingest-ley-articulos.ts --only lirpf       # Solo LIRPF')
    console.log('  npx tsx scripts/ingest-ley-articulos.ts --only lirpf,liva  # LIRPF + LIVA')
    console.log('  npx tsx scripts/ingest-ley-articulos.ts --dry-run --only fiscal  # Test sin insertar')
    console.log('')
    console.log('Grupos disponibles: pt, fiscal')
    console.log('Source types disponibles:', DOCUMENTS.map(d => d.source_type).join(', '))
    process.exit(0)
  }

  return { filter, dryRun }
}

function filterDocuments(docs: DocumentConfig[], filter: 'all' | string[]): DocumentConfig[] {
  if (filter === 'all') return docs

  return docs.filter(doc => {
    return filter.some(f => f === doc.group || f === doc.source_type)
  })
}

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
    // Cabeceras BOE repetidas
    .replace(/LEGISLACIÓN CONSOLIDADA/g, '')
    .replace(/BOLETÍN OFICIAL DEL ESTADO/g, '')
    .replace(/Página \d+ de \d+/g, '')
    .replace(/cve: BOE-A-\d+-\d+/g, '')
    .replace(/Verificable en https?:\/\/www\.boe\.es/g, '')
    // Limpieza general
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
  article_id: string | null         // "18", "611-1", "11 bis" — full identifier
  article_variant: string | null    // 'bis', 'ter', 'quáter', etc.
  article_title: string | null
  chapter: string | null
  titulo: string | null
  chunk_part: number
  chunk_total: number
  is_preamble: boolean
  is_index: boolean
}

/**
 * Detecta si un bloque de texto es parte del índice/sumario del BOE.
 */
function isIndexContent(text: string): boolean {
  const dotLines = (text.match(/\.{5,}/g) || []).length
  const totalLines = text.split('\n').length
  return dotLines > 3 && (dotLines / totalLines) > 0.2
}

/**
 * Detecta si un bloque es preámbulo/exposición de motivos.
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
  const tituloMatches = [...textBefore.matchAll(/T[ÍI]TULO\s+([IVXLC]+(?:\s+[A-Z])?)/gi)]
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
 * Soporta artículos estándar (Art. 18), variantes (Art. 11 bis, Art. 23 ter),
 * y numeración compuesta (Art. 611-1, típica del Código Tributario Catalunya).
 */
function parseArticles(fullText: string, sourceType: string): ArticleChunk[] {
  const chunks: ArticleChunk[] = []

  // Regex extendido:
  //   - "Artículo 18."
  //   - "Artículo 11 bis."
  //   - "Artículo 611-1." (numeración compuesta Catalunya)
  //   - "Artículo 612-10." (compuesta con segundo número >9)
  const articleRegex = /(?:^|\n)\s*Art[íi]culo\s+(\d+(?:-\d+)?)\s*(bis|ter|qu[aá]ter|quinquies|sexies|septies|octies|nonies|decies)?\s*\.\s*([^\n]*)/gi

  const matches: { index: number; articleId: string; number: number; variant: string | null; title: string }[] = []
  let match: RegExpExecArray | null

  while ((match = articleRegex.exec(fullText)) !== null) {
    const articleId = match[1]  // "18" o "611-1"
    const baseNumber = parseInt(articleId.split('-')[0])  // Para ordenación
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
    console.log('   ⚠️  No se detectaron artículos — usando chunking genérico como fallback')
    return fallbackChunking(fullText, sourceType)
  }

  // Texto ANTES del primer artículo = índice + preámbulo/exposición de motivos
  // Lo excluimos completamente: no aporta valor RAG para consultas fiscales.
  // Los artículos son la fuente normativa relevante.
  const textBeforeFirstArticle = fullText.slice(0, matches[0].index)
  const preChars = textBeforeFirstArticle.trim().length
  if (preChars > MIN_CHUNK_CHARS) {
    console.log(`   🗑️  Texto pre-articulado (${preChars.toLocaleString()} chars) — EXCLUIDO (índice/preámbulo)`)
  }

  // Procesar cada artículo
  for (let i = 0; i < matches.length; i++) {
    const current = matches[i]
    const nextIndex = i + 1 < matches.length ? matches[i + 1].index : fullText.length

    let articleText = fullText.slice(current.index, nextIndex).trim()

    if (articleText.length < MIN_CHUNK_CHARS) {
      console.log(`   ⏭️  Art. ${current.articleId}${current.variant ? ' ' + current.variant : ''} — muy corto (${articleText.length} chars), incluido como chunk único`)
    }

    // Detectar capítulo y título del contexto previo
    // Solo buscar desde el primer artículo para evitar contaminación del índice/preámbulo
    const textBefore = fullText.slice(matches[0].index, current.index)
    const { chapter, titulo } = detectChapterAndTitulo(textBefore)

    // Construir label del artículo
    const artLabel = current.variant
      ? `Artículo ${current.articleId} ${current.variant}`
      : `Artículo ${current.articleId}`

    // Encabezado de contexto
    const contextHeader = [
      titulo ? `[${titulo}]` : null,
      chapter ? `[${chapter}]` : null,
      `${artLabel}. ${current.title}`,
    ].filter(Boolean).join(' · ')

    // Si el artículo cabe en un solo chunk
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
      })
    } else {
      // Artículo largo: subdividir respetando apartados
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
        })
      }
    }
  }

  return chunks
}

/**
 * Subdivide un artículo largo respetando la estructura de apartados.
 */
function subdivideArticle(text: string, contextHeader: string): string[] {
  const parts: string[] = []

  // Intentar dividir por apartados numerados (1. , 2. , etc.)
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
    article_id: null,
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
  const cliArgs = parseCLIArgs()
  const selectedDocs = filterDocuments(DOCUMENTS, cliArgs.filter)

  if (selectedDocs.length === 0) {
    console.error('❌ No se encontraron documentos para el filtro especificado.')
    console.error('   Filtro:', cliArgs.filter)
    console.error('   Grupos disponibles: pt, fiscal')
    console.error('   Source types:', DOCUMENTS.map(d => d.source_type).join(', '))
    process.exit(1)
  }

  const filterLabel = cliArgs.filter === 'all'
    ? 'TODOS'
    : (cliArgs.filter as string[]).join(', ').toUpperCase()

  console.log(`🚀 INGESTA UNIVERSAL — Leyes y Reglamentos BOE`)
  console.log('===================================================')
  console.log(`  Filtro: ${filterLabel}`)
  console.log(`  Documentos: ${selectedDocs.length}`)
  console.log(`  Modo: ${cliArgs.dryRun ? '🧪 DRY RUN (sin insertar)' : 'Chunking por artículos + inserción'}`)
  console.log('===================================================')
  console.log('')
  console.log('  Documentos seleccionados:')
  for (const doc of selectedDocs) {
    console.log(`    · ${doc.source_label} (${doc.source_type}) [${doc.group}]`)
  }
  console.log('')

  loadEnv()
  const { supabase, openai } = getClients()

  let totalInserted = 0
  let totalDeleted = 0
  let totalErrors = 0
  let totalChunks = 0

  for (const doc of selectedDocs) {
    const filePath = path.join(CORPUS_DIR, doc.file)

    console.log(`\n📄 Procesando: ${doc.file}`)
    console.log(`   Tipo: ${doc.source_type} (${doc.source_label}) [grupo: ${doc.group}]`)

    if (!fs.existsSync(filePath)) {
      console.error(`   ❌ Archivo no encontrado: ${filePath}`)
      console.error(`   💡 Verifica que el PDF está en la carpeta: ${CORPUS_DIR}`)
      totalErrors++
      continue
    }

    // ── PASO 1: Borrar chunks viejos de esta fuente ──
    if (!cliArgs.dryRun) {
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
    }

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
    console.log(`   ✅ Texto extraído: ${cleanedText.length.toLocaleString()} caracteres`)

    // ── PASO 3: Parsear artículos ──
    console.log('   🔍 Parseando artículos...')
    const articleChunks = parseArticles(cleanedText, doc.source_type)

    // Excluir chunks de índice
    const validChunks = articleChunks.filter(c => !c.is_index)
    console.log(`   ✅ ${validChunks.length} chunks válidos (${articleChunks.length - validChunks.length} descartados como índice)`)
    totalChunks += validChunks.length

    // Estadísticas de artículos detectados
    const uniqueArticles = new Set(
      validChunks
        .filter(c => c.article_number)
        .map(c => `${c.article_id || c.article_number}${c.article_variant ? ' ' + c.article_variant : ''}`)
    )
    console.log(`   📋 Artículos únicos detectados: ${uniqueArticles.size}`)

    // Verificar artículos prioritarios
    if (doc.priority_articles && doc.priority_articles.length > 0) {
      const found = doc.priority_articles.filter(a => uniqueArticles.has(String(a)))
      const missing = doc.priority_articles.filter(a => !uniqueArticles.has(String(a)))
      console.log(`   ✅ Artículos prioritarios encontrados: ${found.join(', ')}`)
      if (missing.length > 0) {
        console.log(`   ⚠️  Artículos prioritarios NO encontrados: ${missing.join(', ')}`)
      }
    }

    // Si es dry run, parar aquí para este documento
    if (cliArgs.dryRun) {
      console.log(`   🧪 DRY RUN — no se generan embeddings ni se insertan chunks`)
      // Mostrar muestra de los primeros 3 chunks
      console.log('   📝 Muestra de chunks:')
      for (const chunk of validChunks.slice(0, 3)) {
        const artLabel = chunk.article_id
          ? `Art. ${chunk.article_id}${chunk.article_variant ? ' ' + chunk.article_variant : ''}`
          : (chunk.is_preamble ? 'Preámbulo' : 'Genérico')
        console.log(`      · [${artLabel}] ${chunk.content.slice(0, 100).replace(/\n/g, ' ')}...`)
      }
      continue
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

      // Construir label del artículo (usa article_id para soportar "611-1" etc.)
      const artId = chunk.article_id || (chunk.article_number ? String(chunk.article_number) : null)
      const artLabel = artId
        ? (chunk.article_variant ? `Art. ${artId} ${chunk.article_variant}` : `Art. ${artId}`)
        : null

      // Construir título descriptivo
      let title = doc.source_label
      if (artLabel) {
        title += ` — ${artLabel}`
        if (chunk.article_title) title += `. ${chunk.article_title}`
        if (chunk.chunk_total > 1) title += ` (${chunk.chunk_part}/${chunk.chunk_total})`
      } else if (chunk.is_preamble) {
        title += ' — Preámbulo'
        if (chunk.chunk_total > 1) title += ` (${chunk.chunk_part}/${chunk.chunk_total})`
      }

      // Construir section label
      const sectionLabel = artLabel || (chunk.is_preamble ? 'Preámbulo' : null)

      const record = {
        source_file: doc.file,
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
  console.log(`📊 RESUMEN DE INGESTA`)
  console.log('===================================================')
  console.log(`   Filtro:                      ${filterLabel}`)
  console.log(`   Documentos procesados:       ${selectedDocs.length}`)
  if (!cliArgs.dryRun) {
    console.log(`   Chunks eliminados (viejos):  ${totalDeleted}`)
    console.log(`   Chunks insertados (nuevos):  ${totalInserted}`)
  } else {
    console.log(`   Chunks detectados (dry run): ${totalChunks}`)
  }
  console.log(`   Errores:                     ${totalErrors}`)

  if (!cliArgs.dryRun) {
    // Verificación final: conteo total en Supabase
    const { count } = await supabase
      .from('documents')
      .select('*', { count: 'exact', head: true })

    console.log(`   Total documentos en Supabase: ${count}`)

    // Conteo desglosado por source_type
    console.log('\n   Desglose por source_type:')
    const { data: breakdown } = await supabase
      .rpc('count_by_source_type')
      .select('*')
    
    // Si la RPC no existe, hacer consulta manual
    if (!breakdown) {
      for (const doc of DOCUMENTS) {
        const { count: docCount } = await supabase
          .from('documents')
          .select('*', { count: 'exact', head: true })
          .eq('source_type', doc.source_type)
        if (docCount && docCount > 0) {
          console.log(`     · ${doc.source_type}: ${docCount} chunks`)
        }
      }
      // También contar los que no están en DOCUMENTS (OCDE, LGT, casos)
      for (const extraType of ['directrices_ocde', 'lgt', 'modulo_casos_complejos']) {
        if (!DOCUMENTS.find(d => d.source_type === extraType)) {
          const { count: docCount } = await supabase
            .from('documents')
            .select('*', { count: 'exact', head: true })
            .eq('source_type', extraType)
          if (docCount && docCount > 0) {
            console.log(`     · ${extraType}: ${docCount} chunks`)
          }
        }
      }
    }
  }

  console.log('\n✅ Ingesta completada.')

  if (!cliArgs.dryRun && totalInserted > 0) {
    console.log('\n📌 SIGUIENTE PASO:')
    console.log('   Verificar que los nuevos source_types están en el filtro de route.ts')
    console.log('   (FISCAL_SOURCE_TYPES en app/api/chat-fiscal/route.ts)')
  }
}

main().catch(err => {
  console.error('❌ Error fatal:', err)
  process.exit(1)
})
