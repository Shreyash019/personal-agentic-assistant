export interface AdminDoc {
  source: string;
  chunk_count: number;
  preview: string;
  full_text: string;
}

export interface IngestResult {
  chunks_ingested: number;
  source: string;
}

export interface UpdateResult {
  source: string;
  chunks_ingested: number;
}
