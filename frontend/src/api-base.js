export const DEFAULT_API_BASE = 'http://localhost:8000'

export function getApiBase() {
  return new URL(window.SCAN_GRAPH_API_BASE || DEFAULT_API_BASE).origin
}
