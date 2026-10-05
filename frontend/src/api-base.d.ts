export const DEFAULT_API_BASE: string
export function getApiBase(): string

declare global {
  interface Window {
    SCAN_GRAPH_API_BASE?: string
  }
}
