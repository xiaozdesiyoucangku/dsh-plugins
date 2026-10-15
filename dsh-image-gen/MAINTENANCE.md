# dsh-image-gen 维护手册

> 这份文件是**自包含**的：接手时只看它即可，不需要翻聊天记录。
> 最后更新：2026-10-12

---

## 0. 改这份文件之前先备份

**动 `MAINTENANCE.md` 之前，必须先复制一份 `MAINTENANCE.md.bak`（同级，覆盖式）。**

```powershell
Copy-Item -LiteralPath 'MAINTENANCE.md' -Destination 'MAINTENANCE.md.bak' -Force
```

- 位置：与 `MAINTENANCE.md` 同级，即 `plugins\dsh-image-gen\MAINTENANCE.md.bak`
- 策略：**覆盖式**，只保留改动前的上一版，不做时间戳堆积
- 时机：**先备份，再改**。改完再备份等于备份了坏版本，没有意义
- 回退：`Copy-Item 'MAINTENANCE.md.bak' 'MAINTENANCE.md' -Force`
- 注意：`.bak` 不是唯一历史。本文件本身也是 git/文件系统可追溯的，
  但 `.bak` 是**改坏时最快的一步回退**，所以保留

> 只有 `MAINTENANCE.md` 需要这样备份。`README.md`、`index.js` 等不在此规则内。

---

## 1. 这是什么

DSH 生图插件。注册 `generate_image` 工具，调用各厂商的生图 API，
把图片存到本地，并**在对话界面直接显示**。

**为什么需要插件**：DSH 模型层是文本进出，图片只支持输入（视觉理解），
不支持输出。原生做不到「打提示词出图」。

---

## 2. 文件位置

```
<插件目录>\
├── index.js                    Host 侧主体（~87KB）：工具注册 + 3 个 HTTP 路由 + 厂商逻辑
├── client-src\index.js         设置界面**源文件**（改这个）
├── lib\client.js               设置界面**构建产物**（勿手改，由 build 生成）
├── scripts\build-client.mjs    构建脚本（esbuild → __ModuleLoader__ 格式）
├── scripts\_preflight.mjs      重启前自检脚本
├── cordis.patch.yml            默认配置（插件自带，用户覆盖在 profile 根）
├── package.json                插件清单（声明 dsh.bundle.patch + dsh.client）
├── README.md                   面向用户的使用说明
├── MAINTENANCE.md              本文件（维护手册）
└── MAINTENANCE.md.bak          本文件改动前的上一版（见第 0 节）
```

**运行期数据文件**（在 profile 根目录，不在插件目录）：
```
<profileDir>\
├── .dsh-image-gen.json           界面保存的设置（模型/尺寸/厂商）
├── .dsh-image-gen-keys.json      API Key 存储（按厂商分组，多个 Key）
└── .dsh-image-gen-models.json    模型列表缓存
```

> ⚠️ 这三个文件**固定在 profile 目录**，不跟着 `outputDir` 走。
> 曾经放在 outputDir 父目录，导致用户改图片目录时数据「凭空消失」。

**profile 登记**（`<profileDir>\package.json`）：
- `dependencies` 里有 `"dsh-image-gen": "link:<插件目录绝对路径>"`
- `dsh.profile.bundles` 数组末尾有 `"dsh-image-gen"`

---

## 3. 快速上手：改代码后怎么生效

| 改了什么 | 怎么生效 |
|---|---|
| `client-src/index.js`（界面） | `node scripts/build-client.mjs` → **重启 dsh** |
| `index.js`（Host 侧） | **重启 dsh** |
| 只改配置（模型/尺寸/Key） | **立即生效，不用重启** |
| profile 根的 `cordis.patch.yml` | HMR 自动重载，不用重启 |

**Host 插件源码改动必须重启**：ESM 模块被缓存，HMR 不会重新导入已装插件的源码
（连模块级副作用都不重跑）。这个规律验证过多次。

