'use client'

import { useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'

// ── Tipos ─────────────────────────────────────────────────────────────────────
type AssistantMode = 'pt' | 'fiscal'

interface ModeConfig {
  label: string
  subtitle: string
  endpoint: string
  placeholder: string
  welcomeIcon: string
  welcomeTitle: string
  welcomeDesc: string
  accentColor: string
}

const MODE_CONFIG: Record<AssistantMode, ModeConfig> = {
  pt: {
    label: 'Precios de Transferencia',
    subtitle: 'Precios de Transferencia',
    endpoint: '/api/chat',
    placeholder: 'Escribe tu consulta sobre precios de transferencia...',
    welcomeIcon: '⚖️',
    welcomeTitle: 'Asistente PT',
    welcomeDesc: 'Consulta doctrina TEAC, métodos de valoración, documentación y régimen sancionador en precios de transferencia.',
    accentColor: '#5abfc3',
  },
  fiscal: {
    label: 'Fiscal General',
    subtitle: 'Fiscal General',
    endpoint: '/api/chat-fiscal',
    placeholder: 'Escribe tu consulta fiscal (IRPF, IVA, IS, LGT, ISD, ITP...)...',
    welcomeIcon: '📋',
    welcomeTitle: 'Asistente Fiscal',
    welcomeDesc: 'Consulta normativa tributaria, doctrina TEAC/TEAR y resoluciones DGT en materia fiscal general.',
    accentColor: '#f7c52c',
  },
}

// ── Word HTML generator ────────────────────────────────────────────────────
function inlineMarkdown(text: string): string {
  const parts = text.split(/(<br\s*\/?>)/gi)
  return parts.map((part, idx) => {
    if (idx % 2 === 1) return part
    return part
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\*\*(.*?)\*\*/g, '<strong style="font-weight:bold;color:#264b6e">$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/`(.*?)`/g, '<code style="background:#f0f4f8;padding:2px 6px;border-radius:4px;font-size:12px">$1</code>')
  }).join('')
}

function buildWordHtml(markdown: string): string {
  const fixed = fixTableMarkdown(markdown)
  const lines = fixed.split('\n')
  let html = ''
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()

    if (trimmed.startsWith('|')) {
      const tableLines: string[] = []
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        tableLines.push(lines[i])
        i++
      }
      const parseRow = (row: string): string[] =>
        row.split('|').slice(1, -1).map(c => c.trim())
      const isSep = (row: string): boolean =>
        /^\|[\s\-:|]+\|/.test(row.trim())

      let headerIdx = -1, sepIdx = -1
      for (let j = 0; j < tableLines.length; j++) {
        if (isSep(tableLines[j])) { sepIdx = j; headerIdx = j - 1; break }
      }
      if (headerIdx >= 0 && sepIdx >= 0) {
        const headers = parseRow(tableLines[headerIdx])
        const bodyRows = tableLines.slice(sepIdx + 1).filter(r => !isSep(r))
        const colW = Math.floor(9360 / headers.length)

        html += `<table style="border-collapse:separate;border-spacing:0;width:100%;table-layout:fixed">`
        html += `<colgroup>${headers.map(() => `<col width="${colW}">`).join('')}</colgroup>`
        html += `<thead><tr>`
        headers.forEach(h => {
          const text = h.replace(/\*\*(.*?)\*\*/g, '$1').replace(/\*(.*?)\*/g, '$1')
          html += `<td width="${colW}" bgcolor="#264b6e" `
            + `style="background-color:#264b6e;color:white;padding:8px 12px;`
            + `text-align:left;font-weight:bold;font-size:12px;width:${colW}px">`
            + `${text}</td>`
        })
        html += `</tr></thead><tbody>`
        bodyRows.forEach(row => {
          const cells = parseRow(row)
          html += `<tr>`
          cells.forEach(cell => {
            html += `<td style="padding:7px 12px;border-bottom:1px solid #e8f0f7;`
              + `vertical-align:top;color:#1a2a3a">${inlineMarkdown(cell)}</td>`
          })
          html += `</tr>`
        })
        html += `</tbody></table>`
      }
      continue
    }

    if (trimmed.startsWith('## ')) {
      html += `<div style="font-size:15px;font-weight:700;color:#264b6e;margin-top:14px;`
        + `margin-bottom:6px;padding-bottom:4px;border-bottom:1px solid #e8f0f7">`
        + `${inlineMarkdown(trimmed.slice(3))}</div>`
    } else if (trimmed.startsWith('### ')) {
      html += `<div style="font-size:14px;font-weight:700;color:#368087;margin-top:10px;`
        + `margin-bottom:4px">${inlineMarkdown(trimmed.slice(4))}</div>`
    } else if (trimmed.startsWith('# ')) {
      html += `<div style="font-size:17px;font-weight:900;color:#264b6e;margin-top:16px;`
        + `margin-bottom:8px">${inlineMarkdown(trimmed.slice(2))}</div>`
    } else if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      html += `<div style="padding-left:16px;margin-bottom:4px;line-height:1.6">`
        + `<span style="color:#5abfc3">•</span> ${inlineMarkdown(trimmed.slice(2))}</div>`
    } else if (/^\d+\.\s/.test(trimmed)) {
      html += `<div style="padding-left:16px;margin-bottom:4px;line-height:1.6">`
        + `${inlineMarkdown(trimmed)}</div>`
    } else if (trimmed.startsWith('> ')) {
      html += `<div style="border-left:3px solid #5abfc3;padding-left:12px;margin:8px 0;`
        + `color:#368087;font-style:italic">${inlineMarkdown(trimmed.slice(2))}</div>`
    } else if (/^[-*_]{3,}$/.test(trimmed)) {
      html += `<div style="border-top:1px solid #e5e5e5;margin:12px 0"></div>`
    } else if (trimmed !== '') {
      html += `<div style="margin-bottom:8px;line-height:1.7">${inlineMarkdown(trimmed)}</div>`
    }
    i++
  }

  return `<html><head><meta charset="UTF-8"><style>`
    + `body{font-family:Lato,Arial,sans-serif;font-size:13px;color:#1a2a3a;line-height:1.6}`
    + `</style></head>`
    + `<body style="font-family:Lato,Arial,sans-serif;font-size:13px;color:#1a2a3a">`
    + `${html}</body></html>`
}
// ── End Word HTML generator ────────────────────────────────────────────────

