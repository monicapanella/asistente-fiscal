export default function ForgotPasswordPage() {
  return (
    <div style={{
      minHeight: '100vh', background: '#fbf6f3',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: 'Lato, sans-serif'
    }}>
      <div style={{
        background: 'white', borderRadius: 12, padding: '48px 40px',
        width: '100%', maxWidth: 400,
        boxShadow: '0 2px 16px rgba(38,75,110,0.10)',
        textAlign: 'center'
      }}>
        <div style={{ fontSize: 22, fontWeight: 900, color: '#264b6e', marginBottom: 16 }}>
          Recuperar contraseña
        </div>
        <p style={{ fontSize: 14, color: '#264b6e', lineHeight: 1.6 }}>
          Para restablecer tu contraseña, contacta con el administrador del sistema.
        </p>
        <a href="/login" style={{
          display: 'inline-block', marginTop: 24, padding: '10px 24px',
          background: '#264b6e', color: 'white', borderRadius: 8,
          textDecoration: 'none', fontSize: 14, fontWeight: 700
        }}>
          Volver al login
        </a>
      </div>
    </div>
  )
}