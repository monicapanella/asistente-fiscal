// scripts/ingest-ocde-fix-cap2-cap6.ts
// =====================================================================
// FIX: Re-ingesta caps II y VI con chunking por tamaño forzado
// Los párrafos OCDE de estos capítulos generaban chunks demasiado grandes
// Ejecutar con: npx tsx scripts/ingest-ocde-fix-cap2-cap6.ts
// =====================================================================

import fs from 'fs'
import path from 'path'
import { createClient } from '@supabase/supabase-js'
import OpenAI from 'openai'

const CORPUS_DIR = path.join(process.cwd(), 'corpus')
const SOURCE_TYPE = 'directrices_ocde'
const SOURCE_LABEL = 'Directrices OCDE PT 2022'

const CHAPTERS = [
  {
    number: 2,
    roman: 'II',
    title: 'Métodos de precios de transferencia',
    file: 'directrices ocde precios de transferencia 2022_extract cap II.pdf',
    description: 'CUP, Precio de Reventa, Coste Incrementado, TNMM, Profit Split',
  },
  {
    number: 6,
    roman: 'VI',
    title: 'Consideraciones especiales aplicables a los activos intangibles',
    file: 'directrices ocde precios de transferencia 2022_extract Cap VI.pdf',
    description: 'DEMPE, HTVI, intangibles de difícil valoración, royalties',
  },
]

const CHUNK_TARGET = 1800
const CHUNK_OVERLAP = 200
const MIN_CHUNK_CHARS = 100
const EMBEDDING_MODEL = 'text-embedding-3-small'
const BATCH_SIZE = 20
const DELAY_BETWEEN_BATCHES = 1000

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
          if (!process.env[key]) process.env[key] = value
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
    console.error('❌ Faltan variables de entorno')
    process.exit(1)
  }
  return {
    supabase: createClient(supabaseUrl, supabaseKey, { auth: { autoRefreshToken: false, persistSession: false } }),
    openai: new OpenAI({ apiKey: openaiKey }),
  }
}

async function extractTextFromPDF(filePath: string): Promise<string> {
  const { PDFParse } = require('pdf-parse')
  const buffer = fs.readFileSync(filePath)
  const parser = new PDFParse({ data: new Uint8Array(buffer) })
  const result = await parser.getText()
  return result.text
}

function cleanOCDEText(text: string): string {
  return text
    .replace(/DIRECTRICES DE LA OCDE APLICABLES EN MATERIA DE PRECIOS DE TRANSFERENCIA \d{4}\s*©.*?\n/gi, '')
    .replace(/DIRECTRICES DE LA OCDE.*?PRECIOS DE TRANSFERENCIA.*?\n/gi, '')
    .replace(/© OCDE \d{4}/g, '')
    .replace(/OECD TRANSFER PRICING GUIDELINES.*?\n/gi, '')
    .replace(/^\s*\d{1,3}\s*$/gm, '')
    .replace(/--\s*\d+\s*of\s*\d+\s*--/g, '')
    .replace(/Página\s+\d+/g, '')
    .replace(/^\s*Cap[íi]tulo\s+[IVXLC]+\.\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/ {2,}/g, ' ')
    .replace(/[\x00-\x09\x0B\x0C\x0E-\x1F]/g, '')
    .trim()
}

// Chunking por tamaño forzado (sin intentar detectar párrafos OCDE)
function chunkBySize(text: string, chapter: typeof CHAPTERS[0]): { content: string; chunk_index: number }[] {
  const chunks: { content: string; chunk_index: number }[] = []
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
        chunk_index: index++,
      })
    }

    start = end - CHUNK_OVERLAP
    if (start < 0) start = 0
    if (end >= text.length) break
  }

  return chunks
}

async function generateEmbeddings(openai: OpenAI, texts: string[]): Promise<number[][]> {
  const embeddings: number[][] = []
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE)
    console.log(`    📊 Embeddings ${i + 1}-${Math.min(i + BATCH_SIZE, texts.length)} de ${texts.length}...`)
    const response = await openai.embeddings.create({ model: EMBEDDING_MODEL, input: batch })
    for (const item of response.data) embeddings.push(item.embedding)
    if (i + BATCH_SIZE < texts.length) await new Promise(r => setTimeout(r, DELAY_BETWEEN_BATCHES))
  }
  return embeddings
}

async function main() {
  console.log('🔧 FIX: Re-ingesta caps II y VI con chunking por tamaño')
  console.log('=========================================================\n')

  loadEnv()
  const { supabase, openai } = getClients()

  let totalInserted = 0

  for (const chapter of CHAPTERS) {
    const filePath = path.join(CORPUS_DIR, chapter.file)
    console.log(`\n📖 Capítulo ${chapter.roman}: ${chapter.title}`)

    if (!fs.existsSync(filePath)) {
      console.error(`   ❌ Archivo no encontrado: ${filePath}`)
      continue
    }

    // Borrar chunks de este capítulo
    console.log(`   🗑️  Borrando chunks de Cap. ${chapter.roman}...`)
    const { count: delCount } = await supabase
      .from('documents')
      .delete({ count: 'exact' })
      .eq('source_file', chapter.file)
    console.log(`   ✅ ${delCount || 0} chunks eliminados`)

    // Extraer y limpiar texto
    console.log('   📄 Extrayendo texto...')
    const rawText = await extractTextFromPDF(filePath)
    const cleanedText = cleanOCDEText(rawText)
    console.log(`   ✅ ${cleanedText.length} caracteres`)

    // Chunking por tamaño (forzado)
    const chunks = chunkBySize(cleanedText, chapter)
    console.log(`   ✂️  ${chunks.length} chunks generados (por tamaño)`)

    // Embeddings
    console.log('   🧠 Generando embeddings...')
    const embeddings = await generateEmbeddings(openai, chunks.map(c => c.content))

    // Insertar
    console.log('   💾 Insertando en Supabase...')
    let inserted = 0
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]
      const title = `${SOURCE_LABEL} — Cap. ${chapter.roman}. ${chapter.title}`

      const { error } = await supabase.from('documents').insert({
        source_file: chapter.file,
        source_type: SOURCE_TYPE,
        title,
        content: chunk.content,
        chapter: `Capítulo ${chapter.roman}`,
        section: null,
        page_start: null,
        page_end: null,
        chunk_index: chunk.chunk_index,
        embedding: JSON.stringify(embeddings[i]),
      })

      if (error) {
        console.error(`   ❌ Error chunk ${i}: ${error.message}`)
      } else {
        inserted++
      }
    }
    console.log(`   ✅ ${inserted}/${chunks.length} chunks insertados`)
    totalInserted += inserted
  }

  const { count } = await supabase
    .from('documents')
    .select('*', { count: 'exact', head: true })

  console.log(`\n=========================================================`)
  console.log(`📊 Caps II + VI insertados: ${totalInserted} chunks`)
  console.log(`📦 Total documentos en Supabase: ${count}`)
  console.log(`\n✅ Fix completado.`)
}

main().catch(err => { console.error('❌ Error fatal:', err); process.exit(1) })
