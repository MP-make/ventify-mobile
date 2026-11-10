"use client";

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function MobileIndexPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/mobile/pos');
  }, [router]);

  return null;
}
