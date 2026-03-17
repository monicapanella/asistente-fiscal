'use client'

import { useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'

// ── Word HTML generator ────────────────────────────────────────────────────
// Converts markdown directly to Word-compatible HTML WITHOUT going through
// the DOM. This avoids the browser normalising hex colours to rgb() in
// element.innerHTML, which caused Word to drop the last-column background.
function inlineMarkdown(text: string): string {
  // Split on <br> tags inserted by fixTableMarkdown so we don't escape them
  const parts = text.split(/(<br\s*\/?>)/gi)
  return parts.map((part, idx) => {
    if (idx % 2 === 1) return part // preserve <br>
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

    // ── Table ──────────────────────────────────────────────────────────────
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

        // Header cells: built directly from markdown text with hex colors.
        // No DOM → no rgb() normalisation → Word gets #264b6e for every cell.
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

    // ── Headings ───────────────────────────────────────────────────────────
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
    // ── List items ─────────────────────────────────────────────────────────
    } else if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      html += `<div style="padding-left:16px;margin-bottom:4px;line-height:1.6">`
        + `<span style="color:#5abfc3">•</span> ${inlineMarkdown(trimmed.slice(2))}</div>`
    } else if (/^\d+\.\s/.test(trimmed)) {
      html += `<div style="padding-left:16px;margin-bottom:4px;line-height:1.6">`
        + `${inlineMarkdown(trimmed)}</div>`
    // ── Blockquote ─────────────────────────────────────────────────────────
    } else if (trimmed.startsWith('> ')) {
      html += `<div style="border-left:3px solid #5abfc3;padding-left:12px;margin:8px 0;`
        + `color:#368087;font-style:italic">${inlineMarkdown(trimmed.slice(2))}</div>`
    // ── HR ─────────────────────────────────────────────────────────────────
    } else if (/^[-*_]{3,}$/.test(trimmed)) {
      html += `<div style="border-top:1px solid #e5e5e5;margin:12px 0"></div>`
    // ── Paragraph ──────────────────────────────────────────────────────────
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
      // Line spilled out of a table cell — append to last table row's last cell
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

export default function AsistentePage() {
  const [messages, setMessages] = useState<{role: string, content: string}[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null)
  const messageRefs = useRef<(HTMLDivElement | null)[]>([])

  async function handleCopy(content: string, index: number) {
    // Build Word-compatible HTML directly from markdown — bypasses the DOM
    // entirely so hex colours are never normalised to rgb() by the browser.
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
  const supabase = createClient()

  async function handleLogout() {
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
      const response = await fetch('/api/chat', {
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
          <div style={{ fontSize: 16, fontWeight: 900, color: 'white' }}>Precios de Transferencia</div>
        </div>
        <button onClick={handleLogout} style={{ background: 'none', border: '1px solid rgba(255,255,255,0.3)', borderRadius: 6, padding: '6px 14px', color: 'rgba(255,255,255,0.7)', fontSize: 12, cursor: 'pointer', fontFamily: 'Lato, sans-serif' }}>
          Cerrar sesión
        </button>
      </div>

      {/* CHAT */}
      <div style={{ flex: 1, maxWidth: 800, width: '100%', margin: '0 auto', padding: '24px 24px 0', display: 'flex', flexDirection: 'column', gap: 16 }}>

        {messages.length === 0 && (
          <div style={{ textAlign: 'center', padding: '60px 20px' }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>⚖️</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: '#264b6e', marginBottom: 8 }}>Asistente PT</div>
            <div style={{ fontSize: 14, color: '#8bafc8', maxWidth: 400, margin: '0 auto' }}>
              Consulta doctrina TEAC, métodos de valoración, documentación y régimen sancionador en precios de transferencia.
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
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
                <div style={{ marginTop: 8, display: 'flex', justifyContent: 'flex-end' }}>
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
                </>
              )}
            </div>
          </div>
        ))}

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
            placeholder="Escribe tu consulta sobre precios de transferencia..."
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
