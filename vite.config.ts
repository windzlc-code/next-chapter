import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import fs from "fs";
import { createRequire } from "module";
import path from "path";
import { componentTagger } from "lovable-tagger";

const reactDomRoot = fs.realpathSync(path.resolve(__dirname, "node_modules/react-dom"));
const requireFromReactDom = createRequire(path.join(reactDomRoot, "client.js"));
const reactRoot = path.dirname(requireFromReactDom.resolve("react/package.json"));

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  base: "./",
  server: {
    host: "127.0.0.1",
    port: 8080,
    strictPort: true,
    hmr: {
      overlay: false,
    },
  },
  plugins: [react(), mode === "development" && componentTagger()].filter(
    Boolean,
  ),
  esbuild: mode === "production" ? { drop: ["console", "debugger"] } : {},
  build: {
    modulePreload: false,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;

          if (
            id.includes("react-router") ||
            id.includes("@tanstack/react-query") ||
            id.includes("react-hook-form") ||
            id.includes("react-resizable-panels") ||
            id.includes("next-themes") ||
            id.includes("sonner")
          ) {
            return "app-framework";
          }

          if (
            id.includes("@radix-ui") ||
            id.includes("framer-motion") ||
            id.includes("embla-carousel-react") ||
            id.includes("lucide-react") ||
            id.includes("react-day-picker") ||
            id.includes("input-otp") ||
            id.includes("vaul")
          ) {
            return "ui-vendor";
          }

          if (
            id.includes("docx") ||
            id.includes("xlsx") ||
            id.includes("exceljs") ||
            id.includes("pdfjs-dist") ||
            id.includes("mammoth") ||
            id.includes("mermaid")
          ) {
            return "document-vendor";
          }

          if (id.includes("recharts")) {
            return "chart-vendor";
          }

          if (
            id.includes("react") ||
            id.includes("react-dom") ||
            id.includes("scheduler")
          ) {
            return "react-vendor";
          }
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      react: reactRoot,
      "react/jsx-runtime": path.join(reactRoot, "jsx-runtime.js"),
      "react/jsx-dev-runtime": path.join(reactRoot, "jsx-dev-runtime.js"),
      "react-dom": reactDomRoot,
      "react-dom/client": path.join(reactDomRoot, "client.js"),
    },
    dedupe: ["react", "react-dom"],
    preserveSymlinks: true,
  },
}));
