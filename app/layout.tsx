import type { Metadata } from 'next'

import { erode, excon } from './fonts'
import './globals.css'

export const metadata: Metadata = {
  title: 'Melanite Laser Suite',
  description: 'Provider portal for Melanite Laser Suite.',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className={`${excon.variable} ${erode.variable} h-full`}>
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  )
}
