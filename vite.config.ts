import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig(({ mode }) => {
  const hosted = mode === "jatos" || mode === "pavlovia";
  const pages = mode === "github-pages";
  const base = hosted ? "./" : (process.env.VITE_BASE_PATH || "/");
  const pagesSecurityPolicy = {
    name: "github-pages-security-policy",
    transformIndexHtml(html: string) {
      const apiOrigin = process.env.VITE_API_ORIGIN ? new URL(process.env.VITE_API_ORIGIN).origin : null;
      const connectSources = [
        "'self'",
        "https://identitytoolkit.googleapis.com",
        "https://securetoken.googleapis.com",
        "https://firestore.googleapis.com",
        "https://firebaseappcheck.googleapis.com",
        "https://www.google.com/recaptcha/",
        ...(apiOrigin ? [apiOrigin] : []),
      ];
      const policy = [
        "default-src 'self'",
        "script-src 'self' https://www.google.com/recaptcha/ https://www.gstatic.com/recaptcha/",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: https://www.gstatic.com/recaptcha/",
        `connect-src ${connectSources.join(" ")}`,
        "frame-src https://www.google.com/recaptcha/ https://recaptcha.google.com/recaptcha/",
        "font-src 'self'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join("; ");
      return html.replace("</head>", `  <meta http-equiv="Content-Security-Policy" content="${policy}" />\n  </head>`);
    },
  };
  return {
    base,
    plugins: [...(pages ? [pagesSecurityPolicy] : []), react()],
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
