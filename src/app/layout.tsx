import type { Metadata } from 'next';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import { TooltipProvider } from '@/components/ui/tooltip';
import './globals.css';

export const metadata: Metadata = {
  title: 'Slate',
  icons: { icon: '/slate-icon.png', apple: '/slate-icon.png' },
  description: 'A quiet place to write. Markdown, beautifully simple.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}><body><TooltipProvider delayDuration={400} disableHoverableContent>{children}</TooltipProvider></body></html>;
}