**重启前先跑自检**：
```powershell
cd <插件目录>
node scripts/_preflight.mjs
```
它检查 7 项：Host 模块可导入、Config 可实例化、`apply()` 在 6 种服务组合下不抛错、
工具定义符合宿主校验、路由行为、客户端产物可执行可注册可渲染。
**全绿才重启** —— 这个脚本抓出过会导致「功能静默失效」的 bug。

**重启后怎么确认真的生效**（三步）：

| 步骤 | 看什么 | 没生效的表现 |
|---|---|---|
| 1 | 工具列表里有 `generate_image` | 工具定义不符合宿主校验时会**静默不注册** |
| 2 | 对话里出图后能看到图片 | 看不到 → 查第 5 节（图片显示原理） |
| 3 | 设置 → 模型 底部有「生图」那一行 | 没有 → 客户端产物没加载（见第 10 节） |

⚠️ **只改 `index.js` 不重启，DSH 里跑的还是旧代码**。
用 `node scripts/xxx.mjs` 直接 import 文件测试时跑的是**新代码**，
别把「测试通过」当成「线上已生效」。

---

## 4. 三个 HTTP 路由

插件自己注册的路由（`index.js` 里 `webServer.register`）：

| 路由 | 方法 | 作用 |
|---|---|---|
| `/dsh-image-gen/config` | GET / POST | 读 / 写界面设置 |
| `/dsh-image-gen/models` | POST | 拉模型列表（可选探测），结果缓存 |
| `/dsh-image-gen/keys` | GET / POST | API Key 增删改查 + 连通性测试 |

**安全**：每个路由都过 `rejection()` 同源校验（webServer 路由**不经过** connection
的信任栅栏，必须自己拒绝跨站/异源请求）。

---

## 5. 图片显示原理（关键，别改错）

**不注册任何 HTTP 路由来提供图片。** 前端 `AssistantMarkdown` 无条件给每个
文本块注入 `pathImages`，把 markdown 里指向**绝对路径**的图片重写为
`/api/file?path=...`（Web）或 `dsh-app://app/api/file?...`（桌面）。

所以工具只要返回 `![](H:/.../xxx.png)` 就能出图。**已在真实对话中验证。**

三条前提：
1. 必须是**绝对路径** —— `localPathMediaUrl` 不拼 cwd
2. Windows 路径**用正斜杠**，含空格/中文要 URL 编码
3. 图片要出现在**助手回复文本**里最稳，所以工具返回的文本里明确要求模型
   把 markdown 图片行原样带进最终回复

---

## 6. 内置厂商（5 家，全部真实 Key 实测过）

| 厂商 | id | 出图 | 关键实测结论 |
|---|---|---|---|
| 硅基流动 | `siliconflow` | ✔ | 支持 `sub_type=text-to-image` 服务端筛选 |
| 智谱 GLM | `zhipu` | ✔ | `/models` **不含生图模型**，靠内置清单兜底 |
| 阿里云百炼 | `dashscope` | ✔ | **异步**：提交→轮询，16~28 秒；尺寸用 `*`；**唯一能自动化价格的厂商** |
| 百度千帆 | `qianfan` | ✔ | RPM 限流很紧 |
| 火山方舟 | `ark` | ✘ | 列表可拉，但账号未开通（`ModelNotOpen`） |

### 实测踩到的坑（都已处理，改代码时别踩回去）

