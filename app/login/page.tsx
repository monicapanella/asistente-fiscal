'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const router = useRouter()
  const supabase = createClient()

  async function handleLogin() {
    setLoading(true)
    setError('')
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) {
      setError('Email o contraseña incorrectos')
      setLoading(false)
    } else {
      router.push('/asistente')
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
            Acceso al despacho
          </div>
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 12, fontWeight: 700, color: '#264b6e', display: 'block', marginBottom: 6 }}>
            Email
          </label>
          <input
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="tu@despacho.com"
            style={{
              width: '100%', padding: '10px 14px', borderRadius: 8,
              border: '1.5px solid #e5e5e5', fontSize: 14,
              fontFamily: 'Lato, sans-serif', outline: 'none',
              color: '#1a2a3a'
            }}
          />
        </div>

        <div style={{ marginBottom: 8 }}>
          <label style={{ fontSize: 12, fontWeight: 700, color: '#264b6e', display: 'block', marginBottom: 6 }}>
            Contraseña
          </label>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleLogin()}
            placeholder="••••••••"
            style={{
              width: '100%', padding: '10px 14px', borderRadius: 8,
              border: '1.5px solid #e5e5e5', fontSize: 14,
              fontFamily: 'Lato, sans-serif', outline: 'none',
              color: '#1a2a3a'
            }}
          />
        </div>

        <div style={{ textAlign: 'right', marginBottom: 20 }}>
          <a href="/auth/forgot-password" style={{ fontSize: 12, color: '#5abfc3', textDecoration: 'none' }}>
            ¿Olvidaste tu contraseña?
          </a>
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
          onClick={handleLogin}
          disabled={loading}
          style={{
            width: '100%', padding: '12px', borderRadius: 8,
            background: loading ? '#e5e5e5' : '#264b6e',
            color: 'white', fontSize: 14, fontWeight: 700,
            border: 'none', cursor: loading ? 'not-allowed' : 'pointer',
            fontFamily: 'Lato, sans-serif', transition: 'background 0.2s'
          }}
        >
          {loading ? 'Accediendo...' : 'Entrar'}
        </button>

        <div style={{ marginTop: 24, textAlign: 'center', fontSize: 11, color: '#8bafc8' }}>
          Picas de la Rosa &amp; Asociados · Uso interno
        </div>
      </div>
    </div>
  )
}
