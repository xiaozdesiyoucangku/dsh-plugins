/**
 * 构建客户端半边。
 *
 * 产出 `lib/client.js`：DSH Web 壳认识的 `window.__ModuleLoader__.load({...})`
 * 包装格式。React 由宿主通过 `require` 提供，标记为 external。
 *
 * 用法：node scripts/build-client.mjs
 */
import { build } from 'esbuild'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = join(ROOT, 'client-src', 'index.js')
const OUT_DIR = join(ROOT, 'lib')
const OUT_FILE = join(OUT_DIR, 'client.js')

/** 宿主通过 require 提供的模块（web boot 的 baseline 模块表） */
const HOST_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

const result = await build({
  entryPoints: [ENTRY],
  bundle: true,
  // ⚠️ 必须用 iife + globalName：cjs 格式会让 esbuild 自己声明 module/exports，
  // 与外层包装的同名变量冲突，导致导出的 apply 丢失。
  format: 'iife',
  globalName: '__dshImageGen',
  platform: 'browser',
  target: 'es2022',
  write: false,
  legalComments: 'none',
  external: HOST_MODULES,
  // 让 iife 的返回值就是模块导出对象
  footer: { js: 'return __dshImageGen;' },
})

const code = result.outputFiles[0].text

// 包成 DSH Web 壳的模块格式：factory 返回导出对象
const wrapped = `window.__ModuleLoader__.load({
\tid: "dsh-image-gen",
\tfactory: (require) => {
${code.replace(/^/gm, '\t\t')}
\t}
});
`

mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(OUT_FILE, wrapped, 'utf8')

const bytes = readFileSync(OUT_FILE).length
console.log(`[dsh-image-gen] 客户端已构建: ${OUT_FILE} (${bytes} bytes)`)