| 坑 | 表现 | 处理方式 |
|---|---|---|
| 智谱列表不含生图模型 | `/models` 只返回 11 个 `glm-*` 对话模型 | 内置 `knownImageModels` 兜底 |
| 智谱错误码无区分度 | 对**任何**模型名（含不存在的）都返回 `1214` | 不依赖它判定，走 HTTP 状态 |
| 阿里兼容模式 404 | `/compatible-mode/v1/images/generations` | 改用异步接口 |
| 阿里需异步头 | 不带 `X-DashScope-Async: enable` 报 403 | 内置该请求头 |
| **阿里尺寸分隔符** | `1024x1024` 报 `Invalid size format, expected width*height` | `sizeSeparator: '*'` |
| 阿里请求体嵌套 | 用 `input.prompt` / `parameters.size` | `buildRequestBody` 支持点号路径 |
| 火山模型已下线 | `seedream-3-0` 等 `status` 是 `Shutdown` | 默认模型改用未下线的 |
| 火山账号未开通 | `ModelNotOpen` | 需去火山控制台开通，插件无法绕过 |
| **价格计费项命名不统一** | 只认 `type: image_number` 会漏掉 18/43 个模型 | 改按 `price_unit` 含「张」筛，见第 9 节 |
| **输入价混入输出价** | `qwen-image-3.0` 输入 0.02 / 输出 0.18，取最低价会拿错 | 排除 `price_name` 含「输入」的项 |
| **价格精度丢失** | `qwen-mt-image` = 0.003 被 `toFixed(2)` 显示成 `¥0.00` | `formatPrice` 按数量级选小数位 |

### 火山方舟要手动开通

报 `ModelNotOpen` 时，去**火山方舟控制台 → 开通管理**开通 Seedream 模型。

---

## 7. 模型列表获取（两级策略）

### 优先：服务端筛选（快且准）

厂商支持筛选参数时，**一次请求直接拿到生图模型**：

```
硅基流动  GET /v1/models?sub_type=text-to-image  →  189ms，精确返回 6 个
阿里百炼  GET /api/v1/models?capabilities=IG     →  精确返回 43 个，且自带官方价格
```

结果与「关键词预筛 + 逐个探测」完全一致，但快两个数量级、不消耗限流额度。
配置位置：`providers.<id>.models.query`。

**阿里百炼为什么要换成原生接口**（2026-10-11 改）：
之前用 `compatible-mode/v1/models`，返回 175 个混杂模型，靠关键词筛。
换成原生 `/api/v1/models?capabilities=IG` 后：

| | 旧（compatible-mode） | 新（原生 + IG） |
|---|---|---|
| 返回数 | 175 个混杂 | 43 个**全是生图** |
| 筛选方式 | 关键词预筛（会误判） | 服务端精确 |
| 价格 | 无，靠内置表 | **自带官方价格** |

响应结构是 `{ output: { total, models: [...] } }`，所以 `path: 'output.models'`、
`id: 'model'`（不是 `data` / `id`）。

### 回退：关键词预筛 + 零成本探测

厂商不支持筛选时自动回退。

**为什么要探测**：`/v1/models` 只返回模型 id，**没有类型字段**，
关键词预筛会误判（实测 `diffusiongemma` 是对话模型，却含 "diffusion" 被选中）。

**探测原理（零成本）**：给生图接口传非法尺寸 `1x1`：

| 硅基流动返回 | 判定 |
|---|---|
| `code 20015` width should be greater than 16 | ✅ 生图模型 |
| `code 30000` Illegal operation | ❌ 非生图 |
| `code 20012` Model does not exist | ❌ 无效 |

**参数校验发生在扣费之前**，所以探测不花钱、不出图。实测准确性 6/6。

**注意**：这个技巧**不通用**。智谱对任何模型都返回同一个 `1214`，
所以它的 `probeCodes` 只能证明「请求被参数校验拦下」，不能区分模型。
各家探测码需要单独实测。

### 兜底：内置清单

`providers.<id>.knownImageModels` —— 列表接口拉不到生图模型时用它。
智谱就是靠这个。

---

## 7.5 价格自动化（仅阿里百炼）

**目的**：不再依赖会过时的内置 `PRICE_TABLE`。

百炼的模型列表**每个条目都带 `prices` 字段**，是官方实时数据：

```json
{ "model": "wan2.6-t2i",
  "prices": [ { "range_name": "Default", "prices": [
    { "type": "image_number", "price": "0.2", "price_unit": "每张",
      "price_name": "图片生成", "time_band": "standard" } ] } ] }
```

配置：`providers.dashscope.models.price = { path, unit, excludeName }`。
运行时由 `extractApiPrice()` 解析，**优先于** `priceOf()` 的内置表。
界面用 `priceFromApi` 标志区分（true 时提示「价格来自厂商接口实时数据」）。

