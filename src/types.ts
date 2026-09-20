export type MediaType = 'IMAGE' | 'TEXT' | 'AUDIO' | 'VIDEO' | 'FILE';

export interface CmccAccount {
  id?: number;
  name?: string;
  apiKey: string;
}

export type CredentialKind = 'gotify' | 'webhook';

export interface UpstreamSummary {
  id: number;
  name: string;
  apiKeyPreview: string;
  createdAt: string;
  updatedAt: string;
}

export interface CredentialSummary {
  id: number;
  name: string;
  kind: CredentialKind;
  secretPreview: string;
  upstreamIds: number[];
  createdAt: string;
  updatedAt: string;
}

export interface HistoryEntry {
  id: number;
  createdAt: string;
  source: CredentialKind | 'manual' | 'system';
  credentialName: string | null;
  upstreamName: string | null;
  status: 'success' | 'failed';
  title: string | null;
  content: string | null;
  mediaType: string | null;
  messageId: string | null;
  error: string | null;
  handledAt?: string | null;
}

export interface NativeSendRequest {
  type: 'send';
  apiKey?: string;
  content?: string;
  mediaType?: MediaType;
  mediaUrl?: string;
  thumbnailUrl?: string;
  mediaFileName?: string;
  mediaSize?: number;
  mediaMimeType?: string;
  messageId?: string;
  timestamp?: number;
  extra?: unknown;
}

export interface GotifyRequest {
  title?: string;
  message: string;
  priority?: number;
  extras?: Record<string, unknown>;
}
