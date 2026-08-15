/** @type {import('next').NextConfig} */
const nextConfig = {
  // `experimental.serverComponentsExternalPackages` se removió: en Next 15 pasó
  // a llamarse `serverExternalPackages`, y acá era una lista vacía —o sea, no
  // hacía nada—. Se saca en vez de renombrarla para no dejar configuración
  // muerta. Si algún día hay que excluir un paquete del bundle del servidor, la
  // clave nueva es `serverExternalPackages`.
  compress: true,
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
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