### ⚠️ 三个必须知道的坑

**坑 1：计费项命名不统一，不能用 `type` 白名单。**
实测 43 个模型出现 5 种命名，只认 `image_number` 会漏掉 18 个：

| type 值 | 出现在 |
|---|---|
| `image_number` | wan2.6-t2i 等 |
| `image_standard` / `image_thinking` | z-image-turbo |
| `image_type_1k` / `_2k` / `_4k` | vidu、kling |
| `qima_output_1k` / `_2k` | qwen-image-3.0 系列 |
| `qima_input_1k` / `_2k` | 同上（**这是输入价，要排除**） |

所以改成按 **`price_unit` 含「张」** 筛。改完提取率从 25/43 升到 36/43。

**坑 2：必须排除「输入」项。**
`qwen-image-3.0` 同时有输入价（0.02，图生图时上传的参考图）和输出价（0.18，
真正生成一张图）。取最低价会拿到输入价，误导用户。所以配了
`excludeName: '输入'`。

**坑 3：小价格会被 `toFixed(2)` 抹平。**
`qwen-mt-image` = 0.003 会显示成 `¥0.00`。用 `formatPrice()` 按数量级
选小数位（≥0.01 两位 / ≥0.001 三位 / 否则四位）。

### 剩下 7 个模型没有价格

`wanx-x-painting`、`wanx-virtualmodel`、`virtualmodel-v2`、`shoemodel-v1`、
`wanx-poster-generation-v1`、`image-instance-segmentation`、`image-erase-completion`
—— 官方就是**不给单价**（标「按量计费」或需申请）。不是 bug，不要试图修。

---

## 7.6 免费额度（仅阿里百炼，**无 API**）

**关键事实：免费额度查不到，只能内置表。**

实测 2026-10-11，五个猜测端点全部 404：

```
/api/v1/free-quota        404
/api/v1/free_quota        404
/api/v1/quota/free        404
/api/v1/allocation-quota  404
/api/v1/usage             404
```

⚠️ **最容易搞错的一点**：`/api/v1/quotas` **存在**，但它返回的是**限流配额**
（RPM、并发数，`usage_limit_period` = 6/30/60 分钟），**不是免费额度**。
354 个模型里有 148 个带 `usage_limit`，但 **43 个生图模型全部为 `null`** ——
因为图像模型按「张」计费，不走 token 配额体系。

### 官方规则（来源：百炼「新人免费额度」文档）

- **仅华北2（北京）地域**有；其他地域没有
- 有效期 **90 天**，从开通/模型发布/申请通过起算（以较晚者为准）
- **每个模型额度独立**，不互通；快照版（带日期）和最新版算两个模型
- 图像生成以**张**计；额度用完且开了「用完即停」→ 403 `AllocationQuota.FreeTierOnly`
- 余量**只能去控制台看**：`bailian.console.aliyun.com/cn-beijing/costing-balance/free-quota`
- ⚠️ 同一实名主体重新注册账号**不能**再领新人额度

### 内置表 `FREE_QUOTA`（index.js）

数据来源：官方「模型调用价格」页的图像生成章节。抓取日期见 `FREE_QUOTA.asOf`。

| 张数 | 模型 |
|---|---|
| **500** | `wanx2.1-t2i-plus`、`wanx2.1-t2i-turbo`、`wanx2.0-t2i-turbo`、`wanx-v1`、`wanx2.1-imageedit`、`wanx-x-painting` |
| **100** | `wan2.2-t2i-plus`、`wan2.2-t2i-flash`、`qwen-image-2.0` 系列（含各快照）、`qwen-mt-image`、`qwen-mt-image-2.0` |
| **50** | `wan2.6-t2i`、`wan2.5-t2i-preview`、`wan2.7-image`、`wan2.7-image-pro`、`wan2.6-image`、`wan2.5-i2i-preview` |
| **10** | `qwen-image-3.0`、`qwen-image-3.0-pro`、`qwen-image-2.1-pro`、`qwen-image-2.1-turbo` |

