'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'

export default function ResetPasswordPage() {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [ready, setReady] = useState(false)
  const router = useRouter()
  const supabase = createClient()

  useEffect(() => {
    // Supabase procesa el token del hash de la URL automáticamente
    supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') {
        setReady(true)
      }
    })
  }, [supabase])

  async function handleReset() {
    if (password !== confirm) {
      setError('Las contraseñas no coinciden')
      return
    }
    if (password.length < 6) {
      setError('La contraseña debe tener al menos 6 caracteres')
      return
    }
    setLoading(true)
    setError('')
    const { error } = await supabase.auth.updateUser({ password })
    if (error) {
      setError('Error al actualizar la contraseña. Solicita un nuevo enlace.')
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
            Nueva contraseña
          </div>
        </div>

        {!ready ? (
          <div style={{ textAlign: 'center', color: '#8bafc8', fontSize: 14 }}>
            Verificando enlace...
          </div>
        ) : (
          <div>
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 12, fontWeight: 700, color: '#264b6e', display: 'block', marginBottom: 6 }}>
                Nueva contraseña
              </label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="Mínimo 6 caracteres"
                style={{
                  width: '100%', padding: '10px 14px', borderRadius: 8,
                  border: '1.5px solid #e5e5e5', fontSize: 14,
                  fontFamily: 'Lato, sans-serif', outline: 'none',
                  color: '#1a2a3a'
                }}
              />
            </div>

            <div style={{ marginBottom: 24 }}>
              <label style={{ fontSize: 12, fontWeight: 700, color: '#264b6e', display: 'block', marginBottom: 6 }}>
                Confirmar contraseña
              </label>
              <input
                type="password"
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleReset()}
                placeholder="Repite la contraseña"
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
              onClick={handleReset}
              disabled={loading || !password || !confirm}
              style={{
                width: '100%', padding: '12px', borderRadius: 8,
                background: loading || !password || !confirm ? '#e5e5e5' : '#264b6e',
                color: 'white', fontSize: 14, fontWeight: 700,
                border: 'none', cursor: loading || !password || !confirm ? 'not-allowed' : 'pointer',
                fontFamily: 'Lato, sans-serif'
              }}
            >
              {loading ? 'Guardando...' : 'Guardar nueva contraseña'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
