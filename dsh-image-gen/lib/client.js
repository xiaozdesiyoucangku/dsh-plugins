window.__ModuleLoader__.load({
	id: "dsh-image-gen",
	factory: (require) => {
		var __dshImageGen = (() => {
		  var __defProp = Object.defineProperty;
		  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
		  var __getOwnPropNames = Object.getOwnPropertyNames;
		  var __hasOwnProp = Object.prototype.hasOwnProperty;
		  var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
		    get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
		  }) : x)(function(x) {
		    if (typeof require !== "undefined") return require.apply(this, arguments);
		    throw Error('Dynamic require of "' + x + '" is not supported');
		  });
		  var __export = (target, all) => {
		    for (var name2 in all)
		      __defProp(target, name2, { get: all[name2], enumerable: true });
		  };
		  var __copyProps = (to, from, except, desc) => {
		    if (from && typeof from === "object" || typeof from === "function") {
		      for (let key of __getOwnPropNames(from))
		        if (!__hasOwnProp.call(to, key) && key !== except)
		          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
		    }
		    return to;
		  };
		  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
		
		  // client-src/index.js
		  var index_exports = {};
		  __export(index_exports, {
		    apply: () => apply,
		    inject: () => inject,
		    name: () => name
		  });
		  var import_react = __require("react");
		  var name = "dsh-image-gen-client";
		  var inject = ["slots"];
		  var CONFIG_PATH = "/dsh-image-gen/config";
		  var MODELS_PATH = "/dsh-image-gen/models";
		  var KEYS_PATH = "/dsh-image-gen/keys";
		  async function call(path, options = {}) {
		    const response = await fetch(path, {
		      method: options.method ?? "GET",
		      headers: options.body === void 0 ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
		      credentials: "same-origin",
		      ...options.body === void 0 ? {} : { body: JSON.stringify(options.body) },
		      ...options.signal === void 0 ? {} : { signal: options.signal }
		    });
		    const text = await response.text();
		    let parsed;
		    try {
		      parsed = text.length > 0 ? JSON.parse(text) : {};
		    } catch (err) {
		      throw new Error(text.slice(0, 200) || `HTTP ${response.status}`);
		    }
		    if (!response.ok) throw new Error(parsed?.error ?? `HTTP ${response.status}`);
		    return parsed;
		  }
		  var rowStyle = {
		    display: "flex",
		    flexDirection: "column",
		    gap: "10px",
		    padding: "12px 14px",
		    border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25))",
		    borderRadius: "10px"
		  };
		  var headStyle = { display: "flex", alignItems: "center", gap: "8px", fontWeight: 600 };
		  var mutedStyle = { opacity: 0.65, fontSize: "0.9em" };
		  var fieldStyle = { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" };
		  var labelStyle = { minWidth: "5em", ...mutedStyle };
		  var controlStyle = {
		    flex: "1 1 220px",
		    minWidth: "160px",
		    padding: "6px 8px",
		    borderRadius: "6px",
		    border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))",
		    background: "transparent",
		    color: "inherit",
		    font: "inherit"
		  };
		  var buttonStyle = {
		    padding: "6px 12px",
		    borderRadius: "6px",
		    border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))",
		    background: "transparent",
		    color: "inherit",
		    cursor: "pointer",
		    font: "inherit",
		    whiteSpace: "nowrap"
		  };
		  var keyBoxStyle = {
		    display: "flex",
		    flexDirection: "column",
		    gap: "8px",
		    padding: "10px 12px",
		    border: "1px dashed var(--dsw-alias-border-l2, rgba(128,128,128,0.35))",
		    borderRadius: "8px"
		  };
		  function ImageGenRow() {
		    const [state, setState] = (0, import_react.useState)({ status: "loading" });
		    const [draft, setDraft] = (0, import_react.useState)({ provider: "", model: "", imageSize: "" });
		    const [save, setSave] = (0, import_react.useState)({ status: "idle" });
		    const [models, setModels] = (0, import_react.useState)({ status: "idle" });
		    const [keys, setKeys] = (0, import_react.useState)({ status: "idle", rows: [] });
		    const [newKey, setNewKey] = (0, import_react.useState)({ name: "", value: "" });
		    const apply2 = (0, import_react.useCallback)((data2) => {
		      setState({ status: "ready", data: data2 });
		      setDraft({ provider: data2.provider ?? "", model: data2.model ?? "", imageSize: data2.imageSize ?? "" });
		    }, []);
		    (0, import_react.useEffect)(() => {
		      const controller = new AbortController();
		      const load = async () => {
		        try {
		          const data2 = await call(CONFIG_PATH, { signal: controller.signal });
		          apply2(data2);
		          const providerId = data2.provider ?? "";
		          if (providerId.length === 0) return;
		          try {
		            const keyData = await call(`${KEYS_PATH}?provider=${encodeURIComponent(providerId)}`, {
		              signal: controller.signal
		            });
		            setKeys({
		              status: "ready",
		              rows: keyData.keys ?? [],
		              file: keyData.file,
		              message: (keyData.imported ?? 0) > 0 ? `\u5DF2\u4ECE DSH \u51ED\u636E\u57DF\u81EA\u52A8\u5BFC\u5165 ${keyData.imported} \u4E2A Key` : ""
		            });
		          } catch (err) {
		            if (err?.name === "AbortError") return;
		            setKeys({ status: "error", message: err instanceof Error ? err.message : String(err) });
		          }
		          try {
		            const modelData = await call(MODELS_PATH, {
		              method: "POST",
		              body: { provider: providerId, refresh: false, probe: false },
		              signal: controller.signal
		            });
		            const list = modelData.serverFiltered === true ? modelData.candidates ?? [] : modelData.supported?.length > 0 ? modelData.supported : modelData.candidates ?? [];
		            if (list.length > 0) {
		              setModels({
		                status: "ready",
		                probe: false,
		                list,
		                detailed: modelData.candidatesDetailed,
		                data: modelData,
		                fromCache: true
		              });
		            }
		          } catch (err) {
		          }
		        } catch (err) {
		          if (err?.name === "AbortError") return;
		          setState({ status: "error", message: err instanceof Error ? err.message : String(err) });
		        }
		      };
		      void load();
		      return () => controller.abort();
		    }, [apply2]);
		    const onSave = (0, import_react.useCallback)(async () => {
		      setSave({ status: "saving" });
		      try {
		        apply2(await call(CONFIG_PATH, { method: "POST", body: draft }));
		        setSave({ status: "saved" });
		      } catch (err) {
		        setSave({ status: "error", message: err instanceof Error ? err.message : String(err) });
		      }
		    }, [draft, apply2]);
		    const onFetchModels = (0, import_react.useCallback)(async (probe) => {
		      setModels({ status: "loading", probe });
		      try {
		        const data2 = await call(MODELS_PATH, {
		          method: "POST",
		          body: { provider: draft.provider, refresh: true, probe }
		        });
		        const serverFiltered = data2.serverFiltered === true;
		        const list = serverFiltered ? data2.candidates ?? [] : probe ? data2.supported ?? [] : data2.candidates ?? [];
		        setModels({
		          status: "ready",
		          probe: probe && !serverFiltered,
		          list,
		          detailed: data2.candidatesDetailed,
		          data: data2
		        });
		      } catch (err) {
		        setModels({ status: "error", message: err instanceof Error ? err.message : String(err) });
		      }
		    }, [draft.provider]);
		    const loadKeys = (0, import_react.useCallback)(async (providerId) => {
		      if (providerId.length === 0) return;
		      try {
		        const data2 = await call(`${KEYS_PATH}?provider=${encodeURIComponent(providerId)}`);
		        setKeys({
		          status: "ready",
		          rows: data2.keys ?? [],
		          file: data2.file,
		          // 首次打开时从凭据域/环境变量导入了 Key → 提示用户
		          message: (data2.imported ?? 0) > 0 ? `\u5DF2\u4ECE DSH \u51ED\u636E\u57DF\u81EA\u52A8\u5BFC\u5165 ${data2.imported} \u4E2A Key` : ""
		        });
		      } catch (err) {
		        setKeys({ status: "error", message: err instanceof Error ? err.message : String(err) });
		      }
		    }, []);
		    const keyAction = (0, import_react.useCallback)(async (payload) => {
		      setKeys((prev) => ({ ...prev, status: "busy", message: "" }));
		      try {
		        const data2 = await call(KEYS_PATH, { method: "POST", body: { provider: draft.provider, ...payload } });
		        setKeys({
		          status: "ready",
		          rows: data2.keys ?? [],
		          file: data2.file,
		          message: payload.action === "test" && Array.isArray(data2.results) ? data2.results.map((r) => {
		            const row = (data2.keys ?? []).find((k) => k.id === r.id);
		            return `${row?.hint ?? r.id}: ${r.ok ? "\u2713 " : "\u2717 "}${r.message}`;
		          }).join("\uFF1B") : ""
		        });
		      } catch (err) {
		        setKeys({ status: "error", message: err instanceof Error ? err.message : String(err) });
		      }
		    }, [draft.provider]);
		    const head = (0, import_react.createElement)("div", { style: headStyle }, "\u751F\u56FE\uFF08dsh-image-gen\uFF09");
		    if (state.status === "loading") {
		      return (0, import_react.createElement)(
		        "div",
		        { style: rowStyle },
		        head,
		        (0, import_react.createElement)("div", { style: mutedStyle }, "\u6B63\u5728\u8BFB\u53D6\u914D\u7F6E\u2026")
		      );
		    }
		    if (state.status === "error") {
		      return (0, import_react.createElement)(
		        "div",
		        { style: rowStyle },
		        head,
		        (0, import_react.createElement)("div", { style: mutedStyle }, `\u8BFB\u53D6\u5931\u8D25\uFF1A${state.message}`)
		      );
		    }
		    const data = state.data;
		    const saveText = save.status === "saving" ? "\u4FDD\u5B58\u4E2D\u2026" : save.status === "saved" ? "\u5DF2\u4FDD\u5B58\uFF08\u4E0B\u4E00\u6B21\u8C03\u7528\u751F\u6548\uFF09" : save.status === "error" ? `\u4FDD\u5B58\u5931\u8D25\uFF1A${save.message}` : "";
		    let modelArea = null;
		    if (models.status === "loading") {
		      modelArea = (0, import_react.createElement)(
		        "div",
		        { style: mutedStyle },
		        models.probe ? "\u6B63\u5728\u83B7\u53D6\u5E76\u63A2\u6D4B\u53EF\u7528\u751F\u56FE\u6A21\u578B\uFF08\u9010\u4E2A\u9A8C\u8BC1\uFF0C\u7EA6\u9700 10\u201360 \u79D2\uFF09\u2026" : "\u6B63\u5728\u83B7\u53D6\u6A21\u578B\u5217\u8868\u2026"
		      );
		    } else if (models.status === "error") {
		      modelArea = (0, import_react.createElement)("div", { style: mutedStyle }, `\u83B7\u53D6\u5931\u8D25\uFF1A${models.message}`);
		    } else if (models.status === "ready") {
		      const { list, probe, data: info, detailed, fromCache } = models;
		      if (list.length === 0) {
		        modelArea = (0, import_react.createElement)(
		          "div",
		          { style: mutedStyle },
		          `\u672A\u627E\u5230\u5019\u9009\u6A21\u578B\uFF08\u8BE5\u5382\u5546\u5171 ${info.all} \u4E2A\u6A21\u578B\uFF09\u3002\u53EF\u5728\u4E0A\u65B9\u624B\u52A8\u586B\u5199\u6A21\u578B id\u3002`
		        );
		      } else {
		        const rows = detailed ?? list.map((id) => ({ id, price: void 0 }));
		        const priceValue = (row) => {
		          if (row.price === void 0) return Number.POSITIVE_INFINITY;
		          if (row.price.free === true) return 0;
		          const num = Number(String(row.price.text).replace(/[^\d.]/g, ""));
		          return Number.isFinite(num) ? num : Number.POSITIVE_INFINITY;
		        };
		        const sortedRows = [...rows].sort((a, b) => {
		          const qa = a.quota?.images ?? -1;
		          const qb = b.quota?.images ?? -1;
		          if (qa !== qb) return qb - qa;
		          return priceValue(a) - priceValue(b);
		        });
		        const priceHint = rows.filter((row) => row.price !== void 0 && row.price.free !== true).map((row) => row.price);
		        const anyUnofficial = priceHint.some((p) => p.official === false);
		        const quotaLabel = (row) => row.quota === void 0 ? "" : `\u3000\u514D\u8D39${row.quota.images}\u5F20`;
		        const anyQuota = rows.some((row) => row.quota !== void 0);
		        modelArea = (0, import_react.createElement)(
		          "div",
		          { style: fieldStyle },
		          (0, import_react.createElement)("span", { style: labelStyle }, probe ? "\u53EF\u7528\u6A21\u578B" : "\u5019\u9009\u6A21\u578B"),
		          (0, import_react.createElement)(
		            "select",
		            {
		              style: controlStyle,
		              value: list.includes(draft.model) ? draft.model : "",
		              onChange: (event) => {
		                if (event.target.value.length > 0) {
		                  setDraft((prev) => ({ ...prev, model: event.target.value }));
		                }
		              }
		            },
		            (0, import_react.createElement)("option", { value: "" }, `\u2014 \u8BF7\u9009\u62E9\uFF08\u5171 ${list.length} \u4E2A\uFF09\u2014`),
		            ...sortedRows.map((row) => (0, import_react.createElement)(
		              "option",
		              { key: row.id, value: row.id },
		              `${row.id}${row.price === void 0 ? "" : `\u3000${row.price.text}`}${quotaLabel(row)}`
		            ))
		          ),
		          (0, import_react.createElement)(
		            "div",
		            { style: mutedStyle },
		            (fromCache ? "\uFF08\u7F13\u5B58\uFF0C\u70B9\u300C\u83B7\u53D6\u6A21\u578B\u5217\u8868\u300D\u53EF\u5237\u65B0\uFF09" : "") + (info.priceFromApi === true ? "\u4EF7\u683C\u6765\u81EA\u5382\u5546\u63A5\u53E3\u5B9E\u65F6\u6570\u636E" : `\u4EF7\u683C\u6570\u636E ${info.priceAsOf ?? "\u672A\u77E5"}\uFF08\u9009\u578B\u53C2\u8003\uFF0C\u4EE5\u5382\u5546\u5B98\u7F51\u4E3A\u51C6\uFF09`) + (anyUnofficial ? "\uFF1B\u5E26 ? \u7684\u4E3A\u7B2C\u4E09\u65B9\u8D44\u6599\uFF0C\u672A\u786E\u8BC1" : "")
		          ),
		          anyQuota ? (0, import_react.createElement)(
		            "div",
		            { style: mutedStyle },
		            `\u514D\u8D39\u989D\u5EA6\u6570\u636E ${info.quotaAsOf ?? "\u672A\u77E5"}\uFF08\u4EC5\u534E\u53172\u5317\u4EAC\u5730\u57DF\u3001\u5F00\u901A\u540E90\u5929\u5185\u6709\u6548\uFF1B\u5404\u6A21\u578B\u989D\u5EA6\u72EC\u7ACB\u4E0D\u4E92\u901A\uFF1B\u5B9E\u9645\u4F59\u91CF\u4EE5\u767E\u70BC\u63A7\u5236\u53F0\u4E3A\u51C6\uFF09`
		          ) : null,
		          info.usedKnownList === true ? (0, import_react.createElement)(
		            "div",
		            { style: mutedStyle },
		            "\u8BE5\u5382\u5546\u7684\u6A21\u578B\u5217\u8868\u4E0D\u542B\u751F\u56FE\u6A21\u578B\uFF0C\u4EE5\u4E0A\u4E3A\u5185\u7F6E\u7684\u5DF2\u77E5\u6E05\u5355"
		          ) : null,
		          probe && (info.unsupported?.length ?? 0) > 0 ? (0, import_react.createElement)(
		            "div",
		            { style: mutedStyle },
		            `\u5DF2\u6392\u9664 ${info.unsupported.length} \u4E2A\u975E\u751F\u56FE\u6A21\u578B`
		          ) : null
		        );
		      }
		    }
		    const keyRows = keys.rows ?? [];
		    const keyArea = (0, import_react.createElement)(
		      "div",
		      { style: keyBoxStyle },
		      (0, import_react.createElement)(
		        "div",
		        { style: { ...headStyle, fontSize: "0.95em" } },
		        `API Key\uFF08${data.providerName}\uFF09`
		      ),
		      (0, import_react.createElement)(
		        "div",
		        { style: mutedStyle },
		        "\u53EF\u6DFB\u52A0\u591A\u4E2A Key\uFF1B\u9047\u9274\u6743\u5931\u8D25\u4F1A\u81EA\u52A8\u5207\u6362\u5230\u4E0B\u4E00\u4E2A\u3002Key \u5B58\u5728\u63D2\u4EF6\u81EA\u5DF1\u7684\u6587\u4EF6\u91CC\u3002"
		      ),
		      keyRows.length === 0 ? (0, import_react.createElement)(
		        "div",
		        { style: mutedStyle },
		        "\u5C1A\u672A\u6DFB\u52A0 Key\u3002\u5728\u4E0B\u9762\u7C98\u8D34\u4E00\u4E2A\uFF0C\u6216\u628A Key \u5199\u8FDB $DSH_HOME/.credentials.yaml\uFF08\u4E0B\u6B21\u6253\u5F00\u672C\u9875\u9762\u4F1A\u81EA\u52A8\u5BFC\u5165\uFF09\u3002"
		      ) : (0, import_react.createElement)(
		        "div",
		        { style: { display: "flex", flexDirection: "column", gap: "6px" } },
		        ...keyRows.map((row) => (0, import_react.createElement)(
		          "div",
		          {
		            key: row.id,
		            style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }
		          },
		          (0, import_react.createElement)("input", {
		            type: "radio",
		            name: "dsh-image-gen-active-key",
		            checked: row.active === true,
		            title: "\u8BBE\u4E3A\u5F53\u524D\u4F7F\u7528\u7684 Key",
		            onChange: () => {
		              void keyAction({ action: "setActive", id: row.id });
		            }
		          }),
		          (0, import_react.createElement)("code", { style: { fontFamily: "monospace" } }, row.hint),
		          row.name.length > 0 ? (0, import_react.createElement)("span", { style: mutedStyle }, row.name) : null,
		          row.active === true ? (0, import_react.createElement)("span", { style: { ...mutedStyle, color: "inherit" } }, "\u2190 \u5F53\u524D") : null,
		          row.lastError !== void 0 ? (0, import_react.createElement)(
		            "span",
		            { style: { ...mutedStyle, color: "var(--dsw-alias-text-warning, orange)" } },
		            `\u4E0A\u6B21\u5931\u8D25\uFF1A${row.lastError}`
		          ) : null,
		          (0, import_react.createElement)("button", {
		            type: "button",
		            style: { ...buttonStyle, padding: "2px 8px", fontSize: "0.9em" },
		            title: "\u5220\u9664\u8FD9\u4E00\u4E2A Key",
		            onClick: () => {
		              void keyAction({ action: "remove", id: row.id });
		            }
		          }, "\u5220\u9664\u8FD9\u4E00\u4E2A")
		        ))
		      ),
		      (0, import_react.createElement)(
		        "div",
		        { style: fieldStyle },
		        (0, import_react.createElement)("input", {
		          style: { ...controlStyle, flex: "0 1 140px", minWidth: "100px" },
		          value: newKey.name,
		          placeholder: "\u5907\u6CE8\uFF08\u53EF\u9009\uFF09",
		          spellCheck: false,
		          onChange: (event) => setNewKey((prev) => ({ ...prev, name: event.target.value }))
		        }),
		        (0, import_react.createElement)("input", {
		          style: controlStyle,
		          value: newKey.value,
		          placeholder: "\u7C98\u8D34 API Key",
		          spellCheck: false,
		          type: "password",
		          onChange: (event) => setNewKey((prev) => ({ ...prev, value: event.target.value }))
		        }),
		        (0, import_react.createElement)("button", {
		          type: "button",
		          style: buttonStyle,
		          disabled: keys.status === "busy" || newKey.value.trim().length === 0,
		          onClick: async () => {
		            await keyAction({ action: "add", name: newKey.name, value: newKey.value });
		            setNewKey({ name: "", value: "" });
		          }
		        }, "\u4FDD\u5B58 Key")
		      ),
		      (0, import_react.createElement)(
		        "div",
		        { style: fieldStyle },
		        (0, import_react.createElement)("button", {
		          type: "button",
		          style: buttonStyle,
		          disabled: keys.status === "busy" || keyRows.length === 0,
		          onClick: () => {
		            void keyAction({ action: "test" });
		          }
		        }, "\u6D4B\u8BD5\u5168\u90E8 Key"),
		        (0, import_react.createElement)("button", {
		          type: "button",
		          style: buttonStyle,
		          disabled: keys.status === "busy" || keyRows.length === 0,
		          onClick: () => {
		            void keyAction({ action: "clear" });
		          }
		        }, "\u6E05\u7A7A\u5168\u90E8"),
		        keys.status === "busy" ? (0, import_react.createElement)("span", { style: mutedStyle }, "\u5904\u7406\u4E2D\u2026") : null
		      ),
		      keys.message !== void 0 && keys.message.length > 0 ? (0, import_react.createElement)("div", { style: mutedStyle }, keys.message) : null,
		      keys.status === "error" ? (0, import_react.createElement)("div", { style: mutedStyle }, `Key \u64CD\u4F5C\u5931\u8D25\uFF1A${keys.message}`) : null
		    );
		    return (0, import_react.createElement)(
		      "div",
		      { style: rowStyle },
		      head,
		      (0, import_react.createElement)(
		        "div",
		        { style: mutedStyle },
		        `\u5F53\u524D\u5382\u5546 ${data.providerName}\uFF08${data.provider}\uFF09\uFF5C\u8F93\u51FA\u76EE\u5F55 ${data.outputDir}`
		      ),
		      (data.providers?.length ?? 0) > 1 ? (0, import_react.createElement)(
		        "div",
		        { style: fieldStyle },
		        (0, import_react.createElement)("span", { style: labelStyle }, "\u5382\u5546"),
		        (0, import_react.createElement)(
		          "select",
		          {
		            style: controlStyle,
		            value: draft.provider,
		            onChange: (event) => {
		              const id = event.target.value;
		              setDraft((prev) => ({ ...prev, provider: id, model: "" }));
		              setModels({ status: "idle" });
		              void loadKeys(id);
		            }
		          },
		          ...data.providers.map((p) => (0, import_react.createElement)("option", {
		            key: p.id,
		            value: p.id
		          }, `${p.displayName}\uFF08${p.id}\uFF09${p.problem === void 0 ? "" : " \u26A0 \u914D\u7F6E\u4E0D\u5B8C\u6574"}`))
		        ),
		        (0, import_react.createElement)("span", { style: mutedStyle }, "\u5207\u6362\u540E\u9700\u4FDD\u5B58")
		      ) : null,
		      keyArea,
		      (0, import_react.createElement)(
		        "div",
		        { style: fieldStyle },
		        (0, import_react.createElement)("span", { style: labelStyle }, "\u9ED8\u8BA4\u6A21\u578B"),
		        (0, import_react.createElement)("input", {
		          style: controlStyle,
		          value: draft.model,
		          placeholder: data.builtinModel,
		          spellCheck: false,
		          onChange: (event) => setDraft((prev) => ({ ...prev, model: event.target.value }))
		        })
		      ),
		      (0, import_react.createElement)(
		        "div",
		        { style: fieldStyle },
		        (0, import_react.createElement)("button", {
		          type: "button",
		          style: buttonStyle,
		          disabled: models.status === "loading",
		          onClick: () => {
		            void onFetchModels(false);
		          }
		        }, "\u83B7\u53D6\u6A21\u578B\u5217\u8868"),
		        (0, import_react.createElement)("button", {
		          type: "button",
		          style: buttonStyle,
		          disabled: models.status === "loading",
		          onClick: () => {
		            void onFetchModels(true);
		          }
		        }, "\u83B7\u53D6\u5E76\u7B5B\u9009\u53EF\u7528\u751F\u56FE\u6A21\u578B")
		      ),
		      modelArea,
		      (0, import_react.createElement)(
		        "div",
		        { style: fieldStyle },
		        (0, import_react.createElement)("span", { style: labelStyle }, "\u9ED8\u8BA4\u5C3A\u5BF8"),
		        (0, import_react.createElement)("input", {
		          style: controlStyle,
		          value: draft.imageSize,
		          placeholder: "1024x1024",
		          spellCheck: false,
		          onChange: (event) => setDraft((prev) => ({ ...prev, imageSize: event.target.value }))
		        })
		      ),
		      (0, import_react.createElement)(
		        "div",
		        { style: fieldStyle },
		        (0, import_react.createElement)("button", {
		          type: "button",
		          style: buttonStyle,
		          disabled: save.status === "saving",
		          onClick: () => {
		            void onSave();
		          }
		        }, "\u4FDD\u5B58"),
		        saveText.length > 0 ? (0, import_react.createElement)("span", { style: mutedStyle }, saveText) : null
		      )
		    );
		  }
		  function apply(ctx) {
		    ctx.slots.inject("settings.models.footer", () => ctx.slots.register({
		      name: "settings.models.footer",
		      id: "dsh-image-gen",
		      order: 100,
		      label: "\u751F\u56FE"
		    }, ImageGenRow));
		  }
		  return __toCommonJS(index_exports);
		})();
		return __dshImageGen;
		
	}
});