界面在下拉里显示 `免费500张`，并**按额度降序排**（额度多的排前面）。

### 默认选型（用户要求「额度最多 + 质量较好」各一个）

| 用途 | 模型 | 额度 | 单价 | 实测 |
|---|---|---|---|---|
| 文生图 | `wanx2.1-t2i-plus` | 500 张 | ¥0.20/张 | ✔ 16 秒出图 |
| 图生图 | `wanx2.1-imageedit` | 500 张 | ¥0.14/张 | ✔ 28 秒出图 |

万相2.1 系列是**唯一给到 500 张**的一档，且是同代成熟模型。
改这两个默认值的位置：`BUILTIN_PROVIDERS.dashscope.defaultModel / editModel`。

**图生图接口不同**：`wanx2.1-imageedit` 走的是
`/api/v1/services/aigc/image2image/image-synthesis`（不是 text2image）。
插件为此加了 `editEndpoint` + `fields.image = 'input.base_image_url'` +
`defaultEditFunction`，见下一节。

---

## 7.7 图生图（三个必须配套的字段）

**背景**：图生图不是「文生图换个模型名」，阿里百炼有三个独立要求。
2026-10-12 全部实测通过（`wanx2.1-imageedit` 出图成功）。

### ① 不同的 endpoint

| | 地址 |
|---|---|
| 文生图 | `/api/v1/services/aigc/text2image/image-synthesis` |
| 图生图 | `/api/v1/services/aigc/image2image/image-synthesis` |

配置：`providers.dashscope.editEndpoint`。
运行时若带参考图且厂商配了 `editEndpoint`，自动切换（`providerForRequest`）。

⚠️ 打错接口**不会**报明显的 404，而是任务直接 FAILED，很难定位。

### ② 参考图字段名

```json
{ "input": { "base_image_url": "data:image/png;base64,..." } }
```

配置：`providers.dashscope.fields.image = 'input.base_image_url'`。

⚠️ **改之前这里是空串** —— 意味着图生图时参考图**根本不进请求体**，
静默退化成文生图。这是最容易漏的一处。

### ③ `input.function` 是必填（最容易踩）

不传会报：
```
InvalidParameter: The following fields are required: function
```

配置：`providers.dashscope.fields.editFunction = 'input.function'`
+ `providers.dashscope.defaultEditFunction = 'description_edit'`。

合法取值（官方文档，共 10 种）：

| function | 用途 | 备注 |
|---|---|---|
| `description_edit` | 指令编辑 | **默认值**，无需指定区域，最通用 |
| `stylization_all` | 全局风格化 | 支持 `strength` 0~1 |
| `stylization_local` | 局部风格化 | 支持 `strength` |
| `remove_watermark` | 去文字水印 | 中英文 |
| `expand` | 扩图 | 支持 `top/bottom/left/right_scale` |
| `super_resolution` | 图像超分 | 支持 `upscale_factor` 1~4 |
| `colorization` | 图像上色 | 黑白转彩色 |
| `doodle` | 线稿生图 | 支持 `is_sketch` |
| `control_cartoon_feature` | 参考卡通形象生图 | |
| `description_edit_with_mask` | 局部重绘 | ⚠️ **需额外传 `mask_image_url`，本插件未支持** |

**踩坑经过**：先用「提交后看 HTTP 200」判断 `function` 可选 —— 错的。
提交**总是**返回 200 + PENDING，真正的校验发生在任务调度后。
必须轮询到终态才能看到 `InvalidParameter`。

### 其他厂商

`editEndpoint` / `defaultEditFunction` 留空即不生效，
图生图与文生图共用 endpoint 和字段（多数 OpenAI 兼容厂商如此）。

---

## 8. API Key 管理

### 存储

存在 `.dsh-image-gen-keys.json`（插件自己的文件，**不写 DSH 官方凭据域**）。
结构：
```json
{
  "keys": { "<providerId>": [ { id, name, value, disabled, lastError? } ] },
  "active": { "<providerId>": "<keyId>" }
}
```

