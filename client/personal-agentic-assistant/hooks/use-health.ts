/**
 * useHealth — pings GET /health on mount and whenever the baseUrl changes.
 *
 * Used to display a connection status indicator in the chat header so the
 * user knows immediately if the Go backend is unreachable (wrong LAN IP,
 * server not started, etc.) before they try to send a message.
 */

import { useEffect, useState } from 'react';

export type HealthStatus = 'checking' | 'online' | 'offline';

export function useHealth(baseUrl: string): HealthStatus {
  const [status, setStatus] = useState<HealthStatus>('checking');

  useEffect(() => {
    let cancelled = false;
    setStatus('checking');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000); // 5 s timeout

    fetch(`${baseUrl}/health`, { signal: controller.signal })
      .then((res) => {
        clearTimeout(timeout);
        if (!cancelled) setStatus(res.ok ? 'online' : 'offline');
      })
      .catch(() => {
        clearTimeout(timeout);
        if (!cancelled) setStatus('offline');
      });

    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timeout);
    };
  }, [baseUrl]);

  return status;
}
