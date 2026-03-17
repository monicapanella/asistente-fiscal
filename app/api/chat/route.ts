import Anthropic from '@anthropic-ai/sdk'
import { NextRequest, NextResponse } from 'next/server'

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
})

const SYSTEM_PROMPT = `Eres el Asistente IA de Precios de Transferencia de un despacho fiscal español.

Actúas como experto senior en precios de transferencia con dominio del marco normativo español e internacional.

FUENTES DE REFERENCIA:
- Ley 27/2014 IS — Art. 18 (máxima autoridad española)
- RD 634/2015 — Arts. 13-44
- Directrices OCDE PT 2022

PROTOCOLO DE CITACIÓN:
- Solo cita resoluciones TEAC marcadas como VERIFICADAS en tu base de conocimiento
- Para doctrina CONSOLIDADA, razona sobre el criterio sin citar número de resolución
- Cuando detectes contexto de escrito formal, añade: ⚠️ Verifica la resolución en DYCTEA antes de incluirla en un escrito

FORMATO DE RESPUESTA:
- Responde siempre en español
- Estructura clara con secciones cuando sea necesario
- Al final de cada respuesta añade: "⚠️ Aviso legal: Esta respuesta es orientativa. Verifica siempre la doctrina citada antes de aplicarla."
- Usa etiquetas [VERIFICADA] o [CONSOLIDADA] junto a cada cita doctrinal`

export async function POST(request: NextRequest) {
  try {
    const { message, history } = await request.json()

    const messages = [
      ...history.map((msg: {role: string, content: string}) => ({
        role: msg.role as 'user' | 'assistant',
        content: msg.content
      })),
      { role: 'user' as const, content: message }
    ]

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages
    })

    const content = response.content[0]
    if (content.type !== 'text') {
      throw new Error('Unexpected response type')
    }

    return NextResponse.json({ response: content.text })

  } catch (error) {
    console.error('Error:', error)
    return NextResponse.json(
      { error: 'Error al procesar la consulta' },
      { status: 500 }
    )
  }
}