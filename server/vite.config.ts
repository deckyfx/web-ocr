import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";

const watching = process.argv.includes("--watch") || process.argv.includes("-w");

export default defineConfig(({ mode }) => ({
  plugins: [solid(), tailwindcss()],
  // Lib mode doesn't replace process.env.* automatically — inline at build time
  define: {
    "process.env.NODE_ENV": JSON.stringify(mode === "development" ? "development" : "production"),
  },
  build: {
    // Exclude own output dir so --watch doesn't loop on every rebuild
    watch: watching ? { exclude: "**/wwwroot/**" } : null,
    outDir: "wwwroot/js",
    emptyOutDir: false,
    lib: {
      entry: "ClientApp/src/solid-app.tsx",
      name: "AppBridge",
      formats: ["iife"],
      fileName: () => "app.js",
    },
    rollupOptions: {
      output: {
        // CSS extracted alongside the JS as app.css
        assetFileNames: "app[extname]",
      },
    },
  },
}));
