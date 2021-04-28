import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import remoteAssets from 'vite-plugin-remote-assets'

export default defineConfig({
  plugins: [
    vue(),
    remoteAssets({
      awaitDownload: false,
    }),
  ],
})
