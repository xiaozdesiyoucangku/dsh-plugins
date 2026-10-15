/**
 * 启动安全性检查（临时脚本）。
 *
 * 目标：在重启前，尽可能复现宿主启动时会做的每一件事，找出会导致
 * 「启动失败 / 白屏 / 功能静默失效」的问题。
 *
 * 覆盖：
 *   1. Host 模块能否被 import（顶层代码不抛错）
 *   2. Config schema 能否实例化
 *   3. apply() 在「服务齐全」与「服务缺失」两种情况下都不抛错
 *   4. 工具注册定义符合宿主校验规则（required 必须是字符串数组等）
 *   5. 客户端 bundle 声明合法性（复刻 client-modules 的判定）
 *   6. 客户端 bundle 能执行并返回导出对象
 *   7. 各路由在同源/异源下的行为
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 插件根目录 = 本脚本所在目录的上一级。写成相对推导，换机器不用改。
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const problems = []
const notes = []
const fail = (m) => problems.push(m)
const note = (m) => notes.push(m)

// ───────── 1. Host 模块 import ─────────
let mod
try {
  mod = await import(`file://${ROOT}/index.js`)
  console.log('1. Host 模块 import        ✓')
} catch (err) {
  fail(`Host 模块 import 抛错: ${err.message}`)
  console.log('1. Host 模块 import        ✗ ' + err.message)
}

if (mod !== undefined) {
  // ───────── 2. 导出完整性 ─────────
  for (const key of ['name', 'apply', 'Config']) {
    if (mod[key] === undefined) fail(`缺少导出 ${key}`)
  }
  console.log(`2. 导出 name/apply/Config  ${mod.name !== undefined && typeof mod.apply === 'function' && mod.Config !== undefined ? '✓' : '✗'}`)

  // ───────── 3. Config schema ─────────
  let config
  try {
    config = mod.Config({})
    console.log('3. Config 实例化           ✓')
  } catch (err) {
    fail(`Config({}) 抛错: ${err.message}`)
    console.log('3. Config 实例化           ✗ ' + err.message)
  }

  // ───────── 4. apply() 各种服务组合 ─────────
  if (config !== undefined) {
    const makeRoot = (services, label) => ({
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      inject: (deps, cb) => {
        const ctx = {
          get: (n) => services[n],
          effect: (fn) => { fn(); return () => {} },
        }
        try {
          cb(ctx)
        } catch (err) {
          fail(`apply() 在「${label}」下抛错: ${err.message}`)
        }
      },
    })
    const toolStub = { register: () => () => {} }
    const webStub = { register: () => () => {} }
    const credStub = { resolve: async () => undefined }

    const scenarios = [
      ['服务齐全', { tools: toolStub, webServer: webStub, credentials: credStub }],
      ['只有 tools', { tools: toolStub }],
      ['只有 webServer', { webServer: webStub }],
      ['全部缺失', {}],
      ['tools 是空对象', { tools: {}, webServer: {} }],
      ['webServer.register 缺失', { tools: toolStub, webServer: {} }],
    ]
    let ok = true
    for (const [label, services] of scenarios) {
      const before = problems.length
      try {
        mod.apply(makeRoot(services, label), config)
      } catch (err) {
        fail(`apply() 直接抛错（${label}）: ${err.message}`)
        ok = false
      }
      if (problems.length > before) ok = false
    }
    console.log(`4. apply() 服务组合容错     ${ok ? '✓' : '✗'}（测了 ${scenarios.length} 种）`)

    // ───────── 5. 工具定义符合宿主校验 ─────────
    let captured = null
    try {
      mod.apply({
        logger: { info: () => {}, warn: () => {} },
        inject: (deps, cb) => cb({
          get: (n) => (n === 'tools' ? { register: (d) => { captured = d; return () => {} } } : undefined),
          effect: (fn) => { fn(); return () => {} },
        }),
      }, config)
    } catch (err) {
      fail(`捕获工具定义时抛错: ${err.message}`)
    }
    if (captured === null) {
      fail('未捕获到工具定义（tools.register 未被调用）')
      console.log('5. 工具定义校验            ✗ 未捕获')
    } else {
      const issues = []
      if (captured.name !== 'generate_image') issues.push(`name 异常: ${captured.name}`)
      if (typeof captured.description !== 'string' || captured.description.length === 0) issues.push('description 缺失')
      if (captured.output === undefined) issues.push('output 缺失')
      else {
        if (typeof captured.output.render !== 'function') issues.push('output.render 不是函数')
        // 宿主 assertSupportedJsonSchema 的关键规则
        const checkRequired = (node, path) => {
          if (node === null || typeof node !== 'object') return
          if (Object.hasOwn(node, 'required')
            && (!Array.isArray(node.required) || node.required.some((x) => typeof x !== 'string'))) {
            issues.push(`${path}.required 必须是字符串数组`)
          }
          for (const [k, v] of Object.entries(node.properties ?? {})) checkRequired(v, `${path}.properties.${k}`)
          if (node.items !== undefined) checkRequired(node.items, `${path}.items`)
        }
        checkRequired(captured.output.schema, 'output.schema')
        checkRequired(captured.parameters, 'parameters')
      }
      if (captured.timeoutMs !== undefined && (!Number.isFinite(captured.timeoutMs) || captured.timeoutMs <= 0)) {
        issues.push('timeoutMs 非法')
      }
      if (issues.length > 0) {
        for (const i of issues) fail(`工具定义: ${i}`)
        console.log('5. 工具定义校验            ✗ ' + issues.join('; '))
      } else {
        console.log('5. 工具定义校验            ✓（required 为字符串数组、render 存在）')
      }
    }

    // ───────── 7. 路由行为 ─────────
    const routes = {}
    mod.apply({
      logger: { info: () => {}, warn: () => {} },
      inject: (deps, cb) => cb({
        get: (n) => (n === 'webServer'
          ? { register: (r) => { routes[r.path] = r; return () => {} } }
          : (n === 'credentials' ? { resolve: async () => undefined } : undefined)),
        effect: (fn) => { fn(); return () => {} },
      }),
    }, config)
    const expected = ['/dsh-image-gen/config', '/dsh-image-gen/models']
    const missing = expected.filter((p) => routes[p] === undefined)
    if (missing.length > 0) fail(`路由未注册: ${missing.join(', ')}`)
    else {
      // 同源 GET 应 200；跨站应 403
      const mockRes = () => {
        const r = { statusCode: 0, headers: {}, body: '' }
        r.setHeader = (k, v) => { r.headers[k] = v }
        r.end = (b) => { r.body = b }
        return r
      }
      const H = { host: '127.0.0.1:19387' }
      const checks = []
      let r1 = mockRes()
      await routes['/dsh-image-gen/config'].handler({ method: 'GET', headers: { ...H } }, r1)
      checks.push(['同源 GET config', r1.statusCode === 200])
      let r2 = mockRes()
      await routes['/dsh-image-gen/config'].handler(
        { method: 'POST', headers: { ...H, 'sec-fetch-site': 'cross-site' },
          async *[Symbol.asyncIterator]() { yield Buffer.from('{}') } }, r2)
      checks.push(['跨站 POST 被拒', r2.statusCode === 403])
      let r3 = mockRes()
      await routes['/dsh-image-gen/models'].handler({ method: 'GET', headers: { ...H } }, r3)
      checks.push(['GET models 返回 405', r3.statusCode === 405])
      const bad = checks.filter(([, ok]) => !ok).map(([n]) => n)
      if (bad.length > 0) fail(`路由行为异常: ${bad.join(', ')}`)
      console.log(`7. 路由行为                ${bad.length === 0 ? '✓' : '✗ ' + bad.join(', ')}`)
    }
  }
}

// ───────── 6. 客户端 bundle ─────────
const pkgPath = join(ROOT, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const decl = pkg.dsh?.client
if (decl === undefined || decl.platform !== 'web') {
  note('未声明 dsh.client，跳过客户端检查')
} else {
  const rel = typeof pkg.exports?.['./client'] === 'string' ? pkg.exports['./client'] : undefined
  if (rel === undefined) {
    fail('声明了 dsh.client 但没有 exports["./client"]（宿主会抛 ClientPackageCompositionError）')
    console.log('6. 客户端 bundle            ✗ 缺少 exports["./client"]')
  } else {
    const abs = join(ROOT, rel)
    if (!existsSync(abs)) {
      fail(`客户端 bundle 不存在: ${abs}`)
      console.log('6. 客户端 bundle            ✗ 文件不存在')
    } else {
      const code = readFileSync(abs, 'utf8')
      const size = statSync(abs).size
      let clientOk = true
      if (!code.includes('__ModuleLoader__.load')) { fail('bundle 未使用 __ModuleLoader__.load'); clientOk = false }
      const idm = /id:\s*"([^"]+)"/.exec(code)
      if (idm === null || idm[1] !== pkg.name) { fail(`bundle id (${idm?.[1]}) 与包名 (${pkg.name}) 不一致`); clientOk = false }
      if (!/return\s+__dshImageGen\s*;/.test(code)) { fail('bundle factory 未返回导出对象'); clientOk = false }
      // 实际执行
      if (clientOk) {
        let loaded = null
        try {
          const loader = { load: (e) => { loaded = e } }
          new Function('window', code)({ __ModuleLoader__: loader })
          const reactStub = {
            createElement: (t, p, ...c) => ({ type: t, props: p, children: c }),
            useState: (i) => [typeof i === 'function' ? i() : i, () => {}],
            useCallback: (f) => f,
            useEffect: () => {},
          }
          const exp = loaded.factory((id) => {
            if (id === 'react') return reactStub
            throw new Error(`unexpected require: ${id}`)
          })
          if (typeof exp.apply !== 'function') { fail('客户端 apply 不是函数'); clientOk = false }
          let injected = null
          const registered = []
          exp.apply({
            slots: {
              inject: (k, cb) => { injected = k; cb() },
              register: (d, c) => registered.push({ d, c }),
            },
            effect: (fn) => { fn(); return () => {} },
          })
          if (injected !== 'settings.models.footer') { fail(`槽位不对: ${injected}`); clientOk = false }
          if (registered.length !== 1) { fail(`注册数异常: ${registered.length}`); clientOk = false }
          // 渲染一次
          const tree = registered[0].c({})
          if (tree === undefined || tree === null) { fail('组件渲染返回空'); clientOk = false }
        } catch (err) {
          fail(`客户端 bundle 执行抛错: ${err.message}`)
          clientOk = false
        }
      }
      console.log(`6. 客户端 bundle            ${clientOk ? `✓（${size} bytes，可执行、可注册、可渲染）` : '✗'}`)
    }
  }
}

// ───────── 结论 ─────────
console.log('')
console.log('================ 结论 ================')
if (notes.length > 0) for (const n of notes) console.log(`提示: ${n}`)
if (problems.length === 0) {
  console.log('✅ 未发现会导致启动失败或功能静默失效的问题。')
  console.log('   可以重启。')
  process.exit(0)
} else {
  console.log('❌ 发现问题，重启前请先修：')
  for (const p of problems) console.log(`   - ${p}`)
  process.exit(1)
}
