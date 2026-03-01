import { useCallback, useEffect, useRef, useState } from 'react';
import { deleteDoc, listDocs, updateDoc } from '../api';
import type { AdminDoc, UpdateResult } from '../types';

export interface UseDocsReturn {
  docs: AdminDoc[];
  loading: boolean;
  error: string | null;
  totalChunks: number;
  refresh: () => Promise<void>;
  remove: (source: string) => Promise<void>;
  update: (oldSource: string, text: string, newSource: string) => Promise<UpdateResult>;
}

export function useDocs(): UseDocsReturn {
  const [docs, setDocs] = useState<AdminDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const refresh = useCallback(async () => {
    if (mounted.current) setLoading(true);
    try {
      const data = await listDocs();
      if (mounted.current) { setDocs(data); setError(null); }
    } catch (e: unknown) {
      if (mounted.current)
        setError(e instanceof Error ? e.message : 'Failed to load documents');
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const remove = useCallback(async (source: string) => {
    await deleteDoc(source);
    if (mounted.current)
      setDocs(prev => prev.filter(d => d.source !== source));
  }, []);

  const update = useCallback(
    async (oldSource: string, text: string, newSource: string): Promise<UpdateResult> => {
      const result = await updateDoc(oldSource, text, newSource);
      // Refresh to get accurate chunk counts from the server.
      await refresh();
      return result;
    },
    [refresh],
  );

  const totalChunks = docs.reduce((acc, d) => acc + d.chunk_count, 0);

  return { docs, loading, error, totalChunks, refresh, remove, update };
}
