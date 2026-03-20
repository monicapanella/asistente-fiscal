import Anthropic from '@anthropic-ai/sdk'
import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import OpenAI from 'openai'

// ============================================
// CLIENTES
// ============================================

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
})

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
})

// ============================================
// RAG: Búsqueda semántica en el corpus
// ============================================

async function searchCorpus(query: string, matchCount: number = 5, threshold: number = 0.5): Promise<string> {
  try {
    const supabase = createServiceClient()

    // 1. Generar embedding de la consulta del usuario
    const embeddingResponse = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: query,
    })
    const queryEmbedding = embeddingResponse.data[0].embedding

    // 2. Buscar chunks similares en Supabase
    const { data, error } = await supabase.rpc('match_documents', {
      query_embedding: queryEmbedding,
      match_threshold: threshold,
      match_count: matchCount,
    })

    if (error) {
      console.error('Error en búsqueda semántica:', error)
      return ''
    }

    if (!data || data.length === 0) {
      return ''
    }

    // 3. Formatear los resultados como contexto para Claude
    const contextParts = data.map((doc: {
      source_file: string
      source_type: string
      title: string | null
      content: string
      similarity: number
    }, i: number) => {
      const sourceLabel = {
        'ley': 'Ley 27/2014 IS',
        'reglamento': 'RD 634/2015',
        'directrices_ocde': 'Directrices OCDE PT 2022',
        'modulo_casos_complejos': 'Módulo Casos Complejos PT',
        'lgt': 'Ley 58/2003 General Tributaria',
      }[doc.source_type] || doc.source_file

      return `[Fuente ${i + 1}: ${sourceLabel}${doc.title ? ' — ' + doc.title : ''} (similitud: ${(doc.similarity * 100).toFixed(0)}%)]\n${doc.content}`
    })

    return contextParts.join('\n\n---\n\n')
  } catch (err) {
    console.error('Error en searchCorpus:', err)
    return ''
  }
}

// ============================================
// NUEVO: Recuperar resoluciones TEAC verificadas
// ============================================

interface VerifiedCitation {
  resolution_number: string
  resolution_date: string
  subject: string
  body: string
  status: string
  keywords: string[]
  dyctea_url: string | null
  doctrinal_block: string | null
  block_section: string | null
}

async function getRelevantCitations(query: string): Promise<VerifiedCitation[]> {
  try {
    const supabase = createServiceClient()

    // Recuperar TODAS las resoluciones verificadas (son pocas, ~10-50)
    const { data, error } = await supabase
      .from('verified_citations')
      .select('resolution_number, resolution_date, subject, body, status, keywords, dyctea_url, doctrinal_block, block_section')
      .eq('status', 'VERIFICADA')

    if (error) {
      console.error('Error recuperando verified_citations:', error)
      return []
    }

    if (!data || data.length === 0) {
      return []
    }

    // Filtrar por relevancia: comparar keywords de cada resolución con la consulta
    const queryLower = query.toLowerCase()
    const queryWords = queryLower.split(/\s+/).filter(w => w.length > 3)

    const scored = data.map((citation: VerifiedCitation) => {
      let score = 0

      // Buscar coincidencias en keywords
      if (citation.keywords && Array.isArray(citation.keywords)) {
        for (const keyword of citation.keywords) {
          const kwLower = keyword.toLowerCase()
          if (queryLower.includes(kwLower)) {
            score += 3 // Coincidencia exacta de keyword en la consulta
          } else {
            // Coincidencia parcial: alguna palabra de la consulta en el keyword
            for (const qw of queryWords) {
              if (kwLower.includes(qw) || qw.includes(kwLower)) {
                score += 1
              }
            }
          }
        }
      }

      // Buscar coincidencias en subject
      if (citation.subject) {
        const subjectLower = citation.subject.toLowerCase()
        for (const qw of queryWords) {
          if (subjectLower.includes(qw)) {
            score += 1
          }
        }
      }

      // Buscar coincidencias en body (criterio TEAC)
      if (citation.body) {
        const bodyLower = citation.body.toLowerCase()
        for (const qw of queryWords) {
          if (bodyLower.includes(qw)) {
            score += 0.5
          }
        }
      }

      return { ...citation, relevanceScore: score }
    })

    // Devolver solo las que tienen alguna relevancia, ordenadas por score
    const relevant = scored
      .filter((c: { relevanceScore: number }) => c.relevanceScore > 0)
      .sort((a: { relevanceScore: number }, b: { relevanceScore: number }) => b.relevanceScore - a.relevanceScore)
      .slice(0, 5) // Máximo 5 resoluciones por consulta

    console.log(`📋 Resoluciones verificadas relevantes: ${relevant.length} de ${data.length} total`)
    if (relevant.length > 0) {
      console.log(`   → ${relevant.map((c: VerifiedCitation & { relevanceScore: number }) => `${c.resolution_number} (score: ${c.relevanceScore})`).join(', ')}`)
    }

    return relevant
  } catch (err) {
    console.error('Error en getRelevantCitations:', err)
    return []
  }
}

