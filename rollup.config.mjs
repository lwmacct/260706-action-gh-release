import commonjs from "@rollup/plugin-commonjs";
import json from "@rollup/plugin-json";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";
import path from "node:path";
import { minify } from "terser";

const NODE_BUILTIN_PATTERN = /^(node:)?(assert|async_hooks|buffer|child_process|console|crypto|diagnostics_channel|dns|events|fs|http|http2|https|module|net|os|path|process|querystring|stream|stream\/promises|string_decoder|timers|tls|tty|url|util|worker_threads|zlib)$/;

function __manualChunks(_id) {
  if (!_id.includes("node_modules")) {
    return undefined;
  }

  if (_id.includes("@actions/cache")) {
    return "actions-cache";
  }
  if (_id.includes("@actions/core")) {
    return "actions-core";
  }
  if (_id.includes("@actions/tool-cache")) {
    return "actions-tool-cache";
  }
  if (_id.includes("@actions/")) {
    return "actions-core";
  }
  if (_id.includes("@azure/storage-blob") || _id.includes("@azure/storage-common")) {
    return "azure-storage";
  }
  if (_id.includes("@azure/")) {
    return "azure-core";
  }
  if (_id.includes("@protobuf-ts/runtime")) {
    return "protobuf-runtime";
  }
  if (_id.includes("@protobuf-ts/")) {
    return "protobuf";
  }
  if (_id.includes("supports-color")) {
    return "vendor";
  }
  if (_id.includes("semver")) {
    return "semver";
  }
  if (_id.includes("undici")) {
    return "undici";
  }

  return "vendor";
}

function __protobufRuntimeAlias() {
  const _runtimePath = path.resolve("node_modules/@protobuf-ts/runtime/build/es2015/index.js");

  return {
    name: "protobuf-runtime-alias",
    resolveId(_source) {
      if (_source === "@protobuf-ts/runtime") {
        return _runtimePath;
      }
      return null;
    },
  };
}

function __minifyChunks() {
  return {
    name: "minify-chunks",
    async generateBundle(_options, _bundle) {
      for (const [_fileName, _asset] of Object.entries(_bundle)) {
        if (_asset.type !== "chunk" || !_asset.fileName.startsWith("chunks/")) {
          continue;
        }

        const _result = await minify(_asset.code, {
          compress: {
            passes: 2,
          },
          format: {
            comments: false,
          },
          mangle: true,
          module: true,
        });

        if (!_result.code) {
          throw new Error(`Failed to minify ${_asset.fileName}`);
        }
        _asset.code = _result.code;
      }
    },
  };
}

export default {
  input: "src/main.ts",
  external: (_id) => NODE_BUILTIN_PATTERN.test(_id),
  output: {
    dir: "dist",
    format: "es",
    entryFileNames: "index.js",
    chunkFileNames: "chunks/[name].js",
    manualChunks: __manualChunks,
    generatedCode: {
      constBindings: true,
    },
  },
  plugins: [
    __protobufRuntimeAlias(),
    nodeResolve({
      exportConditions: ["node", "import", "default"],
      preferBuiltins: true,
    }),
    commonjs({
      transformMixedEsModules: true,
    }),
    json(),
    typescript({
      tsconfig: "./tsconfig.json",
      noForceEmit: true,
      noEmit: false,
      outDir: undefined,
    }),
    __minifyChunks(),
  ],
};
