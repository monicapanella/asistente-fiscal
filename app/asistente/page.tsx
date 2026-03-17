'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'

export default function AsistentePage() {
  const [messages, setMessages] = useState<{role: string, content: string}[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
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
              maxWidth: '80%', padding: '12px 16px', borderRadius: 12,
              background: msg.role === 'user' ? '#264b6e' : 'white',
              color: msg.role === 'user' ? 'white' : '#1a2a3a',
              fontSize: 14, lineHeight: 1.6,
              boxShadow: '0 1px 4px rgba(38,75,110,0.08)',
              whiteSpace: 'pre-wrap'
            }}>
              {msg.content}
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
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }}}
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