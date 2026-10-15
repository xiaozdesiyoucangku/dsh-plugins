# dsh-image-gen

DSH 生图插件：注册 `generate_image` 工具，用硅基流动接口出图，图片保存到本地并
**在对话界面直接显示**；带**设置界面**（设置 → 模型 → 页脚「生图」）。

## 为什么需要它

DSH 的模型层是文本进出，图片只支持输入（视觉理解），不支持输出。
原生做不到「打提示词出图」，必须靠插件补。

## 设置界面

**设置 → 模型 → 页面底部「生图（dsh-image-gen）」**，包含四块：

| 区域 | 能做什么 |
|---|---|
| **厂商** | 切换厂商（内置 5 家 + 自定义） |
| **API Key** | 添加 / 删除 / 清空 / 选当前 / 测试全部 |
| **默认模型** | 手动填，或从模型列表选 |
| **默认尺寸** | 如 `1024x1024` |

- 改完**立即生效**，不用重启：配置存在 `<profile>/.dsh-image-gen.json`，
  每次调用工具时重读。
- 存储**不写**你的 `cordis.patch.yml`，所以不会和手写配置互相覆盖。
- 优先级：界面设置 > `cordis.patch.yml` 的 `model` > 厂商模板的 `defaultModel`。
- 留空则回落到内置默认（Kolors 免费模型）。

### API Key 管理（多 Key + 自动轮换）

**每个厂商可以存多个 Key。** Key 存在插件自己的文件里
（`<profile>/.dsh-image-gen-keys.json`），**不写 DSH 官方凭据域**。

- **添加**：填备注（可选）+ 粘贴 Key → 点「保存 Key」
- **删除 / 清空**：逐条删或一键清空
- **选当前**：单选按钮切换优先使用的 Key
- **测试全部 Key**：逐个发一次零成本探测，验证鉴权是否通过
- **明文不外泄**：界面只显示掩码（`sk-x****mpfj`），接口响应永不含明文

**自动轮换**：某个 Key 返回鉴权失败（401/403）时，自动切到下一个 Key 重试，
不需要手动干预。实测：第 1 个 Key 无效时，自动用第 2 个成功出图。

Key 的查找顺序：**插件自有存储** → DSH 凭据域（`<厂商>.credential` 指定的名字）
→ 同名环境变量。所以以前配在 `.credentials.yaml` 里的 Key 仍然有效。

### 获取可用生图模型列表

界面上有两个按钮：

| 按钮 | 行为 |
|---|---|
| **获取模型列表** | 拉该厂商的模型列表并筛出生图模型（**通常不到 1 秒**） |
| **获取并筛选可用生图模型** | 仅对**不支持服务端筛选**的厂商：逐个探测确认（约 10–60 秒） |

#### 优先走服务端筛选（快且准）

厂商的模型列表接口若支持筛选参数，**一次请求就能拿到生图模型**，
不需要关键词猜测、也不需要逐个探测。硅基流动实测：

```
GET /v1/models?sub_type=text-to-image   →  189ms，精确返回 6 个生图模型
```

结果与「关键词预筛 + 逐个探测」**完全一致**，但快了两个数量级、不消耗限流额度。
在 `providers.<id>.models.query` 里配置，例如：

```yaml
models:
  endpoint: https://api.siliconflow.cn/v1/models
  query:
    sub_type: text-to-image
```

#### 回退：关键词预筛 + 零成本探测

厂商不支持筛选参数时自动回退。**为什么要探测**：`/v1/models` 只返回模型 id，
**没有任何类型字段**，无法直接区分生图/对话模型。关键词预筛会误判
（实测 `diffusiongemma` 是对话模型，却含 "diffusion" 被选中）。

**探测原理（零成本）**：给生图接口传一个非法尺寸（`1x1`）：

| 返回 | 判定 |
|---|---|
| `code 20015` width should be greater than 16 | ✅ 生图模型 |
| `code 30000` Illegal operation | ❌ 非生图 |
| `code 20012` Model does not exist | ❌ 无效 |

**参数校验发生在扣费之前**，所以探测不产生任何费用，也不会真的出图。

实测准确性 6/6（含正确排除被关键词误判的对话模型）。
探测结果缓存在 `<profile>/.dsh-image-gen-models.json`。

### 价格显示

模型下拉里会带上价格，例如 `Tongyi-MAI/Z-Image-Turbo　¥0.10/张`。

