import { defineConfig } from 'vite'

// The optional Python backend is reached SAME-ORIGIN through these proxies, so the
// browser only ever talks to one host:port. That is what lets Band Mode work over
// plain localhost, a LAN address, or a single HTTPS tunnel (where the page is https
// and the jam socket must therefore be wss on the same host) with no extra config.
//   /jam/*  ->  session_server.py  :8502   (HTTP + WebSocket; the /jam prefix is stripped)
//   /api/*  ->  music_api.py       :8766   (song library, MIDI import)
// If a server isn't running the proxy answers 5xx and the UI says so.
const proxy = {
  '/jam': {
    target: 'http://127.0.0.1:8502',
    ws: true,
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/jam/, ''),
  },
  '/api': {
    target: 'http://127.0.0.1:8766',
    changeOrigin: true,
  },
}

// Relative base so the build runs from any static host or file path.
export default defineConfig({
  base: './',
  // allowedHosts:true lets a tunnel (localtunnel/cloudflared/ngrok) reach the dev/preview
  // server without Vite's "host not allowed" block.
  server: { host: true, open: false, allowedHosts: true, proxy, watch: { ignored: ['**/.playwright-mcp/**'] } },
  preview: { host: true, allowedHosts: true, proxy },
  build: { target: 'esnext', sourcemap: false },
})
