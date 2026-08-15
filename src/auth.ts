import NextAuth from 'next-auth'
import Google from 'next-auth/providers/google'
import {
  contextoDesdeEnv,
  evaluarAllowlist,
  puedeAcceder,
  sesionSigueAutorizada,
} from '@/lib/auth/allowlist'

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
      // contextoDesdeEnv() se llama acá y no una vez al importar el módulo: si
      // la allowlist queda congelada en una constante, sacar un email y
      // redesplegar no tiene efecto hasta el próximo arranque en frío.
      const resultado = evaluarAllowlist(user.email, contextoDesdeEnv())

      if (!resultado.permitido) {
        // No se loguea el email: es un dato personal y termina en logs del server.
        console.warn(`Login rechazado: ${resultado.motivo}`)
      }

      return resultado.permitido
    },
    authorized({ auth, request: { nextUrl } }) {
      // Dos condiciones distintas, y hacen falta las dos: que haya sesión
      // (el token es válido) y que quien la tiene siga autorizado (su email
      // sigue en la allowlist). Antes solo se comprobaba la primera, así que
      // una sesión ya emitida sobrevivía a la revocación del acceso hasta
      // expirar sola.
      const haySesion = !!auth?.user
      const sigueAutorizado = haySesion && sesionSigueAutorizada(auth!.user!.email)
      return puedeAcceder(nextUrl.pathname, sigueAutorizado)
    },
    session({ session }) {
      return session
    },
  },
  pages: {
    signIn: '/admin/login',
  },
})