⚠️ **价格是内置数据，会过时**，仅供选型参考，以厂商官网为准。
界面上会显示数据日期（`价格数据 2026-10-08`）。

| 厂商 | 数据来源 | 可信度 |
|---|---|---|
| 硅基流动 | 官方定价页 | ✔ 官方 |
| 智谱 GLM | 官方文档 | ✔ 官方 |
| 百度千帆 | 官方文档 | ✔ 官方 |
| 阿里云百炼 | 第三方资料 | ⚠ 未确证（显示为 `¥0.20/张?`） |
| 火山方舟 | 第三方资料 | ⚠ 未确证 |

**带 `?` 的价格表示来源未经官方确证**（阿里/火山的官方价格页是 JS 渲染，抓不到明细）。

内置数据在 `index.js` 的 `PRICE_TABLE`，可自行增删。价格变动时改这里即可。

**客户端代码改动后需要重新构建**：

```powershell
cd plugins/dsh-image-gen
node scripts/build-client.mjs
```

构建产物是 `lib/client.js`（`window.__ModuleLoader__.load({...})` 格式）。
React 由宿主通过 `require` 提供，不打包进产物。

构建后建议先跑一遍启动风险检查（避免改坏声明导致重启失败）：

```powershell
node scripts/_preflight.mjs
```

它会检查：Host 模块可导入、Config 可实例化、`apply()` 在 6 种服务组合下不抛错、
工具定义符合宿主校验、路由行为、客户端产物可执行可渲染。

## 内置厂商

**5 家全部用真实 Key 实测过**（2026-10-08）：

| 厂商 | id | 出图 | 实测结论 |
|---|---|---|---|
| 硅基流动 | `siliconflow` | ✔ | 正常；支持 `sub_type` 服务端筛选 |
| 智谱 GLM | `zhipu` | ✔ | `cogview-3-flash` 免费可用 |
| 阿里云百炼 | `dashscope` | ✔ | **异步**：提交→轮询，实测约 8 秒 |
| 百度千帆 | `qianfan` | ✔ | `qwen-image` 可用；**RPM 限流很紧** |
| 火山方舟 | `ark` | ✘ | 列表可拉，但**账号未开通**生图模型 |

### 实测踩到的坑（都已处理）

| 坑 | 表现 | 处理 |
|---|---|---|
| 智谱列表不含生图模型 | `/models` 只返回 11 个 `glm-*` 对话模型 | 内置 `knownImageModels` 兜底 |
| 智谱错误码无区分度 | 对**任何**模型名都返回 `1214`（含不存在的） | 不依赖它判定，走 HTTP 状态 |
| 阿里兼容模式是 404 | `/compatible-mode/v1/images/generations` | 改用异步接口 |
| 阿里需异步头 | 不带 `X-DashScope-Async: enable` 报 403 | 内置该请求头 |
| **阿里尺寸分隔符** | `1024x1024` 报 `Invalid size format, expected width*height` | `sizeSeparator: '*'` |
| 火山模型已下线 | `seedream-3-0` 等状态为 `Shutdown` | 默认模型改用未下线的 |
| 火山账号未开通 | `ModelNotOpen` | 需去火山控制台开通 |

### 火山方舟需要手动开通

生图模型返回 `ModelNotOpen` 时，去**火山方舟控制台 → 开通管理**
开通对应 Seedream 模型。插件侧无法绕过。

### 千帆 RPM 限流

千帆免费额度 RPM 很低，连续调用返回 `429 rpm_rate_limit_exceeded`。
插件已识别为可重试（自动退避），但仍需等待冷却。

## 安装

```powershell
# 推荐：走 dsh 插件管理器（会同时改 package.json 与 bundles）
# 把 <本仓库路径> 换成你 clone 下来的 dsh-image-gen 目录
dsh plugin --profile desktop add link:<本仓库路径>\dsh-image-gen
```

手工等价步骤：

1. 备份 `package.json`
2. `dependencies` 加 `"dsh-image-gen": "link:./plugins/dsh-image-gen"`
3. `dsh.profile.bundles` 数组加 `"dsh-image-gen"`
4. `pnpm install`
5. 重启 dsh

**回滚**：还原 `package.json` 备份 → `pnpm install` → 重启；
或 `dsh plugin --profile desktop remove dsh-image-gen`。

## 前置条件

在 `$DSH_HOME/.credentials.yaml` 里配置硅基流动的 Key：

```yaml
refs:
  SILICONFLOW_API_KEY: sk-xxxxxxxx
```

插件每次调用都重新读取凭据，改完无需重启。

