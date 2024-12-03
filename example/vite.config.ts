import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'
import remoteAssets from 'vite-plugin-remote-assets'

export default defineConfig({
  plugins: [
    vue(),
    remoteAssets({
      awaitDownload: false,
    }),
  ],
})
