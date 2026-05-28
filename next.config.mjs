/** @type {import('next').NextConfig} */
const nextConfig = {
  // Requerido por next-auth v5 en deployments no-localhost
  experimental: {
    serverComponentsExternalPackages: [],
  },
}

export default nextConfig
