import type { Metadata } from 'next';
import { Geist, Inter, JetBrains_Mono } from 'next/font/google';
import { QueryProvider } from '@/components/providers/QueryProvider';
import './globals.css';

const geist = Geist({
  subsets: ['latin'],
  variable: '--font-geist',
  display: 'swap',
});

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Nodal - AI Architecture & Codebase Assistant',
  description: 'Instant codebase understanding, interactive dependency graphs, file explorer, and AI architectural assistant with RAG.',
  keywords: ['Nodal', 'RAG', 'Repository Analysis', 'AI Code Chat', 'Code Graph', 'Dependency Graph', 'Developer Tools'],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`dark ${geist.variable} ${inter.variable} ${jetbrainsMono.variable}`}>
      <head>
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200"
        />
      </head>
      <body className="bg-[#121316] text-[#e3e2e6] font-sans antialiased min-h-screen selection:bg-[#fbcfe8]/20 selection:text-[#fbcfe8]">
        <QueryProvider>{children}</QueryProvider>
      </body>
    </html>
  );
}
