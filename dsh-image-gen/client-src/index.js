/**
 * dsh-image-gen 客户端半边。
 *
 * 在「设置 → 模型」页的页脚区域（`settings.models.footer`）加一行，
 * 显示并修改生图插件的配置：模型（可从列表选取）、尺寸。
 *
 * React 由宿主通过 `require` 提供（见 web boot 的模块映射），
 * 因此这里不打包 React，构建时标记为 external。
 */
import { createElement, useCallback, useEffect, useState } from 'react'

export const name = 'dsh-image-gen-client'
export const inject = ['slots']

/** 与 Host 约定的接口 */
const CONFIG_PATH = '/dsh-image-gen/config'
const MODELS_PATH = '/dsh-image-gen/models'
const KEYS_PATH = '/dsh-image-gen/keys'

/** 统一请求封装 */
async function call(path, options = {}) {
  const response = await fetch(path, {
    method: options.method ?? 'GET',
    headers: options.body === undefined
      ? { accept: 'application/json' }
      : { accept: 'application/json', 'content-type': 'application/json' },
    credentials: 'same-origin',
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  const text = await response.text()
  let parsed
  try {
    parsed = text.length > 0 ? JSON.parse(text) : {}
  } catch (err) {
    throw new Error(text.slice(0, 200) || `HTTP ${response.status}`)
  }
  if (!response.ok) throw new Error(parsed?.error ?? `HTTP ${response.status}`)
  return parsed
}

const rowStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: '10px',
  padding: '12px 14px',
  border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25))',
  borderRadius: '10px',
}

const headStyle = { display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600 }
const mutedStyle = { opacity: 0.65, fontSize: '0.9em' }
const fieldStyle = { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }
const labelStyle = { minWidth: '5em', ...mutedStyle }
const controlStyle = {
  flex: '1 1 220px',
  minWidth: '160px',
  padding: '6px 8px',
  borderRadius: '6px',
  border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))',
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
}
const buttonStyle = {
  padding: '6px 12px',
  borderRadius: '6px',
  border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  font: 'inherit',
  whiteSpace: 'nowrap',
}
const keyBoxStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
  padding: '10px 12px',
  border: '1px dashed var(--dsw-alias-border-l2, rgba(128,128,128,0.35))',
  borderRadius: '8px',
}

