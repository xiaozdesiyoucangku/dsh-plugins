/**
 * dsh-image-gen —— DSH 生图插件
 *
 * 注册 `generate_image` 工具：调用硅基流动的 images/generations 接口出图，
 * 立刻把（1 小时过期的）临时 URL 下载到本地，再把本地绝对路径以 markdown
 * 图片形式返回，由前端内建的 pathImages 重写为 /api/file 后直接显示。
 *
 * 设计要点（详见同目录 README.md）：
 *   - 不注册 HTTP 路由：前端 AssistantMarkdown 已无条件把 markdown 里的绝对
 *     路径图片重写为 /api/file?path=...，因此返回 ![](绝对路径) 即可出图。
 *   - 凭据每次调用都 resolve，不缓存（credentials 服务的要求）。
 *   - 免费模型限流很紧（实测约 6 次/分钟，code 50604），必须退避重试。
 *
 * @module dsh-image-gen
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import Schema from '@deepseek-ai/schemastery'

export const name = 'dsh-image-gen'

/** 工具名 */
const TOOL_NAME = 'generate_image'

/** 默认（免费）模型 */
const DEFAULT_MODEL = 'Kwai-Kolors/Kolors'
/** 图生图默认模型：给了参考图但没指定模型时使用 */
const DEFAULT_EDIT_MODEL = 'Qwen/Qwen-Image-Edit'

/** 默认厂商 id */
const DEFAULT_PROVIDER = 'siliconflow'

/**
 * 内置厂商模板。
 *
 * 新增厂商 = 在配置的 providers 下加一段（或改这里的模板），不需要改代码。
 * 各家生图接口的差异基本只在四处：endpoint、鉴权方式、请求字段名、响应取值路径。
 *
 * fields：逻辑字段 → 该厂商的请求体字段名。空字符串表示「不发送该字段」。
 * response：从响应体里取图片数组 / 单张 URL / seed 的路径（点号分隔，支持 [n] 下标）。
 * auth：'bearer' | 'header:<名>' | 'query:<名>' | 'none'
 * retryableCodes：该厂商表示「可重试」（限流/过载）的业务错误码。
 */
const BUILTIN_PROVIDERS = {
  siliconflow: {
    displayName: '硅基流动',
    endpoint: 'https://api.siliconflow.cn/v1/images/generations',
    credential: 'SILICONFLOW_API_KEY',
    auth: 'bearer',
    defaultModel: 'Kwai-Kolors/Kolors',
    editModel: 'Qwen/Qwen-Image-Edit',
    fields: {
      prompt: 'prompt',
      model: 'model',
      size: 'image_size',
      seed: 'seed',
      negativePrompt: 'negative_prompt',
      batchSize: 'batch_size',
      image: 'image',
    },
    response: { images: 'images', url: 'url', seed: 'seed' },
    retryableCodes: [50604, 50505],
    /** 模型列表接口（OpenAI 兼容：GET，Bearer 鉴权，返回 { data: [{ id }] }） */
    models: {
      endpoint: 'https://api.siliconflow.cn/v1/models',
      path: 'data',
      id: 'id',
      /**
       * 服务端筛选参数：**一次请求直接返回生图模型**，无需关键词猜测与逐个探测。
       * 实测 `sub_type=text-to-image` 返回的 6 个模型，与「关键词预筛 + 探测」
       * 的结果完全一致，但快得多、不消耗限流额度。
       */
      query: { sub_type: 'text-to-image' },
    },
    /** 判定「能生图」的业务码 */
    probeCodes: {
      /** 模型存在且是生图模型（参数校验失败 —— 发生在扣费之前，因此探测免费） */
      supported: [20015, 20014, 20013],
      /** 不是生图模型 */
      unsupported: [30000],
      /** 模型不存在 */
      missing: [20012],
    },
    /** 关键词预筛：先用这些词缩小候选，再逐个探测 */
    modelHints: ['image', 'kolors', 'flux', 'stable-diffusion', 'z-image', 'diffusion', 'sd3', 'sdxl'],
  },

  // ==========================================================================
  // 以下 4 家**已用真实 Key 实测**（2026-10-08）：
  //   - 智谱：出图成功（cogview-3-flash 免费）
  //   - 千帆：出图成功（qwen-image）
  //   - 阿里：出图成功（**异步**：提交→轮询，实测约 8 秒）
  //   - 火山：模型列表可拉，但账号未开通生图模型（ModelNotOpen）
  // ==========================================================================

  zhipu: {
    displayName: '智谱 GLM',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4/images/generations',
    credential: 'ZHIPU_API_KEY',
    auth: 'bearer',
    defaultModel: 'cogview-3-flash',   // 免费，实测可用
    editModel: 'cogview-4',
    fields: {
      prompt: 'prompt',
      model: 'model',
      size: 'size',                    // 实测：智谱用 size（不是 image_size）
      seed: '',
      negativePrompt: '',
      batchSize: '',
      image: 'image_url',
    },
    response: { images: 'data', url: 'url', seed: '' },   // 实测：{ data: [{ url }] }
    retryableCodes: [1301, 1113],
    models: { endpoint: 'https://open.bigmodel.cn/api/paas/v4/models', path: 'data', id: 'id' },
    /**
     * ⚠️ 实测：智谱的 /models **只返回 11 个 glm-* 对话模型，不含生图模型**。
     * 所以列表接口拉不到生图模型，必须靠这份清单兜底。
     */
    knownImageModels: ['cogview-4', 'cogview-4-250304', 'glm-image', 'cogview-3-flash'],
    modelHints: ['cogview', 'glm-image'],
    /**
     * ⚠️ 实测：智谱对**任何**模型名都返回同一个 code 1214（参数校验失败），
     * 连不存在的模型也是。所以 1214 只能证明「请求被参数校验拦下」，
     * **不能用来区分模型是否可生图** —— 这里不配 probeCodes，走 HTTP 状态判断。
     */
    probeCodes: { supported: [1214], unsupported: [], missing: [] },
  },

  dashscope: {
    displayName: '阿里云百炼',
    // 实测：兼容模式 /compatible-mode/v1/images/generations 是 404，
    // 必须用这个异步接口。
    endpoint: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis',
    /**
     * ⚠️ 图生图走**另一个 endpoint**（实测 2026-10-12）：
     *   文生图 `/aigc/text2image/image-synthesis`
     *   图生图 `/aigc/image2image/image-synthesis`
     * 打错接口的表现是任务直接 FAILED 或参数被忽略，不是明显的 404。
     * 请求体结构相同（`input.prompt`），差别只是参考图放 `input.base_image_url`。
     */
    editEndpoint: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/image2image/image-synthesis',
    credential: 'DASHSCOPE_API_KEY',
    auth: 'bearer',
    /**
     * 默认模型：优先「新人免费额度最多 + 质量较好」的两个。
     * 实测百炼 `/api/v1/models?capabilities=IG` 共 43 个生图模型，
     * 免费额度见 FREE_QUOTA —— 万相2.1 系列是唯一给到 500 张的一档。
     *   文生图：wanx2.1-t2i-plus（500张，0.20元/张）
     *   图生图：wanx2.1-imageedit（500张，0.14元/张）
     */
    defaultModel: 'wanx2.1-t2i-plus',
    editModel: 'wanx2.1-imageedit',
    fields: {
      prompt: 'input.prompt',          // 实测：嵌套结构
      model: 'model',
      size: 'parameters.size',
      seed: 'parameters.seed',
      negativePrompt: 'input.negative_prompt',
      batchSize: 'parameters.n',
      /**
       * 参考图：百炼图生图放在 `input.base_image_url`（实测 2026-10-12）。
       * 之前这里是空串（图生图时参考图根本不进请求体，静默失效）。
       * 注意必须配合 `editEndpoint` 使用，否则会打到 text2image 上。
       */
      image: 'input.base_image_url',
      /**
       * ⚠️ 百炼图生图的 `input.function` 是**必填**（实测 2026-10-12）。
       * 不传会报 `InvalidParameter: The following fields are required: function`。
       * 这与多数厂商不同，所以单列一个逻辑字段。
       */
      editFunction: 'input.function',
    },
    /**
     * 图生图默认编辑功能。`description_edit`（指令编辑）最通用：
     * 无需指定区域，仅靠提示词增删改图片内容。
     * 其余取值见官方文档：stylization_all/local、remove_watermark、expand、
     * super_resolution、colorization、doodle、control_cartoon_feature、
     * description_edit_with_mask（**需要额外传 mask，本插件暂不支持**）。
     */
    defaultEditFunction: 'description_edit',
    // 异步任务完成后，结果在 output.results[].url
    response: { images: 'output.results', url: 'url', seed: '' },
    retryableCodes: ['Throttling', 'RequestLimitExceeded'],
    /** 实测必需：阿里要求尺寸写成 `1024*1024`，不是 `1024x1024` */
    sizeSeparator: '*',
    /** 实测必需：不带这个头会返回 403「does not support synchronous calls」 */
    headers: { 'X-DashScope-Async': 'enable' },
    /** 异步任务：提交拿 task_id，轮询到 SUCCEEDED */
    asyncTask: {
      taskIdPath: 'output.task_id',
      endpoint: 'https://dashscope.aliyuncs.com/api/v1/tasks/{taskId}',
      statusPath: 'output.task_status',
      successStatus: ['SUCCEEDED'],
      failureStatus: ['FAILED', 'CANCELED', 'UNKNOWN'],
      intervalMs: 4000,
      timeoutMs: 300000,
    },
    /**
     * 模型列表：用百炼**原生** `/api/v1/models` + `capabilities=IG`（图片生成）。
     *
     * 实测（2026-10-11）：该接口精确返回 43 个生图模型，且**每个都带官方价格**
     * （`prices[].prices[].price`，单位「每张」），比 compatible-mode 的
     * 175 个混杂模型 + 关键词预筛准得多，也省掉了逐个探测。
     *
     * `path: output.models` —— 响应是 { output: { total, models: [...] } }。
     * `query` 一旦配置，上层就不再关键词过滤、不再探测（serverFiltered）。
     */
    models: {
      endpoint: 'https://dashscope.aliyuncs.com/api/v1/models',
      path: 'output.models',
      id: 'model',
      query: { capabilities: 'IG', page_size: '100' },
      /**
       * 价格自动化：直接从模型列表响应里读官方价格，覆盖内置 PRICE_TABLE。
       * 按 `price_unit` 含「张」筛，并排除「输入」项（参考图费用）。
       * 详见 extractApiPrice 的注释。
       */
      price: { path: 'prices', unit: '张', excludeName: '输入' },
    },
    modelHints: ['qwen-image', 'wan2', 'wanx', 'wan3'],
    probeCodes: { supported: [], unsupported: [], missing: [] },
  },

  ark: {
    displayName: '火山方舟',
    endpoint: 'https://ark.cn-beijing.volces.com/api/v3/images/generations',
    credential: 'ARK_API_KEY',
    auth: 'bearer',
    defaultModel: 'doubao-seedream-5-0-flash-260915',
    editModel: 'doubao-seededit-3-0-i2i-250628',
    fields: {
      prompt: 'prompt',
      model: 'model',
      size: 'size',
      seed: 'seed',
      negativePrompt: '',
      batchSize: '',
      image: 'image',
    },
    response: { images: 'data', url: 'url', seed: '' },
    retryableCodes: [],
    /**
     * 火山模型列表**带官方元数据**：domain / task_type / status。
     * 比关键词准得多，可直接筛出生图模型并排除已下线的。
     */
    models: {
      endpoint: 'https://ark.cn-beijing.volces.com/api/v3/models',
      path: 'data',
      id: 'id',
      /** 服务端不支持的筛选在本地做：见 filterModel 逻辑 */
      localFilter: { field: 'domain', equals: 'ImageGeneration' },
    },
    modelHints: ['seedream', 'seededit'],
    probeCodes: { supported: [], unsupported: [], missing: [] },
  },

  qianfan: {
    displayName: '百度千帆',
    endpoint: 'https://qianfan.baidubce.com/v2/images/generations',
    credential: 'QIANFAN_API_KEY',
    auth: 'bearer',
    defaultModel: 'qwen-image',
    editModel: 'qwen-image-edit',
    fields: {
      prompt: 'prompt',
      model: 'model',
      size: 'size',
      seed: 'seed',
      negativePrompt: 'negative_prompt',
      batchSize: 'n',
      image: '',
    },
    response: { images: 'data', url: 'url', seed: '' },   // 实测：{ data: [{ url }] }
    // 实测：RPM 限流返回 429 + code rpm_rate_limit_exceeded
    retryableCodes: ['rpm_rate_limit_exceeded', 'rate_limit_exceeded'],
    models: { endpoint: 'https://qianfan.baidubce.com/v2/models', path: 'data', id: 'id' },
    modelHints: ['qwen-image', 'irag', 'musesteamer'],
    probeCodes: { supported: [], unsupported: [], missing: [] },
  },
}