## 用法

装好后直接对模型说「生成一张猫的图片」，模型会调用 `generate_image`。

工具参数：

| 参数 | 说明 |
|---|---|
| `prompt` | 必填，图片描述 |
| `model` | 模型 id，默认 `Kwai-Kolors/Kolors`（免费） |
| `image_size` | 形如 `1024x1024`，默认取配置 |
| `seed` | 随机种子，可复现 |
| `negative_prompt` | 排除元素 |
| `batch_size` | 张数 1–4，默认 1 |
| `image` | 参考图（本地绝对路径或 http(s) URL）→ 图生图 |

## 配置项

**改配置请改 profile 根目录的 `cordis.patch.yml`**（不是插件目录里的那个）——
那是覆盖层，改完 HMR 自动重载，不用重启。加一段：

```yaml
- id: dsh-image-gen
  config:
    provider: siliconflow
    model: Tongyi-MAI/Z-Image-Turbo
```

通用配置项（全部有默认值）：

| 键 | 默认 | 说明 |
|---|---|---|
| `provider` | `siliconflow` | 当前厂商 id |
| `model` | 空 = 厂商模板的 `defaultModel` | 默认模型 |
| `providers` | `{}` | 厂商模板覆盖，见下节 |
| `outputDir` | 空 = `<profile>/generated-images` | 保存目录 |
| `imageSize` | `1024x1024` | 默认尺寸 |
| `maxSide` | `2048` | 尺寸单边上限 |
| `timeoutMs` | `180000` | 生图超时 |
| `downloadTimeoutMs` | `60000` | 下载超时 |
| `maxRetries` | `3` | 限流重试次数 |
| `retryBaseMs` | `20000` | 退避基数 |
| `batchSize` | `1` | 默认张数 |
| `negativePrompt` | 空 | 默认负面词 |
| `maxImageBytes` | `20971520` | 单张字节上限 |

## 新增厂商（不用改代码）

各家生图接口的差异只在四处：**endpoint**、**auth**、**请求字段名**、**响应取值路径**。
在 `providers` 下加一段即可：

```yaml
- id: dsh-image-gen
  config:
    provider: my-vendor
    providers:
      my-vendor:
        displayName: 我的厂商
        endpoint: https://api.example.com/v1/images/generations
        credential: MY_VENDOR_API_KEY   # $DSH_HOME/.credentials.yaml 里的键名
        auth: bearer                    # bearer | header:<名> | query:<名> | none
        defaultModel: some/model-id
        editModel: some/edit-model-id
        fields:                         # 逻辑字段 → 该厂商的请求体字段名
          prompt: prompt
          model: model
          size: image_size              # 有的厂商叫 size
          seed: seed
          negativePrompt: negative_prompt
          batchSize: batch_size
          image: image                  # 空字符串 = 不发送该字段
        response:                       # 响应取值路径（点号分隔，支持 [0] 下标）
          images: images                # 图片数组所在字段
          url: url                      # 数组元素里取 URL 的字段
          seed: seed
        retryableCodes: [50604, 50505]  # 该厂商表示「可重试」的业务错误码
        # ── 模型列表与探测（可选；不配则按 endpoint 自动推导 /v1/models）──
        models:
          endpoint: https://api.example.com/v1/models  # 可省略，默认从 endpoint 推导
          path: data          # 模型数组所在字段
          id: id              # 数组元素里取 id 的字段
        modelHints:           # 关键词预筛词表（可覆盖默认）
          - image
          - flux
        probeCodes:           # 探测判定用的业务码（各厂商不同，需实测）
          supported: [20015]    # 「模型存在且是生图模型」
          unsupported: [30000]  # 「不是生图模型」
          missing: [20012]      # 「模型不存在」
```

**已验证**：只加配置、不改代码，字段重命名（如 `image_size` → `size`）
与切换响应分支（如 `images` → `data`）都能生效。

未配置 `endpoint` 的厂商会在注册时报出明确的中文提示，而不是静默失败。

### 新厂商的 `probeCodes` 怎么填

**各家错误码不同，必须实测**。做法：拿该厂商的一个**已知生图模型**和
一个**已知对话模型**，各发一次 `image_size: "1x1"` 的请求，看返回的 `code`：

```powershell
# 生图模型 → 得到 supported 码
curl -s -X POST <endpoint> -H "Authorization: Bearer <key>" `
  -H "Content-Type: application/json" `
  -d '{"model":"<已知生图模型>","prompt":"x","image_size":"1x1"}'

# 对话模型 → 得到 unsupported 码
```

