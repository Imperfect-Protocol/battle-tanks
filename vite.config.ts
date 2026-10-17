import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { standalone } from 'vite-plugin-standalone'

export default defineConfig({
  plugins: [
    react(),
    standalone({
      entry: {
        index: './server/standalone-entry.js',
      },
    })
  ],
});
