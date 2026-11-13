import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig(({ mode }) => {
  const hosted = mode === "jatos" || mode === "pavlovia";
  const pages = mode === "github-pages";
  const base = hosted ? "./" : (process.env.VITE_BASE_PATH || "/");
  return {
    base,
    plugins: [react()],
    server: {
      proxy: {
        "/api": "http://127.0.0.1:3001",
      },
    },
    build: {
      // These bundles are deployed to public participant hosts. Keep source
      // maps out of releases; private CI artifacts can be added separately.
      sourcemap: false,
      outDir: hosted ? `dist-${mode}` : pages ? "dist-pages" : "dist",
      emptyOutDir: true,
      rollupOptions: hosted
          ? {
            input: { index: path.resolve(`platforms/${mode}/index.html`) },
          }
        : undefined,
    },
  };
});
