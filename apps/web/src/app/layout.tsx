import type { Metadata } from 'next';
import { IBM_Plex_Mono, Public_Sans, Schibsted_Grotesk } from 'next/font/google';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { Banner } from '@cleanpost/ui';
import './globals.css';

const publicSans = Public_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-public-sans',
});
const schibsted = Schibsted_Grotesk({
  subsets: ['latin'],
  weight: ['600', '700'],
  variable: '--font-schibsted',
});
const plexMono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-plex-mono' });

export const metadata: Metadata = {
  title: { default: 'Cleanpost', template: '%s · Cleanpost' },
  description: 'Claims to posted payments for medical billing companies.',
  icons: { icon: '/favicon.svg' },
  robots: { index: false, follow: false },
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const jar = await cookies();
  const theme = jar.get('cp-theme')?.value;
  const density = jar.get('cp-density')?.value === 'comfortable' ? 'comfortable' : 'compact';
  return (
    <html
      lang="en"
      data-theme={theme === 'light' || theme === 'dark' ? theme : undefined}
      data-density={density}
      className={`${publicSans.variable} ${schibsted.variable} ${plexMono.variable}`}
    >
      <body>
        {process.env.CLEANPOST_ENV === 'preview' && (
          <Banner tone="warn" edge>
            Preview · synthetic data only. Never enter real patient information here.
          </Banner>
        )}
        {children}
      </body>
    </html>
  );
}
