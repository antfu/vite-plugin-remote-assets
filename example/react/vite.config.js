import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import RemoteAssets from 'vite-plugin-remote-assets'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [RemoteAssets.VitePluginRemoteAssets(
  ), react()],
})
