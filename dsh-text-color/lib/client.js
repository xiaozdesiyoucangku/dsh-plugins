window.__ModuleLoader__.load({
	id: "dsh-text-color",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		const { jsx, jsxs } = require("react/jsx-runtime");

		//#region text slots
		/**
		 * The text-bearing alias tokens this feature exposes. Every entry is a
		 * label/state token that the design system uses as `color:` — none of them
		 * is a background, border or surface token, so overriding them cannot
		 * disturb a background plugin's work.
		 *
		 * `def` records the built-in palette's resolved value; it seeds the editor
		 * and backs "restore defaults" (which retracts the override entirely, so
		 * the underlying theme — built-in or third-party — wins again).
		 */
		const SLOTS = [
			{ id: "primary", token: "--dsw-alias-label-primary", zh: "正文 / 主文字", en: "Body / primary text", def: { light: "#0f1115", dark: "#f9fafb" } },
			{ id: "secondary", token: "--dsw-alias-label-secondary", zh: "次要文字", en: "Secondary text", def: { light: "#61666b", dark: "#cfd3d6" } },
			{ id: "tertiary", token: "--dsw-alias-label-tertiary", zh: "提示文字", en: "Tertiary text", def: { light: "#81858c", dark: "#adb2b8" } },
			{ id: "caption", token: "--dsw-alias-label-caption", zh: "极小标注", en: "Caption", def: { light: "#adb2b8", dark: "#81858c" } },
			{ id: "business", token: "--dsw-alias-state-business-primary", zh: "链接 / 引用", en: "Link / reference", def: { light: "#4176e6", dark: "#7aaaff" } },
			{ id: "error", token: "--dsw-alias-state-error-primary", zh: "报错", en: "Error", def: { light: "#ec1313", dark: "#f25a5a" } }
		];
		/** Layer identity for `ctx.theme.overrideTokens`; one layer per source. */
		const SOURCE = "dsh-text-color";
		/** Browser-local persistence key for the override table. */
		const STORAGE_KEY = "dsh.text-color.overrides";
		/** Dictionary namespace owned by this plugin. */
		const NS = "settings.textColor";
		/** Required cordis services: slots and locale to mount the row, theme to fold tokens in. */
		const inject = ["slots", "locale", "theme"];
		//#endregion

		//#region color math
		function clamp(value, lo, hi) {
			return Math.min(hi, Math.max(lo, value));
		}
		function hexToRgb(hex) {
			const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
			if (m === null) return null;
			const n = Number.parseInt(m[1], 16);
			return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
		}
		function rgbToHex(r, g, b) {
			const to = (v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0");
			return "#" + to(r) + to(g) + to(b);
		}
		function rgbToHsl(r, g, b) {
			r /= 255; g /= 255; b /= 255;
			const max = Math.max(r, g, b);
			const min = Math.min(r, g, b);
			const l = (max + min) / 2;
			const d = max - min;
			if (d === 0) return { h: 0, s: 0, l: l * 100 };
			const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
			let h;
			if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
			else if (max === g) h = ((b - r) / d + 2) / 6;
			else h = ((r - g) / d + 4) / 6;
			return { h: h * 360, s: s * 100, l: l * 100 };
		}
		function hslToRgb(h, s, l) {
			h = ((h % 360) + 360) % 360 / 360;
			s = clamp(s, 0, 100) / 100;
			l = clamp(l, 0, 100) / 100;
			if (s === 0) {
				const v = l * 255;
				return { r: v, g: v, b: v };
			}
			const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
			const p = 2 * l - q;
			const hue = (t) => {
				if (t < 0) t += 1;
				if (t > 1) t -= 1;
				if (t < 1 / 6) return p + (q - p) * 6 * t;
				if (t < 1 / 2) return q;
				if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
				return p;
			};
			return { r: hue(h + 1 / 3) * 255, g: hue(h) * 255, b: hue(h - 1 / 3) * 255 };
		}
		/** Read a hex string as HSL, falling back to mid grey when unparsable. */
		function hexToHsl(hex) {
			const rgb = hexToRgb(hex);
			return rgb === null ? { h: 0, s: 0, l: 50 } : rgbToHsl(rgb.r, rgb.g, rgb.b);
		}
		function hslToHex(h, s, l) {
			const rgb = hslToRgb(h, s, l);
			return rgbToHex(rgb.r, rgb.g, rgb.b);
		}
		//#endregion

		//#region dictionaries
		const zh = {
			primary: "正文 / 主文字",
			secondary: "次要文字",
			tertiary: "提示文字",
			caption: "极小标注",
			business: "链接 / 引用",
			error: "报错",
			title: "文字颜色",
			description: "只改文字，不动背景、边框与卡片；背景插件不受影响。",
			light: "浅色主题",
			dark: "深色主题",
			hue: "色相",
			sat: "饱和",
			lightness: "明度",
			reset: "恢复默认",
			resetHint: "撤回全部覆盖，交还给当前主题。",
			unavailable: "主题服务不可用，暂时无法应用颜色。",
			note: "深浅两套配色需分别调整：官方要求每个 token 同时给出两种色板的值，否则切换主题后会看不清。"
		};
		const en = {
			primary: "Body / primary text",
			secondary: "Secondary text",
			tertiary: "Tertiary text",
			caption: "Caption",
			business: "Link / reference",
			error: "Error",
			title: "Text colors",
			description: "Recolors text only — backgrounds, borders and cards stay untouched, so a background plugin is unaffected.",
			light: "Light theme",
			dark: "Dark theme",
			hue: "Hue",
			sat: "Saturation",
			lightness: "Lightness",
			reset: "Restore defaults",
			resetHint: "Retracts every override and hands the palette back to the active theme.",
			unavailable: "The theme service is unavailable, so colors cannot be applied right now.",
			note: "Light and dark are edited separately: the official API requires both values per token, or the text goes illegible after a theme switch."
		};
		//#endregion

		//#region styles
		const CSS = `
.dtc-row{border-bottom:.5px solid var(--dsw-alias-border-l2);flex-direction:column;gap:10px;padding:16px 0;display:flex}
.dtc-head{flex-direction:column;gap:4px;display:flex}
.dtc-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}
.dtc-desc{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px}
.dtc-note{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dtc-warn{color:var(--dsw-alias-state-warn-primary);font-size:12px;line-height:18px}
.dtc-palette{align-items:center;gap:6px;display:flex}
.dtc-pbtn{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:0 0;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:5px 12px;font:inherit;font-size:13px;line-height:20px}
.dtc-pbtn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dtc-pbtn-on{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);border-color:var(--dsw-static-neutral-bluish-400)}
.dtc-slot{border-top:.5px solid var(--dsw-alias-border-l2);flex-direction:column;gap:6px;padding:10px 0 2px;display:flex}
.dtc-slot:first-of-type{border-top:none}
.dtc-slothead{align-items:center;gap:8px;display:flex}
.dtc-chip{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-xs);width:16px;height:16px;flex:none}
.dtc-name{color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;flex:1;min-width:0}
.dtc-hex{color:var(--dsw-alias-label-secondary);font-family:var(--ds-font-family-code);font-size:12px}
.dtc-line{align-items:center;gap:8px;display:flex}
.dtc-lab{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;width:32px;flex:none}
.dtc-num{color:var(--dsw-alias-label-secondary);font-size:11px;font-variant-numeric:tabular-nums;width:34px;text-align:right;flex:none}
.dtc-range{-webkit-appearance:none;appearance:none;border-radius:999px;height:10px;flex:1;min-width:0;border:.5px solid var(--dsw-alias-border-l3);cursor:pointer}
.dtc-range::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;border-radius:50%;background:var(--dsw-static-neutral-bluish-00);border:1px solid var(--dsw-alias-border-l3);width:14px;height:14px;cursor:pointer;box-shadow:var(--dsw-shadow-lv1)}
.dtc-foot{align-items:center;gap:10px;padding-top:10px;display:flex}
.dtc-reset{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:0 0;color:var(--dsw-alias-label-primary);cursor:pointer;padding:6px 14px;font:inherit;font-size:13px;line-height:20px}
.dtc-reset:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dtc-foothint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
`;
		//#endregion

		//#region state
		/** Seed a full override table from the built-in defaults. */
		function defaultValues() {
			const out = {};
			for (const slot of SLOTS) out[slot.id] = { light: slot.def.light, dark: slot.def.dark };
			return out;
		}
		/** Read the persisted table, ignoring corrupt or partial entries. */
		function loadValues() {
			const values = defaultValues();
			let stored = null;
			try {
				const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(STORAGE_KEY);
				if (raw !== null) stored = JSON.parse(raw);
			} catch {
				stored = null;
			}
			if (typeof stored !== "object" || stored === null) return values;
			for (const slot of SLOTS) {
				const entry = stored[slot.id];
				if (entry === null || typeof entry !== "object") continue;
				if (typeof entry.light !== "string" || typeof entry.dark !== "string") continue;
				if (hexToRgb(entry.light) === null || hexToRgb(entry.dark) === null) continue;
				values[slot.id] = { light: entry.light, dark: entry.dark };
			}
			return values;
		}
		/** Persist the table; a storage failure must not break the live preview. */
		function saveValues(values) {
			try {
				if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, JSON.stringify(values));
			} catch {
				/* private mode or quota — the override still applies for this session */
			}
		}
		/** Forget the persisted table. */
		function clearValues() {
			try {
				if (typeof localStorage !== "undefined") localStorage.removeItem(STORAGE_KEY);
			} catch {
				/* nothing to forget */
			}
		}
		/** True when the table differs from the built-in defaults in any slot. */
		function isCustomised(values) {
			for (const slot of SLOTS) {
				const entry = values[slot.id];
				if (entry.light !== slot.def.light || entry.dark !== slot.def.dark) return true;
			}
			return false;
		}
		/**
		 * Resolve the theme service. Declared as a required injection, but the
		 * lookup stays defensive so a composition without ui-theme degrades to a
		 * visible notice instead of a load failure.
		 */
		function themeService(ctx) {
			try {
				if (ctx.theme !== void 0 && typeof ctx.theme.overrideTokens === "function") return ctx.theme;
				if (typeof ctx.get === "function") {
					const viaGet = ctx.get("theme");
					if (viaGet !== void 0 && typeof viaGet.overrideTokens === "function") return viaGet;
				}
			} catch {
				/* fall through to null */
			}
			return null;
		}
		//#endregion

		//#region row component
		/**
		 * Build the settings row component for one plugin instance.
		 *
		 * The component owns its draft state and pushes every change straight into
		 * the theme override layer, so the palette updates while the sliders move
		 * and the values survive a reload through localStorage.
		 *
		 * @param ctx - client context, closed over for the theme service lookup.
		 * @param runtime - mutable holder for the current override disposer.
		 * @returns the row component.
		 */
		function makeRow(ctx, runtime) {
			/** Fold the whole table into the active theme as one override layer. */
			function push(values) {
				const theme = themeService(ctx);
				if (theme === null) return false;
				const tokens = {};
				for (const slot of SLOTS) {
					tokens[slot.token] = { light: values[slot.id].light, dark: values[slot.id].dark };
				}
				try {
					runtime.disposer = theme.overrideTokens(SOURCE, tokens);
					return true;
				} catch {
					return false;
				}
			}
			/** Retract the layer, letting the underlying theme's own values return. */
			function retract() {
				if (runtime.disposer === null) return;
				try {
					runtime.disposer();
				} catch {
					/* already retracted */
				}
				runtime.disposer = null;
			}
			return function TextColorRow({ t }) {
				const [palette, setPalette] = React.useState("light");
				const [values, setValues] = React.useState(loadValues);
				const [failed, setFailed] = React.useState(() => themeService(ctx) === null);
				// Set by `reset` so the effect below does not immediately re-push the
				// built-in defaults as an override layer, which would defeat the
				// retraction and pin the palette the user just handed back.
				const skipPush = React.useRef(false);
				// Apply on mount and after every edit; the override layer is replaced
				// wholesale, so no teardown is needed between edits. A table that still
				// matches the built-in defaults is NOT pushed: writing those values as
				// an override would pin them over any third-party theme the user has
				// active, which is the opposite of "restore defaults" semantics.
				React.useEffect(() => {
					if (skipPush.current) {
						skipPush.current = false;
						return;
					}
					if (!isCustomised(values)) {
						retract();
						setFailed(themeService(ctx) === null);
						return;
					}
					if (!push(values)) setFailed(true);
					else setFailed(false);
				}, [values]);
				const edit = (id, channel, next) => {
					setValues((prev) => {
						const merged = {};
						for (const slot of SLOTS) merged[slot.id] = { light: prev[slot.id].light, dark: prev[slot.id].dark };
						merged[id][palette] = next;
						saveValues(merged);
						return merged;
					});
				};
				const reset = () => {
					retract();
					clearValues();
					skipPush.current = true;
					setValues(defaultValues());
				};
				const rows = SLOTS.map((slot) => {
					const hex = values[slot.id][palette];
					const hsl = hexToHsl(hex);
					const swatch = {
						background: hex,
						backgroundImage: "linear-gradient(" + hex + "," + hex + ")"
					};
					const hueTrack = { backgroundImage: "linear-gradient(to right,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)" };
					const satTrack = { backgroundImage: "linear-gradient(to right,hsl(" + hsl.h + ",0%," + hsl.l + "%),hsl(" + hsl.h + ",100%," + hsl.l + "%))" };
					const lightTrack = { backgroundImage: "linear-gradient(to right,#000,hsl(" + hsl.h + "," + hsl.s + "%,50%),#fff)" };
					const slider = (channel, label, max, value, track) => jsxs("div", {
						className: "dtc-line",
						children: [
							jsx("span", { className: "dtc-lab", children: label }),
							jsx("input", {
								className: "dtc-range",
								type: "range",
								min: 0,
								max,
								step: 1,
								value: Math.round(value),
								style: track,
								"aria-label": slot.id + " " + label,
								onChange: (event) => {
									const raw = Number(event.target.value);
									const next = channel === "h"
										? hslToHex(raw, hsl.s, hsl.l)
										: channel === "s"
											? hslToHex(hsl.h, raw, hsl.l)
											: hslToHex(hsl.h, hsl.s, raw);
									edit(slot.id, palette, next);
								}
							}),
							jsx("span", { className: "dtc-num", children: String(Math.round(value)) })
						]
					});
					return jsxs("div", {
						className: "dtc-slot",
						children: [
							jsxs("div", {
								className: "dtc-slothead",
								children: [
									jsx("span", { className: "dtc-chip", style: swatch }),
									jsx("span", { className: "dtc-name", children: t(slot.id) }),
									jsx("span", { className: "dtc-hex", children: hex })
								]
							}),
							slider("h", t("hue"), 360, hsl.h, hueTrack),
							slider("s", t("sat"), 100, hsl.s, satTrack),
							slider("l", t("lightness"), 100, hsl.l, lightTrack)
						]
					});
				});
				return jsxs("div", {
					className: "dtc-row",
					children: [
						jsxs("div", {
							className: "dtc-head",
							children: [
								jsx("div", { className: "dtc-title", children: t("title") }),
								jsx("div", { className: "dtc-desc", children: t("description") })
							]
						}),
						failed ? jsx("div", { className: "dtc-warn", children: t("unavailable") }) : null,
						jsxs("div", {
							className: "dtc-palette",
							children: [
								jsx("button", {
									type: "button",
									className: palette === "light" ? "dtc-pbtn dtc-pbtn-on" : "dtc-pbtn",
									onClick: () => setPalette("light"),
									children: t("light")
								}),
								jsx("button", {
									type: "button",
									className: palette === "dark" ? "dtc-pbtn dtc-pbtn-on" : "dtc-pbtn",
									onClick: () => setPalette("dark"),
									children: t("dark")
								})
							]
						}),
						...rows,
						jsx("div", { className: "dtc-note", children: t("note") }),
						jsxs("div", {
							className: "dtc-foot",
							children: [
								jsx("button", {
									type: "button",
									className: "dtc-reset",
									onClick: reset,
									children: t("reset")
								}),
								jsx("span", { className: "dtc-foothint", children: t("resetHint") })
							]
						})
					]
				});
			};
		}
		//#endregion

		//#region plugin body
		/**
		 * Client plugin body: install the row styles, register the dictionary, and
		 * mount the text-color row into the General settings section. Stored
		 * overrides are folded in immediately so a reload keeps the chosen palette
		 * without opening settings first.
		 *
		 * @param ctx - client cordis context.
		 */
		function apply(ctx) {
			const style = document.createElement("style");
			style.dataset.plugin = "dsh-text-color";
			style.textContent = CSS;
			document.head.appendChild(style);
			ctx.effect(() => () => {
				style.remove();
			}, "dsh-text-color: styles");
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-text-color: dictionaries");
			const runtime = { disposer: null };
			// Re-apply on plugin load so the stored table is live before the settings
			// page is ever opened.
			const stored = loadValues();
			const theme = themeService(ctx);
			if (theme !== null && isCustomised(stored)) {
				const tokens = {};
				for (const slot of SLOTS) {
					tokens[slot.token] = { light: stored[slot.id].light, dark: stored[slot.id].dark };
				}
				try {
					runtime.disposer = theme.overrideTokens(SOURCE, tokens);
				} catch {
					/* leave the theme untouched */
				}
			}
			ctx.effect(() => () => {
				if (runtime.disposer !== null) {
					try {
						runtime.disposer();
					} catch {
						/* already retracted */
					}
					runtime.disposer = null;
				}
			}, "dsh-text-color: override layer");
			const Row = makeRow(ctx, runtime);
			ctx.slots.inject("settings.general.item", () => ctx.slots.register({
				name: "settings.general.item",
				id: "text-color",
				order: 40,
				locale: NS
			}, Row));
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map
