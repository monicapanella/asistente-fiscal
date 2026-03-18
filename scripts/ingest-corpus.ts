// scripts/ingest-corpus.ts
// Script de ingesta única — ejecutar con: npx tsx scripts/ingest-corpus.ts
// Lee PDFs del corpus, los divide en chunks, genera embeddings e inserta en Supabase

import fs from 'fs'
import path from 'path'
const { PDFParse } = require('pdf-parse')
import { createClient } from '@supabase/supabase-js'
import OpenAI from 'openai'

// ============================================
// CONFIGURACIÓN
// ============================================

const CORPUS_DIR = path.join(process.cwd(), 'corpus')

// Definición de los documentos a ingestar
const DOCUMENTS = [
  {
    file: 'ley_27_2014_impuesto_sociedades.pdf',
    source_type: 'ley',
    title_prefix: 'Ley 27/2014 IS',
  },
  {
    file: 'rd_634_2015_reglamento_IS.pdf',
    source_type: 'reglamento',
    title_prefix: 'RD 634/2015 Reglamento IS',
  },
  {
    file: 'directrices_ocde_pt_2022.pdf',
    source_type: 'directrices_ocde',
    title_prefix: 'Directrices OCDE PT 2022',
  },
]

// Parámetros de chunking
const CHUNK_SIZE = 1500        // Caracteres por chunk (~375 tokens)
const CHUNK_OVERLAP = 200      // Solapamiento entre chunks para no perder contexto
const EMBEDDING_MODEL = 'text-embedding-3-small'  // 1536 dimensiones
const BATCH_SIZE = 20          // Embeddings por lote (límite rate OpenAI)
const DELAY_BETWEEN_BATCHES = 1000  // ms entre lotes para no exceder rate limit

// ============================================
// CLIENTES
// ============================================

function getClients() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const openaiKey = process.env.OPENAI_API_KEY

  if (!supabaseUrl || !supabaseKey || !openaiKey) {
    console.error('❌ Faltan variables de entorno. Verifica tu .env.local:')
    if (!supabaseUrl) console.error('   - NEXT_PUBLIC_SUPABASE_URL')
    if (!supabaseKey) console.error('   - SUPABASE_SERVICE_ROLE_KEY')
    if (!openaiKey) console.error('   - OPENAI_API_KEY')
    process.exit(1)
  }

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const openai = new OpenAI({ apiKey: openaiKey })

  return { supabase, openai }
}

// ============================================
// FUNCIONES DE PROCESAMIENTO
// ============================================

// Extraer texto de un PDF
async function extractTextFromPDF(filePath: string): Promise<string> {
  const buffer = fs.readFileSync(filePath)
  const parser = new PDFParse({ data: new Uint8Array(buffer) })
  const result = await parser.getText()
  return result.text
}

// Limpiar texto extraído de PDF
function cleanText(text: string): string {
  return text
    // Eliminar múltiples saltos de línea
    .replace(/\n{3,}/g, '\n\n')
    // Eliminar espacios múltiples
    .replace(/ {2,}/g, ' ')
    // Eliminar caracteres de control excepto saltos de línea
    .replace(/[\x00-\x09\x0B\x0C\x0E-\x1F]/g, '')
    .trim()
}

// Dividir texto en chunks con overlap
function chunkText(text: string): { content: string; index: number }[] {
  const chunks: { content: string; index: number }[] = []
  let start = 0
  let index = 0

  while (start < text.length) {
    let end = start + CHUNK_SIZE

    // Si no es el último chunk, intentar cortar en un punto natural
    if (end < text.length) {
      // Buscar el último salto de párrafo dentro del rango
      const lastParagraph = text.lastIndexOf('\n\n', end)
      if (lastParagraph > start + CHUNK_SIZE * 0.5) {
        end = lastParagraph
      } else {
        // Si no hay párrafo, buscar el último punto seguido de espacio
        const lastSentence = text.lastIndexOf('. ', end)
        if (lastSentence > start + CHUNK_SIZE * 0.5) {
          end = lastSentence + 1 // Incluir el punto
        }
      }
    }

    const content = text.slice(start, end).trim()
    if (content.length > 50) {  // Ignorar chunks muy pequeños
      chunks.push({ content, index })
      index++
    }

    // Avanzar con overlap
    start = end - CHUNK_OVERLAP
    if (start < 0) start = 0
    // Evitar bucle infinito
    if (end >= text.length) break
  }

  return chunks
}

// Generar embeddings en lotes
async function generateEmbeddings(
  openai: OpenAI,
  texts: string[]
): Promise<number[][]> {
  const embeddings: number[][] = []

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE)
    
    console.log(`    📊 Generando embeddings ${i + 1}-${Math.min(i + BATCH_SIZE, texts.length)} de ${texts.length}...`)

    const response = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: batch,
    })

    for (const item of response.data) {
      embeddings.push(item.embedding)
    }

    // Pausa entre lotes para respetar rate limits
    if (i + BATCH_SIZE < texts.length) {
      await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES))
    }
  }

  return embeddings
}

