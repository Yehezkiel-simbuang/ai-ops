// Bentuk data playground dari backend (/api/playground).
export type PlaygroundStatus = 'draft' | 'deploying' | 'running' | 'failed' | 'stopping' | 'stopped';

export interface ComposeService { name: string; image: string; ports: Array<{ host: number | null; container: number }>; volumes: string[]; hasHealthcheck: boolean }
export interface ComposeAnalysis { services: ComposeService[]; publish: Array<{ service: string; host: number; container: number }>; problems: string[]; warnings: string[] }

export interface PlaygroundDeploy {
  id: number; server_id: number; server_name: string; server_host: string; name: string; compose: string; health_path: string; target_port: number;
  status: PlaygroundStatus; target: string; detail: string; log: string; created: number; updated: number; deployed: number | null; analysis: ComposeAnalysis;
}
export interface NewPlayground { server_id: number; name: string; compose: string; health_path: string; target_port: number }
