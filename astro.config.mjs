import cloudflare from "@astrojs/cloudflare";
import { defineConfig } from "astro/config";

export default defineConfig({
  output: "server",
  adapter: cloudflare({
    prerenderEnvironment: "node"
  }),
  security: {
    checkOrigin: true
  },
  vite: {
    build: {
      sourcemap: true
    }
  }
});