/** 默认字段映射（新增厂商未指定 fields 时使用） */
const DEFAULT_FIELDS = {
  prompt: 'prompt',
  model: 'model',
  size: 'image_size',
  seed: 'seed',
  negativePrompt: 'negative_prompt',
  batchSize: 'batch_size',
  image: 'image',
}

/** 默认响应取值路径 */
const DEFAULT_RESPONSE = { images: 'images', url: 'url', seed: 'seed' }

/** 单次生成张数上限 */
const MAX_BATCH_SIZE = 4

/** 图片字节签名：PNG / JPEG / GIF / WEBP */
const IMAGE_SIGNATURES = [
  { ext: '.png', mediaType: 'image/png', test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { ext: '.jpg', mediaType: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: '.gif', mediaType: 'image/gif', test: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 },
  {
    ext: '.webp',
    mediaType: 'image/webp',
    test: (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
      && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  },
]

/** 从字节识别图片格式；识别不出返回 null */
function sniffImage(bytes) {
  if (bytes.length < 12) return null
  for (const signature of IMAGE_SIGNATURES) {
    if (signature.test(bytes)) return signature
  }
  return null
}

/** PNG IHDR 宽高（仅 PNG 可读；其他返回 null） */
function pngSize(bytes) {
  if (bytes.length < 24) return null
  if (!(bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)) return null
  const read = (offset) => (bytes[offset] * 16777216) + (bytes[offset + 1] * 65536) + (bytes[offset + 2] * 256) + bytes[offset + 3]
  return { width: read(16), height: read(20) }
}

/** 展开 ~ / ~\ 前缀 */
function expandHome(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

/** $DSH_HOME（空/空白视为未设置）→ 回落 ~/.dsh */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  const selected = fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), '.dsh')
  return resolve(expandHome(selected))
}

/**
 * 从模块自身位置推导 profile 目录。
 *
 * 不能依赖 DSH_PROFILE_DIR：它由 dsh-shell-env 只注入给**模型 shell 调用**，
 * Host 进程环境里并没有（实测插件在 Host 侧读到的是 undefined）。
 * 插件位于 <profileDir>/plugins/<name>/ 或 <profileDir>/node_modules/<name>/，
 * 所以从模块目录逐级上溯，找到含 `dsh.profile` 的 package.json 即 profile 根。
 *
 * @returns profile 目录绝对路径，推导失败返回 undefined。
 */
function profileDirFromModule() {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 5; depth += 1) {
    const manifest = join(dir, 'package.json')
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, 'utf8'))
        if (parsed !== null && typeof parsed === 'object' && parsed.dsh?.profile !== undefined) return dir
      } catch (err) {
        // 读取/解析失败 → 继续上溯
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/**
 * 默认输出目录：<profile>/generated-images。
 * 依次尝试：模块路径推导 → DSH_PROFILE_DIR → $DSH_HOME/profiles/<DSH_PROFILE> → $DSH_HOME。
 */
function defaultOutputDir() {
  const fromModule = profileDirFromModule()
  if (fromModule !== undefined) return join(fromModule, 'generated-images')
  const profileDir = process.env.DSH_PROFILE_DIR
  if (profileDir !== undefined && profileDir.trim().length > 0) {
    return join(resolve(expandHome(profileDir)), 'generated-images')
  }
  const home = dshHome()
  const profile = process.env.DSH_PROFILE
  if (profile !== undefined && profile.trim().length > 0) {
    return join(home, 'profiles', profile, 'generated-images')
  }
  return join(home, 'generated-images')
}

/** profile 目录（用于放运行期覆盖文件）；推导失败回落 $DSH_HOME */
function defaultProfileDir() {
  return profileDirFromModule() ?? dshHome()
}

/** 校验 image_size：形如 1024x1024，两边为 64..maxSide 的整数 */
function parseImageSize(raw, maxSide) {
  if (typeof raw !== 'string' || !/^\d+x\d+$/.test(raw.trim())) {
    throw new Error(`${TOOL_NAME}: image_size 必须形如 "1024x1024"，收到: ${String(raw)}`)
  }
  const [width, height] = raw.trim().split('x').map((part) => Number(part))
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 64 || height < 64) {
    throw new Error(`${TOOL_NAME}: image_size 两边必须是 >= 64 的整数，收到: ${raw}`)
  }
  if (width > maxSide || height > maxSide) {
    throw new Error(`${TOOL_NAME}: image_size 单边不能超过 ${maxSide}，收到: ${raw}`)
  }
  return `${width}x${height}`
}

/** 模型名 → 安全文件名片段 */
function modelSlug(model) {
  const slug = String(model).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return slug.length > 0 ? slug : 'model'
}

/** 本地时间戳 yyyymmdd-HHMMSS */
function timestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/** 短随机串，避免同一秒内同名 */
function shortId() {
  return Math.random().toString(36).slice(2, 8)
}

