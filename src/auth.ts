import NextAuth from 'next-auth'
import Google from 'next-auth/providers/google'
import { evaluarAllowlist, parsearAllowlist, puedeAcceder } from '@/lib/auth/allowlist'

const allowedEmails = parsearAllowlist(process.env.ALLOWED_EMAILS)

export const { handlers, auth, signIn, signOut } = NextAuth({
  secret: process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET,
  trustHost: true,
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    }),
  ],
  callbacks: {
    signIn({ user }) {
      const resultado = evaluarAllowlist(user.email, {
        allowlist: allowedEmails,
        esProduccion: process.env.NODE_ENV === 'production',
      })

      if (!resultado.permitido) {
        // No se loguea el email: es un dato personal y termina en logs del server.
        console.warn(`Login rechazado: ${resultado.motivo}`)
      }

      return resultado.permitido
    },
    authorized({ auth, request: { nextUrl } }) {
      return puedeAcceder(nextUrl.pathname, !!auth?.user)
    },
    session({ session }) {
      return session
    },
  },
  pages: {
    signIn: '/admin/login',
  },
})
