import type { AdminDoc, IngestResult, UpdateResult } from './types';

const BASE = 'http://localhost:8080';

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

/** Fetch all admin-uploaded documents grouped by source. */
export async function listDocs(): Promise<AdminDoc[]> {
  const res = await fetch(`${BASE}/api/v1/admin/documents`);
  return handleResponse<AdminDoc[]>(res);
}

/** Upload a new document as admin. */
export async function uploadDoc(text: string, source: string): Promise<IngestResult> {
  const res = await fetch(`${BASE}/api/v1/documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, source, user_id: 'admin' }),
  });
  return handleResponse<IngestResult>(res);
}

/** Replace an existing document (delete old chunks, re-ingest new text). */
export async function updateDoc(
  oldSource: string,
  text: string,
  newSource: string,
): Promise<UpdateResult> {
  const res = await fetch(
    `${BASE}/api/v1/admin/documents?source=${encodeURIComponent(oldSource)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, new_source: newSource }),
    },
  );
  return handleResponse<UpdateResult>(res);
}

/** Permanently delete all chunks for the given source. */
export async function deleteDoc(source: string): Promise<void> {
  const res = await fetch(
    `${BASE}/api/v1/admin/documents?source=${encodeURIComponent(source)}`,
    { method: 'DELETE' },
  );
  if (!res.ok && res.status !== 204) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
}
