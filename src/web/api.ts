import type {
  ApiError,
  DiffResponse,
  EdgeEvidenceResponse,
  FlowRequest,
  FlowResponse,
  GraphResponse,
  ImpactRequest,
  ImpactResponse,
  NodeEvidenceResponse,
} from '../shared/api-types.ts';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const body = (await response.json()) as T | ApiError;
  if (!response.ok) throw new Error((body as ApiError).error ?? `${response.status} ${response.statusText}`);
  return body as T;
}

export const api = {
  graph: () => request<GraphResponse>('/api/graph'),
  nodeEvidence: (id: string) => request<NodeEvidenceResponse>(`/api/node/${encodeURIComponent(id)}/evidence`),
  edgeEvidence: (id: number) => request<EdgeEvidenceResponse>(`/api/edge/${id}/evidence`),
  flow: (body: FlowRequest) =>
    request<FlowResponse>('/api/flow', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  impact: (body: ImpactRequest) =>
    request<ImpactResponse>('/api/impact', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  diff: () => request<DiffResponse>('/api/diff'),
};
