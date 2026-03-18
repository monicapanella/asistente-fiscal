import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  // ============================================
  // GUARD 1: Excluir rutas que NO necesitan auth
  // Sin este guard, cada request (CSS, JS, imágenes)
  // ejecuta getUser() → refresca cookies → nuevo request → loop
  // ============================================
  if (
    pathname.startsWith('/_next/') ||
    pathname.startsWith('/api/') ||
    pathname.startsWith('/auth/') ||
    pathname === '/favicon.ico' ||
    pathname.match(/\.(svg|png|jpg|jpeg|gif|ico|css|js|woff|woff2)$/)
  ) {
    return NextResponse.next()
  }

  // ============================================
  // GUARD 2: Crear cliente Supabase con cookies
  // ============================================
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          )
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  // ============================================
  // CHECK AUTH
  // ============================================
  const { data: { user } } = await supabase.auth.getUser()

  // ============================================
  // REDIRECCIONES (con protección anti-loop)
  // ============================================

  // No logueado + NO está en /login → redirigir a /login
  if (!user && pathname !== '/login') {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return NextResponse.redirect(url)
  }

  // Logueado + está en /login → redirigir a /asistente
  if (user && pathname === '/login') {
    const url = request.nextUrl.clone()
    url.pathname = '/asistente'
    return NextResponse.redirect(url)
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
}