function fixTableMarkdown(content: string): string {
  const lines = content.split('\n')
  const result: string[] = []
  let inTable = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    const isTableRow = trimmed.startsWith('|')
    const isSeparator = /^\|[\s\-:|]+\|/.test(trimmed)

    if (isTableRow) {
      inTable = !isSeparator || inTable
      result.push(line)
    } else if (inTable && trimmed.length > 0 && !trimmed.startsWith('#')) {
      const last = result[result.length - 1]
      if (last && last.trim().startsWith('|')) {
        result[result.length - 1] = last.trimEnd().replace(/\|(\s*)$/, `<br>${trimmed}|`)
      } else {
        inTable = false
        result.push(line)
      }
    } else {
      if (!isTableRow) inTable = false
      result.push(line)
    }
  }
  return result.join('\n')
}

// ── Extraer números de resolución de un texto ──────────────────────────────
function extractCitations(text: string): string[] {
  const pattern = /\b(\d{2}\/\d{4,5}\/\d{4})\b/g
  const matches = text.match(pattern)
  return matches ? [...new Set(matches)] : []
}

// ── Generar enlaces de verificación para una resolución ────────────────────
function getCitationLinks(citation: string) {
  const encoded = encodeURIComponent(citation)
  return {
    dyctea: `https://serviciostelematicosext.hacienda.gob.es/TEAC/DYCTEA/`,
    google: `https://www.google.com/search?q=site:serviciostelematicosext.hacienda.gob.es+%22${encoded}%22`,
  }
}