/** 可被取消的 sleep */
function sleep(ms, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    if (signal?.aborted) {
      rejectPromise(new Error('aborted'))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      rejectPromise(new Error('aborted'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolvePromise()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** 请求超时信号：把调用方 signal 与本次超时合并 */
function requestSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs)
  if (signal === undefined) return timeout
  return AbortSignal.any([signal, timeout])
}

/** markdown 图片目标编码：正斜杠 + 编码空格/中文/#/? 等 */
function encodeMarkdownPath(path) {
  return encodeURI(path.replace(/\\/g, '/')).replace(/#/g, '%23').replace(/\?/g, '%3F')
}

/** 统一正斜杠的展示路径（前端要求绝对路径） */
function toDisplayPath(path) {
  return resolve(path).replace(/\\/g, '/')
}

/**
 * 从接口错误响应体里取 code / message。
 *
 * 各家结构不同，实测到的形态：
 *   - 硅基流动：{ code: 20015, message: "..." }
 *   - 智谱：    { error: { code: "401", message: "令牌已过期..." } }
 *   - 火山：    { error: { code: "AuthenticationError", message: "..." } }
 *   - 千帆：    { error: { code: "invalid_iam_token", message: "..." }, id: "..." }
 *   - 阿里：    { code: "InvalidApiKey", message: "..." }
 *
 * @param body - 响应体文本
 * @returns { code, message }；code 统一为字符串，便于跨厂商比较
 */
function readApiError(body) {
  const raw = (() => {
    try {
      return JSON.parse(body)
    } catch (err) {
      return undefined
    }
  })()
  const text = typeof body === 'string' ? body.slice(0, 300) : ''
  if (raw === null || typeof raw !== 'object') return { code: undefined, message: text }
  // 顶层 code，或嵌套 error.code
  const codeValue = raw.code ?? raw.error?.code
  const messageValue = raw.message ?? raw.error?.message
  return {
    code: typeof codeValue === 'number' || typeof codeValue === 'string' ? String(codeValue) : undefined,
    message: typeof messageValue === 'string' ? messageValue : text,
  }
}

/** 把接口错误转成模型可读的中文 Error */
function describeApiError(provider, status, code, message) {
  const where = `${provider.displayName}（${provider.id}）`
  const text = String(message ?? '')
  if (status === 401 || status === 403 || /invalid token|unauthorized|invalid.?api.?key|令牌|鉴权/i.test(text)) {
    return new Error(
      `${TOOL_NAME}: ${where} 凭据无效（HTTP ${status}）。请在「设置 → 模型 → 生图」里检查 API Key。`
      + `原始信息: ${text}`,
    )
  }
  if (code === '50604' || /rate limit|too many requests|throttl/i.test(text)) {
    return new Error(`${TOOL_NAME}: ${where} 触发限流。请稍等约 1 分钟再试。原始信息: ${text}`)
  }
  if (code === '50505' || /overloaded|service unavailable/i.test(text)) {
    return new Error(`${TOOL_NAME}: ${where} 服务过载，请稍后重试。原始信息: ${text}`)
  }
  if (code === '20012' || /invalid.*(parameter|request)|参数/i.test(text)) {
    return new Error(`${TOOL_NAME}: ${where} 请求参数被拒绝。请检查 model / 尺寸 / prompt。原始信息: ${text}`)
  }
  return new Error(
    `${TOOL_NAME}: ${where} 返回 HTTP ${status}${code === undefined ? '' : ` (code ${code})`}: ${text}`,
  )
}

/** 解析参考图：http(s)/data 原样透传，本地路径读成 base64 data URI */
async function resolveReferenceImage(input, maxBytes) {
  if (/^https?:\/\//i.test(input) || /^data:/i.test(input)) return input
  const path = resolve(expandHome(input))
  if (!existsSync(path)) throw new Error(`${TOOL_NAME}: 参考图不存在: ${path}`)
  const bytes = new Uint8Array(await readFile(path))
  if (bytes.length > maxBytes) {
    throw new Error(`${TOOL_NAME}: 参考图过大（${bytes.length} 字节，上限 ${maxBytes}）`)
  }
  const mediaType = sniffImage(bytes)?.mediaType ?? 'image/png'
  return `data:${mediaType};base64,${Buffer.from(bytes).toString('base64')}`
}

/**
 * 解析 API Key，返回**候选列表**（供轮换）。
 *
 * 优先级：插件自有存储（可能多个）→ DSH 凭据域 → 同名环境变量。
 * 插件存储里的 Key 排在前面，因为那是用户在本插件界面显式添加的。
 *
 * @param ctx - 上下文（取 credentials 服务）
 * @param credential - 凭据名（回落用）
 * @param keyStore - 插件自有存储
 * @param providerId - 厂商 id
 * @returns 候选 Key 数组（可能为空）
 */
async function readApiKeys(ctx, credential, keyStore, providerId) {
  const candidates = []
  // 1. 插件自有存储
  if (keyStore !== undefined) {
    for (const value of keyStore.values(providerId)) {
      if (!candidates.includes(value)) candidates.push(value)
    }
  }
  // 2. DSH 凭据域
  try {
    const credentials = ctx?.get?.('credentials') ?? ctx?.credentials
    if (credentials?.resolve !== undefined && typeof credential === 'string' && credential.length > 0) {
      const resolved = await credentials.resolve(credential)
      if (typeof resolved?.value === 'string' && resolved.value.length > 0 && !candidates.includes(resolved.value)) {
        candidates.push(resolved.value)
      }
    }
  } catch (err) {
    // 凭据服务不可用 → 继续回落
  }
  // 3. 环境变量
  if (typeof credential === 'string' && credential.length > 0) {
    const fromEnv = process.env[credential]
    if (fromEnv !== undefined && fromEnv.trim().length > 0 && !candidates.includes(fromEnv.trim())) {
      candidates.push(fromEnv.trim())
    }
  }
  return candidates
}

/**
 * 把 DSH 凭据域 / 环境变量里已有的 Key **导入**插件自有存储。
 *
 * 为什么需要：界面只列插件存储的 Key。用户若早已把 Key 配在
 * `.credentials.yaml`（DSH 官方凭据域），界面上会是空的，看起来像
 * 「没有已保存的 API」——实测踩到过。这里在首次打开界面时自动导入，
 * 之后统一在插件里管理。
 *
 * 幂等：已存在同值的 Key 不会重复导入。
 *
 * @param ctx - 上下文
 * @param credential - 凭据名
 * @param keyStore - 插件自有存储
 * @param providerId - 厂商 id
 * @returns 导入的条数
 */
async function importExternalKeys(ctx, credential, keyStore, providerId) {
  if (keyStore === undefined || typeof credential !== 'string' || credential.length === 0) return 0
  const existing = new Set(keyStore.values(providerId))
  const imported = []
  // DSH 凭据域
  try {
    const credentials = ctx?.get?.('credentials') ?? ctx?.credentials
    if (credentials?.resolve !== undefined) {
      const resolved = await credentials.resolve(credential)
      const value = resolved?.value
      if (typeof value === 'string' && value.length > 0 && !existing.has(value)) {
        imported.push({ name: `来自凭据域（${credential}）`, value })
      }
    }
  } catch (err) {
    // 凭据服务不可用 → 跳过
  }
  // 环境变量（与凭据域同值时跳过）
  const fromEnv = process.env[credential]
  if (fromEnv !== undefined && fromEnv.trim().length > 0) {
    const value = fromEnv.trim()
    if (!existing.has(value) && !imported.some((row) => row.value === value)) {
      imported.push({ name: `来自环境变量（${credential}）`, value })
    }
  }
  for (const row of imported) keyStore.add(providerId, row.name, row.value)
  return imported.length
}

/** 单个 Key 的解析（兼容旧调用点：探测、模型列表等只需一个） */async function readApiKey(ctx, credential, keyStore, providerId) {
  const list = await readApiKeys(ctx, credential, keyStore, providerId)
  return list.length > 0 ? list[0] : undefined
}

/** 按点号路径取值，支持 `a.b[0].c` 形式 */
function readPath(value, path) {
  if (typeof path !== 'string' || path.length === 0) return undefined
  let current = value
  for (const segment of path.split('.')) {
    if (current === null || current === undefined) return undefined
    const match = /^([^[\]]*)((?:\[\d+\])*)$/.exec(segment)
    if (match === null) return undefined
    if (match[1].length > 0) current = current[match[1]]
    for (const index of match[2].match(/\d+/g) ?? []) {
      if (!Array.isArray(current)) return undefined
      current = current[Number(index)]
    }
  }
  return current
}

/**
 * 解析生效的厂商配置。
 * 优先级：providers[provider] 覆盖 → 内置模板 → 顶层通用字段（model / imageSize）。
 * @param config - 已解析的插件配置（可能已合入运行期覆盖）
 * @returns 完整厂商配置（含 endpoint / auth / fields / response / credential / 默认模型）
 */
function resolveProvider(config) {
  const id = config.provider.trim().length > 0 ? config.provider.trim() : DEFAULT_PROVIDER
  const builtin = BUILTIN_PROVIDERS[id] ?? {}
  const override = config.providers?.[id] ?? {}
  const pick = (key) => {
    const fromOverride = override[key]
    if (typeof fromOverride === 'string' && fromOverride.trim().length > 0) return fromOverride.trim()
    const fromBuiltin = builtin[key]
    if (typeof fromBuiltin === 'string' && fromBuiltin.trim().length > 0) return fromBuiltin.trim()
    return ''
  }
  const endpoint = pick('endpoint')
  if (endpoint.length === 0) {
    throw new Error(
      `${TOOL_NAME}: 厂商 "${id}" 未配置 endpoint。请在 cordis.patch.yml 的 providers.${id}.endpoint 填写生图接口地址。`,
    )
  }
  // 顶层 model 优先于厂商模板：设置界面 / 顶层配置改的就是它
  const topLevelModel = typeof config.model === 'string' ? config.model.trim() : ''
  return {
    id,
    displayName: pick('displayName') || id,
    endpoint,
    credential: pick('credential') || pick('credentialEnv'),
    auth: pick('auth') || 'bearer',
    defaultModel: topLevelModel.length > 0
      ? topLevelModel
      : (pick('defaultModel') || pick('model') || DEFAULT_MODEL),
    editModel: pick('editModel') || DEFAULT_EDIT_MODEL,
    /**
     * 图生图专用 endpoint；留空表示与文生图共用（多数 OpenAI 兼容厂商）。
     * 阿里百炼必须分开（text2image / image2image 是两个地址）。
     */
    editEndpoint: pick('editEndpoint'),
    /**
     * 图生图必填的「编辑功能」值（仅部分厂商需要，如阿里百炼）。
     * 厂商未配时为 ''，此时 buildRequestBody 会跳过该字段。
     */
    defaultEditFunction: pick('defaultEditFunction'),
    fields: { ...DEFAULT_FIELDS, ...(builtin.fields ?? {}), ...(override.fields ?? {}) },
    response: { ...DEFAULT_RESPONSE, ...(builtin.response ?? {}), ...(override.response ?? {}) },
    retryableCodes: Array.isArray(override.retryableCodes)
      ? override.retryableCodes
      : (builtin.retryableCodes ?? []),
    models: builtin.models ?? override.models,
    probeCodes: builtin.probeCodes ?? {},
    modelHints: Array.isArray(override.modelHints)
      ? override.modelHints
      : (builtin.modelHints ?? DEFAULT_MODEL_HINTS),
    /** 异步任务配置（阿里百炼必需：提交→轮询） */
    asyncTask: builtin.asyncTask ?? override.asyncTask,
    /** 厂商自定义请求头 */
    headers: { ...(builtin.headers ?? {}), ...(override.headers ?? {}) },
    /** 尺寸分隔符：'x'（默认）或 '*'（阿里百炼要求 width*height） */
    sizeSeparator: pick('sizeSeparator') || 'x',
    /**
     * 已知生图模型清单：某些厂商的 /models 接口**不含**生图模型
     * （实测智谱只返回 glm-* 对话模型），此时用它兜底。
     */
    knownImageModels: Array.isArray(override.knownImageModels)
      ? override.knownImageModels
      : (builtin.knownImageModels ?? []),
  }
}

/** 关键词预筛的默认词表 */
const DEFAULT_MODEL_HINTS = ['image', 'kolors', 'flux', 'stable-diffusion', 'z-image', 'diffusion', 'sdxl']

/**
 * 生图模型价格表（**内置数据，会过时**）。
 *
 * ⚠️ 价格随时可能调整，这里只是选型参考。使用时请以厂商官网为准。
 * `source` 标注数据来源可信度：
 *   - 'official' = 从厂商官方定价页/文档抓取
 *   - 'unofficial' = 第三方资料，**未经官方确证**
 *
 * `asOf` 是抓取日期，界面上会显示，提醒用户数据可能过时。
 */
const PRICE_TABLE = {
  asOf: '2026-10-08',
  entries: {
    // ── 硅基流动（官方定价页，完整）──
    'Kwai-Kolors/Kolors': { price: 0, unit: '张', source: 'official', note: '免费' },
    'Tongyi-MAI/Z-Image-Turbo': { price: 0.10, unit: '张', source: 'official' },
    'Tongyi-MAI/Z-Image': { price: 0.30, unit: '张', source: 'official' },
    'Qwen/Qwen-Image': { price: 0.30, unit: '张', source: 'official' },
    'Qwen/Qwen-Image-Edit': { price: 0.30, unit: '张', source: 'official' },
    'Qwen/Qwen-Image-Edit-2509': { price: 0.30, unit: '张', source: 'official' },

    // ── 智谱 GLM（官方文档 docs.bigmodel.cn/cn/guide/start/pricing）──
    'cogview-4': { price: 0.06, unit: '次', source: 'official' },
    'cogview-4-250304': { price: 0.06, unit: '次', source: 'official' },
    'glm-image': { price: 0.10, unit: '次', source: 'official' },
    'cogview-3-flash': { price: 0, unit: '次', source: 'official', note: '免费' },

    // ── 百度千帆（官方文档 cloud.baidu.com/doc/qianfan-docs）──
    'qwen-image': { price: 0.25, unit: '张', source: 'official' },
    'qwen-image-edit': { price: 0.30, unit: '张', source: 'official' },
    'musesteamer-air-image': { price: 0.05, unit: '张', source: 'official' },
    'irag-1.0': { price: 0.14, unit: '张', source: 'unofficial', note: '第三方资料，未确证' },

    // ── 阿里云百炼（官方价格页为 JS 渲染，抓不到明细）──
    // 实测可用：qwen-image / wan2.7-image / qwen-image-edit 系列
    // 注意：qwen-image 与千帆同名，价格按千帆官方数据（上面那条）
    'qwen-image-edit-max-2026-01-16': { price: 0.30, unit: '张', source: 'unofficial', note: '未确证' },
    'qwen-image-2.0': { price: 0.25, unit: '张', source: 'unofficial', note: '未确证' },
    'qwen-image-2.0-pro': { price: 0.50, unit: '张', source: 'unofficial', note: '未确证' },
    'qwen-image-3.0': { price: 0.30, unit: '张', source: 'unofficial', note: '未确证' },
    'qwen-image-3.0-pro': { price: 0.60, unit: '张', source: 'unofficial', note: '未确证' },
    'wan2.7-image': { price: 0.20, unit: '张', source: 'unofficial', note: '未确证' },
    'wan2.7-image-pro': { price: 0.50, unit: '张', source: 'unofficial', note: '未确证' },
    'wanx2.1-t2i-turbo': { price: 0.14, unit: '张', source: 'unofficial', note: '未确证' },
    'wanx2.1-t2i-plus': { price: 0.20, unit: '张', source: 'unofficial', note: '未确证' },

    // ── 火山方舟（同上；模型列表带 status 字段，Shutdown/Retiring 的已下线）──
    'doubao-seedream-5-0-flash-260915': { price: 0.20, unit: '张', source: 'unofficial', note: '未确证' },
    'doubao-seedream-5-0-pro-260628': { price: 0.30, unit: '张', source: 'unofficial', note: '未确证' },
    'doubao-seedream-5-0-260128': { price: 0.25, unit: '张', source: 'unofficial', note: '未确证' },
    'doubao-seedream-4-5-251128': { price: 0.25, unit: '张', source: 'unofficial', note: '未确证' },
    'doubao-seedream-4-0-250828': { price: 0.25, unit: '张', source: 'unofficial', note: '未确证' },
    'doubao-seedream-3-0-t2i-250415': { price: 0.25, unit: '张', source: 'unofficial', note: '已下线(Shutdown)' },
    'doubao-seededit-3-0-i2i-250628': { price: 0.25, unit: '张', source: 'unofficial', note: '已下线(Shutdown)' },
  },
}

/**
 * 查一个模型的价格。
 * @param modelId - 模型 id
 * @returns { text, free, official } 或 undefined（未知）
 */
function priceOf(modelId) {
  if (typeof modelId !== 'string' || modelId.length === 0) return undefined
  const key = Object.keys(PRICE_TABLE.entries).find(
    (candidate) => candidate.toLowerCase() === modelId.toLowerCase(),
  )
  const entry = key === undefined ? undefined : PRICE_TABLE.entries[key]
  if (entry === undefined) return undefined
  if (entry.price === 0) {
    return { text: '免费', free: true, official: entry.source === 'official' }
  }
  const suffix = entry.source === 'official' ? '' : '?'
  return {
    text: `¥${entry.price.toFixed(2)}/${entry.unit}${suffix}`,
    free: false,
    official: entry.source === 'official',
    note: entry.note,
  }
}

/**
 * 从厂商模型列表接口的**响应条目**里直接读官方价格。
 *
 * 为什么需要：百炼的 `/api/v1/models?capabilities=IG` 每个模型都带 `prices` 字段，
 * 是官方实时数据。能用它就不该依赖内置 PRICE_TABLE（那个会过时）。
 *
 * ⚠️ 实测（2026-10-11）**不能按 `type` 白名单筛选** —— 43 个模型的计费项命名
 * 五花八门，只认 `image_number` 会漏掉 18 个：
 *   - `image_number`        （wan2.6-t2i 等）
 *   - `image_standard` / `image_thinking`（z-image-turbo）
 *   - `image_type_1k/2k/4k` （vidu、kling）
 *   - `qima_output_1k/2k`、`qima_input_1k/2k`（qwen-image-3.0 系列）
 * 所以改为按 **price_unit 含「张」** 筛，再排除**输入**项。
 *
 * 为什么要排除输入项：qwen-image-3.0 同时有输入价（0.02，图生图时上传的参考图）
 * 和输出价（0.18，真正生成一张图）。取最低价会拿到输入价，误导用户。
 *
 * spec 形如 `{ path: 'prices', unit: '张', excludeName: '输入' }`。
 * 同模型有多档（1K/2K/4K、标准/思考）时取**最低价**，便于横向比较。
 *
 * @returns { text, free, official, fromApi } 或 undefined（未配 / 响应里没有）
 */
function extractApiPrice(item, spec) {
  if (spec === null || typeof spec !== 'object') return undefined
  const groups = readPath(item, typeof spec.path === 'string' ? spec.path : 'prices')
  if (!Array.isArray(groups)) return undefined
  const unit = typeof spec.unit === 'string' && spec.unit.length > 0 ? spec.unit : '张'
  const excludeName = typeof spec.excludeName === 'string' ? spec.excludeName : ''
  const values = []
  for (const group of groups) {
    const list = group !== null && typeof group === 'object' ? group.prices : undefined
    if (!Array.isArray(list)) continue
    for (const entry of list) {
      if (entry === null || typeof entry !== 'object') continue
      // 只取按「张」计费的项
      if (typeof entry.price_unit === 'string' && !entry.price_unit.includes(unit)) continue
      // 排除「输入」计费项（参考图费用，不是生成一张图的成本）
      if (excludeName.length > 0
        && typeof entry.price_name === 'string'
        && entry.price_name.includes(excludeName)) continue
      const value = Number(entry.price)
      if (Number.isFinite(value)) values.push(value)
    }
  }
  if (values.length === 0) return undefined
  const lowest = Math.min(...values)
  if (lowest === 0) return { text: '免费', free: true, official: true, fromApi: true }
  return { text: `¥${formatPrice(lowest)}/${unit}`, free: false, official: true, fromApi: true }
}

/**
 * 价格格式化：按数量级选小数位，避免 0.003 被显示成 ¥0.00。
 * 实测 `qwen-mt-image` = 0.003、`qwen-mt-image-2.0` = 0.004。
 */
function formatPrice(value) {
  if (value >= 0.01) return value.toFixed(2)
  if (value >= 0.001) return value.toFixed(3)
  return value.toFixed(4)
}

/**
 * 新人免费额度（**张数**），仅阿里百炼有这个概念。
 *
 * ⚠️ 关键事实：**免费额度没有查询接口**。
 * 实测 2026-10-11：
 *   - `/api/v1/models` 不含额度字段
 *   - `/api/v1/quotas` 返回的是**限流配额**（RPM/并发，period=6/30/60 分钟），
 *     43 个生图模型的 `usage_limit` 全为 null —— 不是免费额度
 *   - `/api/v1/free-quota` 等 5 个猜测端点全部 404
 * 所以只能内置这张表，来源为官方「模型调用价格」页，**会过时**。
 *
 * 规则（官方文档）：仅华北2（北京）地域有；开通后 90 天内有效；
 * 每个模型额度独立、不互通；额度用完且开了「用完即停」会返回
 * 403 `AllocationQuota.FreeTierOnly`。
 *
 * 选型结论（用户要求「额度最多 + 质量较好」各一个）：
 *   文生图 → `wanx2.1-t2i-plus`（500 张）
 *   图生图 → `wanx2.1-imageedit`（500 张）
 * 万相2.1 系列是唯一给到 500 张的一档，且是同代成熟模型。
 */
const FREE_QUOTA = {
  asOf: '2026-10-11',
  /** 单位一律为「张」（图像生成按成功出图张数计费） */
  entries: {
    // ── 500 张（最多的一档）──
    'wanx2.1-t2i-plus': 500,
    'wanx2.1-t2i-turbo': 500,
    'wanx2.0-t2i-turbo': 500,
    'wanx-v1': 500,
    'wanx2.1-imageedit': 500,
    'wanx-x-painting': 500,
    // ── 100 张 ──
    'wan2.2-t2i-plus': 100,
    'wan2.2-t2i-flash': 100,
    'qwen-image-2.0-pro': 100,
    'qwen-image-2.0-pro-2026-06-22': 100,
    'qwen-image-2.0-pro-2026-04-22': 100,
    'qwen-image-2.0-pro-2026-03-03': 100,
    'qwen-image-2.0': 100,
    'qwen-image-2.0-2026-03-03': 100,
    'qwen-mt-image': 100,
    'qwen-mt-image-2.0': 100,
    // ── 50 张 ──
    'wan2.6-t2i': 50,
    'wan2.5-t2i-preview': 50,
    'wan2.7-image': 50,
    'wan2.7-image-pro': 50,
    'wan2.6-image': 50,
    'wan2.5-i2i-preview': 50,
    // ── 10 张（3.0 系列：输入输出共 10 张）──
    'qwen-image-3.0': 10,
    'qwen-image-3.0-pro': 10,
    'qwen-image-2.1-pro': 10,
    'qwen-image-2.1-turbo': 10,
  },
}

/** 查一个模型的免费额度张数；未知返回 undefined */
function freeQuotaOf(modelId) {
  if (typeof modelId !== 'string' || modelId.length === 0) return undefined
  const key = Object.keys(FREE_QUOTA.entries).find(
    (candidate) => candidate.toLowerCase() === modelId.toLowerCase(),
  )
  return key === undefined ? undefined : FREE_QUOTA.entries[key]
}

/**
 * 凭据存储：插件自有文件，按厂商存**多个** API Key。
 *
 * 为什么不写 DSH 官方凭据域：用户要求隔离。代价是这些 Key 在 DSH 其他
 * 功能里看不到（只能在本插件界面管理）。
 *
 * 文件结构：
 *   { "keys": { "<providerId>": [ { id, name, value, disabled, lastError? } ] },
 *     "active": { "<providerId>": "<keyId>" } }
 *
 * @param file - 存储文件绝对路径
 */
function createKeyStore(file) {
  const read = () => {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (parsed === null || typeof parsed !== 'object') return { keys: {}, active: {} }
      return {
        keys: parsed.keys !== null && typeof parsed.keys === 'object' ? parsed.keys : {},
        active: parsed.active !== null && typeof parsed.active === 'object' ? parsed.active : {},
      }
    } catch (err) {
      return { keys: {}, active: {} }
    }
  }
  const write = (next) => {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  }
  return {
    file,
    read,
    /** 列出某厂商的 Key（**不含明文**，只给掩码） */
    list(providerId) {
      const store = read()
      const rows = Array.isArray(store.keys[providerId]) ? store.keys[providerId] : []
      return rows.map((row) => ({
        id: row.id,
        name: row.name ?? '',
        hint: maskKey(row.value),
        disabled: row.disabled === true,
        active: store.active[providerId] === row.id,
        lastError: typeof row.lastError === 'string' ? row.lastError : undefined,
      }))
    },
    /** 取某厂商全部可用明文 Key（按顺序，供轮换） */
    values(providerId) {
      const store = read()
      const rows = Array.isArray(store.keys[providerId]) ? store.keys[providerId] : []
      const usable = rows.filter((row) => row.disabled !== true && typeof row.value === 'string' && row.value.length > 0)
      // 当前选中的排最前，其余保持顺序 —— 轮换时先试它
      const activeId = store.active[providerId]
      if (activeId === undefined) return usable.map((row) => row.value)
      const first = usable.find((row) => row.id === activeId)
      if (first === undefined) return usable.map((row) => row.value)
      return [first.value, ...usable.filter((row) => row.id !== activeId).map((row) => row.value)]
    },
    /** 新增一个 Key */
    add(providerId, name, value) {
      const store = read()
      const rows = Array.isArray(store.keys[providerId]) ? [...store.keys[providerId]] : []
      const id = `k_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
      rows.push({ id, name: name ?? '', value, disabled: false })
      store.keys[providerId] = rows
      if (store.active[providerId] === undefined) store.active[providerId] = id
      write(store)
      return id
    },
    /** 删除一个 Key */
    remove(providerId, id) {
      const store = read()
      const rows = Array.isArray(store.keys[providerId]) ? store.keys[providerId] : []
      store.keys[providerId] = rows.filter((row) => row.id !== id)
      if (store.active[providerId] === id) {
        const next = store.keys[providerId][0]
        if (next === undefined) delete store.active[providerId]
        else store.active[providerId] = next.id
      }
      write(store)
    },
    /** 清空某厂商全部 Key */
    clear(providerId) {
      const store = read()
      delete store.keys[providerId]
      delete store.active[providerId]
      write(store)
    },
    /** 切换当前使用的 Key */
    setActive(providerId, id) {
      const store = read()
      const rows = Array.isArray(store.keys[providerId]) ? store.keys[providerId] : []
      if (!rows.some((row) => row.id === id)) throw new Error('该 Key 不存在')
      store.active[providerId] = id
      write(store)
    },
    /** 记下某个 Key 最近一次失败原因（界面展示用） */
    noteError(providerId, id, message) {
      const store = read()
      const rows = Array.isArray(store.keys[providerId]) ? store.keys[providerId] : []
      const row = rows.find((item) => item.id === id)
      if (row === undefined) return
      row.lastError = message
      write(store)
    },
    /** 清除失败标记 */
    clearError(providerId, id) {
      const store = read()
      const rows = Array.isArray(store.keys[providerId]) ? store.keys[providerId] : []
      const row = rows.find((item) => item.id === id)
      if (row === undefined || row.lastError === undefined) return
      delete row.lastError
      write(store)
    },
  }
}

/** Key 掩码：只露头尾，绝不回传明文 */
function maskKey(value) {
  if (typeof value !== 'string' || value.length === 0) return ''
  if (value.length <= 8) return '****'
  return `${value.slice(0, 4)}****${value.slice(-4)}`
}

/**
 * 推导模型列表接口地址。
 *
 * 多数 OpenAI 兼容厂商的模型列表在 `/v1/models`。若生图接口形如
 * `.../v1/images/generations`，把末段换成 `models` 即得；否则回落到
 * 「取 origin + /v1/models」。
 *
 * @param endpoint - 生图接口地址
 * @returns 推导出的模型列表地址，推导不出返回 undefined
 */
function deriveModelsEndpoint(endpoint) {
  try {
    const url = new URL(endpoint)
    // .../v1/images/generations → .../v1/models
    const match = /^(.*\/v\d+)\/images\/[^/]+$/.exec(url.pathname)
    if (match !== null) {
      url.pathname = `${match[1]}/models`
      url.search = ''
      return url.href
    }
    // 其它形态：退回 /v1/models
    url.pathname = '/v1/models'
    url.search = ''
    return url.href
  } catch (err) {
    return undefined
  }
}

/**
 * 拉取厂商模型列表的**原始数组**（不做 id 提取）。
 *
 * 单独拆出来是因为某些厂商（阿里百炼）的每个条目里还带官方价格，
 * 价格自动化需要拿到原始条目，不能只留 id。
 *
 * @param provider - 已解析的厂商配置
 * @param apiKey - 凭据
 * @param timeoutMs - 超时
 * @returns 原始数组（元素可能是 string 或 object）
 */
async function fetchModelList(provider, apiKey, timeoutMs) {
  // 优先用显式配置；未配置时按生图接口推导（多数 OpenAI 兼容厂商适用）
  const explicit = provider.models?.endpoint
  let endpoint = typeof explicit === 'string' && explicit.length > 0
    ? explicit
    : deriveModelsEndpoint(provider.endpoint)
  if (endpoint === undefined) {
    throw new Error(
      `厂商 "${provider.id}" 无法确定模型列表接口，请在 providers.${provider.id}.models.endpoint 显式配置`,
    )
  }
  // 服务端筛选参数（如 sub_type=text-to-image）：有则直接拿到生图模型，无需探测
  const query = provider.models?.query
  if (query !== null && typeof query === 'object') {
    try {
      const parsed = new URL(endpoint)
      for (const [key, value] of Object.entries(query)) {
        if (typeof value === 'string' && value.length > 0) parsed.searchParams.set(key, value)
      }
      endpoint = parsed.href
    } catch (err) {
      // URL 解析失败 → 用原地址
    }
  }
  // 模型列表接口的鉴权通常与生图接口一致
  const { headers, url } = buildAuth({ ...provider, endpoint }, apiKey)
  let response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    if (/timeout|abort/i.test(reason)) {
      throw new Error(`拉取模型列表超时（${timeoutMs}ms）：${url}`)
    }
    throw new Error(`无法连接模型列表接口 ${url}（网络不可达或地址错误）：${reason}`)
  }
  const text = await response.text()
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error(`拉取模型列表被拒（HTTP ${response.status}）：凭据 ${provider.credential} 可能无效或权限不足`)
    }
    if (response.status === 404) {
      throw new Error(
        `模型列表接口不存在（HTTP 404）：${url}。`
        + `请确认该厂商的模型列表地址，或配置 providers.${provider.id}.models.endpoint`,
      )
    }
    throw new Error(`拉取模型列表失败 HTTP ${response.status}: ${text.slice(0, 200)}`)
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new Error(`模型列表不是合法 JSON: ${text.slice(0, 200)}`)
  }
  const list = readPath(parsed, provider.models?.path ?? 'data')
  if (!Array.isArray(list)) {
    throw new Error(
      `模型列表取值路径 "${provider.models?.path ?? 'data'}" 不是数组。`
      + `若该厂商响应结构不同，请配置 providers.${provider.id}.models.path`,
    )
  }
  return list
}

/**
 * 拉取厂商的模型 id 列表（只取 id）。
 * @returns 模型 id 数组
 */
async function fetchModelIds(provider, apiKey, timeoutMs) {
  return (await fetchModelList(provider, apiKey, timeoutMs))
    .map((item) => (typeof item === 'string' ? item : readPath(item, provider.models?.id ?? 'id')))
    .filter((id) => typeof id === 'string' && id.length > 0)
}

/**
 * 用「非法尺寸」探测一个模型是否可用于生图。
 *
 * 关键：参数校验发生在扣费之前，因此本探测**不产生费用**。
 * 实测硅基流动的三种结果：
 *   - 生图模型 → 参数校验失败（probeCodes.supported）
 *   - 非生图   → Illegal operation（probeCodes.unsupported）
 *   - 不存在   → Model does not exist（probeCodes.missing）
 *
 * @param provider - 已解析的厂商配置
 * @param apiKey - 凭据
 * @param model - 待探测的模型 id
 * @param timeoutMs - 超时
 * @returns 'supported' | 'unsupported' | 'unknown'
 */
async function probeModel(provider, apiKey, model, timeoutMs) {
  const { headers, url } = buildAuth(provider, apiKey)
  // 1x1 必然被参数校验拒绝 —— 我们只要那个「拒绝的原因」
  const body = buildRequestBody(provider, { prompt: 'probe', model, size: '1x1' })
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    return 'unknown'
  }
  const text = await response.text()
  // 真的出图成功了（极少数厂商不校验尺寸）→ 也算支持
  if (response.ok) return 'supported'
  const { code, message } = readApiError(text)
  const codes = provider.probeCodes ?? {}
  const asSet = (list) => new Set((list ?? []).map((c) => String(c)))
  if (code !== undefined) {
    if (asSet(codes.supported).has(code)) return 'supported'
    if (asSet(codes.unsupported).has(code)) return 'unsupported'
    if (asSet(codes.missing).has(code)) return 'unsupported'
  }
  // 未配置 probeCodes 的厂商：按「错误性质」推断，比单纯看状态码准
  // 鉴权失败说明 Key 有问题，与模型是否可生图无关 → unknown
  if (response.status === 401 || response.status === 403) return 'unknown'
  if (response.status === 404) return 'unsupported'
  // 400 通常是参数校验（尺寸非法）→ 说明模型存在且走的是生图接口
  if (response.status === 400) {
    // 但要排除「模型不存在」这类也返回 400 的情况
    if (/model.*(not.*exist|not.*found|invalid)|不存在的模型/i.test(message)) return 'unsupported'
    return 'supported'
  }
  return 'unknown'
}

/** 带并发上限的 map（探测要控速，避免触发限流） */
async function mapLimited(items, limit, worker) {
  const results = new Array(items.length)
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next
      next += 1
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

/**
 * 列出所有可用厂商（内置模板 + 用户自定义），供界面下拉。
 * @param config - 已解析的插件配置
 * @returns [{ id, displayName, builtin, defaultModel }]
 */
function listProviders(config) {
  const ids = new Set([
    ...Object.keys(BUILTIN_PROVIDERS),
    ...Object.keys(config.providers ?? {}),
  ])
  const rows = []
  for (const id of ids) {
    try {
      const provider = resolveProvider({ ...config, provider: id })
      rows.push({
        id,
        displayName: provider.displayName,
        builtin: Object.hasOwn(BUILTIN_PROVIDERS, id),
        defaultModel: provider.defaultModel,
        hasModelsApi: provider.models?.endpoint !== undefined
          || deriveModelsEndpoint(provider.endpoint) !== undefined,
      })
    } catch (err) {
      // 配置不完整（如缺 endpoint）的厂商仍列出，但标注问题
      rows.push({
        id,
        displayName: config.providers?.[id]?.displayName ?? id,
        builtin: Object.hasOwn(BUILTIN_PROVIDERS, id),
        defaultModel: '',
        hasModelsApi: false,
        problem: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return rows.sort((a, b) => (a.builtin === b.builtin ? a.id.localeCompare(b.id) : (a.builtin ? -1 : 1)))
}

/** 读取并解析请求体为对象；非法输入抛出带 statusCode 的错误 */
async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8')
  let parsed
  try {
    parsed = JSON.parse(text.length > 0 ? text : '{}')
  } catch (err) {
    const failure = new Error('请求体不是合法 JSON')
    failure.statusCode = 400
    throw failure
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const failure = new Error('请求体必须是对象')
    failure.statusCode = 400
    throw failure
  }
  return parsed
}

/** 按厂商的 auth 方式构造请求头与 URL（query 鉴权会改写 URL） */
function buildAuth(provider, apiKey) {
  const headers = { 'Content-Type': 'application/json' }
  let url = provider.endpoint
  const auth = provider.auth
  if (auth === 'bearer') {
    headers.Authorization = `Bearer ${apiKey}`
  } else if (auth.startsWith('header:')) {
    headers[auth.slice('header:'.length)] = apiKey
  } else if (auth.startsWith('query:')) {
    const name = auth.slice('query:'.length)
    const parsed = new URL(url)
    parsed.searchParams.set(name, apiKey)
    url = parsed.href
  }
  // 厂商自定义请求头（如阿里异步必需的 X-DashScope-Async）
  if (provider.headers !== null && typeof provider.headers === 'object') {
    for (const [key, value] of Object.entries(provider.headers)) {
      if (typeof value === 'string') headers[key] = value
    }
  }
  return { headers, url }
}

/** 把逻辑参数按厂商字段映射成请求体；空字段名表示不发送 */
function buildRequestBody(provider, input) {
  const fields = provider.fields
  const body = {}
  const put = (logical, value) => {
    const name = fields[logical]
    if (typeof name !== 'string' || name.length === 0 || value === undefined) return
    // 支持 `input.prompt` 这类嵌套字段名（阿里百炼等用嵌套请求体）
    const segments = name.split('.')
    let cursor = body
    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i]
      if (cursor[segment] === null || typeof cursor[segment] !== 'object') cursor[segment] = {}
      cursor = cursor[segment]
    }
    cursor[segments[segments.length - 1]] = value
  }
  put('prompt', input.prompt)
  put('model', input.model)
  /**
   * 尺寸分隔符：多数厂商用 `1024x1024`，但阿里百炼要求 `1024*1024`
   * （实测报错 `Invalid size format: 1024x1024, expected format: width*height`）。
   */
  put('size', typeof input.size === 'string' && provider.sizeSeparator === '*'
    ? input.size.replace('x', '*')
    : input.size)
  put('seed', input.seed)
  put('negativePrompt', input.negativePrompt)
  put('batchSize', input.batchSize)
  put('image', input.image)
  put('editFunction', input.editFunction)
  return body
}

/**
 * 轮询异步生图任务，直到完成或超时。
 *
 * 阿里百炼（dashscope）是异步接口：提交返回 `task_id` + `PENDING`，
 * 需要轮询 `GET /api/v1/tasks/<id>` 直到 `SUCCEEDED`（实测约 8 秒）。
 *
 * @param provider - 厂商配置（用 asyncTask 段）
 * @param apiKey - 凭据
 * @param taskId - 提交时拿到的任务 id
 * @param config - 插件配置
 * @param signal - 取消信号
 * @param logger - 日志器
 * @returns 完成时的响应体
 */
async function pollAsyncTask(provider, apiKey, taskId, config, signal, logger) {
  const spec = provider.asyncTask
  const endpoint = spec.endpoint.replace('{taskId}', encodeURIComponent(taskId))
  const { headers, url } = buildAuth({ ...provider, endpoint }, apiKey)
  const intervalMs = Number.isFinite(spec.intervalMs) ? spec.intervalMs : 4000
  const deadline = Date.now() + (Number.isFinite(spec.timeoutMs) ? spec.timeoutMs : 300000)
  const success = new Set((spec.successStatus ?? ['SUCCEEDED']).map(String))
  const failure = new Set((spec.failureStatus ?? ['FAILED', 'CANCELED', 'UNKNOWN']).map(String))

  while (Date.now() < deadline) {
    await sleep(intervalMs, signal)
    let response
    try {
      response = await fetch(url, { method: 'GET', headers, signal: requestSignal(signal, config.timeoutMs) })
    } catch (err) {
      logger.warn?.(`[dsh-image-gen] 轮询任务失败，继续重试: ${err.message}`)
      continue
    }
    const text = await response.text()
    if (!response.ok) {
      throw new Error(`轮询任务失败 HTTP ${response.status}: ${text.slice(0, 200)}`)
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (err) {
      throw new Error(`轮询响应不是合法 JSON: ${text.slice(0, 200)}`)
    }
    const status = readPath(parsed, spec.statusPath ?? 'output.task_status')
    if (status === undefined) {
      throw new Error(`轮询响应里找不到任务状态（${spec.statusPath ?? 'output.task_status'}）`)
    }
    if (success.has(String(status))) return parsed
    if (failure.has(String(status))) {
      throw new Error(`生图任务失败（状态 ${status}）: ${text.slice(0, 300)}`)
    }
    // PENDING / RUNNING → 继续轮询
  }
  throw new Error(`生图任务超时（${Math.round((Number.isFinite(spec.timeoutMs) ? spec.timeoutMs : 300000) / 1000)}s）未完成`)
}

/**
 * 调用生图接口。
 *
 * 三层容错：
 *   1. **异步任务**：厂商配了 `asyncTask` 时，提交后轮询直到完成（阿里百炼）。
 *   2. **Key 轮换**：某 Key 返回鉴权错误（401/403）时，换下一个 Key 立刻重试
 *      （同一个 Key 不会因鉴权失败被反复使用）。
 *   3. **退避重试**：限流/过载（retryableCodes）时按线性退避重试。
 *
 * @param provider - 厂商配置
 * @param body - 请求体
 * @param apiKeys - 候选 Key 列表（按优先级）
 * @param config - 插件配置
 * @param signal - 取消信号
 * @param logger - 日志器
 * @param onKeyResult - 可选回调 (key, ok, message)，用于记录哪个 Key 失败
 */
async function requestImages(provider, body, apiKeys, config, signal, logger, onKeyResult) {
  const attempts = Math.max(1, config.maxRetries)
  // retryableCodes 可能是数字（硅基流动）或字符串（阿里的 Throttling）
  const retryable = new Set((provider.retryableCodes ?? []).map((c) => String(c)))
  const keys = Array.isArray(apiKeys) ? apiKeys.filter((k) => typeof k === 'string' && k.length > 0) : []
  if (keys.length === 0) throw new Error(`${TOOL_NAME}: 没有可用的 API Key`)
  let keyIndex = 0
  let lastError
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) {
      const delay = config.retryBaseMs * attempt
      logger.warn?.(`[dsh-image-gen] 限流重试 ${attempt}/${attempts - 1}，等待 ${delay}ms`)
      try {
        await sleep(delay, signal)
      } catch (err) {
        throw new Error(`${TOOL_NAME}: 已取消`)
      }
    }

    const apiKey = keys[keyIndex]
    const { headers, url } = buildAuth(provider, apiKey)
    let response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: requestSignal(signal, config.timeoutMs),
      })
    } catch (err) {
      lastError = new Error(`${TOOL_NAME}: 请求生图接口失败（网络或超时）: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }

    const text = await response.text()
    if (!response.ok) {
      const { code, message } = readApiError(text)
      const error = describeApiError(provider, response.status, code, message)

      // ① 鉴权失败 → 换 Key（不消耗重试次数：把 attempt 退回一格）
      const isAuthFailure = response.status === 401 || response.status === 403
      if (isAuthFailure && keyIndex < keys.length - 1) {
        onKeyResult?.(apiKey, false, message)
        logger.warn?.(`[dsh-image-gen] Key #${keyIndex + 1} 鉴权失败，切换到下一个`)
        keyIndex += 1
        attempt -= 1
        lastError = error
        continue
      }
      if (isAuthFailure) onKeyResult?.(apiKey, false, message)

      // ② 限流/过载 → 退避重试
      if (code !== undefined && retryable.has(String(code))) {
        lastError = error
        continue
      }
      throw error
    }

    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (err) {
      throw new Error(`${TOOL_NAME}: 生图接口返回了无法解析的响应: ${text.slice(0, 200)}`)
    }

    // ── 异步任务：提交只拿到 task_id，需要轮询到完成 ──
    if (provider.asyncTask !== undefined && provider.asyncTask.endpoint !== undefined) {
      const taskId = readPath(parsed, provider.asyncTask.taskIdPath ?? 'output.task_id')
      if (typeof taskId === 'string' && taskId.length > 0) {
        logger.info?.(`[dsh-image-gen] 异步任务已提交（${taskId}），开始轮询…`)
        parsed = await pollAsyncTask(provider, apiKey, taskId, config, signal, logger)
        logger.info?.('[dsh-image-gen] 异步任务完成')
      }
    }

    const list = readPath(parsed, provider.response.images)
    const items = Array.isArray(list) ? list : (list === undefined ? [] : [list])
    const urls = items
      .map((item) => (typeof item === 'string' ? item : readPath(item, provider.response.url)))
      .filter((url) => typeof url === 'string' && url.length > 0)
    if (urls.length === 0) {
      throw new Error(
        `${TOOL_NAME}: 生图接口未返回图片 URL（取值路径 ${provider.response.images}[].${provider.response.url}）。`
        + `原始响应: ${text.slice(0, 200)}`,
      )
    }
    onKeyResult?.(apiKey, true)
    const seed = readPath(parsed, provider.response.seed)
    return { urls, seed: typeof seed === 'number' ? seed : undefined }
  }
  throw lastError ?? new Error(`${TOOL_NAME}: 生图失败`)
}

/** 下载一张图片并落盘，返回路径与 markdown 行 */
async function downloadImage(url, outputDir, model, config, signal) {
  let response
  try {
    response = await fetch(url, { signal: requestSignal(signal, config.downloadTimeoutMs) })
  } catch (err) {
    throw new Error(`${TOOL_NAME}: 下载图片失败: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!response.ok) {
    throw new Error(`${TOOL_NAME}: 下载图片失败 HTTP ${response.status}（临时 URL 可能已过期）`)
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.byteLength > config.maxImageBytes) {
    throw new Error(`${TOOL_NAME}: 图片过大（${buffer.byteLength} 字节，上限 ${config.maxImageBytes}）`)
  }
  const bytes = new Uint8Array(buffer)
  // 扩展名按字节嗅探：实测 output_format=jpeg 可能不生效，URL 后缀不可信
  const sniffed = sniffImage(bytes)
  const ext = sniffed?.ext ?? (extname(new URL(url).pathname) || '.png')
  const file = join(outputDir, `img_${timestamp()}_${shortId()}_${modelSlug(model)}${ext}`)
  await writeFile(file, bytes)

  const displayPath = toDisplayPath(file)
  const dimensions = pngSize(bytes)
  return {
    path: displayPath,
    markdown: `![generated image](${encodeMarkdownPath(displayPath)})`,
    bytes: buffer.byteLength,
    mediaType: sniffed?.mediaType ?? 'image/png',
    ...(dimensions === null ? {} : { width: dimensions.width, height: dimensions.height }),
  }
}

export const Config = Schema.object({
  // ── 厂商 ──
  provider: Schema.string().default(DEFAULT_PROVIDER)
    .description('当前使用的厂商 id（对应下方 providers 的键；内置 siliconflow）'),
  model: Schema.string().default('').description('默认生图模型；留空 = 用该厂商模板的 defaultModel'),
  providers: Schema.dict(Schema.object({
    displayName: Schema.string().default('').description('展示名（仅用于报错文案）'),
    endpoint: Schema.string().default('').description('生图接口完整地址'),
    credential: Schema.string().default('').description('凭据名（$DSH_HOME/.credentials.yaml 中的键）'),
    auth: Schema.string().default('').description("鉴权方式：bearer | header:<名> | query:<名> | none"),
    defaultModel: Schema.string().default('').description('该厂商的默认模型'),
    editModel: Schema.string().default('').description('该厂商的图生图模型'),
    editEndpoint: Schema.string().default('')
      .description('图生图专用接口地址；留空表示与文生图共用（阿里百炼必须分开填）'),
    defaultEditFunction: Schema.string().default('')
      .description('图生图必填的编辑功能值（阿里百炼用 description_edit 等）；留空则不发送该字段'),
    fields: Schema.dict(Schema.string()).default({})
      .description('逻辑字段 → 请求体字段名；空字符串表示不发送该字段'),
    response: Schema.dict(Schema.string()).default({})
      .description('响应取值路径：images / url / seed'),
    retryableCodes: Schema.array(Schema.number()).default([])
      .description('该厂商表示「可重试」的业务错误码'),
    models: Schema.object({
      endpoint: Schema.string().default('').description('模型列表接口；留空则从 endpoint 推导 /v1/models'),
      path: Schema.string().default('data').description('模型数组所在字段'),
      id: Schema.string().default('id').description('数组元素里取 id 的字段'),
      query: Schema.dict(Schema.string()).default({})
        .description('服务端筛选参数，如 { sub_type: text-to-image }；配了就无需关键词预筛与探测'),
      price: Schema.object({
        path: Schema.string().default('prices').description('价格数组所在字段'),
        unit: Schema.string().default('张').description('只取 price_unit 含该字的计费项'),
        excludeName: Schema.string().default('输入')
          .description('排除 price_name 含该词的计费项（如「输入」参考图费用）'),
      }).description('从模型列表响应里直接读官方价格（配了就不用内置价格表）'),
    }).default({ endpoint: '', path: 'data', id: 'id', query: {} })
      .description('模型列表接口配置'),
    modelHints: Schema.array(Schema.string()).default([])
      .description('关键词预筛词表；留空用内置默认'),
    knownImageModels: Schema.array(Schema.string()).default([])
      .description('已知生图模型清单：厂商 /models 不含生图模型时用它兜底'),
    headers: Schema.dict(Schema.string()).default({})
      .description('厂商自定义请求头（如阿里异步必需的 X-DashScope-Async）'),
    sizeSeparator: Schema.string().default('x')
      .description("尺寸分隔符：'x'（默认，如 1024x1024）或 '*'（阿里百炼要求 1024*1024）"),
    asyncTask: Schema.object({
      taskIdPath: Schema.string().default('output.task_id').description('提交响应里取 task_id 的路径'),
      endpoint: Schema.string().default('').description('轮询地址，用 {taskId} 占位'),
      statusPath: Schema.string().default('output.task_status').description('轮询响应里取状态的路径'),
      successStatus: Schema.array(Schema.string()).default(['SUCCEEDED']).description('成功状态值'),
      failureStatus: Schema.array(Schema.string()).default(['FAILED']).description('失败状态值'),
      intervalMs: Schema.number().default(4000).description('轮询间隔(ms)'),
      timeoutMs: Schema.number().default(300000).description('轮询总超时(ms)'),
    }).description('异步任务配置；配了则提交后轮询到完成（阿里百炼需要）'),
    probeCodes: Schema.object({
      supported: Schema.array(Schema.number()).default([]).description('模型存在且是生图模型'),
      unsupported: Schema.array(Schema.number()).default([]).description('不是生图模型'),
      missing: Schema.array(Schema.number()).default([]).description('模型不存在'),
    }).default({ supported: [], unsupported: [], missing: [] })
      .description('探测判定用的业务错误码（各厂商不同，需实测）'),
  })).default({})
    .description('厂商模板覆盖；新增厂商在此加一段，无需改代码'),

  // ── 通用 ──
  outputDir: Schema.string().default('').description('图片保存目录；留空 = <profile>/generated-images'),
  imageSize: Schema.string().default('1024x1024').description('默认图片尺寸，形如 1024x1024'),
  maxSide: Schema.number().default(2048).description('尺寸单边上限'),
  timeoutMs: Schema.number().default(180000).description('生图请求超时(ms)'),
  downloadTimeoutMs: Schema.number().default(60000).description('图片下载超时(ms)'),
  maxRetries: Schema.number().default(3).description('限流/过载时的最大尝试次数'),
  retryBaseMs: Schema.number().default(20000).description('重试基础退避(ms)，按第几次线性放大'),
  batchSize: Schema.number().default(1).description('默认生成张数（1-4）'),
  negativePrompt: Schema.string().default('').description('默认负面提示词'),
  maxImageBytes: Schema.number().default(20 * 1024 * 1024).description('单张图片字节上限'),
})

/**
 * 构造工具定义。
 * @param ctx - 注入作用域上下文（取 tools / credentials 服务）
 * @param config - 已解析的插件配置（静态部分）
 * @param logger - 日志器
 * @param effectiveConfig - 每次执行时取「静态配置 + 运行期覆盖」的函数
 */
function buildToolDefinition(ctx, config, logger, effectiveConfig = () => config, keyStore) {
  const outputDir = config.outputDir.trim().length > 0
    ? resolve(expandHome(config.outputDir))
    : defaultOutputDir()
  const provider = resolveProvider(config)

  return {
    name: TOOL_NAME,
    description:
      'Generate an image from a text prompt and save it locally so it shows in the conversation. '
      + 'Use this whenever the user asks to draw, generate, create, or render a picture. '
      + `The current provider is ${provider.displayName} and its default model is ${provider.defaultModel}. `
      + 'The result includes a markdown image line: you MUST copy that line verbatim into your final '
      + 'reply, otherwise the user sees no picture. '
      + 'Pass `image` (a local path or http(s) URL) to edit an existing picture instead of creating one.',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Text prompt describing the image to generate, or the edit to apply when `image` is given.',
        },
        model: {
          type: 'string',
          description: `Model id. Defaults to "${provider.defaultModel}"; use "${provider.editModel}" for image-to-image.`,
        },
        image_size: {
          type: 'string',
          description: `Resolution as "widthxheight", e.g. "1024x1024" (default), "768x1024", "1024x576". Each side must be <= ${config.maxSide}.`,
        },
        seed: {
          type: 'integer',
          description: 'Random seed for reproducible generation. Omit for a random seed.',
        },
        negative_prompt: {
          type: 'string',
          description: 'Things to exclude from the image.',
        },
        batch_size: {
          type: 'integer',
          description: `How many images to generate (1-${MAX_BATCH_SIZE}). Defaults to 1.`,
        },
        image: {
          type: 'string',
          description: 'Reference image for image-to-image: an absolute local path or an http(s) URL.',
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['model', 'prompt', 'images'],
        properties: {
          model: { type: 'string' },
          prompt: { type: 'string' },
          provider: { type: 'string' },
          seed: { type: 'integer' },
          images: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['path', 'markdown', 'bytes', 'mediaType'],
              properties: {
                path: { type: 'string' },
                markdown: { type: 'string' },
                bytes: { type: 'integer' },
                mediaType: { type: 'string' },
                width: { type: 'integer' },
                height: { type: 'integer' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const header = `已生成 ${value.images.length} 张图片（模型 ${value.model}`
          + `${value.seed === undefined ? '' : `，seed ${value.seed}`}）：`
        const markdown = value.images.map((item) => item.markdown).join('\n\n')
        const paths = value.images.map((item) => `- ${item.path}`).join('\n')
        return [{
          type: 'text',
          text: `${header}\n\n${markdown}\n\n保存位置：\n${paths}\n\n`
            + '请在最终回复中原样带上上面的 markdown 图片行，图片才会显示给用户。',
        }]
      },
    },
    // 生图是外部 API 且免费模型限流很紧 → 串行执行
    isConcurrencySafe: () => false,
    timeoutMs: config.timeoutMs,

    async execute(args, exec) {
      const prompt = args.prompt
      if (typeof prompt !== 'string' || prompt.trim().length === 0) {
        throw new Error(`${TOOL_NAME}: prompt 必须是非空字符串`)
      }

      // 每次执行都重读运行期覆盖，因此设置界面改完立即生效
      const cfg = effectiveConfig()
      const activeProvider = resolveProvider(cfg)

      // ── 参数归一 ──
      const hasReference = typeof args.image === 'string' && args.image.trim().length > 0
      const requestedModel = typeof args.model === 'string' ? args.model.trim() : ''
      const model = requestedModel.length > 0
        ? requestedModel
        : (hasReference ? activeProvider.editModel : activeProvider.defaultModel)
      const imageSize = parseImageSize(args.image_size ?? cfg.imageSize, config.maxSide)
      const negativePrompt = typeof args.negative_prompt === 'string' && args.negative_prompt.trim().length > 0
        ? args.negative_prompt
        : config.negativePrompt

      const requestedBatch = args.batch_size ?? config.batchSize
      if (!Number.isSafeInteger(requestedBatch) || requestedBatch < 1) {
        throw new Error(`${TOOL_NAME}: batch_size 必须是 >= 1 的整数`)
      }
      const batchSize = Math.min(requestedBatch, MAX_BATCH_SIZE)

      if (args.seed !== undefined && (!Number.isSafeInteger(args.seed) || args.seed < 0)) {
        throw new Error(`${TOOL_NAME}: seed 必须是 >= 0 的整数`)
      }

      // ── 凭据（每次调用重新读取，支持多 Key 轮换） ──
      const apiKeys = await readApiKeys(ctx, activeProvider.credential, keyStore, activeProvider.id)
      if (apiKeys.length === 0) {
        throw new Error(
          `${TOOL_NAME}: 厂商 "${activeProvider.displayName}" 没有可用的 API Key。`
          + '请在「设置 → 模型 → 生图」里添加，或把 '
          + `${activeProvider.credential || '凭据名'} 写入 $DSH_HOME/.credentials.yaml。`,
        )
      }

      // ── 参考图 ──
      const reference = hasReference
        ? await resolveReferenceImage(args.image.trim(), config.maxImageBytes)
        : undefined

      /**
       * 图生图可能走**另一个 endpoint**（实测阿里百炼：text2image vs image2image）。
       * 带参考图且厂商配了 editEndpoint 时切换过去。
       */
      const providerForRequest = hasReference && activeProvider.editEndpoint.length > 0
        ? { ...activeProvider, endpoint: activeProvider.editEndpoint }
        : activeProvider

      /**
       * 图生图必填的编辑功能（阿里百炼要求）。厂商没配就传 undefined，
       * buildRequestBody 会跳过该字段（多数厂商不需要）。
       */
      const editFunction = hasReference && activeProvider.defaultEditFunction.length > 0
        ? activeProvider.defaultEditFunction
        : undefined

      // ── 请求体（按厂商字段映射） ──
      const body = buildRequestBody(providerForRequest, {
        prompt,
        model,
        size: imageSize,
        seed: args.seed,
        negativePrompt: negativePrompt.length > 0 ? negativePrompt : undefined,
        batchSize: batchSize > 1 ? batchSize : undefined,
        image: reference,
        editFunction,
      })

      const payload = await requestImages(
        providerForRequest,
        body,
        apiKeys,
        config,
        exec.signal,
        logger,
        (key, ok, message) => {
          // 记录哪个 Key 失败，界面上可看到（只在插件自有存储里有记录时才写）
          if (ok || keyStore === undefined) return
          const rows = keyStore.list(activeProvider.id)
          const hit = rows.find((row) => row.hint === maskKey(key))
          if (hit !== undefined) keyStore.noteError(activeProvider.id, hit.id, String(message).slice(0, 200))
        },
      )

      // ── 立刻下载：临时 URL 仅 1 小时有效 ──
      await mkdir(outputDir, { recursive: true })
      const images = []
      for (const url of payload.urls) {
        images.push(await downloadImage(url, outputDir, model, config, exec.signal))
      }

      return {
        model,
        prompt,
        provider: activeProvider.id,
        ...(payload.seed === undefined ? {} : { seed: payload.seed }),
        images,
      }
    },
  }
}

/**
 * 插件主体。
 *
 * 有意不在对象级声明 inject：那会把整个 apply() 推迟到服务就绪之后。
 * 这里 apply() 立即执行，仅在注册工具时局部等待 tools；credentials 作为
 * 可选服务通过 ctx.get 取用，缺失时回落到同名环境变量。
 */
export function apply(root, config) {
  const logger = root.logger ?? console

  // ── 插件的数据文件统一放在 **profile 目录**，不跟着 outputDir 走 ──
  // ⚠️ 曾经把 overrideFile 放在 outputDir 的父目录：一旦用户改了图片目录，
  //    设置/Key/缓存就"凭空消失"（其实留在了旧目录）。数据与图片分开存。
  const dataDir = defaultProfileDir()

  // ── 运行期覆盖：存插件自己的 JSON，不动用户的 cordis.patch.yml ──
  // 每次执行工具时读取，因此改完立即生效，不需要重启。
  const overrideFile = join(dataDir, '.dsh-image-gen.json')

  const readOverride = () => {
    try {
      const parsed = JSON.parse(readFileSync(overrideFile, 'utf8'))
      return parsed !== null && typeof parsed === 'object' ? parsed : {}
    } catch (err) {
      return {}
    }
  }
  const writeOverride = (next) => {
    mkdirSync(dirname(overrideFile), { recursive: true })
    writeFileSync(overrideFile, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  }
  /** Cordis 配置 + 运行期覆盖 */
  const effectiveConfig = () => {
    const override = readOverride()
    const merged = { ...config }
    if (typeof override.model === 'string' && override.model.trim().length > 0) merged.model = override.model.trim()
    if (typeof override.imageSize === 'string' && override.imageSize.trim().length > 0) merged.imageSize = override.imageSize.trim()
    if (typeof override.provider === 'string' && override.provider.trim().length > 0) merged.provider = override.provider.trim()
    return merged
  }

  // ── 插件自有的 API Key 存储（按厂商存多个 Key）──
  const keysFile = join(dataDir, '.dsh-image-gen-keys.json')
  const keyStore = createKeyStore(keysFile)

  root.inject(['tools'], (ctx) => {
    const tools = ctx.get('tools') ?? ctx.tools
    if (tools?.register === undefined) {
      logger.warn?.('[dsh-image-gen] tools 服务不可用，generate_image 工具未注册')
      return
    }
    tools.register(buildToolDefinition(ctx, config, logger, effectiveConfig, keyStore))
    const outputDir = config.outputDir.trim().length > 0
      ? resolve(expandHome(config.outputDir))
      : defaultOutputDir()
    try {
      const provider = resolveProvider(config)
      logger.info?.(
        `[dsh-image-gen] generate_image 已注册（厂商 ${provider.id}，默认模型 ${provider.defaultModel}，输出目录 ${outputDir}）`,
      )
    } catch (err) {
      logger.warn?.(`[dsh-image-gen] generate_image 已注册，但厂商配置有问题: ${err.message}`)
    }
  })

  // ── 给「设置 → 模型」页的配置行提供读写接口 ──
  root.inject(['webServer'], (ctx) => {
    const webServer = ctx.get('webServer') ?? ctx.webServer
    if (webServer?.register === undefined) {
      logger.warn?.('[dsh-image-gen] webServer 服务不可用，设置界面不可用')
      return
    }
    const json = (res, status, payload) => {
      res.statusCode = status
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(JSON.stringify(payload))
    }
    /**
     * 轻量同源校验：webServer 路由不经过 connection 的信任栅栏，
     * 因此自己拒绝跨站写请求（DNS 重绑定 / 跨站表单）。
     * @returns 应当拒绝时返回状态码，否则 null。
     */
    const rejection = (req) => {
      try {
        const headers = req?.headers ?? {}
        let hostUrl
        try {
          hostUrl = new URL(`http://${String(headers.host ?? '')}`)
        } catch (err) {
          return 403
        }
        if (String(headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') return 403
        const origin = headers.origin
        if (typeof origin === 'string' && origin.length > 0 && origin !== 'null') {
          let originUrl
          try {
            originUrl = new URL(origin)
          } catch (err) {
            return 403
          }
          if (originUrl.host.toLowerCase() !== hostUrl.host.toLowerCase()) return 403
        }
        return null
      } catch (err) {
        return 403
      }
    }
    const snapshot = () => {
      const effective = effectiveConfig()
      let provider
      try {
        provider = resolveProvider(effective)
      } catch (err) {
        provider = { id: effective.provider, displayName: effective.provider, defaultModel: '' }
      }
      return {
        provider: provider.id,
        providerName: provider.displayName,
        builtinModel: provider.defaultModel,
        model: effective.model ?? '',
        imageSize: effective.imageSize ?? '',
        outputDir: effective.outputDir.trim().length > 0
          ? resolve(expandHome(effective.outputDir))
          : defaultOutputDir(),
        /** 可选厂商列表（内置模板 + 用户自定义），供界面下拉 */
        providers: listProviders(effective),
      }
    }

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/dsh-image-gen/config',
      handler: async (req, res) => {
        try {
          const denied = rejection(req)
          if (denied !== null) {
            json(res, denied, { error: 'forbidden' })
            return
          }
          if (req.method === 'GET') {
            json(res, 200, snapshot())
            return
          }
          if (req.method !== 'POST') {
            json(res, 405, { error: 'method not allowed' })
            return
          }
          const patch = await readJsonBody(req)
          // 校验尺寸格式，避免写进非法值
          if (typeof patch.imageSize === 'string' && patch.imageSize.trim().length > 0) {
            parseImageSize(patch.imageSize.trim(), config.maxSide)
          }
          const next = readOverride()
          for (const key of ['model', 'imageSize', 'provider']) {
            if (typeof patch[key] !== 'string') continue
            const value = patch[key].trim()
            if (value.length === 0) delete next[key]
            else next[key] = value
          }
          writeOverride(next)
          logger.info?.(`[dsh-image-gen] 设置已更新: ${JSON.stringify(next)}`)
          json(res, 200, snapshot())
        } catch (err) {
          json(res, err?.statusCode ?? 500, { error: err instanceof Error ? err.message : String(err) })
        }
      },
    }), 'dsh-image-gen: 配置路由')

    // ── 模型列表：拉取 + 可选探测，结果缓存 ──
    const modelCacheFile = join(dataDir, '.dsh-image-gen-models.json')
    const readModelCache = () => {
      try {
        const parsed = JSON.parse(readFileSync(modelCacheFile, 'utf8'))
        return parsed !== null && typeof parsed === 'object' ? parsed : {}
      } catch (err) {
        return {}
      }
    }
    const writeModelCache = (next) => {
      mkdirSync(dirname(modelCacheFile), { recursive: true })
      writeFileSync(modelCacheFile, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    }
    /** 一次探测进行中时的互斥，避免并发把限流打满 */
    let probing = false

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/dsh-image-gen/models',
      handler: async (req, res) => {
        try {
          const denied = rejection(req)
          if (denied !== null) {
            json(res, denied, { error: 'forbidden' })
            return
          }
          if (req.method !== 'POST') {
            json(res, 405, { error: 'method not allowed' })
            return
          }
          const body = await readJsonBody(req)
          const effective = effectiveConfig()
          // 允许指定 provider（界面上刚切换、还没保存时）
          if (typeof body.provider === 'string' && body.provider.trim().length > 0) {
            effective.provider = body.provider.trim()
          }
          const provider = resolveProvider(effective)
          const apiKey = await readApiKey(ctx, provider.credential, keyStore, provider.id)
          if (apiKey === undefined) {
            json(res, 400, {
              error: `厂商「${provider.displayName}」没有可用的 API Key，`
                + '请在上方「API Key」区域添加',
            })
            return
          }

          const cache = readModelCache()
          const cachedEntry = cache[provider.id]

          // 只读缓存
          if (body.refresh !== true && cachedEntry !== undefined) {
            json(res, 200, { provider: provider.id, ...cachedEntry, cached: true })
            return
          }

          const list = await fetchModelList(provider, apiKey, config.timeoutMs)
          const all = list
            .map((item) => (typeof item === 'string' ? item : readPath(item, provider.models?.id ?? 'id')))
            .filter((id) => typeof id === 'string' && id.length > 0)
          /**
           * 原始条目按 id 建索引，供价格自动化取官方价格。
           * 只对 object 条目建索引（string 条目没有价格字段）。
           */
          const rawById = new Map()
          for (const item of list) {
            if (item === null || typeof item !== 'object') continue
            const id = readPath(item, provider.models?.id ?? 'id')
            if (typeof id === 'string' && id.length > 0) rawById.set(id, item)
          }
          const hints = provider.modelHints
          const looksLikeImage = (id) => hints.some((hint) => id.toLowerCase().includes(hint.toLowerCase()))
          /**
           * 厂商配了服务端筛选参数（如硅基流动的 sub_type=text-to-image）时，
           * 返回的**本来就是生图模型**，不需要再关键词过滤或逐个探测。
           * 实测该参数的结果与「关键词+探测」完全一致，但快得多。
           */
          const serverFiltered = provider.models?.query !== undefined
            && Object.keys(provider.models.query).length > 0
          let candidates = serverFiltered ? all : all.filter(looksLikeImage)

          /**
           * 某些厂商的 /models **不含生图模型**（实测智谱只返回 glm-* 对话模型），
           * 或账号未开通导致列表里没有可用项 —— 用内置的已知清单兜底。
           */
          let usedKnownList = false
          if (candidates.length === 0 && provider.knownImageModels.length > 0) {
            candidates = [...provider.knownImageModels]
            usedKnownList = true
          }

          /**
           * 带价格标注，供界面下拉直接显示。
           *
           * 价格优先级：
           *   1. 模型列表响应里的**官方价格**（百炼支持，实时、免维护）
           *   2. 内置 PRICE_TABLE（其他厂商，会过时）
           * 免费额度（张数）只有百炼有，单独挂 `quota`。
           */
          const priceSpec = provider.models?.price
          let priceFromApi = false
          const withPrice = (ids) => ids.map((id) => {
            const fromApi = priceSpec === undefined
              ? undefined
              : extractApiPrice(rawById.get(id), priceSpec)
            if (fromApi !== undefined) priceFromApi = true
            const quota = freeQuotaOf(id)
            return {
              id,
              price: fromApi ?? priceOf(id),
              ...(quota === undefined ? {} : { quota: { images: quota, asOf: FREE_QUOTA.asOf } }),
            }
          })

          // 不探测：只返回预筛结果
          if (body.probe !== true || serverFiltered) {
            const result = {
              all: all.length,
              candidates,
              candidatesDetailed: withPrice(candidates),
              supported: serverFiltered ? candidates : [],
              unsupported: [],
              unknown: [],
              probed: serverFiltered,
              serverFiltered,
              usedKnownList,
              priceAsOf: PRICE_TABLE.asOf,
              /** 价格是否来自接口实时数据（true 时界面不必提示「会过时」） */
              priceFromApi,
              /** 免费额度表的抓取日期（仅百炼有；界面提示会过时） */
              quotaAsOf: FREE_QUOTA.asOf,
              updatedAt: new Date().toISOString(),
            }
            cache[provider.id] = result
            writeModelCache(cache)
            json(res, 200, { provider: provider.id, ...result, cached: false })
            return
          }

          if (probing) {
            json(res, 409, { error: '已有一次探测在进行中，请稍候再试' })
            return
          }
          probing = true
          let supported = []
          let unsupported = []
          let unknown = []
          try {
            // 并发 2：实测限流约 6 次/分钟，太快会被 50604 打断
            const verdicts = await mapLimited(candidates, 2, async (id) => {
              const verdict = await probeModel(provider, apiKey, id, config.timeoutMs)
              // 探测之间留间隔，避免触发限流
              await new Promise((r) => setTimeout(r, 1500))
              return { id, verdict }
            })
            for (const { id, verdict } of verdicts) {
              if (verdict === 'supported') supported.push(id)
              else if (verdict === 'unsupported') unsupported.push(id)
              else unknown.push(id)
            }
          } finally {
            probing = false
          }

          const result = {
            all: all.length,
            candidates,
            candidatesDetailed: withPrice(candidates),
            supported,
            unsupported,
            unknown,
            probed: true,
            serverFiltered: false,
            priceAsOf: PRICE_TABLE.asOf,
            priceFromApi,
            quotaAsOf: FREE_QUOTA.asOf,
            updatedAt: new Date().toISOString(),
          }
          cache[provider.id] = result
          writeModelCache(cache)
          logger.info?.(
            `[dsh-image-gen] ${provider.id} 模型探测完成：候选 ${candidates.length}，`
            + `可用 ${supported.length}，非生图 ${unsupported.length}，未知 ${unknown.length}`,
          )
          json(res, 200, { provider: provider.id, ...result, cached: false })
        } catch (err) {
          json(res, err?.statusCode ?? 500, { error: err instanceof Error ? err.message : String(err) })
        }
      },
    }), 'dsh-image-gen: 模型列表路由')

    // ── API Key 管理（增删改查 + 连通性测试）──
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/dsh-image-gen/keys',
      handler: async (req, res) => {
        try {
          const denied = rejection(req)
          if (denied !== null) {
            json(res, denied, { error: 'forbidden' })
            return
          }
          const effective = effectiveConfig()
          const query = new URL(req.url ?? '/', 'http://x').searchParams

          /** 列表（不含明文） */
          const listing = (providerId) => ({
            provider: providerId,
            keys: keyStore.list(providerId),
            file: keyStore.file,
          })

          if (req.method === 'GET') {
            const providerId = query.get('provider') ?? resolveProviderSafe(effective).id
            // 首次打开界面：把凭据域 / 环境变量里已有的 Key 导入进来，
            // 否则用户在 .credentials.yaml 里配好的 Key 在界面上看不见。
            let imported = 0
            try {
              const provider = resolveProviderSafe({ ...effective, provider: providerId })
              imported = await importExternalKeys(ctx, provider.credential, keyStore, providerId)
              if (imported > 0) {
                logger.info?.(`[dsh-image-gen] 已从凭据域导入 ${imported} 个 Key（厂商 ${providerId}）`)
              }
            } catch (err) {
              logger.warn?.(`[dsh-image-gen] 导入已有 Key 失败: ${err.message}`)
            }
            json(res, 200, { ...listing(providerId), imported })
            return
          }
          if (req.method !== 'POST') {
            json(res, 405, { error: 'method not allowed' })
            return
          }

          const body = await readJsonBody(req)
          const providerId = typeof body.provider === 'string' && body.provider.trim().length > 0
            ? body.provider.trim()
            : resolveProviderSafe(effective).id
          const action = typeof body.action === 'string' ? body.action : ''

          if (action === 'add') {
            const value = typeof body.value === 'string' ? body.value.trim() : ''
            if (value.length === 0) {
              json(res, 400, { error: 'API Key 不能为空' })
              return
            }
            if (/\s/.test(value)) {
              json(res, 400, { error: 'API Key 不应包含空白字符，请检查是否复制多了' })
              return
            }
            const id = keyStore.add(providerId, typeof body.name === 'string' ? body.name.trim() : '', value)
            logger.info?.(`[dsh-image-gen] 已为 ${providerId} 添加 API Key（${maskKey(value)}）`)
            json(res, 200, { ...listing(providerId), addedId: id })
            return
          }
          if (action === 'remove') {
            if (typeof body.id !== 'string' || body.id.length === 0) {
              json(res, 400, { error: '缺少要删除的 Key id' })
              return
            }
            keyStore.remove(providerId, body.id)
            logger.info?.(`[dsh-image-gen] 已删除 ${providerId} 的一个 API Key`)
            json(res, 200, listing(providerId))
            return
          }
          if (action === 'clear') {
            keyStore.clear(providerId)
            logger.info?.(`[dsh-image-gen] 已清空 ${providerId} 的全部 API Key`)
            json(res, 200, listing(providerId))
            return
          }
          if (action === 'setActive') {
            if (typeof body.id !== 'string' || body.id.length === 0) {
              json(res, 400, { error: '缺少要选用的 Key id' })
              return
            }
            keyStore.setActive(providerId, body.id)
            json(res, 200, listing(providerId))
            return
          }
          if (action === 'test') {
            // 用每个 Key 发一次「非法尺寸」探测：不花钱，但能验证鉴权是否通过
            const provider = resolveProvider(effective)
            const rows = keyStore.list(provider.id)
            const results = []
            for (const row of rows) {
              const value = keyStore.values(provider.id).find((v) => maskKey(v) === row.hint)
              if (value === undefined) {
                results.push({ id: row.id, ok: false, message: '无法读取该 Key' })
                continue
              }
              try {
                const verdict = await probeModel(provider, value, provider.defaultModel, config.timeoutMs)
                const ok = verdict !== 'unknown'
                results.push({
                  id: row.id,
                  ok,
                  message: ok ? '鉴权通过' : '鉴权失败或网络异常',
                })
                if (ok) keyStore.clearError(provider.id, row.id)
                else keyStore.noteError(provider.id, row.id, '鉴权失败或网络异常')
              } catch (err) {
                results.push({ id: row.id, ok: false, message: err instanceof Error ? err.message : String(err) })
              }
            }
            json(res, 200, { ...listing(provider.id), results })
            return
          }
          json(res, 400, { error: `未知操作: ${action}` })
        } catch (err) {
          json(res, err?.statusCode ?? 500, { error: err instanceof Error ? err.message : String(err) })
        }
      },
    }), 'dsh-image-gen: 凭据管理路由')

    logger.info?.(
      '[dsh-image-gen] 接口已挂载 /dsh-image-gen/config、/dsh-image-gen/models、/dsh-image-gen/keys',
    )
  })
}

/** 解析厂商，失败时返回最小可用结构（避免列表接口因配置问题整体失败） */
function resolveProviderSafe(config) {
  try {
    return resolveProvider(config)
  } catch (err) {
    const id = typeof config.provider === 'string' && config.provider.length > 0 ? config.provider : DEFAULT_PROVIDER
    return { id, displayName: id, credential: '', defaultModel: '' }
  }
}