/** 「生图」配置行 */
function ImageGenRow() {
  const [state, setState] = useState({ status: 'loading' })
  const [draft, setDraft] = useState({ provider: '', model: '', imageSize: '' })
  const [save, setSave] = useState({ status: 'idle' })
  const [models, setModels] = useState({ status: 'idle' })
  const [keys, setKeys] = useState({ status: 'idle', rows: [] })
  const [newKey, setNewKey] = useState({ name: '', value: '' })

  const apply = useCallback((data) => {
    setState({ status: 'ready', data })
    setDraft({ provider: data.provider ?? '', model: data.model ?? '', imageSize: data.imageSize ?? '' })
  }, [])

  // 首次加载：拉配置 → 拉该厂商的 Key 列表 → 拉缓存的模型列表。
  // ⚠️ 不要拆成多个 useEffect 靠 state.status 触发 —— 首次渲染时 status 还是
  // loading，依赖值后续又不变，effect 不会再跑，数据就永远不加载（实测踩到）。
  useEffect(() => {
    const controller = new AbortController()
    const load = async () => {
      try {
        const data = await call(CONFIG_PATH, { signal: controller.signal })
        apply(data)
        const providerId = data.provider ?? ''
        if (providerId.length === 0) return
        try {
          const keyData = await call(`${KEYS_PATH}?provider=${encodeURIComponent(providerId)}`, {
            signal: controller.signal,
          })
          setKeys({
            status: 'ready',
            rows: keyData.keys ?? [],
            file: keyData.file,
            message: (keyData.imported ?? 0) > 0
              ? `已从 DSH 凭据域自动导入 ${keyData.imported} 个 Key`
              : '',
          })
        } catch (err) {
          if (err?.name === 'AbortError') return
          setKeys({ status: 'error', message: err instanceof Error ? err.message : String(err) })
        }
        // 自动加载缓存的模型列表（不重新拉接口，秒开）
        try {
          const modelData = await call(MODELS_PATH, {
            method: 'POST',
            body: { provider: providerId, refresh: false, probe: false },
            signal: controller.signal,
          })
          const list = modelData.serverFiltered === true
            ? (modelData.candidates ?? [])
            : (modelData.supported?.length > 0 ? modelData.supported : (modelData.candidates ?? []))
          if (list.length > 0) {
            setModels({
              status: 'ready',
              probe: false,
              list,
              detailed: modelData.candidatesDetailed,
              data: modelData,
              fromCache: true,
            })
          }
        } catch (err) {
          // 没有缓存就保持 idle，用户点按钮再拉
        }
      } catch (err) {
        if (err?.name === 'AbortError') return
        setState({ status: 'error', message: err instanceof Error ? err.message : String(err) })
      }
    }
    void load()
    return () => controller.abort()
  }, [apply])
  const onSave = useCallback(async () => {
    setSave({ status: 'saving' })
    try {
      apply(await call(CONFIG_PATH, { method: 'POST', body: draft }))
      setSave({ status: 'saved' })
    } catch (err) {
      setSave({ status: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }, [draft, apply])

  /** 拉取模型列表；probe=true 时逐个探测筛出生图模型 */
  const onFetchModels = useCallback(async (probe) => {
    setModels({ status: 'loading', probe })
    try {
      const data = await call(MODELS_PATH, {
        method: 'POST',
        body: { provider: draft.provider, refresh: true, probe },
      })
      // 厂商支持服务端筛选时，一次请求就是最终结果（不需要探测）
      const serverFiltered = data.serverFiltered === true
      const list = serverFiltered
        ? (data.candidates ?? [])
        : (probe ? (data.supported ?? []) : (data.candidates ?? []))
      setModels({
        status: 'ready',
        probe: probe && !serverFiltered,
        list,
        detailed: data.candidatesDetailed,
        data,
      })
    } catch (err) {
      setModels({ status: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }, [draft.provider])

  // ── API Key 管理 ──
  const loadKeys = useCallback(async (providerId) => {
    if (providerId.length === 0) return
    try {
      const data = await call(`${KEYS_PATH}?provider=${encodeURIComponent(providerId)}`)
      setKeys({
        status: 'ready',
        rows: data.keys ?? [],
        file: data.file,
        // 首次打开时从凭据域/环境变量导入了 Key → 提示用户
        message: (data.imported ?? 0) > 0
          ? `已从 DSH 凭据域自动导入 ${data.imported} 个 Key`
          : '',
      })
    } catch (err) {
      setKeys({ status: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }, [])

  const keyAction = useCallback(async (payload) => {
    setKeys((prev) => ({ ...prev, status: 'busy', message: '' }))
    try {
      const data = await call(KEYS_PATH, { method: 'POST', body: { provider: draft.provider, ...payload } })
      setKeys({
        status: 'ready',
        rows: data.keys ?? [],
        file: data.file,
        message: payload.action === 'test' && Array.isArray(data.results)
          ? data.results.map((r) => {
            const row = (data.keys ?? []).find((k) => k.id === r.id)
            return `${row?.hint ?? r.id}: ${r.ok ? '✓ ' : '✗ '}${r.message}`
          }).join('；')
          : '',
      })
    } catch (err) {
      setKeys({ status: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }, [draft.provider])

  const head = createElement('div', { style: headStyle }, '生图（dsh-image-gen）')

  if (state.status === 'loading') {
    return createElement('div', { style: rowStyle }, head,
      createElement('div', { style: mutedStyle }, '正在读取配置…'))
  }
  if (state.status === 'error') {
    return createElement('div', { style: rowStyle }, head,
      createElement('div', { style: mutedStyle }, `读取失败：${state.message}`))
  }

  const data = state.data
  const saveText = save.status === 'saving'
    ? '保存中…'
    : save.status === 'saved'
      ? '已保存（下一次调用生效）'
      : save.status === 'error'
        ? `保存失败：${save.message}`
        : ''

  // 模型选择区
  let modelArea = null
  if (models.status === 'loading') {
    modelArea = createElement('div', { style: mutedStyle },
      models.probe ? '正在获取并探测可用生图模型（逐个验证，约需 10–60 秒）…' : '正在获取模型列表…')
  } else if (models.status === 'error') {
    modelArea = createElement('div', { style: mutedStyle }, `获取失败：${models.message}`)
  } else if (models.status === 'ready') {
    const { list, probe, data: info, detailed, fromCache } = models
    if (list.length === 0) {
      modelArea = createElement('div', { style: mutedStyle },
        `未找到候选模型（该厂商共 ${info.all} 个模型）。可在上方手动填写模型 id。`)
    } else {
      // 下拉里带上价格与免费额度：有价格的显示 "模型 id　¥0.10/张"，未知的不显示价格
      const rows = detailed ?? list.map((id) => ({ id, price: undefined }))
      /**
       * 排序：免费额度多的排前面（用户最关心「哪个能白嫖最多」），
       * 额度相同或没有额度时按价格升序（便宜的排前面）。
       * 排序只影响下拉展示顺序，不改变 list 本身。
       */
      const priceValue = (row) => {
        if (row.price === undefined) return Number.POSITIVE_INFINITY
        if (row.price.free === true) return 0
        const num = Number(String(row.price.text).replace(/[^\d.]/g, ''))
        return Number.isFinite(num) ? num : Number.POSITIVE_INFINITY
      }
      const sortedRows = [...rows].sort((a, b) => {
        const qa = a.quota?.images ?? -1
        const qb = b.quota?.images ?? -1
        if (qa !== qb) return qb - qa
        return priceValue(a) - priceValue(b)
      })
      const priceHint = rows
        .filter((row) => row.price !== undefined && row.price.free !== true)
        .map((row) => row.price)
      const anyUnofficial = priceHint.some((p) => p.official === false)
      /**
       * 免费额度标注：只有阿里百炼有（其他厂商的接口不返回该数据）。
       * 形如 "　免费500张"，让用户一眼挑出额度最多的模型。
       */
      const quotaLabel = (row) => (
        row.quota === undefined ? '' : `　免费${row.quota.images}张`
      )
      const anyQuota = rows.some((row) => row.quota !== undefined)
      modelArea = createElement('div', { style: fieldStyle },
        createElement('span', { style: labelStyle }, probe ? '可用模型' : '候选模型'),
        createElement('select', {
          style: controlStyle,
          value: list.includes(draft.model) ? draft.model : '',
          onChange: (event) => {
            if (event.target.value.length > 0) {
              setDraft((prev) => ({ ...prev, model: event.target.value }))
            }
          },
        },
        createElement('option', { value: '' }, `— 请选择（共 ${list.length} 个）—`),
        ...sortedRows.map((row) => createElement('option', { key: row.id, value: row.id },
          `${row.id}${row.price === undefined ? '' : `　${row.price.text}`}${quotaLabel(row)}`))),
        createElement('div', { style: mutedStyle },
          (fromCache ? '（缓存，点「获取模型列表」可刷新）' : '')
          // 价格来自接口实时数据时不必提「会过时」
          + (info.priceFromApi === true
            ? '价格来自厂商接口实时数据'
            : `价格数据 ${info.priceAsOf ?? '未知'}（选型参考，以厂商官网为准）`)
          + (anyUnofficial ? '；带 ? 的为第三方资料，未确证' : '')),
        anyQuota
          ? createElement('div', { style: mutedStyle },
            `免费额度数据 ${info.quotaAsOf ?? '未知'}（仅华北2北京地域、开通后90天内有效；`
            + '各模型额度独立不互通；实际余量以百炼控制台为准）')
          : null,
        info.usedKnownList === true
          ? createElement('div', { style: mutedStyle },
            '该厂商的模型列表不含生图模型，以上为内置的已知清单')
          : null,
        probe && (info.unsupported?.length ?? 0) > 0
          ? createElement('div', { style: mutedStyle },
            `已排除 ${info.unsupported.length} 个非生图模型`)
          : null)
    }
  }

  // ── API Key 区域 ──
  const keyRows = keys.rows ?? []
  const keyArea = createElement('div', { style: keyBoxStyle },
    createElement('div', { style: { ...headStyle, fontSize: '0.95em' } },
      `API Key（${data.providerName}）`),
    createElement('div', { style: mutedStyle },
      '可添加多个 Key；遇鉴权失败会自动切换到下一个。Key 存在插件自己的文件里。'),

    keyRows.length === 0
      ? createElement('div', { style: mutedStyle },
        '尚未添加 Key。在下面粘贴一个，或把 Key 写进 $DSH_HOME/.credentials.yaml（下次打开本页面会自动导入）。')
      : createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
        ...keyRows.map((row) => createElement('div', {
          key: row.id,
          style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
        },
        createElement('input', {
          type: 'radio',
          name: 'dsh-image-gen-active-key',
          checked: row.active === true,
          title: '设为当前使用的 Key',
          onChange: () => { void keyAction({ action: 'setActive', id: row.id }) },
        }),
        createElement('code', { style: { fontFamily: 'monospace' } }, row.hint),
        row.name.length > 0 ? createElement('span', { style: mutedStyle }, row.name) : null,
        row.active === true ? createElement('span', { style: { ...mutedStyle, color: 'inherit' } }, '← 当前') : null,
        row.lastError !== undefined
          ? createElement('span', { style: { ...mutedStyle, color: 'var(--dsw-alias-text-warning, orange)' } },
            `上次失败：${row.lastError}`)
          : null,
        createElement('button', {
          type: 'button',
          style: { ...buttonStyle, padding: '2px 8px', fontSize: '0.9em' },
          title: '删除这一个 Key',
          onClick: () => { void keyAction({ action: 'remove', id: row.id }) },
        }, '删除这一个')))),

    createElement('div', { style: fieldStyle },
      createElement('input', {
        style: { ...controlStyle, flex: '0 1 140px', minWidth: '100px' },
        value: newKey.name,
        placeholder: '备注（可选）',
        spellCheck: false,
        onChange: (event) => setNewKey((prev) => ({ ...prev, name: event.target.value })),
      }),
      createElement('input', {
        style: controlStyle,
        value: newKey.value,
        placeholder: '粘贴 API Key',
        spellCheck: false,
        type: 'password',
        onChange: (event) => setNewKey((prev) => ({ ...prev, value: event.target.value })),
      }),
      createElement('button', {
        type: 'button',
        style: buttonStyle,
        disabled: keys.status === 'busy' || newKey.value.trim().length === 0,
        onClick: async () => {
          await keyAction({ action: 'add', name: newKey.name, value: newKey.value })
          setNewKey({ name: '', value: '' })
        },
      }, '保存 Key')),

    createElement('div', { style: fieldStyle },
      createElement('button', {
        type: 'button',
        style: buttonStyle,
        disabled: keys.status === 'busy' || keyRows.length === 0,
        onClick: () => { void keyAction({ action: 'test' }) },
      }, '测试全部 Key'),
      createElement('button', {
        type: 'button',
        style: buttonStyle,
        disabled: keys.status === 'busy' || keyRows.length === 0,
        onClick: () => { void keyAction({ action: 'clear' }) },
      }, '清空全部'),
      keys.status === 'busy' ? createElement('span', { style: mutedStyle }, '处理中…') : null),

    keys.message !== undefined && keys.message.length > 0
      ? createElement('div', { style: mutedStyle }, keys.message)
      : null,
    keys.status === 'error'
      ? createElement('div', { style: mutedStyle }, `Key 操作失败：${keys.message}`)
      : null)

  return createElement('div', { style: rowStyle },
    head,
    createElement('div', { style: mutedStyle },
      `当前厂商 ${data.providerName}（${data.provider}）｜输出目录 ${data.outputDir}`),

    (data.providers?.length ?? 0) > 1
      ? createElement('div', { style: fieldStyle },
        createElement('span', { style: labelStyle }, '厂商'),
        createElement('select', {
          style: controlStyle,
          value: draft.provider,
          onChange: (event) => {
            const id = event.target.value
            // 切厂商时清掉模型（模型 id 不跨厂商通用）与旧的模型列表，
            // 并立刻加载新厂商的 Key 列表（Key 是按厂商分开存的）
            setDraft((prev) => ({ ...prev, provider: id, model: '' }))
            setModels({ status: 'idle' })
            void loadKeys(id)
          },
        },
        ...data.providers.map((p) => createElement('option', {
          key: p.id,
          value: p.id,
        }, `${p.displayName}（${p.id}）${p.problem === undefined ? '' : ' ⚠ 配置不完整'}`))),
        createElement('span', { style: mutedStyle }, '切换后需保存'))
      : null,

    keyArea,

    createElement('div', { style: fieldStyle },
      createElement('span', { style: labelStyle }, '默认模型'),
      createElement('input', {
        style: controlStyle,
        value: draft.model,
        placeholder: data.builtinModel,
        spellCheck: false,
        onChange: (event) => setDraft((prev) => ({ ...prev, model: event.target.value })),
      })),

    createElement('div', { style: fieldStyle },
      createElement('button', {
        type: 'button',
        style: buttonStyle,
        disabled: models.status === 'loading',
        onClick: () => { void onFetchModels(false) },
      }, '获取模型列表'),
      createElement('button', {
        type: 'button',
        style: buttonStyle,
        disabled: models.status === 'loading',
        onClick: () => { void onFetchModels(true) },
      }, '获取并筛选可用生图模型')),

    modelArea,

    createElement('div', { style: fieldStyle },
      createElement('span', { style: labelStyle }, '默认尺寸'),
      createElement('input', {
        style: controlStyle,
        value: draft.imageSize,
        placeholder: '1024x1024',
        spellCheck: false,
        onChange: (event) => setDraft((prev) => ({ ...prev, imageSize: event.target.value })),
      })),

    createElement('div', { style: fieldStyle },
      createElement('button', {
        type: 'button',
        style: buttonStyle,
        disabled: save.status === 'saving',
        onClick: () => { void onSave() },
      }, '保存'),
      saveText.length > 0 ? createElement('span', { style: mutedStyle }, saveText) : null),
  )
}

/**
 * 客户端插件主体。
 * @param ctx - 客户端上下文。
 */
export function apply(ctx) {
  ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
    name: 'settings.models.footer',
    id: 'dsh-image-gen',
    order: 100,
    label: '生图',
  }, ImageGenRow))
}
