/**
 * useIngest — wraps POST /api/v1/documents.
 *
 * Chunks the supplied text into overlapping 400-char windows on the server,
 * embeds each chunk with nomic-embed-text (768 dims), and upserts the vectors
 * into the Qdrant "Personal Context" collection.
 *
 * Documents tagged with scope "personal" are visible only to this user.
 * Documents tagged with scope "shared" (user_id = "admin") are visible to all users.
 */

import { useCallback, useState } from 'react';

export type IngestScope = 'personal' | 'shared';

export type IngestResult = {
  chunksIngested: number;
  source: string;
};

export type UseIngestReturn = {
  ingest: (text: string, source: string, scope: IngestScope) => Promise<void>;
  isLoading: boolean;
  result: IngestResult | null;
  error: string | null;
  reset: () => void;
};

export function useIngest(baseUrl: string, userID: string): UseIngestReturn {
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<IngestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ingest = useCallback(
    async (text: string, source: string, scope: IngestScope) => {
      const trimmedText = text.trim();
      if (!trimmedText) return;

      setIsLoading(true);
      setResult(null);
      setError(null);

      // "personal" → tag chunks with the device UUID so only this user retrieves them.
      // "shared"   → tag with "admin" so all users can retrieve them.
      const effectiveUserID = scope === 'personal' ? userID : 'admin';

      try {
        const res = await fetch(`${baseUrl}/api/v1/documents`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: trimmedText,
            source: source.trim() || 'untitled',
            user_id: effectiveUserID,
          }),
        });

        if (!res.ok) {
          const body = await res.text();
          throw new Error(`HTTP ${res.status}: ${body.slice(0, 120)}`);
        }

        const data = (await res.json()) as { chunks_ingested: number; source: string };
        setResult({ chunksIngested: data.chunks_ingested, source: data.source });
      } catch (e: any) {
        setError(e.message ?? 'Ingest failed');
      } finally {
        setIsLoading(false);
      }
    },
    [baseUrl, userID],
  );

  const reset = useCallback(() => {
    setResult(null);
    setError(null);
  }, []);

  return { ingest, isLoading, result, error, reset };
}
