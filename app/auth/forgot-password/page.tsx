'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase'

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const supabase = createClient()

  async function handleSubmit() {
    setLoading(true)
    setError('')
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: 'https://asistente-fiscal.vercel.app/auth/reset-password'
    })
    if (error) {
      setError('Error al enviar el email. Verifica la dirección.')
      setLoading(false)
    } else {
      setSent(true)
      setLoading(false)
    }
  }

  return (
    <div style={{
      minHeight: '100vh', background: '#fbf6f3',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: 'Lato, sans-serif'
    }}>
      <div style={{
        background: 'white', borderRadius: 12, padding: '48px 40px',
        width: '100%', maxWidth: 400,
        boxShadow: '0 2px 16px rgba(38,75,110,0.10)'
      }}>
        <div style={{ marginBottom: 32, textAlign: 'center' }}>
          <div style={{
            fontSize: 11, fontWeight: 700, letterSpacing: 2,
            color: '#5abfc3', textTransform: 'uppercase', marginBottom: 8
          }}>
            Asistente Fiscal IA
          </div>
          <div style={{ fontSize: 22, fontWeight: 900, color: '#264b6e' }}>
            Recuperar contraseña
          </div>
        </div>

        {sent ? (
          <div>
            <div style={{
              background: '#E1F5EE', color: '#0F6E56', borderRadius: 8,
              padding: '16px', fontSize: 14, marginBottom: 24, textAlign: 'center', lineHeight: 1.6
            }}>
              Email enviado a <strong>{email}</strong>. Revisa tu bandeja de entrada y haz clic en el enlace para crear una nueva contraseña.
            </div>
            <a href="/login" style={{
              display: 'block', textAlign: 'center',
              fontSize: 13, color: '#5abfc3', textDecoration: 'none'
            }}>
              ← Volver al login
            </a>
          </div>
        ) : (
          <div>
            <p style={{ fontSize: 13, color: '#6b7f8f', marginBottom: 20, lineHeight: 1.6 }}>
              Introduce tu email y te enviaremos un enlace para restablecer tu contraseña.
            </p>

            <div style={{ marginBottom: 20 }}>
              <label style={{ fontSize: 12, fontWeight: 700, color: '#264b6e', display: 'block', marginBottom: 6 }}>
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSubmit()}
                placeholder="tu@despacho.com"
                style={{
                  width: '100%', padding: '10px 14px', borderRadius: 8,
                  border: '1.5px solid #e5e5e5', fontSize: 14,
                  fontFamily: 'Lato, sans-serif', outline: 'none',
                  color: '#1a2a3a'
                }}
              />
            </div>

            {error && (
              <div style={{
                background: '#fdecea', color: '#c64133', borderRadius: 8,
                padding: '10px 14px', fontSize: 13, marginBottom: 16
              }}>
                {error}
              </div>
            )}

            <button
              onClick={handleSubmit}
              disabled={loading || !email.trim()}
              style={{
                width: '100%', padding: '12px', borderRadius: 8,
                background: loading || !email.trim() ? '#e5e5e5' : '#264b6e',
                color: 'white', fontSize: 14, fontWeight: 700,
                border: 'none', cursor: loading || !email.trim() ? 'not-allowed' : 'pointer',
                fontFamily: 'Lato, sans-serif', marginBottom: 16
              }}
            >
              {loading ? 'Enviando...' : 'Enviar enlace'}
            </button>

            <a href="/login" style={{
              display: 'block', textAlign: 'center',
              fontSize: 13, color: '#5abfc3', textDecoration: 'none'
            }}>
              ← Volver al login
            </a>
          </div>
        )}
      </div>
    </div>
  )
}
