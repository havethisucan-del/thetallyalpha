import { useEffect, useState } from 'react';
import type { ApiClient } from '../lib/api';

export type ApiHealth = 'checking' | 'ok' | 'unavailable';

const POLL_MS = 15_000;

/** Polls `/readyz` while mounted. Display only; nothing depends on it. */
export function useApiHealth(api: ApiClient): ApiHealth {
  const [health, setHealth] = useState<ApiHealth>('checking');

  useEffect(() => {
    let cancelled = false;
    const check = () => {
      void api.checkReady().then((status) => {
        if (!cancelled) setHealth(status);
      });
    };
    check();
    const timer = setInterval(check, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [api]);

  return health;
}
