# DSH 插件合集

我自己写的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件。

全部 MIT 授权，随便用。

## 插件列表

| 插件 | 说明 |
|---|---|
| [dsh-text-color](dsh-text-color/) | 在设置页调整界面**文字颜色**。6 个语义槽位，亮/暗主题各自独立，HSL 滑块调色。只改文字，不碰背景——可以和背景类插件共存。 |
| [dsh-image-gen](dsh-image-gen/) | 生图插件。注册 `generate_image` 工具，出图后直接显示在对话里。支持硅基流动、火山方舟、阿里百炼、智谱、百度千帆。带设置界面。 |
| [xiaoyu-preset](xiaoyu-preset/) | 一个 agent 预设：DSH 内置 `standard` 预设 + 自定义人设。当模板看也行。 |

## 安装

DSH 的插件用 `dsh plugin` 管理。以 `dsh-text-color` 为例：

```sh
# 浏览器版
dsh plugin --profile web add dsh-text-color

# 桌面版
dsh plugin --profile desktop add dsh-text-color
```

**本地开发用**（改代码即时生效，不用重装）：

```sh
# 1. 把插件目录放到 profile 的 plugins 下
# 2. 建 junction / 软链
mklink /J "%DSH_HOME%\profiles\desktop\node_modules\dsh-text-color" ^
          "%DSH_HOME%\profiles\desktop\plugins\dsh-text-color"
# 3. package.json 的 dependencies 加 "dsh-text-color": "link:<绝对路径>"
#    dsh.profile.bundles 数组里加 "dsh-text-color"
# 4. 重启 DSH
```

改完**必须重启 DSH**——客户端插件在启动时加载，没有热重载。

## 注意

- 这些插件是**按 DSH `0.2.0-rc.2` 写的**。DSH 内核升级后 `peerDependencies` 可能不再匹配。
- 客户端插件只能 `require` `react`、`react-dom`、`react/jsx-runtime` 三个包，官方 UI 组件库拿不到。
  所以界面都是原生 HTML + 自注入 CSS。

## 授权

[MIT](LICENSE)。用、改、再分发都行，保留版权声明即可。
