import { defineConfig } from 'vite'
import { DEFAULT_API_BASE } from './src/api-base.js'

const backend = process.env.SCAN_GRAPH_API_BASE || DEFAULT_API_BASE

export default defineConfig({
  define: {
    'window.SCAN_GRAPH_API_BASE': JSON.stringify(process.env.SCAN_GRAPH_API_BASE || DEFAULT_API_BASE),
  },
  server: {
    proxy: {
      '/api': backend,
      '/simulation': backend,
      '/experiments': backend,
      '/hypotheses': backend,
      '/observations': backend,
      '/candidate-actions': backend,
      '/certificate': backend,
      '/scenarios': backend,
    },
  },
})
