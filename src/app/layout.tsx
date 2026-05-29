import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-geist-sans",
  weight: "100 900",
});
const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
  weight: "100 900",
});

export const metadata: Metadata = {
  title: "Mapa del Delito — Usina de Justicia",
  description: "Visualización de estadísticas de delitos en Argentina. Datos oficiales del SNIC y SAT, y casos registrados por medios periodísticos.",
  icons: {
    icon: [
      { url: '/icon.svg', type: 'image/svg+xml' },
      { url: '/favicon.ico', sizes: '48x48' },
    ],
    apple: { url: '/icon.svg', type: 'image/svg+xml' },
  },
  openGraph: {
    title: 'Mapa del Delito — Usina de Justicia',
    description: 'Estadísticas de delitos en Argentina. Datos del SNIC, SAT y medios periodísticos.',
    locale: 'es_AR',
    type: 'website',
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
