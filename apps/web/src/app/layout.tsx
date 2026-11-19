import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Toaster } from '@/components/ui/toaster';
import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: 'WhatsApp Bulk Messaging',
  description: 'Internal platform for WhatsApp template broadcasts',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <Providers>{children}</Providers>
        <Toaster />
      </body>
    </html>
  );
}