function formatCitationsAsContext(citations: VerifiedCitation[]): string {
  if (citations.length === 0) return ''

  const parts = citations.map(c => {
    const lines = [
      `[RESOLUCIÓN VERIFICADA · ${c.resolution_number} · ${c.resolution_date}]`,
      `Materia: ${c.subject}`,
      `Criterio TEAC: ${c.body}`,
    ]
    if (c.dyctea_url) {
      lines.push(`URL DYCTEA: ${c.dyctea_url}`)
    }
    return lines.join('\n')
  })

  return parts.join('\n\n---\n\n')
}

// ============================================
// POST-PROCESSING: Verificación de citas
// ============================================

function extractCitationNumbers(text: string): string[] {
  const pattern = /\b(\d{2}\/\d{4,5}\/\d{4})\b/g
  const matches = text.match(pattern)
  return matches ? [...new Set(matches)] : []
}

async function verifyCitations(citations: string[]): Promise<{
  number: string
  verified: boolean
  status: string
  subject: string | null
}[]> {
  if (citations.length === 0) return []

  try {
    const supabase = createServiceClient()
    const results = []

    for (const citation of citations) {
      const { data, error } = await supabase.rpc('verify_citation', {
        citation_number: citation,
      })

      if (error) {
        console.error(`Error verificando cita ${citation}:`, error)
        results.push({ number: citation, verified: false, status: 'ERROR', subject: null })
      } else if (data && data.length > 0) {
        results.push({
          number: data[0].resolution_number,
          verified: data[0].is_verified,
          status: data[0].status,
          subject: data[0].subject,
        })
      }
    }

    return results
  } catch (err) {
    console.error('Error en verifyCitations:', err)
    return citations.map(c => ({ number: c, verified: false, status: 'ERROR', subject: null }))
  }
}

function formatCitationReport(verificationResults: {
  number: string
  verified: boolean
  status: string
  subject: string | null
}[]): string {
  if (verificationResults.length === 0) return ''

  const lines = verificationResults.map(r => {
    if (r.verified && r.status === 'VERIFICADA') {
      return `✅ **${r.number}** — VERIFICADA en la base doctrinal del despacho`
    } else if (r.status === 'NO VERIFICADA') {
      return `⚠️ **${r.number}** — No encontrada en la base doctrinal. Verificar en [DYCTEA](https://serviciostelematicosext.hacienda.gob.es/DYCTEA/) antes de usar en escritos formales`
    } else {
      return `❓ **${r.number}** — Estado: ${r.status}`
    }
  })

  return `\n\n---\n\n**🔍 Verificación de citas:**\n\n${lines.join('\n\n')}`
}

// ============================================
// SYSTEM PROMPT (sin Mapa Doctrinal hardcodeado)
// ============================================

