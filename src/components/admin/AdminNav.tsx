'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { signOut } from 'next-auth/react'

const LINKS = [
  { href: '/admin/dashboard', label: 'Métricas' },
  { href: '/admin/revisiones', label: 'Revisiones' },
  { href: '/admin/feedback', label: 'Feedback' },
]

export default function AdminNav() {
  const pathname = usePathname()

  return (
    <header className="bg-white border-b border-gray-200 sticky top-0 z-10">
      <div className="max-w-4xl mx-auto px-4 py-2.5 flex items-center gap-3">
        <Link
          href="/admin/dashboard"
          className="font-bold text-sm shrink-0"
          style={{ color: '#1E427C' }}
        >
          Usina de Justicia
        </Link>

        <nav className="flex items-center gap-1.5 overflow-x-auto">
          {LINKS.map(link => {
            const activo = pathname === link.href || pathname?.startsWith(link.href + '/')
            return (
              <Link
                key={link.href}
                href={link.href}
                className={`text-xs font-medium px-2.5 py-1 rounded-lg border transition-colors whitespace-nowrap ${
                  activo
                    ? 'border-[#1E427C] bg-[#1E427C] text-white'
                    : 'border-gray-200 text-gray-500 hover:border-[#1E427C] hover:text-[#1E427C]'
                }`}
              >
                {link.label}
              </Link>
            )
          })}
        </nav>

        <div className="ml-auto flex items-center gap-2 shrink-0">
          <Link
            href="/mapa-del-delito"
            target="_blank"
            className="text-[10px] text-gray-400 hover:text-[#1E427C] transition-colors hidden sm:inline"
          >
            Ver mapa ↗
          </Link>
          <button
            onClick={() => signOut({ callbackUrl: '/admin/login' })}
            className="text-xs text-gray-500 hover:text-gray-700 px-2.5 py-1 rounded-lg border border-gray-200 hover:border-gray-300 transition-colors"
          >
            Salir
          </button>
        </div>
      </div>
    </header>
  )
}
