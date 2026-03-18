// scripts/ingest-markdown.ts
// Ingesta de documentos Markdown al corpus RAG

import fs from 'fs'
import path from 'path'
import { createClient } from '@supabase/supabase-js'
import OpenAI from 'openai'

// Cargar .env.local
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

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
)
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! })

const CHUNK_SIZE = 1500
const CHUNK_OVERLAP = 200

function chunkText(text: string): { content: string; index: number }[] {
  const chunks: { content: string; index: number }[] = []
  let start = 0, index = 0
  while (start < text.length) {
    let end = start + CHUNK_SIZE
    if (end < text.length) {
      const lastParagraph = text.lastIndexOf('\n\n', end)
      if (lastParagraph > start + CHUNK_SIZE * 0.5) end = lastParagraph
      else {
        const lastSentence = text.lastIndexOf('. ', end)
        if (lastSentence > start + CHUNK_SIZE * 0.5) end = lastSentence + 1
      }
    }
    const content = text.slice(start, end).trim()
    if (content.length > 50) { chunks.push({ content, index }); index++ }
    start = end - CHUNK_OVERLAP
    if (start < 0) start = 0
    if (end >= text.length) break
  }
  return chunks
}

async function main() {
  const filePath = path.join(process.cwd(), 'corpus', 'modulo_casos_complejos_PT_v1.0.md')
  console.log('📄 Procesando: modulo_casos_complejos_PT_v1.0.md')

  const text = fs.readFileSync(filePath, 'utf-8')
  console.log(`   ✅ Texto: ${text.length} caracteres`)

  const chunks = chunkText(text)
  console.log(`   ✅ ${chunks.length} chunks`)

  console.log('   🧠 Generando embeddings...')
  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: chunks.map(c => c.content),
  })
  console.log(`   ✅ ${response.data.length} embeddings`)

  console.log('   💾 Insertando en Supabase...')
  let ok = 0
  for (let i = 0; i < chunks.length; i++) {
    const { error } = await supabase.from('documents').insert({
      source_file: 'modulo_casos_complejos_PT_v1.0.md',
      source_type: 'modulo_casos_complejos',
      title: `Módulo Casos Complejos PT — chunk ${chunks[i].index}`,
      content: chunks[i].content,
      chapter: null,
      section: null,
      page_start: null,
      page_end: null,
      chunk_index: chunks[i].index,
      embedding: JSON.stringify(response.data[i].embedding),
    })
    if (error) console.error(`   ❌ Chunk ${i}: ${error.message}`)
    else ok++
  }
  console.log(`   ✅ ${ok}/${chunks.length} insertados`)

  const { count } = await supabase.from('documents').select('*', { count: 'exact', head: true })
  console.log(`\n📦 Total documentos en Supabase: ${count}`)
}

main().catch(err => { console.error('❌', err); process.exit(1) })