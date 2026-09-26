import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { createUiDevWatchOptions } from "./src/lib/vite-watch";
import { createApiProxy } from "./src/lib/vite-api-proxy";
import { serviceWorkerBuildIdPlugin } from "./src/lib/vite-sw-build-id";

const apiProxy = createApiProxy();

function resolvePublicBasePath(): string {
  const raw = process.env.PAPERCLIP_UI_BASE_PATH?.trim() || "/";
  if (!raw.startsWith("/") || raw.includes("?") || raw.includes("#") || raw.includes("\\")) {
    throw new Error("PAPERCLIP_UI_BASE_PATH must be an absolute URL path");
  }
  const parts = raw.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === "..")) {
    throw new Error("PAPERCLIP_UI_BASE_PATH cannot contain dot segments");
  }
  return parts.length === 0 ? "/" : `/${parts.join("/")}/`;
}

export default defineConfig(({ mode }) => ({
  base: resolvePublicBasePath(),
  plugins: [react(), tailwindcss(), serviceWorkerBuildIdPlugin()],
  build: {
    minify: "esbuild",
  },
  esbuild:
    mode === "production"
      ? {
          drop: ["console", "debugger"],
          legalComments: "none",
        }
      : undefined,
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      lexical: path.resolve(__dirname, "./node_modules/lexical/dist/Lexical.mjs"),
    },
  },
  server: {
    port: 5173,
    watch: createUiDevWatchOptions(process.cwd()),
    proxy: apiProxy,
  },
  preview: {
    port: 3101,
    host: "0.0.0.0",
    allowedHosts: true,
    proxy: apiProxy,
  },
}));