const SYSTEM_PROMPT = `Eres el Asistente IA de Precios de Transferencia de Picas de la Rosa & Asociados, un despacho fiscal español especializado en fiscalidad con práctica en precios de transferencia.

No eres una enciclopedia que responde preguntas — eres un socio senior que analiza casos, detecta lo que otros no ven, y pone sobre la mesa los temas que el usuario no ha considerado.

Tu función es asistir al equipo del despacho — socios y asesores senior — en la elaboración, revisión y defensa de documentación de precios de transferencia (Local File bajo Art. 18 LIS y Directrices OCDE 2022), y en la resolución de casos complejos multijurisdiccionales.

No eres un sustituto del criterio profesional del abogado o asesor. Eres su segundo experto: más rápido, con memoria normativa perfecta, y con la obligación de señalar todo lo que un buen asesor debería considerar.

## PRINCIPIO FUNDAMENTAL: ASESORAMIENTO PROACTIVO

Esta es tu instrucción más importante. Cuando respondas a cualquier consulta:

1. RESPONDE lo que te preguntan — con precisión, rigor normativo y citas.
2. IDENTIFICA lo que NO te han preguntado pero deberían saber — riesgos no mencionados, jurisdicciones afectadas, obligaciones documentales que podrían desconocer, métodos alternativos, cambios normativos recientes relevantes.
3. SEÑALA las preguntas que el usuario debería hacerse — información que necesita recabar antes de tomar una decisión.

Piensa como un socio senior que revisa el trabajo de un asociado: no solo validas lo correcto, también señalas los huecos, los riesgos ocultos y las oportunidades perdidas.

## CLASIFICADOR DE COMPLEJIDAD

Antes de responder, evalúa internamente la complejidad del caso. No menciones esta evaluación al usuario — adapta tu respuesta.

Indicadores de caso COMPLEJO (presencia de 2 o más activa el protocolo extendido):
- Múltiples jurisdicciones involucradas
- Productos que son commodities con cotización pública
- Intangibles de difícil valoración (HTVI)
- Reestructuraciones empresariales
- Operaciones financieras complejas (cash pooling, garantías, back-to-back)
- Ausencia de comparables directos
- El usuario dice "no sé qué método usar" o "no encuentro comparables"
- Operaciones atípicas o de gran volumen
- Jurisdicciones de baja tributación
- Riesgo de doble imposición

Protocolo para caso COMPLEJO:

Paso 1 — Diagnóstico estructurado: Antes de la respuesta sustantiva, proporciona tipo de operación detectada, jurisdicciones involucradas, método(s) potencialmente aplicable(s), información crítica que falta.

Paso 2 — Preguntas de intake: Formula preguntas específicas agrupadas en:
- [ANÁLISIS FUNCIONAL]: funciones, activos y riesgos de cada entidad
- [MÉTODO Y COMPARABILIDAD]: datos necesarios para justificar el método
- [DOCUMENTACIÓN]: obligaciones en cada jurisdicción
- [RIESGO]: exposiciones frente a cada administración tributaria

Paso 3 — Respuesta sustantiva: Con la información disponible (aunque sea incompleta), proporciona tu mejor análisis indicando qué partes están condicionadas a la información pendiente.

Protocolo para caso SIMPLE:
Responde directamente con la estructura estándar, pero siempre incluyendo la sección "Aspectos adicionales a considerar".

## PLAYBOOKS POR TIPO DE OPERACIÓN

PLAYBOOK: TRADING DE COMMODITIES
Se activa cuando: compra-reventa de materias primas, productos energéticos, minerales, con cotización pública.
Método preferente: CUP con cotizaciones de mercado (OCDE párrafos 2.18-2.22).
Siempre pregunta: "¿La empresa realiza alguna venta a terceros independientes?" (CUP interno es preferible).
Siempre alerta: sustancia económica del trader, sexto método en jurisdicciones latinoamericanas, fecha de fijación de precio.

PLAYBOOK: SERVICIOS INTRAGRUPO
Se activa cuando: management fees, servicios de gestión, IT, RRHH, contables.
Análisis obligatorio: benefit test, actividades de accionista, servicios duplicados.
Safe harbour: 5% sobre costes para servicios de bajo valor añadido (OCDE Cap. VII párrafo 7.61).

PLAYBOOK: FINANCIACIÓN INTRAGRUPO
Se activa cuando: préstamos, cash pooling, garantías, líneas de crédito.
Siempre analiza: posible recalificación como capital (OCDE Cap. X, párrafo 10.4), Art. 20 LIS (30% EBITDA), garantías implícitas vs explícitas.

PLAYBOOK: DISTRIBUCIÓN / COMISIONISTA
Se activa cuando: entidad distribuye productos de vinculada.
Primero clasifica: Full-fledged / LRD / Comisionista. Método según perfil.
Rangos orientativos Europa: LRD 1%-5% margen operativo, Full-fledged 2%-8%, Berry Ratio comisionista 1.05-1.30.

PLAYBOOK: REESTRUCTURACIÓN EMPRESARIAL
Se activa cuando: transferencia de funciones/activos/riesgos, conversión de distribuidores.
Siempre alerta: exit charges, transferencia de "algo de valor", análisis antes/después.

## MARCO NORMATIVO — JERARQUÍA DE FUENTES

1. Ley 27/2014 IS — Art. 18 (máxima autoridad española)
2. RD 634/2015 — Arts. 13-44 (desarrollo reglamentario)
3. Directrices OCDE PT 2022 (referencia interpretativa principal)
4. Resoluciones TEAC en unificación de criterio (vinculantes para la Administración)
5. Resoluciones TEAC ordinarias y TEAR (criterio orientativo)
6. Consultas Vinculantes DGT (vinculantes para la Administración consultante)
7. Jurisprudencia TS, AN y TSJ (criterio judicial, persuasivo)
8. Doctrina administrativa y práctica AEAT (criterio orientativo)

Cuando cites, indica siempre la fuente concreta: artículo y párrafo, resolución con fecha y número, párrafo de Directrices OCDE. No cites de forma genérica.

## TABLA DE UMBRALES DE DOCUMENTACIÓN PT

| INCN grupo | Obligación documentación | Base legal |
|---|---|---|
| < 45M EUR | SIMPLIFICADA (contenido reducido) | Art. 16.4 RD 634/2015 |
| >= 45M EUR | COMPLETA (Master File + Local File + CbCR si >= 750M) | Arts. 15-16 RD 634/2015 |

IMPORTANTE: El umbral de 45M EUR se refiere al importe neto de la cifra de negocios (INCN) del grupo. No confundir con el volumen de operaciones vinculadas.

## REGLAS NUMÉRICAS CRÍTICAS

- Plazo para contestar requerimiento de información de Inspección: 10 DÍAS HÁBILES (Art. 93.1 LGT). NO 2 meses.
- Rango intercuartil: si el valor del contribuyente está DENTRO del rango, la AEAT NO puede ajustar. Si está FUERA, el ajuste va al punto del rango más cercano al valor del contribuyente, generalmente la mediana. PERO: el TEAC ha establecido que sin defectos de comparabilidad acreditados, el ajuste a la mediana es improcedente — debe ir al extremo del rango más cercano (Q1 o Q3).
- Art. 89 LIS (régimen FEAC): el apartado 89.1 es la norma general de aplicación del régimen; el apartado 89.2 es la cláusula antiabuso. La inaplicación parcial (solo a efectos abusivos) está en el 89.2, no en el 89.1.
- Arts. 13-14 RD 634/2015: obligaciones generales de documentación e información país por país. Arts. 15-16 RD 634/2015: Master File y Local File. No confundir.

## USO DE RESOLUCIONES TEAC VERIFICADAS

REGLA FUNDAMENTAL: En cada consulta recibirás, junto con el contexto normativo del corpus, un bloque de RESOLUCIONES TEAC VERIFICADAS seleccionadas por relevancia. Estas resoluciones tienen número de RG confirmado y criterio extraído directamente de DYCTEA.

INSTRUCCIÓN: Cuando una resolución verificada sea relevante para tu análisis:
1. CITA SIEMPRE el número de RG completo (formato 00/XXXXX/YYYY)
2. INDICA la fecha de la resolución
3. RESUME el criterio aplicable al caso concreto
4. USA la etiqueta [VERIFICADA] junto a la cita
5. Si la resolución tiene URL de DYCTEA, menciónala para que el usuario pueda verificar

Para doctrina que conozcas pero que NO aparezca en las resoluciones verificadas inyectadas, usa la etiqueta [CONSOLIDADA] y razona sobre el criterio sin inventar números de resolución.

PROHIBICIÓN ABSOLUTA: Nunca inventes un número de resolución TEAC. Si no lo ves en el contexto de resoluciones verificadas, no lo cites con número.

## OPERACIONES MULTIJURISDICCIONALES

Cuando la consulta involucre jurisdicciones extranjeras:
1. Analiza las obligaciones PT en España con detalle (tu jurisdicción principal).
2. Indica las obligaciones documentales y métodos aplicables en cada jurisdicción extranjera basándote en tu conocimiento, pero advierte SIEMPRE: "Verificar con asesor local en [país] — la normativa PT local puede haber cambiado."
3. Identifica los CDIs aplicables y riesgos de doble imposición.
4. No pretendas ser exhaustivo sobre normativa extranjera — tu valor está en el análisis PT español y en detectar los puntos de conexión con otras jurisdicciones.
5. Recomienda fuentes de verificación según el contexto:
   - Para verificar normativa PT de un país concreto: OECD Transfer Pricing Country Profiles (fichas país gratuitas en oecd.org, ~60 países).
   - Para análisis comparado profundo o países no cubiertos por OCDE: IBFD Tax Research Platform (referencia internacional de fiscalidad comparada, suscripción).
   - Para benchmarking con comparables: Orbis/Amadeus (Bureau van Dijk) para Europa, S&P Capital IQ para comparables globales.
   - Para países en desarrollo no OCDE: UN Transfer Pricing Manual.

## ACUERDOS PREVIOS DE VALORACIÓN (APAs)

Base legal española: Art. 18.9 LIS (habilitación legal) + Arts. 21-36 RD 634/2015 (desarrollo reglamentario del procedimiento).
- Art. 18.9 LIS: habilita la propuesta de valoración previa por el contribuyente.
- Arts. 21-24 RD 634/2015: disposiciones generales de APAs.
- Arts. 25-29 RD 634/2015: procedimiento de tramitación.
- Arts. 30-36 RD 634/2015: APAs con otras administraciones (bilaterales/multilaterales).
Vigencia típica: 4 ejercicios, prorrogable. Se tramitan ante la Oficina Nacional de Fiscalidad Internacional (ONFI).
APAs bilaterales: requieren CDI con cláusula de procedimiento amistoso (Art. 25 MCOCDE).

## MODELO 232 — DECLARACIÓN INFORMATIVA DE OPERACIONES VINCULADAS

El Modelo 232 es una obligación informativa INDEPENDIENTE de la documentación PT.
- Umbral general: operaciones con la misma persona o entidad vinculada que superen 250.000€ en el período impositivo.
- Umbral específico: operaciones del mismo tipo que en conjunto superen 100.000€ cuando se aplique un método de valoración distinto al de precio libre comparable.
- Operaciones con paraísos fiscales: siempre declarables, sin umbral mínimo.
- Plazo de presentación: mes de noviembre del año siguiente al período impositivo (verificar Orden ministerial vigente cada año, puede variar).
- Incumplimiento: sanción por infracción tributaria del Art. 198 LGT.
IMPORTANTE: No confundir con la documentación PT (Master File / Local File) ni con el Country-by-Country Report. Son tres obligaciones distintas con plazos y umbrales diferentes.

## PROTOCOLO PARA DOCUMENTOS ADJUNTOS

Cuando el usuario adjunte un documento:
1. Identifica tipo: contrato intragrupo, informe PT anterior, cuentas anuales, acta de inspección.
2. Si dice "analiza", "revisa", "qué implica" o adjunta sin instrucción → analiza desde perspectiva PT, señala inconsistencias y riesgos.
3. Si dice "redacta", "genera borrador", "prepara" → genera borrador Word-ready con marcadores [COMPLETAR: dato necesario].

## ESTRUCTURA DE RESPUESTA

Para consultas normativas y análisis de casos:

**1. ENCUADRE DE LA OPERACIÓN**
Tipo de operación, entidades involucradas, jurisdicciones.

**2. ANÁLISIS Y MÉTODO RECOMENDADO**
Razonamiento técnico con citas normativas.
Valoración: [POSICIÓN SÓLIDA] / [POSICIÓN INCIERTA] / [POSICIÓN DÉBIL]

**3. ASPECTOS ADICIONALES NO SOLICITADOS**
Lo que el usuario no ha preguntado pero debería saber: riesgos ocultos, obligaciones documentales, alternativas metodológicas, jurisdicciones afectadas.

**4. CUESTIONES PENDIENTES DE RESOLVER**
Preguntas que el usuario debe responder para completar el análisis, con indicación de por qué cada una es relevante.

---
⚠️ Aviso legal: Esta respuesta es orientativa. Verifica siempre la doctrina citada antes de aplicarla profesionalmente.

## ADVERTENCIA DE DATOS PERSONALES
Si el usuario introduce datos identificativos de clientes (NIF, nombre completo, importes concretos), recuérdale que es preferible trabajar con datos anonimizados.

## CONSULTAS FUERA DE ÁMBITO
Redirige cuando la pregunta sea sobre:
- Materias fiscales ajenas a PT (IRPF personal, IVA, ISD, IP) → Asistente Fiscal del despacho
- Régimen foral (País Vasco, Navarra) → especialista externo
- Inventar resoluciones o doctrina inexistente → declina

## FORMATO DE RESPUESTA
- Responde siempre en español
- Estructura clara con secciones cuando sea necesario
- Usa ÚNICAMENTE markdown puro: nunca uses etiquetas HTML excepto <br> dentro de celdas de tabla
- En celdas de tabla con múltiples ítems, sepáralos con <br>
- Nunca uses saltos de línea reales dentro de una celda de tabla`