不填 `probeCodes` 时会退化为「按 HTTP 状态猜」（400→supported，
403/404→unsupported），不如显式配置准确。

## 图片显示原理

**不注册任何 HTTP 路由。** 前端 `AssistantMarkdown` 无条件给每个文本块注入
`pathImages`，把 markdown 里指向**绝对路径**的图片重写为
`/api/file?path=...`（Web）或 `dsh-app://app/api/file?...`（桌面）：

```js
const pathImages = useMemo(() => ({ resolve: (v) => localPathMediaUrl(document.baseURI, v) }), [])
// → <MarkdownText pathImages={pathImages} />
```

因此插件只要返回 `![](H:/.../xxx.png)` 就能出图。**已在真实对话中验证通过。**

三条前提：

1. **必须是绝对路径** —— `localPathMediaUrl` 不拼 cwd（这点和 `@` 文件提及走的
   `fileImages` 不同）。
2. Windows 路径**用正斜杠**，含空格/中文要 URL 编码（前端会 `decodeURIComponent` 一次）。
3. 图片要出现在**助手回复文本**里最稳，因此工具返回的文本里明确要求模型把
   markdown 图片行原样带进最终回复。

## 输出目录怎么定的（实测踩到的坑）

默认目录是 **`<profileDir>/generated-images`**，即
`$DSH_HOME\profiles\<profile>\generated-images`（例如 `C:\Users\你\.dsh\profiles\desktop\generated-images`）。

**不能用 `DSH_PROFILE_DIR` 推导**：该变量由 `dsh-shell-env` 只注入给**模型 shell 调用**
（bash/pwsh），Host 进程环境里并没有它 —— 插件在 Host 侧读到的是 `undefined`，
早期版本因此静默落到了 `$DSH_HOME/generated-images`。

现在改为**从模块自身位置上溯**推导 profile 根（逐级找含 `dsh.profile` 的
`package.json`），因为插件位于 `<profileDir>/plugins/<name>/` 或
`<profileDir>/node_modules/<name>/`。回退顺序：

1. 模块路径推导（主路径）
2. `DSH_PROFILE_DIR`
3. `$DSH_HOME/profiles/<DSH_PROFILE>`
4. `$DSH_HOME`

需要换位置就在 `cordis.patch.yml` 里显式配 `outputDir`。

## 已知限制与坑

- **临时 URL 仅 1 小时有效**：接口返回的是 S3 签名 URL（`X-Amz-Expires=3600`），
  插件会立刻下载落盘，这也是为什么必须落盘而不能直接引用远程 URL。
- **免费模型限流很紧**：实测约 6 次/分钟就触发 `code 50604 IPM limit reached`，
  冷却约 60–90 秒。插件按 `retryBaseMs × 次数` 线性退避重试。
- **`image_size` 不限于文档列的 5 种**：实测 `1024x1024`、`1280x720`、`1024x1536`、
  `2048x2048` 均可用且输出尺寸与请求一致，因此只做格式与上限校验，不设白名单。
- **`output_format=jpeg` 实测可能不生效**：传 `jpeg` 时返回的 URL 后缀与实际字节
  仍是 PNG。因此落盘扩展名按**字节签名**嗅探，不信 URL 后缀。
- **响应里 `images` 与 `data` 是重复的两份**，插件取 `images`。
- **`output.schema` 的 `required` 必须是字符串数组**：写成属性级 `required: true`
  （`defineTool` DSL 的写法）会被 Host 的 `assertSupportedJsonSchema` 拒绝并抛
  `JsonSchemaError`，导致整个 `tools.register()` 失败、工具静默不出现。
  手写 ToolDefinition 时这是最容易踩的一条。
- 生图是外部 API 且有限流，工具声明 `isConcurrencySafe: false`（串行）。
- **Host 插件源码改动需要重启 dsh**：ESM 模块被缓存，HMR 不会重新导入已安装插件的
  源码（连模块级副作用都不重跑）。

## 相关文件

- `index.js` —— Host 侧：工具注册 + 配置读写路由
- `client-src/index.js` —— 设置界面的客户端源文件
- `lib/client.js` —— 客户端构建产物（勿手改，改 `client-src` 后重新构建）
- `scripts/build-client.mjs` —— 构建脚本
- `cordis.patch.yml` —— 挂载声明与默认配置
- 计划与实测记录：`../../.dsh-image-gen-plan.md`
