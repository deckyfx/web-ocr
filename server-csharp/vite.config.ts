import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  // Lib mode doesn't replace process.env.* automatically — inline at build time
  define: {
    "process.env.NODE_ENV": JSON.stringify(mode === "development" ? "development" : "production"),
  },
  build: {
    outDir: "wwwroot/js",
    emptyOutDir: false,
    lib: {
      entry: "ClientApp/src/react-app.tsx",
      name: "ReactApp",
      formats: ["iife"],
      fileName: () => "react-app.js",
    },
    rollupOptions: {
      output: {
        // CSS extracted alongside the JS as react-app.css
        assetFileNames: "react-app[extname]",
      },
    },
  },
}));