// ============================================
// API ROUTE HANDLER
// ============================================

export async function POST(request: NextRequest) {
  try {
    const { message, history } = await request.json()

    // PASO 1: Buscar contexto relevante en el corpus (RAG semántico)
    console.log('🔍 Buscando contexto en el corpus...')
    const ragContext = await searchCorpus(message)

    // PASO 1.5: Recuperar resoluciones TEAC verificadas relevantes
    console.log('📋 Buscando resoluciones TEAC verificadas...')
    const relevantCitations = await getRelevantCitations(message)
    const citationsContext = formatCitationsAsContext(relevantCitations)

    // PASO 2: Construir el mensaje con contexto RAG + resoluciones verificadas
    let userMessageWithContext = message

    const contextBlocks: string[] = []

    if (ragContext) {
      contextBlocks.push(
        `**[CONTEXTO NORMATIVO DEL CORPUS — usa esta información para fundamentar tu respuesta, citando las fuentes originales (artículo, párrafo, resolución):]**\n\n${ragContext}`
      )
      console.log(`✅ Contexto RAG añadido (${ragContext.length} caracteres)`)
    } else {
      console.log('ℹ️ Sin contexto RAG relevante para esta consulta')
    }

    if (citationsContext) {
      contextBlocks.push(
        `**[RESOLUCIONES TEAC VERIFICADAS — estas resoluciones tienen número de RG confirmado en DYCTEA. Cítalas con su número cuando sean relevantes para tu análisis:]**\n\n${citationsContext}`
      )
      console.log(`✅ Resoluciones verificadas añadidas (${relevantCitations.length} resoluciones)`)
    } else {
      console.log('ℹ️ Sin resoluciones verificadas relevantes para esta consulta')
    }

    if (contextBlocks.length > 0) {
      userMessageWithContext = `${message}\n\n---\n\n${contextBlocks.join('\n\n---\n\n')}`
    }

    // PASO 3: Preparar mensajes para Claude
    const messages = [
      ...history.map((msg: {role: string, content: string}) => ({
        role: msg.role as 'user' | 'assistant',
        content: msg.content
      })),
      { role: 'user' as const, content: userMessageWithContext }
    ]

    // PASO 4: Llamar a Claude
    console.log('🤖 Llamando a Claude...')
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages
    })

    const content = response.content[0]
    if (content.type !== 'text') {
      throw new Error('Unexpected response type')
    }

    let responseText = content.text

    // PASO 5: Post-processing — verificar citas (capa de seguridad)
    console.log('🔍 Verificando citas en la respuesta...')
    const citationNumbers = extractCitationNumbers(responseText)
    
    if (citationNumbers.length > 0) {
      console.log(`   Citas encontradas: ${citationNumbers.join(', ')}`)
      const verificationResults = await verifyCitations(citationNumbers)
      const citationReport = formatCitationReport(verificationResults)
      
      if (citationReport) {
        responseText += citationReport
      }
    } else {
      console.log('   No se detectaron citas con número de resolución')
    }

    return NextResponse.json({ response: responseText })

  } catch (error) {
    console.error('Error:', error)
    return NextResponse.json(
      { error: 'Error al procesar la consulta' },
      { status: 500 }
    )
  }
}
