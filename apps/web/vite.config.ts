import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
// Test options augment Vite types only; the self-contained production runtime does not ship Vitest.
import { defineConfig, type UserConfig } from "vite";
import type { TestUserConfig } from "vitest/config";
import { workloomProductVite } from "../../scripts/vite-product.mjs";

const product = workloomProductVite("B 端工作台");

// A6：vite proxy 转发 /trpc → server（总纲 §2.4 前后端交互）
// W2：preview 同口径代理（桌面发行版以 vite preview 静态服务 dist）
const trpcProxy = {
  target: `http://localhost:${Number(process.env.SERVER_PORT ?? 8787)}`,
  changeOrigin: true,
};
const config: UserConfig & { test: TestUserConfig } = {
  define: product.define,
  plugins: [product.plugin, react(), tailwindcss()],
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    // /health 同代理：前端「环境守门员」（BackendGate）经此探测后端就绪态，
    // 覆盖第三方工具只起 web 不起 server 的首启场景
    proxy: { "/trpc": trpcProxy, "/health": trpcProxy, "/api": trpcProxy },
  },
  preview: {
    port: Number(process.env.WEB_PORT ?? 5173),
    proxy: { "/trpc": trpcProxy, "/health": trpcProxy, "/api": trpcProxy },
  },
  test: {
    // @workloom/ui 发布包内部用无扩展名相对导入（`./language`）：打包器能解析、Node ESM 不能。
    // 让 vitest 用 Vite 的解析链内联处理它，前端单测才不会整片挂在 ERR_MODULE_NOT_FOUND。
    server: { deps: { inline: ["@workloom/ui"] } },
  },
};
export default defineConfig(config);
