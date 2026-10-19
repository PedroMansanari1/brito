// Gera dist/cli.bundle.mjs: o CLI inteiro num arquivo, com zod e os SDKs embutidos.
// Necessário no app desktop: o Node do Electron rejeita alguns package.json (ex.: zod) na resolução de módulos.
// Ficam de fora só os pacotes nativos/wasm, que o bundler não sabe empacotar.
import { build } from "esbuild";

await build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.bundle.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: ["@ladybugdb/core", "web-tree-sitter", "tree-sitter-wasms"],
  // dependências CJS embutidas em ESM precisam de `require`
  banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
  logLevel: "info",
});
