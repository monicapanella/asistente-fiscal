import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'

// ============================================
// API ROUTE: /api/feedback
// Recibe feedback sobre fichas de investigación
// y escribe en pending_citations si es "verified"
// ============================================

interface FeedbackRequest {
  card: {
    id: string
    source: string
    resolution_number: string | null
    date: string | null
    criterion: string
    relevance: string
    applicability: string
    verification_url: string | null
    title: string
  }
  feedback: 'useful' | 'not_relevant' | 'verified'
  assistant_type: 'pt' | 'fiscal'
  query_text: string
}

// Convierte fecha DD/MM/YYYY a YYYY-MM-DD (formato PostgreSQL date)
function parseDate(dateStr: string | null): string | null {
  if (!dateStr) return null
  const match = dateStr.match(/^(\d{2})\/(\d{2})\/(\d{4})$/)
  if (match) {
    return `${match[3]}-${match[2]}-${match[1]}`
  }
  // Si ya está en formato YYYY-MM-DD o no es parseable, devolver tal cual
  return dateStr
}

export async function POST(request: NextRequest) {
  try {
    const body: FeedbackRequest = await request.json()
    const { card, feedback, assistant_type, query_text } = body

    // Validar campos mínimos
    if (!card || !feedback || !assistant_type) {
      return NextResponse.json(
        { error: 'Campos requeridos: card, feedback, assistant_type' },
        { status: 400 }
      )
    }

    const supabase = createServiceClient()

    if (feedback === 'verified') {
      // Insertar en pending_citations para revisión por Monica
      const { error } = await supabase.from('pending_citations').insert({
        tenant_id: 'picas',
        resolution_number: card.resolution_number || `PENDIENTE-${card.id.slice(0, 8)}`,
        source: card.source,
        resolution_date: parseDate(card.date),
        criterion: card.criterion,
        keywords: [],
        suggested_doctrinal_block: null,
        suggested_block_section: null,
        raw_investigation_data: {
          original_card: card,
          query_text,
          assistant_type,
          feedback_timestamp: new Date().toISOString(),
        },
        status: 'pending',
        notes: `Marcada como verificada por el abogado. Fuente: ${card.source}. Título: ${card.title}. Relevancia: ${card.relevance}`,
      })

      if (error) {
        console.error('Error insertando en pending_citations:', error)
        return NextResponse.json(
          { error: 'Error guardando la ficha para revisión', detail: error.message },
          { status: 500 }
        )
      }

      console.log(`📥 Ficha marcada como verificada → pending_citations: ${card.resolution_number || card.title}`)

    } else {
      // Para 'useful' y 'not_relevant', solo logueamos
      console.log(`📊 Feedback "${feedback}" para ficha: ${card.resolution_number || card.title} (${assistant_type})`)
    }

    return NextResponse.json({ ok: true, feedback })

  } catch (error) {
    console.error('Error en /api/feedback:', error)
    return NextResponse.json(
      { error: 'Error procesando el feedback' },
      { status: 500 }
    )
  }
}
