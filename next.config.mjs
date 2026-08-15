import { CSP_ESTRICTA, CSP_OBSERVADA } from './src/config/csp.mjs'

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: [],
  },
  compress: true,
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          // Dos capas, ver src/config/csp.mjs: la primera bloquea de verdad y
          // solo trae directivas que no pueden romper esta app; la segunda
          // observa las que tocan la carga del mapa, para poder ajustarlas con
          // violaciones reales antes de ponerlas a bloquear.
          { key: 'Content-Security-Policy', value: CSP_ESTRICTA },
          { key: 'Content-Security-Policy-Report-Only', value: CSP_OBSERVADA },
          // Limita qué APIs del navegador puede pedir la página. La geolocalización
          // queda habilitada para el propio origen porque el mapa la usa
          // (useGeolocalizacion); el resto se apaga.
          {
            key: 'Permissions-Policy',
            value: 'geolocation=(self), camera=(), microphone=(), payment=(), usb=()',
          },
        ],
      },
      {
        source: '/data/:path*.geojson',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=86400, immutable' },
        ],
      },
      {
        source: '/data/:path*.parquet',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=86400, immutable' },
          { key: 'Access-Control-Allow-Origin', value: '*' },
          { key: 'Access-Control-Expose-Headers', value: 'Content-Range, Accept-Ranges' },
          { key: 'Accept-Ranges', value: 'bytes' },
        ],
      },
      {
        source: '/duckdb/:path*',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=604800, immutable' },
          { key: 'Cross-Origin-Embedder-Policy', value: 'require-corp' },
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
        ],
      },
    ]
  },
}

export default nextConfig