export default function AsistentePage() {
  const [messages, setMessages] = useState<{role: string, content: string}[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null)
  const [expandedCitations, setExpandedCitations] = useState<number | null>(null)
  const [activeMode, setActiveMode] = useState<AssistantMode>('pt')
  const [showSwitchConfirm, setShowSwitchConfirm] = useState<AssistantMode | null>(null)
  const messageRefs = useRef<(HTMLDivElement | null)[]>([])

  const config = MODE_CONFIG[activeMode]

  function handleModeSwitch(newMode: AssistantMode) {
    if (newMode === activeMode) return
    if (messages.length > 0) {
      setShowSwitchConfirm(newMode)
    } else {
      setActiveMode(newMode)
    }
  }

  function confirmModeSwitch() {
    if (showSwitchConfirm) {
      setActiveMode(showSwitchConfirm)
      setMessages([])
      setExpandedCitations(null)
      setCopiedIndex(null)
      setShowSwitchConfirm(null)
    }
  }

  async function handleCopy(content: string, index: number) {
    try {
      const html = buildWordHtml(content)
      const htmlBlob = new Blob([html], { type: 'text/html' })
      const textBlob = new Blob([content], { type: 'text/plain' })
      await navigator.clipboard.write([
        new ClipboardItem({ 'text/html': htmlBlob, 'text/plain': textBlob })
      ])
    } catch {
      await navigator.clipboard.writeText(content)
    }
    setCopiedIndex(index)
    setTimeout(() => setCopiedIndex(null), 2000)
  }

  const router = useRouter()

  async function handleLogout() {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login')
  }

  async function handleSend() {
    if (!input.trim() || loading) return
    const userMessage = input.trim()
    setInput('')
    setMessages(prev => [...prev, { role: 'user', content: userMessage }])
    setLoading(true)
    try {
      const response = await fetch(config.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: userMessage, history: messages })
      })
      const data = await response.json()
      setMessages(prev => [...prev, { role: 'assistant', content: data.response }])
    } catch {
      setMessages(prev => [...prev, { role: 'assistant', content: 'Error al conectar con el asistente. Inténtalo de nuevo.' }])
    }
    setLoading(false)
  }

  return (
    <div style={{ minHeight: '100vh', background: '#fbf6f3', fontFamily: 'Lato, sans-serif', display: 'flex', flexDirection: 'column' }}>

      {/* HEADER */}
      <div style={{ background: '#264b6e', padding: '16px 32px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 2, color: '#5abfc3', textTransform: 'uppercase' }}>Asistente Fiscal IA</div>
          <div style={{ fontSize: 16, fontWeight: 900, color: 'white' }}>{config.subtitle}</div>
        </div>

        {/* SELECTOR PT / FISCAL */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
          <div style={{
            display: 'flex',
            background: 'rgba(255,255,255,0.1)',
            borderRadius: 8,
            padding: 3,
            gap: 2,
          }}>
            {(['pt', 'fiscal'] as AssistantMode[]).map(mode => {
              const isActive = activeMode === mode
              const modeConf = MODE_CONFIG[mode]
              return (
                <button
                  key={mode}
                  onClick={() => handleModeSwitch(mode)}
                  style={{
                    background: isActive ? 'white' : 'transparent',
                    color: isActive ? '#264b6e' : 'rgba(255,255,255,0.7)',
                    border: 'none',
                    borderRadius: 6,
                    padding: '6px 16px',
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: 'pointer',
                    fontFamily: 'Lato, sans-serif',
                    transition: 'all 0.2s',
                    letterSpacing: 0.3,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {mode === 'pt' ? '⚖️' : '📋'} {modeConf.label}
                </button>
              )
            })}
          </div>

          <div style={{ width: 1, height: 24, background: 'rgba(255,255,255,0.2)', margin: '0 16px' }} />

          <button onClick={handleLogout} style={{ background: 'none', border: '1px solid rgba(255,255,255,0.3)', borderRadius: 6, padding: '6px 14px', color: 'rgba(255,255,255,0.7)', fontSize: 12, cursor: 'pointer', fontFamily: 'Lato, sans-serif' }}>
            Cerrar sesión
          </button>
        </div>
      </div>

      {/* MODAL CONFIRMACIÓN CAMBIO DE MODO */}
      {showSwitchConfirm && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(38,75,110,0.5)', display: 'flex',
          alignItems: 'center', justifyContent: 'center', zIndex: 1000,
        }}>
          <div style={{
            background: 'white', borderRadius: 16, padding: '28px 32px',
            maxWidth: 420, width: '90%', boxShadow: '0 8px 32px rgba(38,75,110,0.2)',
            fontFamily: 'Lato, sans-serif',
          }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#264b6e', marginBottom: 8 }}>
              Cambiar de asistente
            </div>
            <div style={{ fontSize: 14, color: '#5a7a8a', marginBottom: 20, lineHeight: 1.6 }}>
              Al cambiar a <strong style={{ color: '#264b6e' }}>{MODE_CONFIG[showSwitchConfirm].label}</strong> se borrará la conversación actual. ¿Continuar?
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setShowSwitchConfirm(null)}
                style={{
                  background: '#f0f4f8', color: '#5a7a8a', border: 'none',
                  borderRadius: 8, padding: '8px 20px', fontSize: 13,
                  fontWeight: 700, cursor: 'pointer', fontFamily: 'Lato, sans-serif',
                }}
              >
                Cancelar
              </button>
              <button
                onClick={confirmModeSwitch}
                style={{
                  background: '#264b6e', color: 'white', border: 'none',
                  borderRadius: 8, padding: '8px 20px', fontSize: 13,
                  fontWeight: 700, cursor: 'pointer', fontFamily: 'Lato, sans-serif',
                }}
              >
                Cambiar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* INDICADOR DE MODO ACTIVO (barra sutil bajo el header) */}
      <div style={{
        height: 3,
        background: config.accentColor,
        transition: 'background 0.3s',
      }} />

      {/* CHAT */}
      <div style={{ flex: 1, maxWidth: 800, width: '100%', margin: '0 auto', padding: '24px 24px 0', display: 'flex', flexDirection: 'column', gap: 16 }}>

        {messages.length === 0 && (
          <div style={{ textAlign: 'center', padding: '60px 20px' }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>{config.welcomeIcon}</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: '#264b6e', marginBottom: 8 }}>{config.welcomeTitle}</div>
            <div style={{ fontSize: 14, color: '#8bafc8', maxWidth: 400, margin: '0 auto' }}>
              {config.welcomeDesc}
            </div>
          </div>
        )}

        {messages.map((msg, i) => {
          const citations = msg.role === 'assistant' ? extractCitations(msg.content) : []
          const hasCitations = citations.length > 0
          const isExpanded = expandedCitations === i

          return (
            <div key={i} style={{ display: 'flex', justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start' }}>
              <div style={{
                maxWidth: '80%',
                padding: '12px 16px',
                borderRadius: 12,
                background: msg.role === 'user' ? '#264b6e' : 'white',
                color: msg.role === 'user' ? 'white' : '#1a2a3a',
                fontSize: 14,
                lineHeight: 1.6,
                boxShadow: '0 1px 4px rgba(38,75,110,0.08)',
              }}>
                {msg.role === 'user' ? (
                  <span style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</span>
                ) : (
                  <>
                  <div ref={el => { messageRefs.current[i] = el }}>
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    rehypePlugins={[rehypeRaw]}
                    components={{
                      h2: ({children}) => (
                        <div style={{ fontSize: 15, fontWeight: 700, color: '#264b6e', marginTop: 14, marginBottom: 6, paddingBottom: 4, borderBottom: '1px solid #e8f0f7' }}>
                          {children}
                        </div>
                      ),
                      h3: ({children}) => (
                        <div style={{ fontSize: 14, fontWeight: 700, color: '#368087', marginTop: 10, marginBottom: 4 }}>
                          {children}
                        </div>
                      ),
                      strong: ({children}) => (
                        <strong style={{ fontWeight: 700, color: '#264b6e' }}>{children}</strong>
                      ),
                      p: ({children}) => (
                        <div style={{ marginBottom: 8, lineHeight: 1.7 }}>{children}</div>
                      ),
                      ul: ({children}) => (
                        <div style={{ marginTop: 4, marginBottom: 8 }}>{children}</div>
                      ),
                      li: ({children}) => (
                        <div style={{ paddingLeft: 16, marginBottom: 4, lineHeight: 1.6, display: 'flex', gap: 8 }}>
                          <span style={{ color: '#5abfc3', flexShrink: 0 }}>•</span>
                          <span>{children}</span>
                        </div>
                      ),
                      hr: () => (
                        <div style={{ borderTop: '1px solid #e5e5e5', margin: '12px 0' }} />
                      ),
                      blockquote: ({children}) => (
                        <div style={{ borderLeft: '3px solid #5abfc3', paddingLeft: 12, margin: '8px 0', color: '#368087', fontStyle: 'italic' }}>
                          {children}
                        </div>
                      ),
                      code: ({children}) => (
                        <code style={{ background: '#f0f4f8', padding: '2px 6px', borderRadius: 4, fontSize: 13, color: '#264b6e' }}>
                          {children}
                        </code>
                      ),
                      table: ({children}) => (
                        <div style={{ overflowX: 'auto', margin: '12px 0' }}>
                          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                            {children}
                          </table>
                        </div>
                      ),
                      thead: ({children}) => (
                        <thead style={{ backgroundColor: '#264b6e', color: 'white' }}>{children}</thead>
                      ),
                      th: ({children}) => (
                        <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 700, fontSize: 12, color: 'white', backgroundColor: '#264b6e' }}>
                          {children}
                        </th>
                      ),
                      td: ({children}) => (
                        <td style={{ padding: '7px 12px', borderBottom: '1px solid #e8f0f7', color: '#1a2a3a' }}>
                          {children}
                        </td>
                      ),
                      tbody: ({children}) => (
                        <tbody style={{ background: 'white' }}>{children}</tbody>
                      ),
                      tr: ({children}) => (
                        <tr>{children}</tr>
                      ),
                    }}
                  >
                    {fixTableMarkdown(msg.content)}
                  </ReactMarkdown>
                  </div>

                  {/* BOTONES: Copiar + Verificar citas */}
                  <div style={{ marginTop: 8, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                    {hasCitations && (
                      <button
                        onClick={() => setExpandedCitations(isExpanded ? null : i)}
                        style={{
                          background: isExpanded ? '#368087' : '#fff7e0',
                          color: isExpanded ? 'white' : '#8a6d00',
                          border: isExpanded ? 'none' : '1px solid #f7c52c',
                          borderRadius: 6, padding: '4px 12px',
                          fontSize: 11, fontWeight: 700, cursor: 'pointer',
                          fontFamily: 'Lato, sans-serif', transition: 'all 0.2s',
                          letterSpacing: 0.5
                        }}
                      >
                        {isExpanded ? 'Ocultar citas' : `🔍 Verificar citas (${citations.length})`}
                      </button>
                    )}
                    <button
                      onClick={() => handleCopy(msg.content, i)}
                      style={{
                        background: copiedIndex === i ? '#368087' : '#f0f4f8',
                        color: copiedIndex === i ? 'white' : '#368087',
                        border: 'none', borderRadius: 6, padding: '4px 12px',
                        fontSize: 11, fontWeight: 700, cursor: 'pointer',
                        fontFamily: 'Lato, sans-serif', transition: 'all 0.2s',
                        letterSpacing: 0.5
                      }}
                    >
                      {copiedIndex === i ? '¡Copiado!' : 'Copiar'}
                    </button>
                  </div>

                  {/* PANEL DE VERIFICACIÓN DE CITAS */}
                  {isExpanded && hasCitations && (
                    <div style={{
                      marginTop: 8, padding: 12, borderRadius: 8,
                      background: '#f8fafb', border: '1px solid #e8f0f7'
                    }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: '#264b6e', marginBottom: 8 }}>
                        Verificar resoluciones citadas:
                      </div>
                      {citations.map((cite, ci) => {
                        const links = getCitationLinks(cite)
                        return (
                          <div key={ci} style={{
                            display: 'flex', alignItems: 'center', gap: 8,
                            padding: '6px 0',
                            borderBottom: ci < citations.length - 1 ? '1px solid #e8f0f7' : 'none'
                          }}>
                            <span style={{ fontSize: 13, fontWeight: 700, color: '#264b6e', minWidth: 130 }}>
                              {cite}
                            </span>
                            <a
                              href={links.dyctea}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{
                                fontSize: 11, fontWeight: 700, color: 'white',
                                background: '#368087', borderRadius: 4,
                                padding: '3px 10px', textDecoration: 'none',
                                transition: 'opacity 0.2s'
                              }}
                            >
                              DYCTEA
                            </a>
                            <a
                              href={links.google}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{
                                fontSize: 11, fontWeight: 700, color: '#368087',
                                background: 'white', border: '1px solid #368087',
                                borderRadius: 4, padding: '3px 10px',
                                textDecoration: 'none', transition: 'opacity 0.2s'
                              }}
                            >
                              Buscar en Google
                            </a>
                          </div>
                        )
                      })}
                      <div style={{ fontSize: 10, color: '#8bafc8', marginTop: 8, lineHeight: 1.4 }}>
                        Verifica siempre las resoluciones en fuentes oficiales antes de incluirlas en escritos formales.
                      </div>
                    </div>
                  )}
                  </>
                )}
              </div>
            </div>
          )
        })}

        {loading && (
          <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
            <div style={{ background: 'white', padding: '12px 16px', borderRadius: 12, fontSize: 14, color: '#8bafc8', boxShadow: '0 1px 4px rgba(38,75,110,0.08)' }}>
              Analizando consulta...
            </div>
          </div>
        )}
      </div>

      {/* INPUT */}
      <div style={{ maxWidth: 800, width: '100%', margin: '0 auto', padding: 24 }}>
        <div style={{ display: 'flex', gap: 12, background: 'white', borderRadius: 12, padding: 12, boxShadow: '0 1px 4px rgba(38,75,110,0.08)' }}>
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
            placeholder={config.placeholder}
            rows={3}
            style={{ flex: 1, border: 'none', outline: 'none', resize: 'none', fontSize: 14, fontFamily: 'Lato, sans-serif', color: '#1a2a3a', lineHeight: 1.5 }}
          />
          <button
            onClick={handleSend}
            disabled={loading || !input.trim()}
            style={{ background: loading || !input.trim() ? '#e5e5e5' : '#264b6e', color: 'white', border: 'none', borderRadius: 8, padding: '0 20px', cursor: loading || !input.trim() ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'Lato, sans-serif', transition: 'background 0.2s' }}
          >
            Enviar
          </button>
        </div>
        <div style={{ textAlign: 'center', fontSize: 11, color: '#c8d8e8', marginTop: 8 }}>
          Enter para enviar · Shift+Enter para nueva línea
        </div>
      </div>

    </div>
  )
}
