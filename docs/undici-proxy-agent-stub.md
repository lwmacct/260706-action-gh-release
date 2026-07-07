# Undici ProxyAgent Stub

本文档说明 `rollup.config.mjs` 中的 `undiciProxyAgentStub()` 优化：为什么要替换 `undici`、替换后会失去什么能力，以及维护时如何验证。

## 背景

项目依赖的 `@actions/cache`、`@actions/core` 和 `@actions/tool-cache` 会间接依赖 `@actions/http-client`。从 `@actions/http-client@4.0.1` 开始，它静态导入了：

```js
import { ProxyAgent } from "undici";
```

这个导入只服务于 `HttpClient#getAgentDispatcher()` 这一条代理 dispatcher 路径。但 Rollup 看到静态导入后，会把完整 `undici` 包纳入依赖图。

`undici` 不是一个小型 proxy helper，它包含完整 HTTP client、fetch/Web API、WebSocket、EventSource、Cache 等实现。压缩后仍然很大：

```text
dist/chunks/undici.js: 约 404 KB
gzip:                  约 130 KB
```

当前 action 的常规请求路径使用 `@actions/http-client` 的 Node `http` / `https` agent 和 `tunnel` 代理实现，不调用 `getAgentDispatcher()`。因此完整打包 `undici` 的收益很低。

## 实现

`rollup.config.mjs` 使用 Rollup 虚拟模块拦截 `undici`：

```js
const UNDICI_STUB_ID = "\0undici-proxy-agent-stub";

function undiciProxyAgentStub() {
  return {
    name: "undici-proxy-agent-stub",
    resolveId(source) {
      if (source === "undici") {
        return UNDICI_STUB_ID;
      }
      return null;
    },
    load(id) {
      if (id !== UNDICI_STUB_ID) {
        return null;
      }

      return `
export class ProxyAgent {
  constructor() {
    throw new Error("Undici ProxyAgent is not bundled by this action");
  }
}
`;
    },
  };
}
```

插件必须放在 `nodeResolve()` 之前，这样 Rollup 会先命中 stub，而不是解析真实的 `undici` 包。

这不是把 `undici` 标记成 external。external 会要求运行环境能提供 `undici`，而 GitHub Action 的 `dist/` 应尽量自包含。stub 方案保留自包含发布，只移除当前未使用的大依赖。

## 行为变化

保留的能力：

- `@actions/cache` 的常规 restore/save 流程。
- `@actions/tool-cache` 的常规下载和解压流程。
- `@actions/http-client` 基于 Node `http` / `https` agent 的普通请求。
- `@actions/http-client` 基于 `tunnel` 的普通代理 agent。

移除的能力：

- `@actions/http-client#getAgentDispatcher()` 使用 `undici.ProxyAgent` 的 dispatcher 代理路径。

如果未来某个依赖开始调用这条路径，会在运行时明确失败：

```text
Undici ProxyAgent is not bundled by this action
```

这是有意设计。失败应该显式暴露，而不是静默降级为不完整的代理行为。

## 收益

主要收益是构建产物体积：

- 删除 `dist/chunks/undici.js`
- 减少约 `404 KB` raw 产物
- 减少约 `130 KB` gzip 体积
- 减少 action 分发和加载的无用代码

构建时间也会略有下降，因为 Rollup 和 Terser 不再处理完整 `undici` 依赖图。

## 风险

这个优化是破坏式的，不做历史兼容。

风险集中在以下情况：

- `@actions/cache`、`@actions/core`、`@actions/tool-cache` 或其依赖未来开始调用 `getAgentDispatcher()`。
- 运行环境依赖 Undici dispatcher 代理能力，而不是 Node `http` / `https` agent 代理能力。
- 升级 `@actions/http-client` 后，它从 `undici` 导入了 `ProxyAgent` 以外的 API。

如果出现这些情况，需要重新评估 stub，可能的处理方式包括：

- 删除 `undiciProxyAgentStub()`，恢复完整 `undici` chunk。
- 改用更完整的本地 shim。
- 替换依赖，避免引入 `@actions/http-client` 的 dispatcher 路径。

## 上游跟踪

`github.com/actions/http-client` 已归档，`@actions/http-client` 的源码已迁移到 `actions/toolkit`：

- [`actions/http-client`](https://github.com/actions/http-client)
- [`actions/toolkit/packages/http-client`](https://github.com/actions/toolkit/tree/main/packages/http-client)

这个包仍然通过 `@actions/core`、`@actions/cache` 和 `@actions/tool-cache` 被高版本 `@actions/*` 包使用。当前需要跟踪的是 `@actions/http-client` 顶层静态导入 `undici` 导致 Rollup 产物膨胀的问题，而不是旧仓库归档本身。

相关上游 issue / PR：

- [`actions/toolkit#1800`](https://github.com/actions/toolkit/pull/1800): lazy load `ProxyAgent`，避免打包完整 `undici`。
- [`actions/toolkit#1697`](https://github.com/actions/toolkit/issues/1697): `undici` 导致不可 tree-shake 的体积增长。
- [`actions/toolkit#1621`](https://github.com/actions/toolkit/issues/1621): `@actions/http-client` bundle size regression。
- [`actions/toolkit#1893`](https://github.com/actions/toolkit/issues/1893): shrink package sizes。

本项目已补充实测数据：

- [`actions/toolkit#1800` comment](https://github.com/actions/toolkit/pull/1800#issuecomment-4899986926)
- [`actions/toolkit#1697` comment](https://github.com/actions/toolkit/issues/1697#issuecomment-4899987088)
- [`actions/toolkit#1621` comment](https://github.com/actions/toolkit/issues/1621#issuecomment-4899987242)
- [`actions/toolkit#1893` comment](https://github.com/actions/toolkit/issues/1893#issuecomment-4899987377)

## 维护检查

每次升级 `@actions/*` 相关依赖后，至少执行：

```sh
pnpm build
pnpm typecheck
test ! -e dist/chunks/undici.js
rg -n "from ['\"]undici|import\\(.*undici|chunks/undici" dist
```

也建议检查依赖源码中是否新增了 `getAgentDispatcher()` 调用：

```sh
rg -n "getAgentDispatcher|ProxyAgent|from ['\"]undici" node_modules pnpm-lock.yaml
```

如果 `dist/chunks/undici.js` 重新出现，说明真实 `undici` 又进入了 Rollup 依赖图。

如果 `dist/` 中出现新的 `undici` API 引用，说明 stub 可能已经不够用。

## 回滚方式

回滚很直接：

1. 删除 `UNDICI_STUB_ID`。
2. 删除 `undiciProxyAgentStub()`。
3. 从 `plugins` 中移除 `undiciProxyAgentStub()`。
4. 如需固定 chunk 名，可把 `["undici", { packages: ["undici"] }]` 加回 `CHUNK_RULES`。
5. 重新运行 `pnpm build`。

回滚后预期会重新生成 `dist/chunks/undici.js`。
