import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // "@/components/ui/..." and "@/lib/utils" are the paths shadcn components import from
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
})
