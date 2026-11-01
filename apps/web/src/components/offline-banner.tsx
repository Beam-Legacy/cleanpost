'use client';
import { useEffect, useState } from 'react';
import { Banner } from '@cleanpost/ui';

/** G-25 Offline or reconnecting. */
export function OfflineBanner() {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  if (online) return null;
  return (
    <Banner tone="warn" edge>
      You&apos;re offline. Changes you make now won&apos;t be saved until the connection returns.
    </Banner>
  );
}