// Detectar capítulo/sección del texto (heurística básica)
function detectSection(text: string, sourceType: string): { chapter?: string; section?: string } {
  let chapter: string | undefined
  let section: string | undefined

  if (sourceType === 'ley' || sourceType === 'reglamento') {
    // Buscar "Artículo X" o "Art. X"
    const artMatch = text.match(/Art[íi]culo\s+(\d+)/i) || text.match(/Art\.\s*(\d+)/i)
    if (artMatch) section = `Art. ${artMatch[1]}`

    // Buscar "Capítulo X" o "CAPÍTULO X"
    const chapMatch = text.match(/Cap[íi]tulo\s+([IVXLC]+|\d+)/i)
    if (chapMatch) chapter = `Capítulo ${chapMatch[1]}`

    // Buscar "Título X"
    const titleMatch = text.match(/T[íi]tulo\s+([IVXLC]+|\d+)/i)
    if (titleMatch) chapter = chapter || `Título ${titleMatch[1]}`
  }

  if (sourceType === 'directrices_ocde') {
    // Buscar "Chapter X" o "Capítulo X"
    const chapMatch = text.match(/(?:Chapter|Cap[íi]tulo)\s+([IVXLC]+|\d+)/i)
    if (chapMatch) chapter = `Capítulo ${chapMatch[1]}`

    // Buscar párrafos numerados (ej: "2.18", "10.4")
    const paraMatch = text.match(/(?:párrafo|paragraph|para\.?)\s*([\d]+\.[\d]+)/i)
    if (paraMatch) section = `Párrafo ${paraMatch[1]}`
  }

  return { chapter, section }
}

// ============================================
// FUNCIÓN PRINCIPAL
// ============================================

async function main() {
  console.log('🚀 INICIO DE INGESTA — Corpus Normativo PT')
  console.log('==========================================\n')

  // Cargar variables de entorno desde .env.local
  // (npx tsx carga automáticamente si usamos dotenv)
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

  const { supabase, openai } = getClients()

  let totalChunks = 0
  let totalErrors = 0

  for (const doc of DOCUMENTS) {
    const filePath = path.join(CORPUS_DIR, doc.file)
    
    console.log(`📄 Procesando: ${doc.file}`)
    console.log(`   Tipo: ${doc.source_type}`)

    // Verificar que el archivo existe
    if (!fs.existsSync(filePath)) {
      console.error(`   ❌ Archivo no encontrado: ${filePath}`)
      totalErrors++
      continue
    }

    // 1. Extraer texto
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

    // 2. Dividir en chunks
    console.log('   ✂️  Dividiendo en chunks...')
    const chunks = chunkText(cleanedText)
    console.log(`   ✅ ${chunks.length} chunks generados`)

    // 3. Generar embeddings
    console.log('   🧠 Generando embeddings...')
    const texts = chunks.map(c => c.content)
    let embeddings: number[][]
    try {
      embeddings = await generateEmbeddings(openai, texts)
    } catch (err) {
      console.error(`   ❌ Error al generar embeddings: ${err}`)
      totalErrors++
      continue
    }
    console.log(`   ✅ ${embeddings.length} embeddings generados`)

    // 4. Insertar en Supabase
    console.log('   💾 Insertando en Supabase...')
    let insertedCount = 0

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]
      const { chapter, section } = detectSection(chunk.content, doc.source_type)

      const record = {
        source_file: doc.file,
        source_type: doc.source_type,
        title: `${doc.title_prefix}${section ? ' — ' + section : ''}${chapter ? ' (' + chapter + ')' : ''}`,
        content: chunk.content,
        chapter: chapter || null,
        section: section || null,
        page_start: null,  // pdf-parse no proporciona páginas por chunk
        page_end: null,
        chunk_index: chunk.index,
        embedding: JSON.stringify(embeddings[i]),
      }

      const { error } = await supabase
        .from('documents')
        .insert(record)

      if (error) {
        console.error(`   ❌ Error insertando chunk ${i}: ${error.message}`)
        totalErrors++
      } else {
        insertedCount++
      }
    }

    console.log(`   ✅ ${insertedCount}/${chunks.length} chunks insertados correctamente`)
    totalChunks += insertedCount
    console.log('')
  }

  // ============================================
  // RESUMEN
  // ============================================
  console.log('==========================================')
  console.log('📊 RESUMEN DE INGESTA')
  console.log('==========================================')
  console.log(`   Total chunks insertados: ${totalChunks}`)
  console.log(`   Total errores: ${totalErrors}`)
  console.log('')

  // Verificación final
  const { count } = await supabase
    .from('documents')
    .select('*', { count: 'exact', head: true })

  console.log(`   📦 Total documentos en Supabase: ${count}`)
  console.log('\n✅ Ingesta completada.')
}

// Ejecutar
main().catch(err => {
  console.error('❌ Error fatal:', err)
  process.exit(1)
})