### 查找顺序（`readApiKeys`）

1. **插件自有存储**（可能多个）
2. **DSH 凭据域**（`providers.<id>.credential` 指定的名字）
3. **同名环境变量**

### 自动导入

打开界面时，若插件存储为空但凭据域里有该厂商的 Key，**自动导入**。
幂等，不会重复导入。

> 为什么需要：界面只列插件存储的 Key。用户若早已配在 `.credentials.yaml`，
> 界面会是空的，看起来像「没有已保存的 API」—— 实测踩到过。

### 多 Key 轮换

某 Key 返回鉴权错误（401/403）时**自动切下一个**，不消耗重试次数
（`attempt -= 1`）。实测：第 1 个 Key 无效时自动用第 2 个成功出图。

### 明文不外泄

界面只显示掩码（`sk-x****mpfj`），接口响应**永不含明文**（有专门测试）。

---

## 9. 价格表

有**两套**价格来源，优先级：**接口实时价格 > 内置 `PRICE_TABLE`**。

| 厂商 | 来源 | 显示 | 维护 |
|---|---|---|---|
| 阿里百炼 | **接口 `prices` 字段** | `¥0.20/张` | ✅ 自动，无需人工 |
| 硅基流动 / 智谱 / 千帆 | 内置 `PRICE_TABLE` | `¥0.10/张` | ❌ 需人工 |
| 火山方舟 | 内置 `PRICE_TABLE` | `¥0.20/张?` ← 问号 | ❌ 需人工 |

**带 `?` = 未经官方确证**。火山的官方价格页是 JS 渲染，抓不到明细。

界面用 `priceFromApi` 区分提示语：
- `true` → 「价格来自厂商接口实时数据」（百炼）
- `false` → 「价格数据 2026-10-08（选型参考，以厂商官网为准）」

价格变动时：
- 百炼 —— **不用管**，下次拉列表自动更新
- 其他 4 家 —— 改 `PRICE_TABLE`，并把 `asOf` 改成当天

---

## 10. 设置界面

注册在 `settings.models.footer` 槽位（设置 → 模型 → 页面底部）。

**客户端 bundle 的格式要求**（踩过坑，务必注意）：

```js
window.__ModuleLoader__.load({
  id: "dsh-image-gen",              // 必须等于包名
  factory: (require) => { ... return 导出对象 }
})
```

- **必须用 esbuild 的 `iife` + `globalName` 格式**。
  用 `cjs` 会让 esbuild 自己声明 `module`/`exports`，
  与外层包装的同名变量冲突，**导出的 apply 会丢失** —— 插件会加载但什么都不显示。
  这个 bug 抓出来过，靠的是「用 Node 执行产物并检查导出键」的测试。
- **React 由宿主通过 `require` 提供**，不打包进产物。
  只 `require('react')`（baseline 模块表里的），
  **不要 require 其他 Harness Client 包**（官方文档明确禁止）。

---

## 11. 测试脚本

保留了两个（带 `_` 前缀的是临时/工具脚本）：

| 脚本 | 用途 |
|---|---|
| `scripts/_preflight.mjs` | **重启前必跑**，7 项启动安全检查 |
| `scripts/build-client.mjs` | 构建客户端产物 |

**写临时测试时注意**：
- 用临时目录，别污染真实配置
- 测完清理（`rmSync`）
- **注意运行期配置会覆盖测试传入的值** —— `.dsh-image-gen.json` 里的 `model` /
  `provider` 优先于 `m.Config()` 传入的值。测试要么先删该字段、要么直接改文件，
  **并且一定要还原**（本轮就因为 ESM 下 `require` 不可用，还原钩子失败，
  把 `provider` 留成了 `qianfan`，需要手工改回）
- Key 存储路径**不跟 outputDir 走**（已修正），测试时用 `m.Config({})` 即可
- **`Config()` 必须真的调用** —— 直接传字面量对象会跳过 Schema 默认值填充，
  嵌套字段（`providers` / `models`）拿不到默认值，测试结论不可信
