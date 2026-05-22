import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import fs from "fs";
import { createRequire } from "module";
import path from "path";

const reactDomRoot = fs.realpathSync(path.resolve(__dirname, "node_modules/react-dom"));
const requireFromReactDom = createRequire(path.join(reactDomRoot, "client.js"));
const reactRoot = path.dirname(requireFromReactDom.resolve("react/package.json"));

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    pool: "threads",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
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
});