- **异步接口别用「提交返回 200」判断参数合法** —— 阿里百炼提交**总是**返回
  200 + `PENDING`，真正的校验在任务调度后。必须轮询到终态（`SUCCEEDED` /
  `FAILED`）才能确认。本轮据此误判过 `input.function` 是否可选
- **测试时如果只改了 `index.js` 而没重启，跑的是新代码**（因为是直接 import
  文件），但**线上 DSH 里跑的是旧代码** —— 别把测试通过当成已生效

---

## 12. 已知限制

- **火山方舟**：需用户在火山控制台开通生图模型，插件无法绕过
- **千帆**：免费额度 RPM 很低，连续调用会 429（已识别为可重试）
- **价格数据会过时**：阿里百炼已自动化（读接口）；**其他 4 家仍需人工更新 `PRICE_TABLE`**
- **免费额度会过时**：`FREE_QUOTA` 是内置表，**没有 API 可查**，需人工更新
- **免费额度余量查不到**：只能去百炼控制台看，插件只显示「总额度」不显示「剩余」
- **智谱**：`/models` 不含生图模型，新增智谱生图模型时要手动加进 `knownImageModels`
- **智谱探测码无区分度**，无法用它判断模型是否可生图
- **图片宽高**：智谱返回 JPEG 时拿不到尺寸，界面显示 `undefinedxundefined`
  （不影响出图，只是显示）
- **局部重绘未支持**：百炼的 `description_edit_with_mask` 需要额外传
  `mask_image_url`，插件没有该字段
- **图生图的 `function` 不能从界面选**：目前固定用 `defaultEditFunction`
  （默认 `description_edit`）。要换风格化/超分等，需改配置或加界面控件

---

## 13. 关键代码位置索引

`index.js` 里按顺序：

| 位置 | 内容 |
|---|---|
| `BUILTIN_PROVIDERS` | 5 家厂商模板（endpoint/auth/字段映射/响应路径） |
| `PRICE_TABLE` | 内置价格表（仅阿里百炼之外的 4 家用） |
| `priceOf()` | 查内置价格 |
| `extractApiPrice()` | **从接口响应读官方价格**（阿里百炼，优先于内置表） |
| `formatPrice()` | 价格格式化（避免 0.003 显示成 ¥0.00） |
| `FREE_QUOTA` / `freeQuotaOf()` | 免费额度内置表（无 API，仅百炼） |
| `resolveProvider()` | 厂商配置三级合并（内置 → 用户覆盖 → 顶层） |
| `createKeyStore()` | Key 存储（增删改查 + 掩码） |
| `readApiKeys()` / `importExternalKeys()` | Key 查找与自动导入 |
| `buildAuth()` | 鉴权（bearer / header / query）+ 自定义头 |
| `buildRequestBody()` | 字段映射（支持 `input.prompt` 嵌套、`sizeSeparator`、`editFunction`） |
| `requestImages()` | 生图调用（异步轮询 + Key 轮换 + 退避重试） |
| `pollAsyncTask()` | 异步任务轮询（阿里） |
| `fetchModelList()` | 拉模型列表**原始条目**（价格自动化需要，别改成只返回 id） |
| `fetchModelIds()` | 从原始条目提取 id（内部调 `fetchModelList`） |
| `probeModel()` | 零成本探测 |
| `apply()` | 插件入口：注册工具 + 3 个路由 |

**图生图的三处配套**（改一处要一起改）：
`BUILTIN_PROVIDERS.dashscope.editEndpoint` +
`fields.image = 'input.base_image_url'` +
`fields.editFunction` / `defaultEditFunction`。

---

## 14. 常见问题排查

| 现象 | 排查方向 |
|---|---|
| 工具没出现 | 是否重启？跑 `_preflight.mjs` 看第 5 项（工具定义校验） |
| 界面那一行不显示 | 跑 `_preflight.mjs` 看第 6 项；或 `cordis_inspect_query` 查 `settings.models.footer` 槽位占用 |
| Key 加了但列表空 | 检查 `.dsh-image-gen-keys.json` 是否在 profile 根（不是 outputDir） |
| 模型列表拉不到 | 该厂商 `/models` 是否含生图模型？不含就加 `knownImageModels` |
| 出图报 401/403 | Key 无效，或厂商需要特殊头（如阿里的 `X-DashScope-Async`） |
| 出图报参数错 | 检查 `fields` 映射与 `sizeSeparator` |
| 阿里任务 FAILED | 看返回的 `message`：尺寸要 `*`；图生图缺 `function` 会说 required |
| **界面价格一直带 `?`** | `priceFromApi` 为 false，即没读到接口价格。查 `models.price` 配置与 `extractApiPrice` |
| **价格全都不显示** | 检查是否误按 `type` 白名单筛（计费项命名有 5 种，要按 `price_unit` 筛） |
| **图生图退化成文生图** | `fields.image` 是否为空串？或 `editEndpoint` 没配 |
| **改了代码没生效** | Host 源码改动**必须重启**；数据文件改动才会立即生效 |
| **模型列表结果没变** | 命中缓存了。点界面「获取模型列表」或删 `.dsh-image-gen-models.json` 里对应厂商 |

**查槽位占用**（判断客户端是否加载成功）：
```
cordis_inspect_query(platform="client", provider="Slots",
                     method="listSubTree", input={root:"settings.models.footer"})
```
`occupants` 里应看到 `{ registrant: "dsh-image-gen-client", id: "dsh-image-gen", active: true }`。

---

## 15. 变更记录

倒序，最新的在最上面。**改完代码往这里补一行**，方便判断线上跑的是哪一版。

### 2026-10-12 —— 接入阿里百炼原生接口 + 修图生图

**改了什么**
- `dashscope.models` 换成原生 `/api/v1/models?capabilities=IG`
  （旧：`compatible-mode/v1/models` + 关键词预筛）
- 新增 `extractApiPrice()` / `formatPrice()`：价格从接口实时读，不再依赖内置表
- 新增 `FREE_QUOTA` / `freeQuotaOf()`：免费额度内置表（无 API）
- 新增 `editEndpoint` / `defaultEditFunction` + `fields.image` / `fields.editFunction`
- 默认模型改为 `wanx2.1-t2i-plus`（文生图）/ `wanx2.1-imageedit`（图生图），
  都是 500 张免费额度
- 界面：下拉显示 `免费N张`、按额度降序排、`priceFromApi` 区分提示语
- 顺手修掉 `fetchModelList` 的 bug（函数体残留 map-to-id，导致价格自动化拿不到原始条目）

**验证**
- `_preflight.mjs` 7 项全绿
- 端到端真实出图：文生图（`wanx2.1-t2i-plus`）+ 图生图（`wanx2.1-imageedit`）都通过
  插件真实代码路径跑通，图生图结果人工确认内容正确
- 回归：硅基流动/智谱/千帆价格回退正常，无多余 `quota` 字段

**关键结论**（详见第 7.5 / 7.6 / 7.7 节）
- 免费额度**没有 API**，只能内置表 + 控制台看余量
- `/api/v1/quotas` 是**限流配额**，不是免费额度（43 个生图模型 `usage_limit` 全 null）
- 图生图三个配套字段缺一不可：`editEndpoint` + `fields.image` + `input.function`
- `input.function` 必填，且**提交总是返回 200**，必须轮询到终态才看得到校验错误

### 2026-10-11 —— 加备份规则

- 新增第 0 节：改本文件前先备份到 `MAINTENANCE.md.bak`（覆盖式）
- 文件清单补上 `MAINTENANCE.md` 自身与 `.bak`

### 2026-10-08 —— 初版

- 5 家厂商接入，4 家实测出图通过（火山待用户开通）
- 内置 `PRICE_TABLE`（30 条）
- 设置界面注册在 `settings.models.footer`
- 本文件首版
