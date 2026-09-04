(function() {
	//#region ../../node_modules/.pnpm/@modelcontextprotocol+client@2.0.0/node_modules/@modelcontextprotocol/client/dist/chunk-Br0eD_fh.mjs
	var __create = Object.create;
	var __defProp = Object.defineProperty;
	var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
	var __getOwnPropNames = Object.getOwnPropertyNames;
	var __getProtoOf = Object.getPrototypeOf;
	var __hasOwnProp = Object.prototype.hasOwnProperty;
	var __commonJSMin = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);
	var __exportAll = (all, symbols) => {
		let target = {};
		for (var name in all) __defProp(target, name, {
			get: all[name],
			enumerable: true
		});
		if (symbols) __defProp(target, Symbol.toStringTag, { value: "Module" });
		return target;
	};
	var __copyProps = (to, from, except, desc) => {
		if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
			key = keys[i];
			if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
				get: ((k) => from[k]).bind(null, key),
				enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
			});
		}
		return to;
	};
	var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
		value: mod,
		enumerable: true
	}) : target, mod));
	//#endregion
	//#region ../../node_modules/.pnpm/@modelcontextprotocol+client@2.0.0/node_modules/@modelcontextprotocol/client/dist/dialects-BOhdv1Fc.mjs
	/**
	* Canonical `$schema` URIs per supported dialect (http + https variants, trailing-`#` stripped).
	*/
	const DRAFT_2020_12_URIS = /* @__PURE__ */ new Set(["https://json-schema.org/draft/2020-12/schema", "http://json-schema.org/draft/2020-12/schema"]);
	const DRAFT_2019_09_URIS = /* @__PURE__ */ new Set(["https://json-schema.org/draft/2019-09/schema", "http://json-schema.org/draft/2019-09/schema"]);
	const DRAFT_07_URIS = /* @__PURE__ */ new Set(["https://json-schema.org/draft-07/schema", "http://json-schema.org/draft-07/schema"]);
	const DRAFT_06_URIS = /* @__PURE__ */ new Set(["https://json-schema.org/draft-06/schema", "http://json-schema.org/draft-06/schema"]);
	/**
	* Whether a `$schema` value declares the 2019-09 dialect — the only supported dialect with
	* `$recursiveRef`/`$recursiveAnchor`. Non-throwing (unlike {@linkcode declaredDialect}) so
	* wire-layer callers can consult it for documents whose dialect may be unsupported.
	*/
	function declares2019Dialect($schema) {
		return typeof $schema === "string" && DRAFT_2019_09_URIS.has($schema.replace(/#$/, ""));
	}
	/**
	* Classify a schema's declared `$schema` dialect. No `$schema` (or a non-string one) means
	* 2020-12. Any other dialect throws a plain `Error` with a clear message rather than letting the
	* engine crash on an opaque internal error or silently mis-validate; `remedy` names the calling
	* provider's escape hatch in that message.
	*/
	function declaredDialect(schema, remedy) {
		if (!("$schema" in schema) || typeof schema.$schema !== "string") return "2020-12";
		const declared = schema.$schema.replace(/#$/, "");
		if (DRAFT_2020_12_URIS.has(declared)) return "2020-12";
		if (DRAFT_2019_09_URIS.has(declared)) return "2019-09";
		if (DRAFT_07_URIS.has(declared) || DRAFT_06_URIS.has(declared)) return "draft-7";
		throw new Error(`JSON Schema declares an unsupported dialect ("$schema": "${schema.$schema.slice(0, 200)}"). The default validator supports JSON Schema 2020-12, 2019-09, draft-07, and draft-06; ${remedy}`);
	}
	//#endregion
	//#region ../../node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/core/core.js
	var _a$1;
	/** A special constant with type `never` */
	const NEVER = /*@__PURE__*/ Object.freeze({ status: "aborted" });
	function $constructor(name, initializer, params) {
		function init(inst, def) {
			if (!inst._zod) Object.defineProperty(inst, "_zod", {
				value: {
					def,
					constr: _,
					traits: /* @__PURE__ */ new Set()
				},
				enumerable: false
			});
			if (inst._zod.traits.has(name)) return;
			inst._zod.traits.add(name);
			initializer(inst, def);
			const proto = _.prototype;
			const keys = Object.keys(proto);
			for (let i = 0; i < keys.length; i++) {
				const k = keys[i];
				if (!(k in inst)) inst[k] = proto[k].bind(inst);
			}
		}
		const Parent = params?.Parent ?? Object;
		class Definition extends Parent {}
		Object.defineProperty(Definition, "name", { value: name });
		function _(def) {
			var _a;
			const inst = params?.Parent ? new Definition() : this;
			init(inst, def);
			(_a = inst._zod).deferred ?? (_a.deferred = []);
			for (const fn of inst._zod.deferred) fn();
			return inst;
		}
		Object.defineProperty(_, "init", { value: init });
		Object.defineProperty(_, Symbol.hasInstance, { value: (inst) => {
			if (params?.Parent && inst instanceof params.Parent) return true;
			return inst?._zod?.traits?.has(name);
		} });
		Object.defineProperty(_, "name", { value: name });
		return _;
	}
	var $ZodAsyncError = class extends Error {
		constructor() {
			super(`Encountered Promise during synchronous parse. Use .parseAsync() instead.`);
		}
	};
	var $ZodEncodeError = class extends Error {
		constructor(name) {
			super(`Encountered unidirectional transform during encode: ${name}`);
			this.name = "ZodEncodeError";
		}
	};
	(_a$1 = globalThis).__zod_globalConfig ?? (_a$1.__zod_globalConfig = {});
	const globalConfig = globalThis.__zod_globalConfig;
	function config(newConfig) {
		if (newConfig) Object.assign(globalConfig, newConfig);
		return globalConfig;
	}
	//#endregion
	//#region ../../node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/core/util.js
	function getEnumValues(entries) {
		const numericValues = Object.values(entries).filter((v) => typeof v === "number");
		return Object.entries(entries).filter(([k, _]) => numericValues.indexOf(+k) === -1).map(([_, v]) => v);
	}
	function jsonStringifyReplacer(_, value) {
		if (typeof value === "bigint") return value.toString();
		return value;
	}
	function cached(getter) {
		return { get value() {
			{
				const value = getter();
				Object.defineProperty(this, "value", { value });
				return value;
			}
		} };
	}
	function nullish(input) {
		return input === null || input === void 0;
	}
	function cleanRegex(source) {
		const start = source.startsWith("^") ? 1 : 0;
		const end = source.endsWith("$") ? source.length - 1 : source.length;
		return source.slice(start, end);
	}
	function floatSafeRemainder(val, step) {
		const ratio = val / step;
		const roundedRatio = Math.round(ratio);
		const tolerance = Number.EPSILON * Math.max(Math.abs(ratio), 1);
		if (Math.abs(ratio - roundedRatio) < tolerance) return 0;
		return ratio - roundedRatio;
	}
	const EVALUATING = /* @__PURE__*/ Symbol("evaluating");
	function defineLazy(object, key, getter) {
		let value = void 0;
		Object.defineProperty(object, key, {
			get() {
				if (value === EVALUATING) return;
				if (value === void 0) {
					value = EVALUATING;
					value = getter();
				}
				return value;
			},
			set(v) {
				Object.defineProperty(object, key, { value: v });
			},
			configurable: true
		});
	}
	function assignProp(target, prop, value) {
		Object.defineProperty(target, prop, {
			value,
			writable: true,
			enumerable: true,
			configurable: true
		});
	}
	function mergeDefs(...defs) {
		const mergedDescriptors = {};
		for (const def of defs) {
			const descriptors = Object.getOwnPropertyDescriptors(def);
			Object.assign(mergedDescriptors, descriptors);
		}
		return Object.defineProperties({}, mergedDescriptors);
	}
	function esc(str) {
		return JSON.stringify(str);
	}
	function slugify(input) {
		return input.toLowerCase().trim().replace(/[^\w\s-]/g, "").replace(/[\s_-]+/g, "-").replace(/^-+|-+$/g, "");
	}
	const captureStackTrace = "captureStackTrace" in Error ? Error.captureStackTrace : (..._args) => {};
	function isObject(data) {
		return typeof data === "object" && data !== null && !Array.isArray(data);
	}
	const allowsEval = /* @__PURE__*/ cached(() => {
		if (globalConfig.jitless) return false;
		if (typeof navigator !== "undefined" && navigator?.userAgent?.includes("Cloudflare")) return false;
		try {
			new Function("");
			return true;
		} catch (_) {
			return false;
		}
	});
	function isPlainObject$5(o) {
		if (isObject(o) === false) return false;
		const ctor = o.constructor;
		if (ctor === void 0) return true;
		if (typeof ctor !== "function") return true;
		const prot = ctor.prototype;
		if (isObject(prot) === false) return false;
		if (Object.prototype.hasOwnProperty.call(prot, "isPrototypeOf") === false) return false;
		return true;
	}
	function shallowClone(o) {
		if (isPlainObject$5(o)) return { ...o };
		if (Array.isArray(o)) return [...o];
		if (o instanceof Map) return new Map(o);
		if (o instanceof Set) return new Set(o);
		return o;
	}
	const propertyKeyTypes = /* @__PURE__*/ new Set([
		"string",
		"number",
		"symbol"
	]);
	function escapeRegex(str) {
		return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}
	function clone(inst, def, params) {
		const cl = new inst._zod.constr(def ?? inst._zod.def);
		if (!def || params?.parent) cl._zod.parent = inst;
		return cl;
	}
	function normalizeParams(_params) {
		const params = _params;
		if (!params) return {};
		if (typeof params === "string") return { error: () => params };
		if (params?.message !== void 0) {
			if (params?.error !== void 0) throw new Error("Cannot specify both `message` and `error` params");
			params.error = params.message;
		}
		delete params.message;
		if (typeof params.error === "string") return {
			...params,
			error: () => params.error
		};
		return params;
	}
	function optionalKeys(shape) {
		return Object.keys(shape).filter((k) => {
			return shape[k]._zod.optin === "optional" && shape[k]._zod.optout === "optional";
		});
	}
	const NUMBER_FORMAT_RANGES = {
		safeint: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
		int32: [-2147483648, 2147483647],
		uint32: [0, 4294967295],
		float32: [-34028234663852886e22, 34028234663852886e22],
		float64: [-Number.MAX_VALUE, Number.MAX_VALUE]
	};
	function pick(schema, mask) {
		const currDef = schema._zod.def;
		const checks = currDef.checks;
		if (checks && checks.length > 0) throw new Error(".pick() cannot be used on object schemas containing refinements");
		return clone(schema, mergeDefs(schema._zod.def, {
			get shape() {
				const newShape = {};
				for (const key in mask) {
					if (!(key in currDef.shape)) throw new Error(`Unrecognized key: "${key}"`);
					if (!mask[key]) continue;
					newShape[key] = currDef.shape[key];
				}
				assignProp(this, "shape", newShape);
				return newShape;
			},
			checks: []
		}));
	}
	function omit(schema, mask) {
		const currDef = schema._zod.def;
		const checks = currDef.checks;
		if (checks && checks.length > 0) throw new Error(".omit() cannot be used on object schemas containing refinements");
		return clone(schema, mergeDefs(schema._zod.def, {
			get shape() {
				const newShape = { ...schema._zod.def.shape };
				for (const key in mask) {
					if (!(key in currDef.shape)) throw new Error(`Unrecognized key: "${key}"`);
					if (!mask[key]) continue;
					delete newShape[key];
				}
				assignProp(this, "shape", newShape);
				return newShape;
			},
			checks: []
		}));
	}
	function extend(schema, shape) {
		if (!isPlainObject$5(shape)) throw new Error("Invalid input to extend: expected a plain object");
		const checks = schema._zod.def.checks;
		if (checks && checks.length > 0) {
			const existingShape = schema._zod.def.shape;
			for (const key in shape) if (Object.getOwnPropertyDescriptor(existingShape, key) !== void 0) throw new Error("Cannot overwrite keys on object schemas containing refinements. Use `.safeExtend()` instead.");
		}
		return clone(schema, mergeDefs(schema._zod.def, { get shape() {
			const _shape = {
				...schema._zod.def.shape,
				...shape
			};
			assignProp(this, "shape", _shape);
			return _shape;
		} }));
	}
	function safeExtend(schema, shape) {
		if (!isPlainObject$5(shape)) throw new Error("Invalid input to safeExtend: expected a plain object");
		return clone(schema, mergeDefs(schema._zod.def, { get shape() {
			const _shape = {
				...schema._zod.def.shape,
				...shape
			};
			assignProp(this, "shape", _shape);
			return _shape;
		} }));
	}
	function merge(a, b) {
		if (a._zod.def.checks?.length) throw new Error(".merge() cannot be used on object schemas containing refinements. Use .safeExtend() instead.");
		return clone(a, mergeDefs(a._zod.def, {
			get shape() {
				const _shape = {
					...a._zod.def.shape,
					...b._zod.def.shape
				};
				assignProp(this, "shape", _shape);
				return _shape;
			},
			get catchall() {
				return b._zod.def.catchall;
			},
			checks: b._zod.def.checks ?? []
		}));
	}
	function partial(Class, schema, mask) {
		const checks = schema._zod.def.checks;
		if (checks && checks.length > 0) throw new Error(".partial() cannot be used on object schemas containing refinements");
		return clone(schema, mergeDefs(schema._zod.def, {
			get shape() {
				const oldShape = schema._zod.def.shape;
				const shape = { ...oldShape };
				if (mask) for (const key in mask) {
					if (!(key in oldShape)) throw new Error(`Unrecognized key: "${key}"`);
					if (!mask[key]) continue;
					shape[key] = Class ? new Class({
						type: "optional",
						innerType: oldShape[key]
					}) : oldShape[key];
				}
				else for (const key in oldShape) shape[key] = Class ? new Class({
					type: "optional",
					innerType: oldShape[key]
				}) : oldShape[key];
				assignProp(this, "shape", shape);
				return shape;
			},
			checks: []
		}));
	}
	function required(Class, schema, mask) {
		return clone(schema, mergeDefs(schema._zod.def, { get shape() {
			const oldShape = schema._zod.def.shape;
			const shape = { ...oldShape };
			if (mask) for (const key in mask) {
				if (!(key in shape)) throw new Error(`Unrecognized key: "${key}"`);
				if (!mask[key]) continue;
				shape[key] = new Class({
					type: "nonoptional",
					innerType: oldShape[key]
				});
			}
			else for (const key in oldShape) shape[key] = new Class({
				type: "nonoptional",
				innerType: oldShape[key]
			});
			assignProp(this, "shape", shape);
			return shape;
		} }));
	}
	function aborted(x, startIndex = 0) {
		if (x.aborted === true) return true;
		for (let i = startIndex; i < x.issues.length; i++) if (x.issues[i]?.continue !== true) return true;
		return false;
	}
	function explicitlyAborted(x, startIndex = 0) {
		if (x.aborted === true) return true;
		for (let i = startIndex; i < x.issues.length; i++) if (x.issues[i]?.continue === false) return true;
		return false;
	}
	function prefixIssues(path, issues) {
		return issues.map((iss) => {
			var _a;
			(_a = iss).path ?? (_a.path = []);
			iss.path.unshift(path);
			return iss;
		});
	}
	function unwrapMessage(message) {
		return typeof message === "string" ? message : message?.message;
	}
	function finalizeIssue(iss, ctx, config) {
		const message = iss.message ? iss.message : unwrapMessage(iss.inst?._zod.def?.error?.(iss)) ?? unwrapMessage(ctx?.error?.(iss)) ?? unwrapMessage(config.customError?.(iss)) ?? unwrapMessage(config.localeError?.(iss)) ?? "Invalid input";
		const { inst: _inst, continue: _continue, input: _input, ...rest } = iss;
		rest.path ?? (rest.path = []);
		rest.message = message;
		if (ctx?.reportInput) rest.input = _input;
		return rest;
	}
	function getLengthableOrigin(input) {
		if (Array.isArray(input)) return "array";
		if (typeof input === "string") return "string";
		return "unknown";
	}
	function issue(...args) {
		const [iss, input, inst] = args;
		if (typeof iss === "string") return {
			message: iss,
			code: "custom",
			input,
			inst
		};
		return { ...iss };
	}
	//#endregion
	//#region ../../node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/core/errors.js
	const initializer$1 = (inst, def) => {
		inst.name = "$ZodError";
		Object.defineProperty(inst, "_zod", {
			value: inst._zod,
			enumerable: false
		});
		Object.defineProperty(inst, "issues", {
			value: def,
			enumerable: false
		});
		inst.message = JSON.stringify(def, jsonStringifyReplacer, 2);
		Object.defineProperty(inst, "toString", {
			value: () => inst.message,
			enumerable: false
		});
	};
	const $ZodError = $constructor("$ZodError", initializer$1);
	const $ZodRealError = $constructor("$ZodError", initializer$1, { Parent: Error });
	function flattenError(error, mapper = (issue) => issue.message) {
		const fieldErrors = {};
		const formErrors = [];
		for (const sub of error.issues) if (sub.path.length > 0) {
			fieldErrors[sub.path[0]] = fieldErrors[sub.path[0]] || [];
			fieldErrors[sub.path[0]].push(mapper(sub));
		} else formErrors.push(mapper(sub));
		return {
			formErrors,
			fieldErrors
		};
	}
	function formatError(error, mapper = (issue) => issue.message) {
		const fieldErrors = { _errors: [] };
		const processError = (error, path = []) => {
			for (const issue of error.issues) if (issue.code === "invalid_union" && issue.errors.length) issue.errors.map((issues) => processError({ issues }, [...path, ...issue.path]));
			else if (issue.code === "invalid_key") processError({ issues: issue.issues }, [...path, ...issue.path]);
			else if (issue.code === "invalid_element") processError({ issues: issue.issues }, [...path, ...issue.path]);
			else {
				const fullpath = [...path, ...issue.path];
				if (fullpath.length === 0) fieldErrors._errors.push(mapper(issue));
				else {
					let curr = fieldErrors;
					let i = 0;
					while (i < fullpath.length) {
						const el = fullpath[i];
						if (!(i === fullpath.length - 1)) curr[el] = curr[el] || { _errors: [] };
						else {
							curr[el] = curr[el] || { _errors: [] };
							curr[el]._errors.push(mapper(issue));
						}
						curr = curr[el];
						i++;
					}
				}
			}
		};
		processError(error);
		return fieldErrors;
	}
	//#endregion
	//#region ../../node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/core/parse.js
	const _parse = (_Err) => (schema, value, _ctx, _params) => {
		const ctx = _ctx ? {
			..._ctx,
			async: false
		} : { async: false };
		const result = schema._zod.run({
			value,
			issues: []
		}, ctx);
		if (result instanceof Promise) throw new $ZodAsyncError();
		if (result.issues.length) {
			const e = new ((_params?.Err) ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
			captureStackTrace(e, _params?.callee);
			throw e;
		}
		return result.value;
	};
	const _parseAsync = (_Err) => async (schema, value, _ctx, params) => {
		const ctx = _ctx ? {
			..._ctx,
			async: true
		} : { async: true };
		let result = schema._zod.run({
			value,
			issues: []
		}, ctx);
		if (result instanceof Promise) result = await result;
		if (result.issues.length) {
			const e = new ((params?.Err) ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
			captureStackTrace(e, params?.callee);
			throw e;
		}
		return result.value;
	};
	const _safeParse = (_Err) => (schema, value, _ctx) => {
		const ctx = _ctx ? {
			..._ctx,
			async: false
		} : { async: false };
		const result = schema._zod.run({
			value,
			issues: []
		}, ctx);
		if (result instanceof Promise) throw new $ZodAsyncError();
		return result.issues.length ? {
			success: false,
			error: new (_Err ?? $ZodError)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
		} : {
			success: true,
			data: result.value
		};
	};
	const safeParse$1 = /* @__PURE__*/ _safeParse($ZodRealError);
	const _safeParseAsync = (_Err) => async (schema, value, _ctx) => {
		const ctx = _ctx ? {
			..._ctx,
			async: true
		} : { async: true };
		let result = schema._zod.run({
			value,
			issues: []
		}, ctx);
		if (result instanceof Promise) result = await result;
		return result.issues.length ? {
			success: false,
			error: new _Err(result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
		} : {
			success: true,
			data: result.value
		};
	};
	const safeParseAsync$1 = /* @__PURE__*/ _safeParseAsync($ZodRealError);
	const _encode = (_Err) => (schema, value, _ctx) => {
		const ctx = _ctx ? {
			..._ctx,
			direction: "backward"
		} : { direction: "backward" };
		return _parse(_Err)(schema, value, ctx);
	};
	const _decode = (_Err) => (schema, value, _ctx) => {
		return _parse(_Err)(schema, value, _ctx);
	};
	const _encodeAsync = (_Err) => async (schema, value, _ctx) => {
		const ctx = _ctx ? {
			..._ctx,
			direction: "backward"
		} : { direction: "backward" };
		return _parseAsync(_Err)(schema, value, ctx);
	};
	const _decodeAsync = (_Err) => async (schema, value, _ctx) => {
		return _parseAsync(_Err)(schema, value, _ctx);
	};
	const _safeEncode = (_Err) => (schema, value, _ctx) => {
		const ctx = _ctx ? {
			..._ctx,
			direction: "backward"
		} : { direction: "backward" };
		return _safeParse(_Err)(schema, value, ctx);
	};
	const _safeDecode = (_Err) => (schema, value, _ctx) => {
		return _safeParse(_Err)(schema, value, _ctx);
	};
	const _safeEncodeAsync = (_Err) => async (schema, value, _ctx) => {
		const ctx = _ctx ? {
			..._ctx,
			direction: "backward"
		} : { direction: "backward" };
		return _safeParseAsync(_Err)(schema, value, ctx);
	};
	const _safeDecodeAsync = (_Err) => async (schema, value, _ctx) => {
		return _safeParseAsync(_Err)(schema, value, _ctx);
	};
	//#endregion
	//#region ../../node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/core/regexes.js
	/**
	* @deprecated CUID v1 is deprecated by its authors due to information leakage
	* (timestamps embedded in the id). Use {@link cuid2} instead.
	* See https://github.com/paralleldrive/cuid.
	*/
	const cuid = /^[cC][0-9a-z]{6,}$/;
	const cuid2 = /^[0-9a-z]+$/;
	const ulid = /^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/;
	const xid = /^[0-9a-vA-V]{20}$/;
	const ksuid = /^[A-Za-z0-9]{27}$/;
	const nanoid = /^[a-zA-Z0-9_-]{21}$/;
	/** ISO 8601-1 duration regex. Does not support the 8601-2 extensions like negative durations or fractional/negative components. */
	const duration$1 = /^P(?:(\d+W)|(?!.*W)(?=\d|T\d)(\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+([.,]\d+)?S)?)?)$/;
	/** A regex for any UUID-like identifier: 8-4-4-4-12 hex pattern */
	const guid = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
	/** Returns a regex for validating an RFC 9562/4122 UUID.
	*
	* @param version Optionally specify a version 1-8. If no version is specified, all versions are supported. */
	const uuid = (version) => {
		if (!version) return /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;
		return new RegExp(`^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-${version}[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$`);
	};
	/** Practical email validation */
	const email$1 = /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/;
	const _emoji$1 = `^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$`;
	function emoji() {
		return new RegExp(_emoji$1, "u");
	}
	const ipv4 = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
	const ipv6 = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$/;
	const cidrv4 = /^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/([0-9]|[1-2][0-9]|3[0-2])$/;
	const cidrv6 = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|::|([0-9a-fA-F]{1,4})?::([0-9a-fA-F]{1,4}:?){0,6})\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
	const base64 = /^$|^(?:[0-9a-zA-Z+/]{4})*(?:(?:[0-9a-zA-Z+/]{2}==)|(?:[0-9a-zA-Z+/]{3}=))?$/;
	const base64url = /^[A-Za-z0-9_-]*$/;
	const httpProtocol = /^https?$/;
	const e164 = /^\+[1-9]\d{6,14}$/;
	const dateSource = `(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))`;
	const date$2 = /*@__PURE__*/ new RegExp(`^${dateSource}$`);
	function timeSource(args) {
		const hhmm = `(?:[01]\\d|2[0-3]):[0-5]\\d`;
		return typeof args.precision === "number" ? args.precision === -1 ? `${hhmm}` : args.precision === 0 ? `${hhmm}:[0-5]\\d` : `${hhmm}:[0-5]\\d\\.\\d{${args.precision}}` : `${hhmm}(?::[0-5]\\d(?:\\.\\d+)?)?`;
	}
	function time$2(args) {
		return new RegExp(`^${timeSource(args)}$`);
	}
	function datetime$1(args) {
		const time = timeSource({ precision: args.precision });
		const opts = ["Z"];
		if (args.local) opts.push("");
		if (args.offset) opts.push(`([+-](?:[01]\\d|2[0-3]):[0-5]\\d)`);
		const timeRegex = `${time}(?:${opts.join("|")})`;
		return new RegExp(`^${dateSource}T(?:${timeRegex})$`);
	}
	const string$1 = (params) => {
		const regex = params ? `[\\s\\S]{${params?.minimum ?? 0},${params?.maximum ?? ""}}` : `[\\s\\S]*`;
		return new RegExp(`^${regex}$`);
	};
	const integer = /^-?\d+$/;
	const number$2 = /^-?\d+(?:\.\d+)?$/;
	const boolean$1 = /^(?:true|false)$/i;
	const _null$2 = /^null$/i;
	const lowercase = /^[^A-Z]*$/;
	const uppercase = /^[^a-z]*$/;
	//#endregion
	//#region ../../node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/core/checks.js
	const $ZodCheck = /*@__PURE__*/ $constructor("$ZodCheck", (inst, def) => {
		var _a;
		inst._zod ?? (inst._zod = {});
		inst._zod.def = def;
		(_a = inst._zod).onattach ?? (_a.onattach = []);
	});
	const numericOriginMap = {
		number: "number",
		bigint: "bigint",
		object: "date"
	};
	const $ZodCheckLessThan = /*@__PURE__*/ $constructor("$ZodCheckLessThan", (inst, def) => {
		$ZodCheck.init(inst, def);
		const origin = numericOriginMap[typeof def.value];
		inst._zod.onattach.push((inst) => {
			const bag = inst._zod.bag;
			const curr = (def.inclusive ? bag.maximum : bag.exclusiveMaximum) ?? Number.POSITIVE_INFINITY;
			if (def.value < curr) {
				if (def.inclusive) bag.maximum = def.value;
				else bag.exclusiveMaximum = def.value;
			}
		});
		inst._zod.check = (payload) => {
			if (def.inclusive ? payload.value <= def.value : payload.value < def.value) return;
			payload.issues.push({
				origin,
				code: "too_big",
				maximum: typeof def.value === "object" ? def.value.getTime() : def.value,
				input: payload.value,
				inclusive: def.inclusive,
				inst,
				continue: !def.abort
			});
		};
	});
	const $ZodCheckGreaterThan = /*@__PURE__*/ $constructor("$ZodCheckGreaterThan", (inst, def) => {
		$ZodCheck.init(inst, def);
		const origin = numericOriginMap[typeof def.value];
		inst._zod.onattach.push((inst) => {
			const bag = inst._zod.bag;
			const curr = (def.inclusive ? bag.minimum : bag.exclusiveMinimum) ?? Number.NEGATIVE_INFINITY;
			if (def.value > curr) {
				if (def.inclusive) bag.minimum = def.value;
				else bag.exclusiveMinimum = def.value;
			}
		});
		inst._zod.check = (payload) => {
			if (def.inclusive ? payload.value >= def.value : payload.value > def.value) return;
			payload.issues.push({
				origin,
				code: "too_small",
				minimum: typeof def.value === "object" ? def.value.getTime() : def.value,
				input: payload.value,
				inclusive: def.inclusive,
				inst,
				continue: !def.abort
			});
		};
	});
	const $ZodCheckMultipleOf = /*@__PURE__*/ $constructor("$ZodCheckMultipleOf", (inst, def) => {
		$ZodCheck.init(inst, def);
		inst._zod.onattach.push((inst) => {
			var _a;
			(_a = inst._zod.bag).multipleOf ?? (_a.multipleOf = def.value);
		});
		inst._zod.check = (payload) => {
			if (typeof payload.value !== typeof def.value) throw new Error("Cannot mix number and bigint in multiple_of check.");
			if (typeof payload.value === "bigint" ? payload.value % def.value === BigInt(0) : floatSafeRemainder(payload.value, def.value) === 0) return;
			payload.issues.push({
				origin: typeof payload.value,
				code: "not_multiple_of",
				divisor: def.value,
				input: payload.value,
				inst,
				continue: !def.abort
			});
		};
	});
	const $ZodCheckNumberFormat = /*@__PURE__*/ $constructor("$ZodCheckNumberFormat", (inst, def) => {
		$ZodCheck.init(inst, def);
		def.format = def.format || "float64";
		const isInt = def.format?.includes("int");
		const origin = isInt ? "int" : "number";
		const [minimum, maximum] = NUMBER_FORMAT_RANGES[def.format];
		inst._zod.onattach.push((inst) => {
			const bag = inst._zod.bag;
			bag.format = def.format;
			bag.minimum = minimum;
			bag.maximum = maximum;
			if (isInt) bag.pattern = integer;
		});
		inst._zod.check = (payload) => {
			const input = payload.value;
			if (isInt) {
				if (!Number.isInteger(input)) {
					payload.issues.push({
						expected: origin,
						format: def.format,
						code: "invalid_type",
						continue: false,
						input,
						inst
					});
					return;
				}
				if (!Number.isSafeInteger(input)) {
					if (input > 0) payload.issues.push({
						input,
						code: "too_big",
						maximum: Number.MAX_SAFE_INTEGER,
						note: "Integers must be within the safe integer range.",
						inst,
						origin,
						inclusive: true,
						continue: !def.abort
					});
					else payload.issues.push({
						input,
						code: "too_small",
						minimum: Number.MIN_SAFE_INTEGER,
						note: "Integers must be within the safe integer range.",
						inst,
						origin,
						inclusive: true,
						continue: !def.abort
					});
					return;
				}
			}
			if (input < minimum) payload.issues.push({
				origin: "number",
				input,
				code: "too_small",
				minimum,
				inclusive: true,
				inst,
				continue: !def.abort
			});
			if (input > maximum) payload.issues.push({
				origin: "number",
				input,
				code: "too_big",
				maximum,
				inclusive: true,
				inst,
				continue: !def.abort
			});
		};
	});
	const $ZodCheckMaxLength = /*@__PURE__*/ $constructor("$ZodCheckMaxLength", (inst, def) => {
		var _a;
		$ZodCheck.init(inst, def);
		(_a = inst._zod.def).when ?? (_a.when = (payload) => {
			const val = payload.value;
			return !nullish(val) && val.length !== void 0;
		});
		inst._zod.onattach.push((inst) => {
			const curr = inst._zod.bag.maximum ?? Number.POSITIVE_INFINITY;
			if (def.maximum < curr) inst._zod.bag.maximum = def.maximum;
		});
		inst._zod.check = (payload) => {
			const input = payload.value;
			if (input.length <= def.maximum) return;
			const origin = getLengthableOrigin(input);
			payload.issues.push({
				origin,
				code: "too_big",
				maximum: def.maximum,
				inclusive: true,
				input,
				inst,
				continue: !def.abort
			});
		};
	});
	const $ZodCheckMinLength = /*@__PURE__*/ $constructor("$ZodCheckMinLength", (inst, def) => {
		var _a;
		$ZodCheck.init(inst, def);
		(_a = inst._zod.def).when ?? (_a.when = (payload) => {
			const val = payload.value;
			return !nullish(val) && val.length !== void 0;
		});
		inst._zod.onattach.push((inst) => {
			const curr = inst._zod.bag.minimum ?? Number.NEGATIVE_INFINITY;
			if (def.minimum > curr) inst._zod.bag.minimum = def.minimum;
		});
		inst._zod.check = (payload) => {
			const input = payload.value;
			if (input.length >= def.minimum) return;
			const origin = getLengthableOrigin(input);
			payload.issues.push({
				origin,
				code: "too_small",
				minimum: def.minimum,
				inclusive: true,
				input,
				inst,
				continue: !def.abort
			});
		};
	});
	const $ZodCheckLengthEquals = /*@__PURE__*/ $constructor("$ZodCheckLengthEquals", (inst, def) => {
		var _a;
		$ZodCheck.init(inst, def);
		(_a = inst._zod.def).when ?? (_a.when = (payload) => {
			const val = payload.value;
			return !nullish(val) && val.length !== void 0;
		});
		inst._zod.onattach.push((inst) => {
			const bag = inst._zod.bag;
			bag.minimum = def.length;
			bag.maximum = def.length;
			bag.length = def.length;
		});
		inst._zod.check = (payload) => {
			const input = payload.value;
			const length = input.length;
			if (length === def.length) return;
			const origin = getLengthableOrigin(input);
			const tooBig = length > def.length;
			payload.issues.push({
				origin,
				...tooBig ? {
					code: "too_big",
					maximum: def.length
				} : {
					code: "too_small",
					minimum: def.length
				},
				inclusive: true,
				exact: true,
				input: payload.value,
				inst,
				continue: !def.abort
			});
		};
	});
	const $ZodCheckStringFormat = /*@__PURE__*/ $constructor("$ZodCheckStringFormat", (inst, def) => {
		var _a, _b;
		$ZodCheck.init(inst, def);
		inst._zod.onattach.push((inst) => {
			const bag = inst._zod.bag;
			bag.format = def.format;
			if (def.pattern) {
				bag.patterns ?? (bag.patterns = /* @__PURE__ */ new Set());
				bag.patterns.add(def.pattern);
			}
		});
		if (def.pattern) (_a = inst._zod).check ?? (_a.check = (payload) => {
			def.pattern.lastIndex = 0;
			if (def.pattern.test(payload.value)) return;
			payload.issues.push({
				origin: "string",
				code: "invalid_format",
				format: def.format,
				input: payload.value,
				...def.pattern ? { pattern: def.pattern.toString() } : {},
				inst,
				continue: !def.abort
			});
		});
		else (_b = inst._zod).check ?? (_b.check = () => {});
	});
	const $ZodCheckRegex = /*@__PURE__*/ $constructor("$ZodCheckRegex", (inst, def) => {
		$ZodCheckStringFormat.init(inst, def);
		inst._zod.check = (payload) => {
			def.pattern.lastIndex = 0;
			if (def.pattern.test(payload.value)) return;
			payload.issues.push({
				origin: "string",
				code: "invalid_format",
				format: "regex",
				input: payload.value,
				pattern: def.pattern.toString(),
				inst,
				continue: !def.abort
			});
		};
	});
	const $ZodCheckLowerCase = /*@__PURE__*/ $constructor("$ZodCheckLowerCase", (inst, def) => {
		def.pattern ?? (def.pattern = lowercase);
		$ZodCheckStringFormat.init(inst, def);
	});
	const $ZodCheckUpperCase = /*@__PURE__*/ $constructor("$ZodCheckUpperCase", (inst, def) => {
		def.pattern ?? (def.pattern = uppercase);
		$ZodCheckStringFormat.init(inst, def);
	});
	const $ZodCheckIncludes = /*@__PURE__*/ $constructor("$ZodCheckIncludes", (inst, def) => {
		$ZodCheck.init(inst, def);
		const escapedRegex = escapeRegex(def.includes);
		const pattern = new RegExp(typeof def.position === "number" ? `^.{${def.position}}${escapedRegex}` : escapedRegex);
		def.pattern = pattern;
		inst._zod.onattach.push((inst) => {
			const bag = inst._zod.bag;
			bag.patterns ?? (bag.patterns = /* @__PURE__ */ new Set());
			bag.patterns.add(pattern);
		});
		inst._zod.check = (payload) => {
			if (payload.value.includes(def.includes, def.position)) return;
			payload.issues.push({
				origin: "string",
				code: "invalid_format",
				format: "includes",
				includes: def.includes,
				input: payload.value,
				inst,
				continue: !def.abort
			});
		};
	});
	const $ZodCheckStartsWith = /*@__PURE__*/ $constructor("$ZodCheckStartsWith", (inst, def) => {
		$ZodCheck.init(inst, def);
		const pattern = new RegExp(`^${escapeRegex(def.prefix)}.*`);
		def.pattern ?? (def.pattern = pattern);
		inst._zod.onattach.push((inst) => {
			const bag = inst._zod.bag;
			bag.patterns ?? (bag.patterns = /* @__PURE__ */ new Set());
			bag.patterns.add(pattern);
		});
		inst._zod.check = (payload) => {
			if (payload.value.startsWith(def.prefix)) return;
			payload.issues.push({
				origin: "string",
				code: "invalid_format",
				format: "starts_with",
				prefix: def.prefix,
				input: payload.value,
				inst,
				continue: !def.abort
			});
		};
	});
	const $ZodCheckEndsWith = /*@__PURE__*/ $constructor("$ZodCheckEndsWith", (inst, def) => {
		$ZodCheck.init(inst, def);
		const pattern = new RegExp(`.*${escapeRegex(def.suffix)}$`);
		def.pattern ?? (def.pattern = pattern);
		inst._zod.onattach.push((inst) => {
			const bag = inst._zod.bag;
			bag.patterns ?? (bag.patterns = /* @__PURE__ */ new Set());
			bag.patterns.add(pattern);
		});
		inst._zod.check = (payload) => {
			if (payload.value.endsWith(def.suffix)) return;
			payload.issues.push({
				origin: "string",
				code: "invalid_format",
				format: "ends_with",
				suffix: def.suffix,
				input: payload.value,
				inst,
				continue: !def.abort
			});
		};
	});
	const $ZodCheckOverwrite = /*@__PURE__*/ $constructor("$ZodCheckOverwrite", (inst, def) => {
		$ZodCheck.init(inst, def);
		inst._zod.check = (payload) => {
			payload.value = def.tx(payload.value);
		};
	});
	//#endregion
	//#region ../../node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/core/doc.js
	var Doc = class {
		constructor(args = []) {
			this.content = [];
			this.indent = 0;
			if (this) this.args = args;
		}
		indented(fn) {
			this.indent += 1;
			fn(this);
			this.indent -= 1;
		}
		write(arg) {
			if (typeof arg === "function") {
				arg(this, { execution: "sync" });
				arg(this, { execution: "async" });
				return;
			}
			const lines = arg.split("\n").filter((x) => x);
			const minIndent = Math.min(...lines.map((x) => x.length - x.trimStart().length));
			const dedented = lines.map((x) => x.slice(minIndent)).map((x) => " ".repeat(this.indent * 2) + x);
			for (const line of dedented) this.content.push(line);
		}
		compile() {
			const F = Function;
			const args = this?.args;
			const lines = [...(this?.content ?? [``]).map((x) => `  ${x}`)];
			return new F(...args, lines.join("\n"));
		}
	};
	//#endregion
	//#region ../../node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/core/versions.js
	const version = {
		major: 4,
		minor: 4,
		patch: 3
	};
	//#endregion
	//#region ../../node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/core/schemas.js
	const $ZodType = /*@__PURE__*/ $constructor("$ZodType", (inst, def) => {
		var _a;
		inst ?? (inst = {});
		inst._zod.def = def;
		inst._zod.bag = inst._zod.bag || {};
		inst._zod.version = version;
		const checks = [...inst._zod.def.checks ?? []];
		if (inst._zod.traits.has("$ZodCheck")) checks.unshift(inst);
		for (const ch of checks) for (const fn of ch._zod.onattach) fn(inst);
		if (checks.length === 0) {
			(_a = inst._zod).deferred ?? (_a.deferred = []);
			inst._zod.deferred?.push(() => {
				inst._zod.run = inst._zod.parse;
			});
		} else {
			const runChecks = (payload, checks, ctx) => {
				let isAborted = aborted(payload);
				let asyncResult;
				for (const ch of checks) {
					if (ch._zod.def.when) {
						if (explicitlyAborted(payload)) continue;
						if (!ch._zod.def.when(payload)) continue;
					} else if (isAborted) continue;
					const currLen = payload.issues.length;
					const _ = ch._zod.check(payload);
					if (_ instanceof Promise && ctx?.async === false) throw new $ZodAsyncError();
					if (asyncResult || _ instanceof Promise) asyncResult = (asyncResult ?? Promise.resolve()).then(async () => {
						await _;
						if (payload.issues.length === currLen) return;
						if (!isAborted) isAborted = aborted(payload, currLen);
					});
					else {
						if (payload.issues.length === currLen) continue;
						if (!isAborted) isAborted = aborted(payload, currLen);
					}
				}
				if (asyncResult) return asyncResult.then(() => {
					return payload;
				});
				return payload;
			};
			const handleCanaryResult = (canary, payload, ctx) => {
				if (aborted(canary)) {
					canary.aborted = true;
					return canary;
				}
				const checkResult = runChecks(payload, checks, ctx);
				if (checkResult instanceof Promise) {
					if (ctx.async === false) throw new $ZodAsyncError();
					return checkResult.then((checkResult) => inst._zod.parse(checkResult, ctx));
				}
				return inst._zod.parse(checkResult, ctx);
			};
			inst._zod.run = (payload, ctx) => {
				if (ctx.skipChecks) return inst._zod.parse(payload, ctx);
				if (ctx.direction === "backward") {
					const canary = inst._zod.parse({
						value: payload.value,
						issues: []
					}, {
						...ctx,
						skipChecks: true
					});
					if (canary instanceof Promise) return canary.then((canary) => {
						return handleCanaryResult(canary, payload, ctx);
					});
					return handleCanaryResult(canary, payload, ctx);
				}
				const result = inst._zod.parse(payload, ctx);
				if (result instanceof Promise) {
					if (ctx.async === false) throw new $ZodAsyncError();
					return result.then((result) => runChecks(result, checks, ctx));
				}
				return runChecks(result, checks, ctx);
			};
		}
		defineLazy(inst, "~standard", () => ({
			validate: (value) => {
				try {
					const r = safeParse$1(inst, value);
					return r.success ? { value: r.data } : { issues: r.error?.issues };
				} catch (_) {
					return safeParseAsync$1(inst, value).then((r) => r.success ? { value: r.data } : { issues: r.error?.issues });
				}
			},
			vendor: "zod",
			version: 1
		}));
	});
	const $ZodString = /*@__PURE__*/ $constructor("$ZodString", (inst, def) => {
		$ZodType.init(inst, def);
		inst._zod.pattern = [...inst?._zod.bag?.patterns ?? []].pop() ?? string$1(inst._zod.bag);
		inst._zod.parse = (payload, _) => {
			if (def.coerce) try {
				payload.value = String(payload.value);
			} catch (_) {}
			if (typeof payload.value === "string") return payload;
			payload.issues.push({
				expected: "string",
				code: "invalid_type",
				input: payload.value,
				inst
			});
			return payload;
		};
	});
	const $ZodStringFormat = /*@__PURE__*/ $constructor("$ZodStringFormat", (inst, def) => {
		$ZodCheckStringFormat.init(inst, def);
		$ZodString.init(inst, def);
	});
	const $ZodGUID = /*@__PURE__*/ $constructor("$ZodGUID", (inst, def) => {
		def.pattern ?? (def.pattern = guid);
		$ZodStringFormat.init(inst, def);
	});
	const $ZodUUID = /*@__PURE__*/ $constructor("$ZodUUID", (inst, def) => {
		if (def.version) {
			const v = {
				v1: 1,
				v2: 2,
				v3: 3,
				v4: 4,
				v5: 5,
				v6: 6,
				v7: 7,
				v8: 8
			}[def.version];
			if (v === void 0) throw new Error(`Invalid UUID version: "${def.version}"`);
			def.pattern ?? (def.pattern = uuid(v));
		} else def.pattern ?? (def.pattern = uuid());
		$ZodStringFormat.init(inst, def);
	});
	const $ZodEmail = /*@__PURE__*/ $constructor("$ZodEmail", (inst, def) => {
		def.pattern ?? (def.pattern = email$1);
		$ZodStringFormat.init(inst, def);
	});
	const $ZodURL = /*@__PURE__*/ $constructor("$ZodURL", (inst, def) => {
		$ZodStringFormat.init(inst, def);
		inst._zod.check = (payload) => {
			try {
				const trimmed = payload.value.trim();
				if (!def.normalize && def.protocol?.source === httpProtocol.source) {
					if (!/^https?:\/\//i.test(trimmed)) {
						payload.issues.push({
							code: "invalid_format",
							format: "url",
							note: "Invalid URL format",
							input: payload.value,
							inst,
							continue: !def.abort
						});
						return;
					}
				}
				const url = new URL(trimmed);
				if (def.hostname) {
					def.hostname.lastIndex = 0;
					if (!def.hostname.test(url.hostname)) payload.issues.push({
						code: "invalid_format",
						format: "url",
						note: "Invalid hostname",
						pattern: def.hostname.source,
						input: payload.value,
						inst,
						continue: !def.abort
					});
				}
				if (def.protocol) {
					def.protocol.lastIndex = 0;
					if (!def.protocol.test(url.protocol.endsWith(":") ? url.protocol.slice(0, -1) : url.protocol)) payload.issues.push({
						code: "invalid_format",
						format: "url",
						note: "Invalid protocol",
						pattern: def.protocol.source,
						input: payload.value,
						inst,
						continue: !def.abort
					});
				}
				if (def.normalize) payload.value = url.href;
				else payload.value = trimmed;
				return;
			} catch (_) {
				payload.issues.push({
					code: "invalid_format",
					format: "url",
					input: payload.value,
					inst,
					continue: !def.abort
				});
			}
		};
	});
	const $ZodEmoji = /*@__PURE__*/ $constructor("$ZodEmoji", (inst, def) => {
		def.pattern ?? (def.pattern = emoji());
		$ZodStringFormat.init(inst, def);
	});
	const $ZodNanoID = /*@__PURE__*/ $constructor("$ZodNanoID", (inst, def) => {
		def.pattern ?? (def.pattern = nanoid);
		$ZodStringFormat.init(inst, def);
	});
	/**
	* @deprecated CUID v1 is deprecated by its authors due to information leakage
	* (timestamps embedded in the id). Use {@link $ZodCUID2} instead.
	* See https://github.com/paralleldrive/cuid.
	*/
	const $ZodCUID = /*@__PURE__*/ $constructor("$ZodCUID", (inst, def) => {
		def.pattern ?? (def.pattern = cuid);
		$ZodStringFormat.init(inst, def);
	});
	const $ZodCUID2 = /*@__PURE__*/ $constructor("$ZodCUID2", (inst, def) => {
		def.pattern ?? (def.pattern = cuid2);
		$ZodStringFormat.init(inst, def);
	});
	const $ZodULID = /*@__PURE__*/ $constructor("$ZodULID", (inst, def) => {
		def.pattern ?? (def.pattern = ulid);
		$ZodStringFormat.init(inst, def);
	});
	const $ZodXID = /*@__PURE__*/ $constructor("$ZodXID", (inst, def) => {
		def.pattern ?? (def.pattern = xid);
		$ZodStringFormat.init(inst, def);
	});
	const $ZodKSUID = /*@__PURE__*/ $constructor("$ZodKSUID", (inst, def) => {
		def.pattern ?? (def.pattern = ksuid);
		$ZodStringFormat.init(inst, def);
	});
	const $ZodISODateTime = /*@__PURE__*/ $constructor("$ZodISODateTime", (inst, def) => {
		def.pattern ?? (def.pattern = datetime$1(def));
		$ZodStringFormat.init(inst, def);
	});
	const $ZodISODate = /*@__PURE__*/ $constructor("$ZodISODate", (inst, def) => {
		def.pattern ?? (def.pattern = date$2);
		$ZodStringFormat.init(inst, def);
	});
	const $ZodISOTime = /*@__PURE__*/ $constructor("$ZodISOTime", (inst, def) => {
		def.pattern ?? (def.pattern = time$2(def));
		$ZodStringFormat.init(inst, def);
	});
	const $ZodISODuration = /*@__PURE__*/ $constructor("$ZodISODuration", (inst, def) => {
		def.pattern ?? (def.pattern = duration$1);
		$ZodStringFormat.init(inst, def);
	});
	const $ZodIPv4 = /*@__PURE__*/ $constructor("$ZodIPv4", (inst, def) => {
		def.pattern ?? (def.pattern = ipv4);
		$ZodStringFormat.init(inst, def);
		inst._zod.bag.format = `ipv4`;
	});
	const $ZodIPv6 = /*@__PURE__*/ $constructor("$ZodIPv6", (inst, def) => {
		def.pattern ?? (def.pattern = ipv6);
		$ZodStringFormat.init(inst, def);
		inst._zod.bag.format = `ipv6`;
		inst._zod.check = (payload) => {
			try {
				new URL(`http://[${payload.value}]`);
			} catch {
				payload.issues.push({
					code: "invalid_format",
					format: "ipv6",
					input: payload.value,
					inst,
					continue: !def.abort
				});
			}
		};
	});
	const $ZodCIDRv4 = /*@__PURE__*/ $constructor("$ZodCIDRv4", (inst, def) => {
		def.pattern ?? (def.pattern = cidrv4);
		$ZodStringFormat.init(inst, def);
	});
	const $ZodCIDRv6 = /*@__PURE__*/ $constructor("$ZodCIDRv6", (inst, def) => {
		def.pattern ?? (def.pattern = cidrv6);
		$ZodStringFormat.init(inst, def);
		inst._zod.check = (payload) => {
			const parts = payload.value.split("/");
			try {
				if (parts.length !== 2) throw new Error();
				const [address, prefix] = parts;
				if (!prefix) throw new Error();
				const prefixNum = Number(prefix);
				if (`${prefixNum}` !== prefix) throw new Error();
				if (prefixNum < 0 || prefixNum > 128) throw new Error();
				new URL(`http://[${address}]`);
			} catch {
				payload.issues.push({
					code: "invalid_format",
					format: "cidrv6",
					input: payload.value,
					inst,
					continue: !def.abort
				});
			}
		};
	});
	function isValidBase64(data) {
		if (data === "") return true;
		if (/\s/.test(data)) return false;
		if (data.length % 4 !== 0) return false;
		try {
			atob(data);
			return true;
		} catch {
			return false;
		}
	}
	const $ZodBase64 = /*@__PURE__*/ $constructor("$ZodBase64", (inst, def) => {
		def.pattern ?? (def.pattern = base64);
		$ZodStringFormat.init(inst, def);
		inst._zod.bag.contentEncoding = "base64";
		inst._zod.check = (payload) => {
			if (isValidBase64(payload.value)) return;
			payload.issues.push({
				code: "invalid_format",
				format: "base64",
				input: payload.value,
				inst,
				continue: !def.abort
			});
		};
	});
	function isValidBase64URL(data) {
		if (!base64url.test(data)) return false;
		const base64 = data.replace(/[-_]/g, (c) => c === "-" ? "+" : "/");
		return isValidBase64(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
	}
	const $ZodBase64URL = /*@__PURE__*/ $constructor("$ZodBase64URL", (inst, def) => {
		def.pattern ?? (def.pattern = base64url);
		$ZodStringFormat.init(inst, def);
		inst._zod.bag.contentEncoding = "base64url";
		inst._zod.check = (payload) => {
			if (isValidBase64URL(payload.value)) return;
			payload.issues.push({
				code: "invalid_format",
				format: "base64url",
				input: payload.value,
				inst,
				continue: !def.abort
			});
		};
	});
	const $ZodE164 = /*@__PURE__*/ $constructor("$ZodE164", (inst, def) => {
		def.pattern ?? (def.pattern = e164);
		$ZodStringFormat.init(inst, def);
	});
	function isValidJWT(token, algorithm = null) {
		try {
			const tokensParts = token.split(".");
			if (tokensParts.length !== 3) return false;
			const [header] = tokensParts;
			if (!header) return false;
			const parsedHeader = JSON.parse(atob(header));
			if ("typ" in parsedHeader && parsedHeader?.typ !== "JWT") return false;
			if (!parsedHeader.alg) return false;
			if (algorithm && (!("alg" in parsedHeader) || parsedHeader.alg !== algorithm)) return false;
			return true;
		} catch {
			return false;
		}
	}
	const $ZodJWT = /*@__PURE__*/ $constructor("$ZodJWT", (inst, def) => {
		$ZodStringFormat.init(inst, def);
		inst._zod.check = (payload) => {
			if (isValidJWT(payload.value, def.alg)) return;
			payload.issues.push({
				code: "invalid_format",
				format: "jwt",
				input: payload.value,
				inst,
				continue: !def.abort
			});
		};
	});
	const $ZodNumber = /*@__PURE__*/ $constructor("$ZodNumber", (inst, def) => {
		$ZodType.init(inst, def);
		inst._zod.pattern = inst._zod.bag.pattern ?? number$2;
		inst._zod.parse = (payload, _ctx) => {
			if (def.coerce) try {
				payload.value = Number(payload.value);
			} catch (_) {}
			const input = payload.value;
			if (typeof input === "number" && !Number.isNaN(input) && Number.isFinite(input)) return payload;
			const received = typeof input === "number" ? Number.isNaN(input) ? "NaN" : !Number.isFinite(input) ? "Infinity" : void 0 : void 0;
			payload.issues.push({
				expected: "number",
				code: "invalid_type",
				input,
				inst,
				...received ? { received } : {}
			});
			return payload;
		};
	});
	const $ZodNumberFormat = /*@__PURE__*/ $constructor("$ZodNumberFormat", (inst, def) => {
		$ZodCheckNumberFormat.init(inst, def);
		$ZodNumber.init(inst, def);
	});
	const $ZodBoolean = /*@__PURE__*/ $constructor("$ZodBoolean", (inst, def) => {
		$ZodType.init(inst, def);
		inst._zod.pattern = boolean$1;
		inst._zod.parse = (payload, _ctx) => {
			if (def.coerce) try {
				payload.value = Boolean(payload.value);
			} catch (_) {}
			const input = payload.value;
			if (typeof input === "boolean") return payload;
			payload.issues.push({
				expected: "boolean",
				code: "invalid_type",
				input,
				inst
			});
			return payload;
		};
	});
	const $ZodNull = /*@__PURE__*/ $constructor("$ZodNull", (inst, def) => {
		$ZodType.init(inst, def);
		inst._zod.pattern = _null$2;
		inst._zod.values = /* @__PURE__ */ new Set([null]);
		inst._zod.parse = (payload, _ctx) => {
			const input = payload.value;
			if (input === null) return payload;
			payload.issues.push({
				expected: "null",
				code: "invalid_type",
				input,
				inst
			});
			return payload;
		};
	});
	const $ZodAny = /*@__PURE__*/ $constructor("$ZodAny", (inst, def) => {
		$ZodType.init(inst, def);
		inst._zod.parse = (payload) => payload;
	});
	const $ZodUnknown = /*@__PURE__*/ $constructor("$ZodUnknown", (inst, def) => {
		$ZodType.init(inst, def);
		inst._zod.parse = (payload) => payload;
	});
	const $ZodNever = /*@__PURE__*/ $constructor("$ZodNever", (inst, def) => {
		$ZodType.init(inst, def);
		inst._zod.parse = (payload, _ctx) => {
			payload.issues.push({
				expected: "never",
				code: "invalid_type",
				input: payload.value,
				inst
			});
			return payload;
		};
	});
	function handleArrayResult(result, final, index) {
		if (result.issues.length) final.issues.push(...prefixIssues(index, result.issues));
		final.value[index] = result.value;
	}
	const $ZodArray = /*@__PURE__*/ $constructor("$ZodArray", (inst, def) => {
		$ZodType.init(inst, def);
		inst._zod.parse = (payload, ctx) => {
			const input = payload.value;
			if (!Array.isArray(input)) {
				payload.issues.push({
					expected: "array",
					code: "invalid_type",
					input,
					inst
				});
				return payload;
			}
			payload.value = Array(input.length);
			const proms = [];
			for (let i = 0; i < input.length; i++) {
				const item = input[i];
				const result = def.element._zod.run({
					value: item,
					issues: []
				}, ctx);
				if (result instanceof Promise) proms.push(result.then((result) => handleArrayResult(result, payload, i)));
				else handleArrayResult(result, payload, i);
			}
			if (proms.length) return Promise.all(proms).then(() => payload);
			return payload;
		};
	});
	function handlePropertyResult(result, final, key, input, isOptionalIn, isOptionalOut) {
		const isPresent = key in input;
		if (result.issues.length) {
			if (isOptionalIn && isOptionalOut && !isPresent) return;
			final.issues.push(...prefixIssues(key, result.issues));
		}
		if (!isPresent && !isOptionalIn) {
			if (!result.issues.length) final.issues.push({
				code: "invalid_type",
				expected: "nonoptional",
				input: void 0,
				path: [key]
			});
			return;
		}
		if (result.value === void 0) {
			if (isPresent) final.value[key] = void 0;
		} else final.value[key] = result.value;
	}
	function normalizeDef(def) {
		const keys = Object.keys(def.shape);
		for (const k of keys) if (!def.shape?.[k]?._zod?.traits?.has("$ZodType")) throw new Error(`Invalid element at key "${k}": expected a Zod schema`);
		const okeys = optionalKeys(def.shape);
		return {
			...def,
			keys,
			keySet: new Set(keys),
			numKeys: keys.length,
			optionalKeys: new Set(okeys)
		};
	}
	function handleCatchall(proms, input, payload, ctx, def, inst) {
		const unrecognized = [];
		const keySet = def.keySet;
		const _catchall = def.catchall._zod;
		const t = _catchall.def.type;
		const isOptionalIn = _catchall.optin === "optional";
		const isOptionalOut = _catchall.optout === "optional";
		for (const key in input) {
			if (key === "__proto__") continue;
			if (keySet.has(key)) continue;
			if (t === "never") {
				unrecognized.push(key);
				continue;
			}
			const r = _catchall.run({
				value: input[key],
				issues: []
			}, ctx);
			if (r instanceof Promise) proms.push(r.then((r) => handlePropertyResult(r, payload, key, input, isOptionalIn, isOptionalOut)));
			else handlePropertyResult(r, payload, key, input, isOptionalIn, isOptionalOut);
		}
		if (unrecognized.length) payload.issues.push({
			code: "unrecognized_keys",
			keys: unrecognized,
			input,
			inst
		});
		if (!proms.length) return payload;
		return Promise.all(proms).then(() => {
			return payload;
		});
	}
	const $ZodObject = /*@__PURE__*/ $constructor("$ZodObject", (inst, def) => {
		$ZodType.init(inst, def);
		if (!Object.getOwnPropertyDescriptor(def, "shape")?.get) {
			const sh = def.shape;
			Object.defineProperty(def, "shape", { get: () => {
				const newSh = { ...sh };
				Object.defineProperty(def, "shape", { value: newSh });
				return newSh;
			} });
		}
		const _normalized = cached(() => normalizeDef(def));
		defineLazy(inst._zod, "propValues", () => {
			const shape = def.shape;
			const propValues = {};
			for (const key in shape) {
				const field = shape[key]._zod;
				if (field.values) {
					propValues[key] ?? (propValues[key] = /* @__PURE__ */ new Set());
					for (const v of field.values) propValues[key].add(v);
				}
			}
			return propValues;
		});
		const isObject$1 = isObject;
		const catchall = def.catchall;
		let value;
		inst._zod.parse = (payload, ctx) => {
			value ?? (value = _normalized.value);
			const input = payload.value;
			if (!isObject$1(input)) {
				payload.issues.push({
					expected: "object",
					code: "invalid_type",
					input,
					inst
				});
				return payload;
			}
			payload.value = {};
			const proms = [];
			const shape = value.shape;
			for (const key of value.keys) {
				const el = shape[key];
				const isOptionalIn = el._zod.optin === "optional";
				const isOptionalOut = el._zod.optout === "optional";
				const r = el._zod.run({
					value: input[key],
					issues: []
				}, ctx);
				if (r instanceof Promise) proms.push(r.then((r) => handlePropertyResult(r, payload, key, input, isOptionalIn, isOptionalOut)));
				else handlePropertyResult(r, payload, key, input, isOptionalIn, isOptionalOut);
			}
			if (!catchall) return proms.length ? Promise.all(proms).then(() => payload) : payload;
			return handleCatchall(proms, input, payload, ctx, _normalized.value, inst);
		};
	});
	const $ZodObjectJIT = /*@__PURE__*/ $constructor("$ZodObjectJIT", (inst, def) => {
		$ZodObject.init(inst, def);
		const superParse = inst._zod.parse;
		const _normalized = cached(() => normalizeDef(def));
		const generateFastpass = (shape) => {
			const doc = new Doc([
				"shape",
				"payload",
				"ctx"
			]);
			const normalized = _normalized.value;
			const parseStr = (key) => {
				const k = esc(key);
				return `shape[${k}]._zod.run({ value: input[${k}], issues: [] }, ctx)`;
			};
			doc.write(`const input = payload.value;`);
			const ids = Object.create(null);
			let counter = 0;
			for (const key of normalized.keys) ids[key] = `key_${counter++}`;
			doc.write(`const newResult = {};`);
			for (const key of normalized.keys) {
				const id = ids[key];
				const k = esc(key);
				const schema = shape[key];
				const isOptionalIn = schema?._zod?.optin === "optional";
				const isOptionalOut = schema?._zod?.optout === "optional";
				doc.write(`const ${id} = ${parseStr(key)};`);
				if (isOptionalIn && isOptionalOut) doc.write(`
        if (${id}.issues.length) {
          if (${k} in input) {
            payload.issues = payload.issues.concat(${id}.issues.map(iss => ({
              ...iss,
              path: iss.path ? [${k}, ...iss.path] : [${k}]
            })));
          }
        }
        
        if (${id}.value === undefined) {
          if (${k} in input) {
            newResult[${k}] = undefined;
          }
        } else {
          newResult[${k}] = ${id}.value;
        }
        
      `);
				else if (!isOptionalIn) doc.write(`
        const ${id}_present = ${k} in input;
        if (${id}.issues.length) {
          payload.issues = payload.issues.concat(${id}.issues.map(iss => ({
            ...iss,
            path: iss.path ? [${k}, ...iss.path] : [${k}]
          })));
        }
        if (!${id}_present && !${id}.issues.length) {
          payload.issues.push({
            code: "invalid_type",
            expected: "nonoptional",
            input: undefined,
            path: [${k}]
          });
        }

        if (${id}_present) {
          if (${id}.value === undefined) {
            newResult[${k}] = undefined;
          } else {
            newResult[${k}] = ${id}.value;
          }
        }

      `);
				else doc.write(`
        if (${id}.issues.length) {
          payload.issues = payload.issues.concat(${id}.issues.map(iss => ({
            ...iss,
            path: iss.path ? [${k}, ...iss.path] : [${k}]
          })));
        }
        
        if (${id}.value === undefined) {
          if (${k} in input) {
            newResult[${k}] = undefined;
          }
        } else {
          newResult[${k}] = ${id}.value;
        }
        
      `);
			}
			doc.write(`payload.value = newResult;`);
			doc.write(`return payload;`);
			const fn = doc.compile();
			return (payload, ctx) => fn(shape, payload, ctx);
		};
		let fastpass;
		const isObject$2 = isObject;
		const jit = !globalConfig.jitless;
		const fastEnabled = jit && allowsEval.value;
		const catchall = def.catchall;
		let value;
		inst._zod.parse = (payload, ctx) => {
			value ?? (value = _normalized.value);
			const input = payload.value;
			if (!isObject$2(input)) {
				payload.issues.push({
					expected: "object",
					code: "invalid_type",
					input,
					inst
				});
				return payload;
			}
			if (jit && fastEnabled && ctx?.async === false && ctx.jitless !== true) {
				if (!fastpass) fastpass = generateFastpass(def.shape);
				payload = fastpass(payload, ctx);
				if (!catchall) return payload;
				return handleCatchall([], input, payload, ctx, value, inst);
			}
			return superParse(payload, ctx);
		};
	});
	function handleUnionResults(results, final, inst, ctx) {
		for (const result of results) if (result.issues.length === 0) {
			final.value = result.value;
			return final;
		}
		const nonaborted = results.filter((r) => !aborted(r));
		if (nonaborted.length === 1) {
			final.value = nonaborted[0].value;
			return nonaborted[0];
		}
		final.issues.push({
			code: "invalid_union",
			input: final.value,
			inst,
			errors: results.map((result) => result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
		});
		return final;
	}
	const $ZodUnion = /*@__PURE__*/ $constructor("$ZodUnion", (inst, def) => {
		$ZodType.init(inst, def);
		defineLazy(inst._zod, "optin", () => def.options.some((o) => o._zod.optin === "optional") ? "optional" : void 0);
		defineLazy(inst._zod, "optout", () => def.options.some((o) => o._zod.optout === "optional") ? "optional" : void 0);
		defineLazy(inst._zod, "values", () => {
			if (def.options.every((o) => o._zod.values)) return new Set(def.options.flatMap((option) => Array.from(option._zod.values)));
		});
		defineLazy(inst._zod, "pattern", () => {
			if (def.options.every((o) => o._zod.pattern)) {
				const patterns = def.options.map((o) => o._zod.pattern);
				return new RegExp(`^(${patterns.map((p) => cleanRegex(p.source)).join("|")})$`);
			}
		});
		const first = def.options.length === 1 ? def.options[0]._zod.run : null;
		inst._zod.parse = (payload, ctx) => {
			if (first) return first(payload, ctx);
			let async = false;
			const results = [];
			for (const option of def.options) {
				const result = option._zod.run({
					value: payload.value,
					issues: []
				}, ctx);
				if (result instanceof Promise) {
					results.push(result);
					async = true;
				} else {
					if (result.issues.length === 0) return result;
					results.push(result);
				}
			}
			if (!async) return handleUnionResults(results, payload, inst, ctx);
			return Promise.all(results).then((results) => {
				return handleUnionResults(results, payload, inst, ctx);
			});
		};
	});
	const $ZodDiscriminatedUnion = /*@__PURE__*/ $constructor("$ZodDiscriminatedUnion", (inst, def) => {
		def.inclusive = false;
		$ZodUnion.init(inst, def);
		const _super = inst._zod.parse;
		defineLazy(inst._zod, "propValues", () => {
			const propValues = {};
			for (const option of def.options) {
				const pv = option._zod.propValues;
				if (!pv || Object.keys(pv).length === 0) throw new Error(`Invalid discriminated union option at index "${def.options.indexOf(option)}"`);
				for (const [k, v] of Object.entries(pv)) {
					if (!propValues[k]) propValues[k] = /* @__PURE__ */ new Set();
					for (const val of v) propValues[k].add(val);
				}
			}
			return propValues;
		});
		const disc = cached(() => {
			const opts = def.options;
			const map = /* @__PURE__ */ new Map();
			for (const o of opts) {
				const values = o._zod.propValues?.[def.discriminator];
				if (!values || values.size === 0) throw new Error(`Invalid discriminated union option at index "${def.options.indexOf(o)}"`);
				for (const v of values) {
					if (map.has(v)) throw new Error(`Duplicate discriminator value "${String(v)}"`);
					map.set(v, o);
				}
			}
			return map;
		});
		inst._zod.parse = (payload, ctx) => {
			const input = payload.value;
			if (!isObject(input)) {
				payload.issues.push({
					code: "invalid_type",
					expected: "object",
					input,
					inst
				});
				return payload;
			}
			const opt = disc.value.get(input?.[def.discriminator]);
			if (opt) return opt._zod.run(payload, ctx);
			if (def.unionFallback || ctx.direction === "backward") return _super(payload, ctx);
			payload.issues.push({
				code: "invalid_union",
				errors: [],
				note: "No matching discriminator",
				discriminator: def.discriminator,
				options: Array.from(disc.value.keys()),
				input,
				path: [def.discriminator],
				inst
			});
			return payload;
		};
	});
	const $ZodIntersection = /*@__PURE__*/ $constructor("$ZodIntersection", (inst, def) => {
		$ZodType.init(inst, def);
		inst._zod.parse = (payload, ctx) => {
			const input = payload.value;
			const left = def.left._zod.run({
				value: input,
				issues: []
			}, ctx);
			const right = def.right._zod.run({
				value: input,
				issues: []
			}, ctx);
			if (left instanceof Promise || right instanceof Promise) return Promise.all([left, right]).then(([left, right]) => {
				return handleIntersectionResults(payload, left, right);
			});
			return handleIntersectionResults(payload, left, right);
		};
	});
	function mergeValues(a, b) {
		if (a === b) return {
			valid: true,
			data: a
		};
		if (a instanceof Date && b instanceof Date && +a === +b) return {
			valid: true,
			data: a
		};
		if (isPlainObject$5(a) && isPlainObject$5(b)) {
			const bKeys = Object.keys(b);
			const sharedKeys = Object.keys(a).filter((key) => bKeys.indexOf(key) !== -1);
			const newObj = {
				...a,
				...b
			};
			for (const key of sharedKeys) {
				const sharedValue = mergeValues(a[key], b[key]);
				if (!sharedValue.valid) return {
					valid: false,
					mergeErrorPath: [key, ...sharedValue.mergeErrorPath]
				};
				newObj[key] = sharedValue.data;
			}
			return {
				valid: true,
				data: newObj
			};
		}
		if (Array.isArray(a) && Array.isArray(b)) {
			if (a.length !== b.length) return {
				valid: false,
				mergeErrorPath: []
			};
			const newArray = [];
			for (let index = 0; index < a.length; index++) {
				const itemA = a[index];
				const itemB = b[index];
				const sharedValue = mergeValues(itemA, itemB);
				if (!sharedValue.valid) return {
					valid: false,
					mergeErrorPath: [index, ...sharedValue.mergeErrorPath]
				};
				newArray.push(sharedValue.data);
			}
			return {
				valid: true,
				data: newArray
			};
		}
		return {
			valid: false,
			mergeErrorPath: []
		};
	}
	function handleIntersectionResults(result, left, right) {
		const unrecKeys = /* @__PURE__ */ new Map();
		let unrecIssue;
		for (const iss of left.issues) if (iss.code === "unrecognized_keys") {
			unrecIssue ?? (unrecIssue = iss);
			for (const k of iss.keys) {
				if (!unrecKeys.has(k)) unrecKeys.set(k, {});
				unrecKeys.get(k).l = true;
			}
		} else result.issues.push(iss);
		for (const iss of right.issues) if (iss.code === "unrecognized_keys") for (const k of iss.keys) {
			if (!unrecKeys.has(k)) unrecKeys.set(k, {});
			unrecKeys.get(k).r = true;
		}
		else result.issues.push(iss);
		const bothKeys = [...unrecKeys].filter(([, f]) => f.l && f.r).map(([k]) => k);
		if (bothKeys.length && unrecIssue) result.issues.push({
			...unrecIssue,
			keys: bothKeys
		});
		if (aborted(result)) return result;
		const merged = mergeValues(left.value, right.value);
		if (!merged.valid) throw new Error(`Unmergable intersection. Error path: ${JSON.stringify(merged.mergeErrorPath)}`);
		result.value = merged.data;
		return result;
	}
	const $ZodRecord = /*@__PURE__*/ $constructor("$ZodRecord", (inst, def) => {
		$ZodType.init(inst, def);
		inst._zod.parse = (payload, ctx) => {
			const input = payload.value;
			if (!isPlainObject$5(input)) {
				payload.issues.push({
					expected: "record",
					code: "invalid_type",
					input,
					inst
				});
				return payload;
			}
			const proms = [];
			const values = def.keyType._zod.values;
			if (values) {
				payload.value = {};
				const recordKeys = /* @__PURE__ */ new Set();
				for (const key of values) if (typeof key === "string" || typeof key === "number" || typeof key === "symbol") {
					recordKeys.add(typeof key === "number" ? key.toString() : key);
					const keyResult = def.keyType._zod.run({
						value: key,
						issues: []
					}, ctx);
					if (keyResult instanceof Promise) throw new Error("Async schemas not supported in object keys currently");
					if (keyResult.issues.length) {
						payload.issues.push({
							code: "invalid_key",
							origin: "record",
							issues: keyResult.issues.map((iss) => finalizeIssue(iss, ctx, config())),
							input: key,
							path: [key],
							inst
						});
						continue;
					}
					const outKey = keyResult.value;
					const result = def.valueType._zod.run({
						value: input[key],
						issues: []
					}, ctx);
					if (result instanceof Promise) proms.push(result.then((result) => {
						if (result.issues.length) payload.issues.push(...prefixIssues(key, result.issues));
						payload.value[outKey] = result.value;
					}));
					else {
						if (result.issues.length) payload.issues.push(...prefixIssues(key, result.issues));
						payload.value[outKey] = result.value;
					}
				}
				let unrecognized;
				for (const key in input) if (!recordKeys.has(key)) {
					unrecognized = unrecognized ?? [];
					unrecognized.push(key);
				}
				if (unrecognized && unrecognized.length > 0) payload.issues.push({
					code: "unrecognized_keys",
					input,
					inst,
					keys: unrecognized
				});
			} else {
				payload.value = {};
				for (const key of Reflect.ownKeys(input)) {
					if (key === "__proto__") continue;
					if (!Object.prototype.propertyIsEnumerable.call(input, key)) continue;
					let keyResult = def.keyType._zod.run({
						value: key,
						issues: []
					}, ctx);
					if (keyResult instanceof Promise) throw new Error("Async schemas not supported in object keys currently");
					if (typeof key === "string" && number$2.test(key) && keyResult.issues.length) {
						const retryResult = def.keyType._zod.run({
							value: Number(key),
							issues: []
						}, ctx);
						if (retryResult instanceof Promise) throw new Error("Async schemas not supported in object keys currently");
						if (retryResult.issues.length === 0) keyResult = retryResult;
					}
					if (keyResult.issues.length) {
						if (def.mode === "loose") payload.value[key] = input[key];
						else payload.issues.push({
							code: "invalid_key",
							origin: "record",
							issues: keyResult.issues.map((iss) => finalizeIssue(iss, ctx, config())),
							input: key,
							path: [key],
							inst
						});
						continue;
					}
					const result = def.valueType._zod.run({
						value: input[key],
						issues: []
					}, ctx);
					if (result instanceof Promise) proms.push(result.then((result) => {
						if (result.issues.length) payload.issues.push(...prefixIssues(key, result.issues));
						payload.value[keyResult.value] = result.value;
					}));
					else {
						if (result.issues.length) payload.issues.push(...prefixIssues(key, result.issues));
						payload.value[keyResult.value] = result.value;
					}
				}
			}
			if (proms.length) return Promise.all(proms).then(() => payload);
			return payload;
		};
	});
	const $ZodEnum = /*@__PURE__*/ $constructor("$ZodEnum", (inst, def) => {
		$ZodType.init(inst, def);
		const values = getEnumValues(def.entries);
		const valuesSet = new Set(values);
		inst._zod.values = valuesSet;
		inst._zod.pattern = new RegExp(`^(${values.filter((k) => propertyKeyTypes.has(typeof k)).map((o) => typeof o === "string" ? escapeRegex(o) : o.toString()).join("|")})$`);
		inst._zod.parse = (payload, _ctx) => {
			const input = payload.value;
			if (valuesSet.has(input)) return payload;
			payload.issues.push({
				code: "invalid_value",
				values,
				input,
				inst
			});
			return payload;
		};
	});
	const $ZodLiteral = /*@__PURE__*/ $constructor("$ZodLiteral", (inst, def) => {
		$ZodType.init(inst, def);
		if (def.values.length === 0) throw new Error("Cannot create literal schema with no valid values");
		const values = new Set(def.values);
		inst._zod.values = values;
		inst._zod.pattern = new RegExp(`^(${def.values.map((o) => typeof o === "string" ? escapeRegex(o) : o ? escapeRegex(o.toString()) : String(o)).join("|")})$`);
		inst._zod.parse = (payload, _ctx) => {
			const input = payload.value;
			if (values.has(input)) return payload;
			payload.issues.push({
				code: "invalid_value",
				values: def.values,
				input,
				inst
			});
			return payload;
		};
	});
	const $ZodTransform = /*@__PURE__*/ $constructor("$ZodTransform", (inst, def) => {
		$ZodType.init(inst, def);
		inst._zod.optin = "optional";
		inst._zod.parse = (payload, ctx) => {
			if (ctx.direction === "backward") throw new $ZodEncodeError(inst.constructor.name);
			const _out = def.transform(payload.value, payload);
			if (ctx.async) return (_out instanceof Promise ? _out : Promise.resolve(_out)).then((output) => {
				payload.value = output;
				payload.fallback = true;
				return payload;
			});
			if (_out instanceof Promise) throw new $ZodAsyncError();
			payload.value = _out;
			payload.fallback = true;
			return payload;
		};
	});
	function handleOptionalResult(result, input) {
		if (input === void 0 && (result.issues.length || result.fallback)) return {
			issues: [],
			value: void 0
		};
		return result;
	}
	const $ZodOptional = /*@__PURE__*/ $constructor("$ZodOptional", (inst, def) => {
		$ZodType.init(inst, def);
		inst._zod.optin = "optional";
		inst._zod.optout = "optional";
		defineLazy(inst._zod, "values", () => {
			return def.innerType._zod.values ? /* @__PURE__ */ new Set([...def.innerType._zod.values, void 0]) : void 0;
		});
		defineLazy(inst._zod, "pattern", () => {
			const pattern = def.innerType._zod.pattern;
			return pattern ? new RegExp(`^(${cleanRegex(pattern.source)})?$`) : void 0;
		});
		inst._zod.parse = (payload, ctx) => {
			if (def.innerType._zod.optin === "optional") {
				const input = payload.value;
				const result = def.innerType._zod.run(payload, ctx);
				if (result instanceof Promise) return result.then((r) => handleOptionalResult(r, input));
				return handleOptionalResult(result, input);
			}
			if (payload.value === void 0) return payload;
			return def.innerType._zod.run(payload, ctx);
		};
	});
	const $ZodExactOptional = /*@__PURE__*/ $constructor("$ZodExactOptional", (inst, def) => {
		$ZodOptional.init(inst, def);
		defineLazy(inst._zod, "values", () => def.innerType._zod.values);
		defineLazy(inst._zod, "pattern", () => def.innerType._zod.pattern);
		inst._zod.parse = (payload, ctx) => {
			return def.innerType._zod.run(payload, ctx);
		};
	});
	const $ZodNullable = /*@__PURE__*/ $constructor("$ZodNullable", (inst, def) => {
		$ZodType.init(inst, def);
		defineLazy(inst._zod, "optin", () => def.innerType._zod.optin);
		defineLazy(inst._zod, "optout", () => def.innerType._zod.optout);
		defineLazy(inst._zod, "pattern", () => {
			const pattern = def.innerType._zod.pattern;
			return pattern ? new RegExp(`^(${cleanRegex(pattern.source)}|null)$`) : void 0;
		});
		defineLazy(inst._zod, "values", () => {
			return def.innerType._zod.values ? /* @__PURE__ */ new Set([...def.innerType._zod.values, null]) : void 0;
		});
		inst._zod.parse = (payload, ctx) => {
			if (payload.value === null) return payload;
			return def.innerType._zod.run(payload, ctx);
		};
	});
	const $ZodDefault = /*@__PURE__*/ $constructor("$ZodDefault", (inst, def) => {
		$ZodType.init(inst, def);
		inst._zod.optin = "optional";
		defineLazy(inst._zod, "values", () => def.innerType._zod.values);
		inst._zod.parse = (payload, ctx) => {
			if (ctx.direction === "backward") return def.innerType._zod.run(payload, ctx);
			if (payload.value === void 0) {
				payload.value = def.defaultValue;
				/**
				* $ZodDefault returns the default value immediately in forward direction.
				* It doesn't pass the default value into the validator ("prefault"). There's no reason to pass the default value through validation. The validity of the default is enforced by TypeScript statically. Otherwise, it's the responsibility of the user to ensure the default is valid. In the case of pipes with divergent in/out types, you can specify the default on the `in` schema of your ZodPipe to set a "prefault" for the pipe.   */
				return payload;
			}
			const result = def.innerType._zod.run(payload, ctx);
			if (result instanceof Promise) return result.then((result) => handleDefaultResult(result, def));
			return handleDefaultResult(result, def);
		};
	});
	function handleDefaultResult(payload, def) {
		if (payload.value === void 0) payload.value = def.defaultValue;
		return payload;
	}
	const $ZodPrefault = /*@__PURE__*/ $constructor("$ZodPrefault", (inst, def) => {
		$ZodType.init(inst, def);
		inst._zod.optin = "optional";
		defineLazy(inst._zod, "values", () => def.innerType._zod.values);
		inst._zod.parse = (payload, ctx) => {
			if (ctx.direction === "backward") return def.innerType._zod.run(payload, ctx);
			if (payload.value === void 0) payload.value = def.defaultValue;
			return def.innerType._zod.run(payload, ctx);
		};
	});
	const $ZodNonOptional = /*@__PURE__*/ $constructor("$ZodNonOptional", (inst, def) => {
		$ZodType.init(inst, def);
		defineLazy(inst._zod, "values", () => {
			const v = def.innerType._zod.values;
			return v ? new Set([...v].filter((x) => x !== void 0)) : void 0;
		});
		inst._zod.parse = (payload, ctx) => {
			const result = def.innerType._zod.run(payload, ctx);
			if (result instanceof Promise) return result.then((result) => handleNonOptionalResult(result, inst));
			return handleNonOptionalResult(result, inst);
		};
	});
	function handleNonOptionalResult(payload, inst) {
		if (!payload.issues.length && payload.value === void 0) payload.issues.push({
			code: "invalid_type",
			expected: "nonoptional",
			input: payload.value,
			inst
		});
		return payload;
	}
	const $ZodCatch = /*@__PURE__*/ $constructor("$ZodCatch", (inst, def) => {
		$ZodType.init(inst, def);
		inst._zod.optin = "optional";
		defineLazy(inst._zod, "optout", () => def.innerType._zod.optout);
		defineLazy(inst._zod, "values", () => def.innerType._zod.values);
		inst._zod.parse = (payload, ctx) => {
			if (ctx.direction === "backward") return def.innerType._zod.run(payload, ctx);
			const result = def.innerType._zod.run(payload, ctx);
			if (result instanceof Promise) return result.then((result) => {
				payload.value = result.value;
				if (result.issues.length) {
					payload.value = def.catchValue({
						...payload,
						error: { issues: result.issues.map((iss) => finalizeIssue(iss, ctx, config())) },
						input: payload.value
					});
					payload.issues = [];
					payload.fallback = true;
				}
				return payload;
			});
			payload.value = result.value;
			if (result.issues.length) {
				payload.value = def.catchValue({
					...payload,
					error: { issues: result.issues.map((iss) => finalizeIssue(iss, ctx, config())) },
					input: payload.value
				});
				payload.issues = [];
				payload.fallback = true;
			}
			return payload;
		};
	});
	const $ZodPipe = /*@__PURE__*/ $constructor("$ZodPipe", (inst, def) => {
		$ZodType.init(inst, def);
		defineLazy(inst._zod, "values", () => def.in._zod.values);
		defineLazy(inst._zod, "optin", () => def.in._zod.optin);
		defineLazy(inst._zod, "optout", () => def.out._zod.optout);
		defineLazy(inst._zod, "propValues", () => def.in._zod.propValues);
		inst._zod.parse = (payload, ctx) => {
			if (ctx.direction === "backward") {
				const right = def.out._zod.run(payload, ctx);
				if (right instanceof Promise) return right.then((right) => handlePipeResult(right, def.in, ctx));
				return handlePipeResult(right, def.in, ctx);
			}
			const left = def.in._zod.run(payload, ctx);
			if (left instanceof Promise) return left.then((left) => handlePipeResult(left, def.out, ctx));
			return handlePipeResult(left, def.out, ctx);
		};
	});
	function handlePipeResult(left, next, ctx) {
		if (left.issues.length) {
			left.aborted = true;
			return left;
		}
		return next._zod.run({
			value: left.value,
			issues: left.issues,
			fallback: left.fallback
		}, ctx);
	}
	const $ZodPreprocess = /*@__PURE__*/ $constructor("$ZodPreprocess", (inst, def) => {
		$ZodPipe.init(inst, def);
	});
	const $ZodReadonly = /*@__PURE__*/ $constructor("$ZodReadonly", (inst, def) => {
		$ZodType.init(inst, def);
		defineLazy(inst._zod, "propValues", () => def.innerType._zod.propValues);
		defineLazy(inst._zod, "values", () => def.innerType._zod.values);
		defineLazy(inst._zod, "optin", () => def.innerType?._zod?.optin);
		defineLazy(inst._zod, "optout", () => def.innerType?._zod?.optout);
		inst._zod.parse = (payload, ctx) => {
			if (ctx.direction === "backward") return def.innerType._zod.run(payload, ctx);
			const result = def.innerType._zod.run(payload, ctx);
			if (result instanceof Promise) return result.then(handleReadonlyResult);
			return handleReadonlyResult(result);
		};
	});
	function handleReadonlyResult(payload) {
		payload.value = Object.freeze(payload.value);
		return payload;
	}
	const $ZodLazy = /*@__PURE__*/ $constructor("$ZodLazy", (inst, def) => {
		$ZodType.init(inst, def);
		defineLazy(inst._zod, "innerType", () => {
			const d = def;
			if (!d._cachedInner) d._cachedInner = def.getter();
			return d._cachedInner;
		});
		defineLazy(inst._zod, "pattern", () => inst._zod.innerType?._zod?.pattern);
		defineLazy(inst._zod, "propValues", () => inst._zod.innerType?._zod?.propValues);
		defineLazy(inst._zod, "optin", () => inst._zod.innerType?._zod?.optin ?? void 0);
		defineLazy(inst._zod, "optout", () => inst._zod.innerType?._zod?.optout ?? void 0);
		inst._zod.parse = (payload, ctx) => {
			return inst._zod.innerType._zod.run(payload, ctx);
		};
	});
	const $ZodCustom = /*@__PURE__*/ $constructor("$ZodCustom", (inst, def) => {
		$ZodCheck.init(inst, def);
		$ZodType.init(inst, def);
		inst._zod.parse = (payload, _) => {
			return payload;
		};
		inst._zod.check = (payload) => {
			const input = payload.value;
			const r = def.fn(input);
			if (r instanceof Promise) return r.then((r) => handleRefineResult(r, payload, input, inst));
			handleRefineResult(r, payload, input, inst);
		};
	});
	function handleRefineResult(result, payload, input, inst) {
		if (!result) {
			const _iss = {
				code: "custom",
				input,
				inst,
				path: [...inst._zod.def.path ?? []],
				continue: !inst._zod.def.abort
			};
			if (inst._zod.def.params) _iss.params = inst._zod.def.params;
			payload.issues.push(issue(_iss));
		}
	}
	//#endregion
	//#region ../../node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/core/registries.js
	var _a;
	var $ZodRegistry = class {
		constructor() {
			this._map = /* @__PURE__ */ new WeakMap();
			this._idmap = /* @__PURE__ */ new Map();
		}
		add(schema, ..._meta) {
			const meta = _meta[0];
			this._map.set(schema, meta);
			if (meta && typeof meta === "object" && "id" in meta) this._idmap.set(meta.id, schema);
			return this;
		}
		clear() {
			this._map = /* @__PURE__ */ new WeakMap();
			this._idmap = /* @__PURE__ */ new Map();
			return this;
		}
		remove(schema) {
			const meta = this._map.get(schema);
			if (meta && typeof meta === "object" && "id" in meta) this._idmap.delete(meta.id);
			this._map.delete(schema);
			return this;
		}
		get(schema) {
			const p = schema._zod.parent;
			if (p) {
				const pm = { ...this.get(p) ?? {} };
				delete pm.id;
				const f = {
					...pm,
					...this._map.get(schema)
				};
				return Object.keys(f).length ? f : void 0;
			}
			return this._map.get(schema);
		}
		has(schema) {
			return this._map.has(schema);
		}
	};
	function registry() {
		return new $ZodRegistry();
	}
	(_a = globalThis).__zod_globalRegistry ?? (_a.__zod_globalRegistry = registry());
	const globalRegistry = globalThis.__zod_globalRegistry;
	//#endregion
	//#region ../../node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/core/api.js
	// @__NO_SIDE_EFFECTS__
	function _string(Class, params) {
		return new Class({
			type: "string",
			...normalizeParams(params)
		});
	}
	// @__NO_SIDE_EFFECTS__
	function _email(Class, params) {
		return new Class({
			type: "string",
			format: "email",
			check: "string_format",
			abort: false,
			...normalizeParams(params)
		});
	}
	// @__NO_SIDE_EFFECTS__
	function _guid(Class, params) {
		return new Class({
			type: "string",
			format: "guid",
			check: "string_format",
			abort: false,
			...normalizeParams(params)
		});
	}
	// @__NO_SIDE_EFFECTS__
	function _uuid(Class, params) {
		return new Class({
			type: "string",
			format: "uuid",
			check: "string_format",
			abort: false,
			...normalizeParams(params)
		});
	}
	// @__NO_SIDE_EFFECTS__
	function _uuidv4(Class, params) {
		return new Class({
			type: "string",
			format: "uuid",
			check: "string_format",
			abort: false,
			version: "v4",
			...normalizeParams(params)
		});
	}
	// @__NO_SIDE_EFFECTS__
	function _uuidv6(Class, params) {
		return new Class({
			type: "string",
			format: "uuid",
			check: "string_format",
			abort: false,
			version: "v6",
			...normalizeParams(params)
		});
	}
	// @__NO_SIDE_EFFECTS__
	function _uuidv7(Class, params) {
		return new Class({
			type: "string",
			format: "uuid",
			check: "string_format",
			abort: false,
			version: "v7",
			...normalizeParams(params)
		});
	}
	// @__NO_SIDE_EFFECTS__
	function _url(Class, params) {
		return new Class({
			type: "string",
			format: "url",
			check: "string_format",
			abort: false,
			...normalizeParams(params)
		});
	}
	// @__NO_SIDE_EFFECTS__
	function _emoji(Class, params) {
		return new Class({
			type: "string",
			format: "emoji",
			check: "string_format",
			abort: false,
			...normalizeParams(params)
		});
	}
	// @__NO_SIDE_EFFECTS__
	function _nanoid(Class, params) {
		return new Class({
			type: "string",
			format: "nanoid",
			check: "string_format",
			abort: false,
			...normalizeParams(params)
		});
	}
	/**
	* @deprecated CUID v1 is deprecated by its authors due to information leakage
	* (timestamps embedded in the id). Use {@link _cuid2} instead.
	* See https://github.com/paralleldrive/cuid.
	*/
	// @__NO_SIDE_EFFECTS__
	function _cuid(Class, params) {
		return new Class({
			type: "string",
			format: "cuid",
			check: "string_format",
			abort: false,
			...normalizeParams(params)
		});
	}
	// @__NO_SIDE_EFFECTS__
	function _cuid2(Class, params) {
		return new Class({
			type: "string",
			format: "cuid2",
			check: "string_format",
			abort: false,
			...normalizeParams(params)
		});
	}
	// @__NO_SIDE_EFFECTS__
	function _ulid(Class, params) {
		return new Class({
			type: "string",
			format: "ulid",
			check: "string_format",
			abort: false,
			...normalizeParams(params)
		});
	}
	// @__NO_SIDE_EFFECTS__
	function _xid(Class, params) {
		return new Class({
			type: "string",
			format: "xid",
			check: "string_format",
			abort: false,
			...normalizeParams(params)
		});
	}
	// @__NO_SIDE_EFFECTS__
	function _ksuid(Class, params) {
		return new Class({
			type: "string",
			format: "ksuid",
			check: "string_format",
			abort: false,
			...normalizeParams(params)
		});
	}
	// @__NO_SIDE_EFFECTS__
	function _ipv4(Class, params) {
		return new Class({
			type: "string",
			format: "ipv4",
			check: "string_format",
			abort: false,
			...normalizeParams(params)
		});
	}
	// @__NO_SIDE_EFFECTS__
	function _ipv6(Class, params) {
		return new Class({
			type: "string",
			format: "ipv6",
			check: "string_format",
			abort: false,
			...normalizeParams(params)
		});
	}
	// @__NO_SIDE_EFFECTS__
	function _cidrv4(Class, params) {
		return new Class({
			type: "string",
			format: "cidrv4",
			check: "string_format",
			abort: false,
			...normalizeParams(params)
		});
	}
	// @__NO_SIDE_EFFECTS__
	function _cidrv6(Class, params) {
		return new Class({
			type: "string",
			format: "cidrv6",
			check: "string_format",
			abort: false,
			...normalizeParams(params)
		});
	}
	// @__NO_SIDE_EFFECTS__
	function _base64(Class, params) {
		return new Class({
			type: "string",
			format: "base64",
			check: "string_format",
			abort: false,
			...normalizeParams(params)
		});
	}
	// @__NO_SIDE_EFFECTS__
	function _base64url(Class, params) {
		return new Class({
			type: "string",
			format: "base64url",
			check: "string_format",
			abort: false,
			...normalizeParams(params)
		});
	}
	// @__NO_SIDE_EFFECTS__
	function _e164(Class, params) {
		return new Class({
			type: "string",
			format: "e164",
			check: "string_format",
			abort: false,
			...normalizeParams(params)
		});
	}
	// @__NO_SIDE_EFFECTS__
	function _jwt(Class, params) {
		return new Class({
			type: "string",
			format: "jwt",
			check: "string_format",
			abort: false,
			...normalizeParams(params)
		});
	}
	// @__NO_SIDE_EFFECTS__
	function _isoDateTime(Class, params) {
		return new Class({
			type: "string",
			format: "datetime",
			check: "string_format",
			offset: false,
			local: false,
			precision: null,
			...normalizeParams(params)
		});
	}
	// @__NO_SIDE_EFFECTS__
	function _isoDate(Class, params) {
		return new Class({
			type: "string",
			format: "date",
			check: "string_format",
			...normalizeParams(params)
		});
	}
	// @__NO_SIDE_EFFECTS__
	function _isoTime(Class, params) {
		return new Class({
			type: "string",
			format: "time",
			check: "string_format",
			precision: null,
			...normalizeParams(params)
		});
	}
	// @__NO_SIDE_EFFECTS__
	function _isoDuration(Class, params) {
		return new Class({
			type: "string",
			format: "duration",
			check: "string_format",
			...normalizeParams(params)
		});
	}
	// @__NO_SIDE_EFFECTS__
	function _number(Class, params) {
		return new Class({
			type: "number",
			checks: [],
			...normalizeParams(params)
		});
	}
	// @__NO_SIDE_EFFECTS__
	function _coercedNumber(Class, params) {
		return new Class({
			type: "number",
			coerce: true,
			checks: [],
			...normalizeParams(params)
		});
	}
	// @__NO_SIDE_EFFECTS__
	function _int(Class, params) {
		return new Class({
			type: "number",
			check: "number_format",
			abort: false,
			format: "safeint",
			...normalizeParams(params)
		});
	}
	// @__NO_SIDE_EFFECTS__
	function _boolean(Class, params) {
		return new Class({
			type: "boolean",
			...normalizeParams(params)
		});
	}
	// @__NO_SIDE_EFFECTS__
	function _null$1(Class, params) {
		return new Class({
			type: "null",
			...normalizeParams(params)
		});
	}
	// @__NO_SIDE_EFFECTS__
	function _any(Class) {
		return new Class({ type: "any" });
	}
	// @__NO_SIDE_EFFECTS__
	function _unknown(Class) {
		return new Class({ type: "unknown" });
	}
	// @__NO_SIDE_EFFECTS__
	function _never(Class, params) {
		return new Class({
			type: "never",
			...normalizeParams(params)
		});
	}
	// @__NO_SIDE_EFFECTS__
	function _lt(value, params) {
		return new $ZodCheckLessThan({
			check: "less_than",
			...normalizeParams(params),
			value,
			inclusive: false
		});
	}
	// @__NO_SIDE_EFFECTS__
	function _lte(value, params) {
		return new $ZodCheckLessThan({
			check: "less_than",
			...normalizeParams(params),
			value,
			inclusive: true
		});
	}
	// @__NO_SIDE_EFFECTS__
	function _gt(value, params) {
		return new $ZodCheckGreaterThan({
			check: "greater_than",
			...normalizeParams(params),
			value,
			inclusive: false
		});
	}
	// @__NO_SIDE_EFFECTS__
	function _gte(value, params) {
		return new $ZodCheckGreaterThan({
			check: "greater_than",
			...normalizeParams(params),
			value,
			inclusive: true
		});
	}
	// @__NO_SIDE_EFFECTS__
	function _multipleOf(value, params) {
		return new $ZodCheckMultipleOf({
			check: "multiple_of",
			...normalizeParams(params),
			value
		});
	}
	// @__NO_SIDE_EFFECTS__
	function _maxLength(maximum, params) {
		return new $ZodCheckMaxLength({
			check: "max_length",
			...normalizeParams(params),
			maximum
		});
	}
	// @__NO_SIDE_EFFECTS__
	function _minLength(minimum, params) {
		return new $ZodCheckMinLength({
			check: "min_length",
			...normalizeParams(params),
			minimum
		});
	}
	// @__NO_SIDE_EFFECTS__
	function _length(length, params) {
		return new $ZodCheckLengthEquals({
			check: "length_equals",
			...normalizeParams(params),
			length
		});
	}
	// @__NO_SIDE_EFFECTS__
	function _regex(pattern, params) {
		return new $ZodCheckRegex({
			check: "string_format",
			format: "regex",
			...normalizeParams(params),
			pattern
		});
	}
	// @__NO_SIDE_EFFECTS__
	function _lowercase(params) {
		return new $ZodCheckLowerCase({
			check: "string_format",
			format: "lowercase",
			...normalizeParams(params)
		});
	}
	// @__NO_SIDE_EFFECTS__
	function _uppercase(params) {
		return new $ZodCheckUpperCase({
			check: "string_format",
			format: "uppercase",
			...normalizeParams(params)
		});
	}
	// @__NO_SIDE_EFFECTS__
	function _includes(includes, params) {
		return new $ZodCheckIncludes({
			check: "string_format",
			format: "includes",
			...normalizeParams(params),
			includes
		});
	}
	// @__NO_SIDE_EFFECTS__
	function _startsWith(prefix, params) {
		return new $ZodCheckStartsWith({
			check: "string_format",
			format: "starts_with",
			...normalizeParams(params),
			prefix
		});
	}
	// @__NO_SIDE_EFFECTS__
	function _endsWith(suffix, params) {
		return new $ZodCheckEndsWith({
			check: "string_format",
			format: "ends_with",
			...normalizeParams(params),
			suffix
		});
	}
	// @__NO_SIDE_EFFECTS__
	function _overwrite(tx) {
		return new $ZodCheckOverwrite({
			check: "overwrite",
			tx
		});
	}
	// @__NO_SIDE_EFFECTS__
	function _normalize(form) {
		return /* @__PURE__ */ _overwrite((input) => input.normalize(form));
	}
	// @__NO_SIDE_EFFECTS__
	function _trim() {
		return /* @__PURE__ */ _overwrite((input) => input.trim());
	}
	// @__NO_SIDE_EFFECTS__
	function _toLowerCase() {
		return /* @__PURE__ */ _overwrite((input) => input.toLowerCase());
	}
	// @__NO_SIDE_EFFECTS__
	function _toUpperCase() {
		return /* @__PURE__ */ _overwrite((input) => input.toUpperCase());
	}
	// @__NO_SIDE_EFFECTS__
	function _slugify() {
		return /* @__PURE__ */ _overwrite((input) => slugify(input));
	}
	// @__NO_SIDE_EFFECTS__
	function _array(Class, element, params) {
		return new Class({
			type: "array",
			element,
			...normalizeParams(params)
		});
	}
	// @__NO_SIDE_EFFECTS__
	function _refine(Class, fn, _params) {
		return new Class({
			type: "custom",
			check: "custom",
			fn,
			...normalizeParams(_params)
		});
	}
	// @__NO_SIDE_EFFECTS__
	function _superRefine(fn, params) {
		const ch = /* @__PURE__ */ _check((payload) => {
			payload.addIssue = (issue$2) => {
				if (typeof issue$2 === "string") payload.issues.push(issue(issue$2, payload.value, ch._zod.def));
				else {
					const _issue = issue$2;
					if (_issue.fatal) _issue.continue = false;
					_issue.code ?? (_issue.code = "custom");
					_issue.input ?? (_issue.input = payload.value);
					_issue.inst ?? (_issue.inst = ch);
					_issue.continue ?? (_issue.continue = !ch._zod.def.abort);
					payload.issues.push(issue(_issue));
				}
			};
			return fn(payload.value, payload);
		}, params);
		return ch;
	}
	// @__NO_SIDE_EFFECTS__
	function _check(fn, params) {
		const ch = new $ZodCheck({
			check: "custom",
			...normalizeParams(params)
		});
		ch._zod.check = fn;
		return ch;
	}
	//#endregion
	//#region ../../node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/core/to-json-schema.js
	function initializeContext(params) {
		let target = params?.target ?? "draft-2020-12";
		if (target === "draft-4") target = "draft-04";
		if (target === "draft-7") target = "draft-07";
		return {
			processors: params.processors ?? {},
			metadataRegistry: params?.metadata ?? globalRegistry,
			target,
			unrepresentable: params?.unrepresentable ?? "throw",
			override: params?.override ?? (() => {}),
			io: params?.io ?? "output",
			counter: 0,
			seen: /* @__PURE__ */ new Map(),
			cycles: params?.cycles ?? "ref",
			reused: params?.reused ?? "inline",
			external: params?.external ?? void 0
		};
	}
	function process(schema, ctx, _params = {
		path: [],
		schemaPath: []
	}) {
		var _a;
		const def = schema._zod.def;
		const seen = ctx.seen.get(schema);
		if (seen) {
			seen.count++;
			if (_params.schemaPath.includes(schema)) seen.cycle = _params.path;
			return seen.schema;
		}
		const result = {
			schema: {},
			count: 1,
			cycle: void 0,
			path: _params.path
		};
		ctx.seen.set(schema, result);
		const overrideSchema = schema._zod.toJSONSchema?.();
		if (overrideSchema) result.schema = overrideSchema;
		else {
			const params = {
				..._params,
				schemaPath: [..._params.schemaPath, schema],
				path: _params.path
			};
			if (schema._zod.processJSONSchema) schema._zod.processJSONSchema(ctx, result.schema, params);
			else {
				const _json = result.schema;
				const processor = ctx.processors[def.type];
				if (!processor) throw new Error(`[toJSONSchema]: Non-representable type encountered: ${def.type}`);
				processor(schema, ctx, _json, params);
			}
			const parent = schema._zod.parent;
			if (parent) {
				if (!result.ref) result.ref = parent;
				process(parent, ctx, params);
				ctx.seen.get(parent).isParent = true;
			}
		}
		const meta = ctx.metadataRegistry.get(schema);
		if (meta) Object.assign(result.schema, meta);
		if (ctx.io === "input" && isTransforming(schema)) {
			delete result.schema.examples;
			delete result.schema.default;
		}
		if (ctx.io === "input" && "_prefault" in result.schema) (_a = result.schema).default ?? (_a.default = result.schema._prefault);
		delete result.schema._prefault;
		return ctx.seen.get(schema).schema;
	}
	function extractDefs(ctx, schema) {
		const root = ctx.seen.get(schema);
		if (!root) throw new Error("Unprocessed schema. This is a bug in Zod.");
		const idToSchema = /* @__PURE__ */ new Map();
		for (const entry of ctx.seen.entries()) {
			const id = ctx.metadataRegistry.get(entry[0])?.id;
			if (id) {
				const existing = idToSchema.get(id);
				if (existing && existing !== entry[0]) throw new Error(`Duplicate schema id "${id}" detected during JSON Schema conversion. Two different schemas cannot share the same id when converted together.`);
				idToSchema.set(id, entry[0]);
			}
		}
		const makeURI = (entry) => {
			const defsSegment = ctx.target === "draft-2020-12" ? "$defs" : "definitions";
			if (ctx.external) {
				const externalId = ctx.external.registry.get(entry[0])?.id;
				const uriGenerator = ctx.external.uri ?? ((id) => id);
				if (externalId) return { ref: uriGenerator(externalId) };
				const id = entry[1].defId ?? entry[1].schema.id ?? `schema${ctx.counter++}`;
				entry[1].defId = id;
				return {
					defId: id,
					ref: `${uriGenerator("__shared")}#/${defsSegment}/${id}`
				};
			}
			if (entry[1] === root) return { ref: "#" };
			const defUriPrefix = `#/${defsSegment}/`;
			const defId = entry[1].schema.id ?? `__schema${ctx.counter++}`;
			return {
				defId,
				ref: defUriPrefix + defId
			};
		};
		const extractToDef = (entry) => {
			if (entry[1].schema.$ref) return;
			const seen = entry[1];
			const { ref, defId } = makeURI(entry);
			seen.def = { ...seen.schema };
			if (defId) seen.defId = defId;
			const schema = seen.schema;
			for (const key in schema) delete schema[key];
			schema.$ref = ref;
		};
		if (ctx.cycles === "throw") for (const entry of ctx.seen.entries()) {
			const seen = entry[1];
			if (seen.cycle) throw new Error(`Cycle detected: #/${seen.cycle?.join("/")}/<root>

Set the \`cycles\` parameter to \`"ref"\` to resolve cyclical schemas with defs.`);
		}
		for (const entry of ctx.seen.entries()) {
			const seen = entry[1];
			if (schema === entry[0]) {
				extractToDef(entry);
				continue;
			}
			if (ctx.external) {
				const ext = ctx.external.registry.get(entry[0])?.id;
				if (schema !== entry[0] && ext) {
					extractToDef(entry);
					continue;
				}
			}
			if (ctx.metadataRegistry.get(entry[0])?.id) {
				extractToDef(entry);
				continue;
			}
			if (seen.cycle) {
				extractToDef(entry);
				continue;
			}
			if (seen.count > 1) {
				if (ctx.reused === "ref") {
					extractToDef(entry);
					continue;
				}
			}
		}
	}
	function finalize(ctx, schema) {
		const root = ctx.seen.get(schema);
		if (!root) throw new Error("Unprocessed schema. This is a bug in Zod.");
		const flattenRef = (zodSchema) => {
			const seen = ctx.seen.get(zodSchema);
			if (seen.ref === null) return;
			const schema = seen.def ?? seen.schema;
			const _cached = { ...schema };
			const ref = seen.ref;
			seen.ref = null;
			if (ref) {
				flattenRef(ref);
				const refSeen = ctx.seen.get(ref);
				const refSchema = refSeen.schema;
				if (refSchema.$ref && (ctx.target === "draft-07" || ctx.target === "draft-04" || ctx.target === "openapi-3.0")) {
					schema.allOf = schema.allOf ?? [];
					schema.allOf.push(refSchema);
				} else Object.assign(schema, refSchema);
				Object.assign(schema, _cached);
				if (zodSchema._zod.parent === ref) for (const key in schema) {
					if (key === "$ref" || key === "allOf") continue;
					if (!(key in _cached)) delete schema[key];
				}
				if (refSchema.$ref && refSeen.def) for (const key in schema) {
					if (key === "$ref" || key === "allOf") continue;
					if (key in refSeen.def && JSON.stringify(schema[key]) === JSON.stringify(refSeen.def[key])) delete schema[key];
				}
			}
			const parent = zodSchema._zod.parent;
			if (parent && parent !== ref) {
				flattenRef(parent);
				const parentSeen = ctx.seen.get(parent);
				if (parentSeen?.schema.$ref) {
					schema.$ref = parentSeen.schema.$ref;
					if (parentSeen.def) for (const key in schema) {
						if (key === "$ref" || key === "allOf") continue;
						if (key in parentSeen.def && JSON.stringify(schema[key]) === JSON.stringify(parentSeen.def[key])) delete schema[key];
					}
				}
			}
			ctx.override({
				zodSchema,
				jsonSchema: schema,
				path: seen.path ?? []
			});
		};
		for (const entry of [...ctx.seen.entries()].reverse()) flattenRef(entry[0]);
		const result = {};
		if (ctx.target === "draft-2020-12") result.$schema = "https://json-schema.org/draft/2020-12/schema";
		else if (ctx.target === "draft-07") result.$schema = "http://json-schema.org/draft-07/schema#";
		else if (ctx.target === "draft-04") result.$schema = "http://json-schema.org/draft-04/schema#";
		else if (ctx.target === "openapi-3.0") {}
		if (ctx.external?.uri) {
			const id = ctx.external.registry.get(schema)?.id;
			if (!id) throw new Error("Schema is missing an `id` property");
			result.$id = ctx.external.uri(id);
		}
		Object.assign(result, root.def ?? root.schema);
		const rootMetaId = ctx.metadataRegistry.get(schema)?.id;
		if (rootMetaId !== void 0 && result.id === rootMetaId) delete result.id;
		const defs = ctx.external?.defs ?? {};
		for (const entry of ctx.seen.entries()) {
			const seen = entry[1];
			if (seen.def && seen.defId) {
				if (seen.def.id === seen.defId) delete seen.def.id;
				defs[seen.defId] = seen.def;
			}
		}
		if (ctx.external) {} else if (Object.keys(defs).length > 0) {
			if (ctx.target === "draft-2020-12") result.$defs = defs;
			else result.definitions = defs;
		}
		try {
			const finalized = JSON.parse(JSON.stringify(result));
			Object.defineProperty(finalized, "~standard", {
				value: {
					...schema["~standard"],
					jsonSchema: {
						input: createStandardJSONSchemaMethod(schema, "input", ctx.processors),
						output: createStandardJSONSchemaMethod(schema, "output", ctx.processors)
					}
				},
				enumerable: false,
				writable: false
			});
			return finalized;
		} catch (_err) {
			throw new Error("Error converting schema to JSON.");
		}
	}
	function isTransforming(_schema, _ctx) {
		const ctx = _ctx ?? { seen: /* @__PURE__ */ new Set() };
		if (ctx.seen.has(_schema)) return false;
		ctx.seen.add(_schema);
		const def = _schema._zod.def;
		if (def.type === "transform") return true;
		if (def.type === "array") return isTransforming(def.element, ctx);
		if (def.type === "set") return isTransforming(def.valueType, ctx);
		if (def.type === "lazy") return isTransforming(def.getter(), ctx);
		if (def.type === "promise" || def.type === "optional" || def.type === "nonoptional" || def.type === "nullable" || def.type === "readonly" || def.type === "default" || def.type === "prefault") return isTransforming(def.innerType, ctx);
		if (def.type === "intersection") return isTransforming(def.left, ctx) || isTransforming(def.right, ctx);
		if (def.type === "record" || def.type === "map") return isTransforming(def.keyType, ctx) || isTransforming(def.valueType, ctx);
		if (def.type === "pipe") {
			if (_schema._zod.traits.has("$ZodCodec")) return true;
			return isTransforming(def.in, ctx) || isTransforming(def.out, ctx);
		}
		if (def.type === "object") {
			for (const key in def.shape) if (isTransforming(def.shape[key], ctx)) return true;
			return false;
		}
		if (def.type === "union") {
			for (const option of def.options) if (isTransforming(option, ctx)) return true;
			return false;
		}
		if (def.type === "tuple") {
			for (const item of def.items) if (isTransforming(item, ctx)) return true;
			if (def.rest && isTransforming(def.rest, ctx)) return true;
			return false;
		}
		return false;
	}
	/**
	* Creates a toJSONSchema method for a schema instance.
	* This encapsulates the logic of initializing context, processing, extracting defs, and finalizing.
	*/
	const createToJSONSchemaMethod = (schema, processors = {}) => (params) => {
		const ctx = initializeContext({
			...params,
			processors
		});
		process(schema, ctx);
		extractDefs(ctx, schema);
		return finalize(ctx, schema);
	};
	const createStandardJSONSchemaMethod = (schema, io, processors = {}) => (params) => {
		const { libraryOptions, target } = params ?? {};
		const ctx = initializeContext({
			...libraryOptions ?? {},
			target,
			io,
			processors
		});
		process(schema, ctx);
		extractDefs(ctx, schema);
		return finalize(ctx, schema);
	};
	//#endregion
	//#region ../../node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/core/json-schema-processors.js
	const formatMap = {
		guid: "uuid",
		url: "uri",
		datetime: "date-time",
		json_string: "json-string",
		regex: ""
	};
	const stringProcessor = (schema, ctx, _json, _params) => {
		const json = _json;
		json.type = "string";
		const { minimum, maximum, format, patterns, contentEncoding } = schema._zod.bag;
		if (typeof minimum === "number") json.minLength = minimum;
		if (typeof maximum === "number") json.maxLength = maximum;
		if (format) {
			json.format = formatMap[format] ?? format;
			if (json.format === "") delete json.format;
			if (format === "time") delete json.format;
		}
		if (contentEncoding) json.contentEncoding = contentEncoding;
		if (patterns && patterns.size > 0) {
			const regexes = [...patterns];
			if (regexes.length === 1) json.pattern = regexes[0].source;
			else if (regexes.length > 1) json.allOf = [...regexes.map((regex) => ({
				...ctx.target === "draft-07" || ctx.target === "draft-04" || ctx.target === "openapi-3.0" ? { type: "string" } : {},
				pattern: regex.source
			}))];
		}
	};
	const numberProcessor = (schema, ctx, _json, _params) => {
		const json = _json;
		const { minimum, maximum, format, multipleOf, exclusiveMaximum, exclusiveMinimum } = schema._zod.bag;
		if (typeof format === "string" && format.includes("int")) json.type = "integer";
		else json.type = "number";
		const exMin = typeof exclusiveMinimum === "number" && exclusiveMinimum >= (minimum ?? Number.NEGATIVE_INFINITY);
		const exMax = typeof exclusiveMaximum === "number" && exclusiveMaximum <= (maximum ?? Number.POSITIVE_INFINITY);
		const legacy = ctx.target === "draft-04" || ctx.target === "openapi-3.0";
		if (exMin) {
			if (legacy) {
				json.minimum = exclusiveMinimum;
				json.exclusiveMinimum = true;
			} else json.exclusiveMinimum = exclusiveMinimum;
		} else if (typeof minimum === "number") json.minimum = minimum;
		if (exMax) {
			if (legacy) {
				json.maximum = exclusiveMaximum;
				json.exclusiveMaximum = true;
			} else json.exclusiveMaximum = exclusiveMaximum;
		} else if (typeof maximum === "number") json.maximum = maximum;
		if (typeof multipleOf === "number") json.multipleOf = multipleOf;
	};
	const booleanProcessor = (_schema, _ctx, json, _params) => {
		json.type = "boolean";
	};
	const bigintProcessor = (_schema, ctx, _json, _params) => {
		if (ctx.unrepresentable === "throw") throw new Error("BigInt cannot be represented in JSON Schema");
	};
	const symbolProcessor = (_schema, ctx, _json, _params) => {
		if (ctx.unrepresentable === "throw") throw new Error("Symbols cannot be represented in JSON Schema");
	};
	const nullProcessor = (_schema, ctx, json, _params) => {
		if (ctx.target === "openapi-3.0") {
			json.type = "string";
			json.nullable = true;
			json.enum = [null];
		} else json.type = "null";
	};
	const undefinedProcessor = (_schema, ctx, _json, _params) => {
		if (ctx.unrepresentable === "throw") throw new Error("Undefined cannot be represented in JSON Schema");
	};
	const voidProcessor = (_schema, ctx, _json, _params) => {
		if (ctx.unrepresentable === "throw") throw new Error("Void cannot be represented in JSON Schema");
	};
	const neverProcessor = (_schema, _ctx, json, _params) => {
		json.not = {};
	};
	const anyProcessor = (_schema, _ctx, _json, _params) => {};
	const unknownProcessor = (_schema, _ctx, _json, _params) => {};
	const dateProcessor = (_schema, ctx, _json, _params) => {
		if (ctx.unrepresentable === "throw") throw new Error("Date cannot be represented in JSON Schema");
	};
	const enumProcessor = (schema, _ctx, json, _params) => {
		const def = schema._zod.def;
		const values = getEnumValues(def.entries);
		if (values.every((v) => typeof v === "number")) json.type = "number";
		if (values.every((v) => typeof v === "string")) json.type = "string";
		json.enum = values;
	};
	const literalProcessor = (schema, ctx, json, _params) => {
		const def = schema._zod.def;
		const vals = [];
		for (const val of def.values) if (val === void 0) {
			if (ctx.unrepresentable === "throw") throw new Error("Literal `undefined` cannot be represented in JSON Schema");
		} else if (typeof val === "bigint") {
			if (ctx.unrepresentable === "throw") throw new Error("BigInt literals cannot be represented in JSON Schema");
			else vals.push(Number(val));
		} else vals.push(val);
		if (vals.length === 0) {} else if (vals.length === 1) {
			const val = vals[0];
			json.type = val === null ? "null" : typeof val;
			if (ctx.target === "draft-04" || ctx.target === "openapi-3.0") json.enum = [val];
			else json.const = val;
		} else {
			if (vals.every((v) => typeof v === "number")) json.type = "number";
			if (vals.every((v) => typeof v === "string")) json.type = "string";
			if (vals.every((v) => typeof v === "boolean")) json.type = "boolean";
			if (vals.every((v) => v === null)) json.type = "null";
			json.enum = vals;
		}
	};
	const nanProcessor = (_schema, ctx, _json, _params) => {
		if (ctx.unrepresentable === "throw") throw new Error("NaN cannot be represented in JSON Schema");
	};
	const templateLiteralProcessor = (schema, _ctx, json, _params) => {
		const _json = json;
		const pattern = schema._zod.pattern;
		if (!pattern) throw new Error("Pattern not found in template literal");
		_json.type = "string";
		_json.pattern = pattern.source;
	};
	const fileProcessor = (schema, _ctx, json, _params) => {
		const _json = json;
		const file = {
			type: "string",
			format: "binary",
			contentEncoding: "binary"
		};
		const { minimum, maximum, mime } = schema._zod.bag;
		if (minimum !== void 0) file.minLength = minimum;
		if (maximum !== void 0) file.maxLength = maximum;
		if (mime) {
			if (mime.length === 1) {
				file.contentMediaType = mime[0];
				Object.assign(_json, file);
			} else {
				Object.assign(_json, file);
				_json.anyOf = mime.map((m) => ({ contentMediaType: m }));
			}
		} else Object.assign(_json, file);
	};
	const successProcessor = (_schema, _ctx, json, _params) => {
		json.type = "boolean";
	};
	const customProcessor = (_schema, ctx, _json, _params) => {
		if (ctx.unrepresentable === "throw") throw new Error("Custom types cannot be represented in JSON Schema");
	};
	const functionProcessor = (_schema, ctx, _json, _params) => {
		if (ctx.unrepresentable === "throw") throw new Error("Function types cannot be represented in JSON Schema");
	};
	const transformProcessor = (_schema, ctx, _json, _params) => {
		if (ctx.unrepresentable === "throw") throw new Error("Transforms cannot be represented in JSON Schema");
	};
	const mapProcessor = (_schema, ctx, _json, _params) => {
		if (ctx.unrepresentable === "throw") throw new Error("Map cannot be represented in JSON Schema");
	};
	const setProcessor = (_schema, ctx, _json, _params) => {
		if (ctx.unrepresentable === "throw") throw new Error("Set cannot be represented in JSON Schema");
	};
	const arrayProcessor = (schema, ctx, _json, params) => {
		const json = _json;
		const def = schema._zod.def;
		const { minimum, maximum } = schema._zod.bag;
		if (typeof minimum === "number") json.minItems = minimum;
		if (typeof maximum === "number") json.maxItems = maximum;
		json.type = "array";
		json.items = process(def.element, ctx, {
			...params,
			path: [...params.path, "items"]
		});
	};
	const objectProcessor = (schema, ctx, _json, params) => {
		const json = _json;
		const def = schema._zod.def;
		json.type = "object";
		json.properties = {};
		const shape = def.shape;
		for (const key in shape) json.properties[key] = process(shape[key], ctx, {
			...params,
			path: [
				...params.path,
				"properties",
				key
			]
		});
		const allKeys = new Set(Object.keys(shape));
		const requiredKeys = new Set([...allKeys].filter((key) => {
			const v = def.shape[key]._zod;
			if (ctx.io === "input") return v.optin === void 0;
			else return v.optout === void 0;
		}));
		if (requiredKeys.size > 0) json.required = Array.from(requiredKeys);
		if (def.catchall?._zod.def.type === "never") json.additionalProperties = false;
		else if (!def.catchall) {
			if (ctx.io === "output") json.additionalProperties = false;
		} else if (def.catchall) json.additionalProperties = process(def.catchall, ctx, {
			...params,
			path: [...params.path, "additionalProperties"]
		});
	};
	const unionProcessor = (schema, ctx, json, params) => {
		const def = schema._zod.def;
		const isExclusive = def.inclusive === false;
		const options = def.options.map((x, i) => process(x, ctx, {
			...params,
			path: [
				...params.path,
				isExclusive ? "oneOf" : "anyOf",
				i
			]
		}));
		if (isExclusive) json.oneOf = options;
		else json.anyOf = options;
	};
	const intersectionProcessor = (schema, ctx, json, params) => {
		const def = schema._zod.def;
		const a = process(def.left, ctx, {
			...params,
			path: [
				...params.path,
				"allOf",
				0
			]
		});
		const b = process(def.right, ctx, {
			...params,
			path: [
				...params.path,
				"allOf",
				1
			]
		});
		const isSimpleIntersection = (val) => "allOf" in val && Object.keys(val).length === 1;
		json.allOf = [...isSimpleIntersection(a) ? a.allOf : [a], ...isSimpleIntersection(b) ? b.allOf : [b]];
	};
	const tupleProcessor = (schema, ctx, _json, params) => {
		const json = _json;
		const def = schema._zod.def;
		json.type = "array";
		const prefixPath = ctx.target === "draft-2020-12" ? "prefixItems" : "items";
		const restPath = ctx.target === "draft-2020-12" ? "items" : ctx.target === "openapi-3.0" ? "items" : "additionalItems";
		const prefixItems = def.items.map((x, i) => process(x, ctx, {
			...params,
			path: [
				...params.path,
				prefixPath,
				i
			]
		}));
		const rest = def.rest ? process(def.rest, ctx, {
			...params,
			path: [
				...params.path,
				restPath,
				...ctx.target === "openapi-3.0" ? [def.items.length] : []
			]
		}) : null;
		if (ctx.target === "draft-2020-12") {
			json.prefixItems = prefixItems;
			if (rest) json.items = rest;
		} else if (ctx.target === "openapi-3.0") {
			json.items = { anyOf: prefixItems };
			if (rest) json.items.anyOf.push(rest);
			json.minItems = prefixItems.length;
			if (!rest) json.maxItems = prefixItems.length;
		} else {
			json.items = prefixItems;
			if (rest) json.additionalItems = rest;
		}
		const { minimum, maximum } = schema._zod.bag;
		if (typeof minimum === "number") json.minItems = minimum;
		if (typeof maximum === "number") json.maxItems = maximum;
	};
	const recordProcessor = (schema, ctx, _json, params) => {
		const json = _json;
		const def = schema._zod.def;
		json.type = "object";
		const keyType = def.keyType;
		const patterns = keyType._zod.bag?.patterns;
		if (def.mode === "loose" && patterns && patterns.size > 0) {
			const valueSchema = process(def.valueType, ctx, {
				...params,
				path: [
					...params.path,
					"patternProperties",
					"*"
				]
			});
			json.patternProperties = {};
			for (const pattern of patterns) json.patternProperties[pattern.source] = valueSchema;
		} else {
			if (ctx.target === "draft-07" || ctx.target === "draft-2020-12") json.propertyNames = process(def.keyType, ctx, {
				...params,
				path: [...params.path, "propertyNames"]
			});
			json.additionalProperties = process(def.valueType, ctx, {
				...params,
				path: [...params.path, "additionalProperties"]
			});
		}
		const keyValues = keyType._zod.values;
		if (keyValues) {
			const validKeyValues = [...keyValues].filter((v) => typeof v === "string" || typeof v === "number");
			if (validKeyValues.length > 0) json.required = validKeyValues;
		}
	};
	const nullableProcessor = (schema, ctx, json, params) => {
		const def = schema._zod.def;
		const inner = process(def.innerType, ctx, params);
		const seen = ctx.seen.get(schema);
		if (ctx.target === "openapi-3.0") {
			seen.ref = def.innerType;
			json.nullable = true;
		} else json.anyOf = [inner, { type: "null" }];
	};
	const nonoptionalProcessor = (schema, ctx, _json, params) => {
		const def = schema._zod.def;
		process(def.innerType, ctx, params);
		const seen = ctx.seen.get(schema);
		seen.ref = def.innerType;
	};
	const defaultProcessor = (schema, ctx, json, params) => {
		const def = schema._zod.def;
		process(def.innerType, ctx, params);
		const seen = ctx.seen.get(schema);
		seen.ref = def.innerType;
		json.default = JSON.parse(JSON.stringify(def.defaultValue));
	};
	const prefaultProcessor = (schema, ctx, json, params) => {
		const def = schema._zod.def;
		process(def.innerType, ctx, params);
		const seen = ctx.seen.get(schema);
		seen.ref = def.innerType;
		if (ctx.io === "input") json._prefault = JSON.parse(JSON.stringify(def.defaultValue));
	};
	const catchProcessor = (schema, ctx, json, params) => {
		const def = schema._zod.def;
		process(def.innerType, ctx, params);
		const seen = ctx.seen.get(schema);
		seen.ref = def.innerType;
		let catchValue;
		try {
			catchValue = def.catchValue(void 0);
		} catch {
			throw new Error("Dynamic catch values are not supported in JSON Schema");
		}
		json.default = catchValue;
	};
	const pipeProcessor = (schema, ctx, _json, params) => {
		const def = schema._zod.def;
		const inIsTransform = def.in._zod.traits.has("$ZodTransform");
		const innerType = ctx.io === "input" ? inIsTransform ? def.out : def.in : def.out;
		process(innerType, ctx, params);
		const seen = ctx.seen.get(schema);
		seen.ref = innerType;
	};
	const readonlyProcessor = (schema, ctx, json, params) => {
		const def = schema._zod.def;
		process(def.innerType, ctx, params);
		const seen = ctx.seen.get(schema);
		seen.ref = def.innerType;
		json.readOnly = true;
	};
	const promiseProcessor = (schema, ctx, _json, params) => {
		const def = schema._zod.def;
		process(def.innerType, ctx, params);
		const seen = ctx.seen.get(schema);
		seen.ref = def.innerType;
	};
	const optionalProcessor = (schema, ctx, _json, params) => {
		const def = schema._zod.def;
		process(def.innerType, ctx, params);
		const seen = ctx.seen.get(schema);
		seen.ref = def.innerType;
	};
	const lazyProcessor = (schema, ctx, _json, params) => {
		const innerType = schema._zod.innerType;
		process(innerType, ctx, params);
		const seen = ctx.seen.get(schema);
		seen.ref = innerType;
	};
	const allProcessors = {
		string: stringProcessor,
		number: numberProcessor,
		boolean: booleanProcessor,
		bigint: bigintProcessor,
		symbol: symbolProcessor,
		null: nullProcessor,
		undefined: undefinedProcessor,
		void: voidProcessor,
		never: neverProcessor,
		any: anyProcessor,
		unknown: unknownProcessor,
		date: dateProcessor,
		enum: enumProcessor,
		literal: literalProcessor,
		nan: nanProcessor,
		template_literal: templateLiteralProcessor,
		file: fileProcessor,
		success: successProcessor,
		custom: customProcessor,
		function: functionProcessor,
		transform: transformProcessor,
		map: mapProcessor,
		set: setProcessor,
		array: arrayProcessor,
		object: objectProcessor,
		union: unionProcessor,
		intersection: intersectionProcessor,
		tuple: tupleProcessor,
		record: recordProcessor,
		nullable: nullableProcessor,
		nonoptional: nonoptionalProcessor,
		default: defaultProcessor,
		prefault: prefaultProcessor,
		catch: catchProcessor,
		pipe: pipeProcessor,
		readonly: readonlyProcessor,
		promise: promiseProcessor,
		optional: optionalProcessor,
		lazy: lazyProcessor
	};
	function toJSONSchema(input, params) {
		if ("_idmap" in input) {
			const registry = input;
			const ctx = initializeContext({
				...params,
				processors: allProcessors
			});
			const defs = {};
			for (const entry of registry._idmap.entries()) {
				const [_, schema] = entry;
				process(schema, ctx);
			}
			const schemas = {};
			ctx.external = {
				registry,
				uri: params?.uri,
				defs
			};
			for (const entry of registry._idmap.entries()) {
				const [key, schema] = entry;
				extractDefs(ctx, schema);
				schemas[key] = finalize(ctx, schema);
			}
			if (Object.keys(defs).length > 0) schemas.__shared = { [ctx.target === "draft-2020-12" ? "$defs" : "definitions"]: defs };
			return { schemas };
		}
		const ctx = initializeContext({
			...params,
			processors: allProcessors
		});
		process(input, ctx);
		extractDefs(ctx, input);
		return finalize(ctx, input);
	}
	//#endregion
	//#region ../../node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/classic/iso.js
	const ZodISODateTime = /*@__PURE__*/ $constructor("ZodISODateTime", (inst, def) => {
		$ZodISODateTime.init(inst, def);
		ZodStringFormat.init(inst, def);
	});
	function datetime(params) {
		return /* @__PURE__ */ _isoDateTime(ZodISODateTime, params);
	}
	const ZodISODate = /*@__PURE__*/ $constructor("ZodISODate", (inst, def) => {
		$ZodISODate.init(inst, def);
		ZodStringFormat.init(inst, def);
	});
	function date$1(params) {
		return /* @__PURE__ */ _isoDate(ZodISODate, params);
	}
	const ZodISOTime = /*@__PURE__*/ $constructor("ZodISOTime", (inst, def) => {
		$ZodISOTime.init(inst, def);
		ZodStringFormat.init(inst, def);
	});
	function time$1(params) {
		return /* @__PURE__ */ _isoTime(ZodISOTime, params);
	}
	const ZodISODuration = /*@__PURE__*/ $constructor("ZodISODuration", (inst, def) => {
		$ZodISODuration.init(inst, def);
		ZodStringFormat.init(inst, def);
	});
	function duration(params) {
		return /* @__PURE__ */ _isoDuration(ZodISODuration, params);
	}
	//#endregion
	//#region ../../node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/classic/errors.js
	const initializer = (inst, issues) => {
		$ZodError.init(inst, issues);
		inst.name = "ZodError";
		Object.defineProperties(inst, {
			format: { value: (mapper) => formatError(inst, mapper) },
			flatten: { value: (mapper) => flattenError(inst, mapper) },
			addIssue: { value: (issue) => {
				inst.issues.push(issue);
				inst.message = JSON.stringify(inst.issues, jsonStringifyReplacer, 2);
			} },
			addIssues: { value: (issues) => {
				inst.issues.push(...issues);
				inst.message = JSON.stringify(inst.issues, jsonStringifyReplacer, 2);
			} },
			isEmpty: { get() {
				return inst.issues.length === 0;
			} }
		});
	};
	const ZodRealError = /*@__PURE__*/ $constructor("ZodError", initializer, { Parent: Error });
	//#endregion
	//#region ../../node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/classic/parse.js
	const parse = /* @__PURE__ */ _parse(ZodRealError);
	const parseAsync = /* @__PURE__ */ _parseAsync(ZodRealError);
	const safeParse = /* @__PURE__ */ _safeParse(ZodRealError);
	const safeParseAsync = /* @__PURE__ */ _safeParseAsync(ZodRealError);
	const encode = /* @__PURE__ */ _encode(ZodRealError);
	const decode = /* @__PURE__ */ _decode(ZodRealError);
	const encodeAsync = /* @__PURE__ */ _encodeAsync(ZodRealError);
	const decodeAsync = /* @__PURE__ */ _decodeAsync(ZodRealError);
	const safeEncode = /* @__PURE__ */ _safeEncode(ZodRealError);
	const safeDecode = /* @__PURE__ */ _safeDecode(ZodRealError);
	const safeEncodeAsync = /* @__PURE__ */ _safeEncodeAsync(ZodRealError);
	const safeDecodeAsync = /* @__PURE__ */ _safeDecodeAsync(ZodRealError);
	//#endregion
	//#region ../../node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/classic/schemas.js
	const _installedGroups = /* @__PURE__ */ new WeakMap();
	function _installLazyMethods(inst, group, methods) {
		const proto = Object.getPrototypeOf(inst);
		let installed = _installedGroups.get(proto);
		if (!installed) {
			installed = /* @__PURE__ */ new Set();
			_installedGroups.set(proto, installed);
		}
		if (installed.has(group)) return;
		installed.add(group);
		for (const key in methods) {
			const fn = methods[key];
			Object.defineProperty(proto, key, {
				configurable: true,
				enumerable: false,
				get() {
					const bound = fn.bind(this);
					Object.defineProperty(this, key, {
						configurable: true,
						writable: true,
						enumerable: true,
						value: bound
					});
					return bound;
				},
				set(v) {
					Object.defineProperty(this, key, {
						configurable: true,
						writable: true,
						enumerable: true,
						value: v
					});
				}
			});
		}
	}
	const ZodType = /*@__PURE__*/ $constructor("ZodType", (inst, def) => {
		$ZodType.init(inst, def);
		Object.assign(inst["~standard"], { jsonSchema: {
			input: createStandardJSONSchemaMethod(inst, "input"),
			output: createStandardJSONSchemaMethod(inst, "output")
		} });
		inst.toJSONSchema = createToJSONSchemaMethod(inst, {});
		inst.def = def;
		inst.type = def.type;
		Object.defineProperty(inst, "_def", { value: def });
		inst.parse = (data, params) => parse(inst, data, params, { callee: inst.parse });
		inst.safeParse = (data, params) => safeParse(inst, data, params);
		inst.parseAsync = async (data, params) => parseAsync(inst, data, params, { callee: inst.parseAsync });
		inst.safeParseAsync = async (data, params) => safeParseAsync(inst, data, params);
		inst.spa = inst.safeParseAsync;
		inst.encode = (data, params) => encode(inst, data, params);
		inst.decode = (data, params) => decode(inst, data, params);
		inst.encodeAsync = async (data, params) => encodeAsync(inst, data, params);
		inst.decodeAsync = async (data, params) => decodeAsync(inst, data, params);
		inst.safeEncode = (data, params) => safeEncode(inst, data, params);
		inst.safeDecode = (data, params) => safeDecode(inst, data, params);
		inst.safeEncodeAsync = async (data, params) => safeEncodeAsync(inst, data, params);
		inst.safeDecodeAsync = async (data, params) => safeDecodeAsync(inst, data, params);
		_installLazyMethods(inst, "ZodType", {
			check(...chks) {
				const def = this.def;
				return this.clone(mergeDefs(def, { checks: [...def.checks ?? [], ...chks.map((ch) => typeof ch === "function" ? { _zod: {
					check: ch,
					def: { check: "custom" },
					onattach: []
				} } : ch)] }), { parent: true });
			},
			with(...chks) {
				return this.check(...chks);
			},
			clone(def, params) {
				return clone(this, def, params);
			},
			brand() {
				return this;
			},
			register(reg, meta) {
				reg.add(this, meta);
				return this;
			},
			refine(check, params) {
				return this.check(refine(check, params));
			},
			superRefine(refinement, params) {
				return this.check(superRefine(refinement, params));
			},
			overwrite(fn) {
				return this.check(/* @__PURE__ */ _overwrite(fn));
			},
			optional() {
				return optional(this);
			},
			exactOptional() {
				return exactOptional(this);
			},
			nullable() {
				return nullable(this);
			},
			nullish() {
				return optional(nullable(this));
			},
			nonoptional(params) {
				return nonoptional(this, params);
			},
			array() {
				return array(this);
			},
			or(arg) {
				return union([this, arg]);
			},
			and(arg) {
				return intersection(this, arg);
			},
			transform(tx) {
				return pipe(this, transform(tx));
			},
			default(d) {
				return _default(this, d);
			},
			prefault(d) {
				return prefault(this, d);
			},
			catch(params) {
				return _catch(this, params);
			},
			pipe(target) {
				return pipe(this, target);
			},
			readonly() {
				return readonly(this);
			},
			describe(description) {
				const cl = this.clone();
				globalRegistry.add(cl, { description });
				return cl;
			},
			meta(...args) {
				if (args.length === 0) return globalRegistry.get(this);
				const cl = this.clone();
				globalRegistry.add(cl, args[0]);
				return cl;
			},
			isOptional() {
				return this.safeParse(void 0).success;
			},
			isNullable() {
				return this.safeParse(null).success;
			},
			apply(fn) {
				return fn(this);
			}
		});
		Object.defineProperty(inst, "description", {
			get() {
				return globalRegistry.get(inst)?.description;
			},
			configurable: true
		});
		return inst;
	});
	/** @internal */
	const _ZodString = /*@__PURE__*/ $constructor("_ZodString", (inst, def) => {
		$ZodString.init(inst, def);
		ZodType.init(inst, def);
		inst._zod.processJSONSchema = (ctx, json, params) => stringProcessor(inst, ctx, json, params);
		const bag = inst._zod.bag;
		inst.format = bag.format ?? null;
		inst.minLength = bag.minimum ?? null;
		inst.maxLength = bag.maximum ?? null;
		_installLazyMethods(inst, "_ZodString", {
			regex(...args) {
				return this.check(/* @__PURE__ */ _regex(...args));
			},
			includes(...args) {
				return this.check(/* @__PURE__ */ _includes(...args));
			},
			startsWith(...args) {
				return this.check(/* @__PURE__ */ _startsWith(...args));
			},
			endsWith(...args) {
				return this.check(/* @__PURE__ */ _endsWith(...args));
			},
			min(...args) {
				return this.check(/* @__PURE__ */ _minLength(...args));
			},
			max(...args) {
				return this.check(/* @__PURE__ */ _maxLength(...args));
			},
			length(...args) {
				return this.check(/* @__PURE__ */ _length(...args));
			},
			nonempty(...args) {
				return this.check(/* @__PURE__ */ _minLength(1, ...args));
			},
			lowercase(params) {
				return this.check(/* @__PURE__ */ _lowercase(params));
			},
			uppercase(params) {
				return this.check(/* @__PURE__ */ _uppercase(params));
			},
			trim() {
				return this.check(/* @__PURE__ */ _trim());
			},
			normalize(...args) {
				return this.check(/* @__PURE__ */ _normalize(...args));
			},
			toLowerCase() {
				return this.check(/* @__PURE__ */ _toLowerCase());
			},
			toUpperCase() {
				return this.check(/* @__PURE__ */ _toUpperCase());
			},
			slugify() {
				return this.check(/* @__PURE__ */ _slugify());
			}
		});
	});
	const ZodString = /*@__PURE__*/ $constructor("ZodString", (inst, def) => {
		$ZodString.init(inst, def);
		_ZodString.init(inst, def);
		inst.email = (params) => inst.check(/* @__PURE__ */ _email(ZodEmail, params));
		inst.url = (params) => inst.check(/* @__PURE__ */ _url(ZodURL, params));
		inst.jwt = (params) => inst.check(/* @__PURE__ */ _jwt(ZodJWT, params));
		inst.emoji = (params) => inst.check(/* @__PURE__ */ _emoji(ZodEmoji, params));
		inst.guid = (params) => inst.check(/* @__PURE__ */ _guid(ZodGUID, params));
		inst.uuid = (params) => inst.check(/* @__PURE__ */ _uuid(ZodUUID, params));
		inst.uuidv4 = (params) => inst.check(/* @__PURE__ */ _uuidv4(ZodUUID, params));
		inst.uuidv6 = (params) => inst.check(/* @__PURE__ */ _uuidv6(ZodUUID, params));
		inst.uuidv7 = (params) => inst.check(/* @__PURE__ */ _uuidv7(ZodUUID, params));
		inst.nanoid = (params) => inst.check(/* @__PURE__ */ _nanoid(ZodNanoID, params));
		inst.guid = (params) => inst.check(/* @__PURE__ */ _guid(ZodGUID, params));
		inst.cuid = (params) => inst.check(/* @__PURE__ */ _cuid(ZodCUID, params));
		inst.cuid2 = (params) => inst.check(/* @__PURE__ */ _cuid2(ZodCUID2, params));
		inst.ulid = (params) => inst.check(/* @__PURE__ */ _ulid(ZodULID, params));
		inst.base64 = (params) => inst.check(/* @__PURE__ */ _base64(ZodBase64, params));
		inst.base64url = (params) => inst.check(/* @__PURE__ */ _base64url(ZodBase64URL, params));
		inst.xid = (params) => inst.check(/* @__PURE__ */ _xid(ZodXID, params));
		inst.ksuid = (params) => inst.check(/* @__PURE__ */ _ksuid(ZodKSUID, params));
		inst.ipv4 = (params) => inst.check(/* @__PURE__ */ _ipv4(ZodIPv4, params));
		inst.ipv6 = (params) => inst.check(/* @__PURE__ */ _ipv6(ZodIPv6, params));
		inst.cidrv4 = (params) => inst.check(/* @__PURE__ */ _cidrv4(ZodCIDRv4, params));
		inst.cidrv6 = (params) => inst.check(/* @__PURE__ */ _cidrv6(ZodCIDRv6, params));
		inst.e164 = (params) => inst.check(/* @__PURE__ */ _e164(ZodE164, params));
		inst.datetime = (params) => inst.check(datetime(params));
		inst.date = (params) => inst.check(date$1(params));
		inst.time = (params) => inst.check(time$1(params));
		inst.duration = (params) => inst.check(duration(params));
	});
	function string(params) {
		return /* @__PURE__ */ _string(ZodString, params);
	}
	const ZodStringFormat = /*@__PURE__*/ $constructor("ZodStringFormat", (inst, def) => {
		$ZodStringFormat.init(inst, def);
		_ZodString.init(inst, def);
	});
	const ZodEmail = /*@__PURE__*/ $constructor("ZodEmail", (inst, def) => {
		$ZodEmail.init(inst, def);
		ZodStringFormat.init(inst, def);
	});
	function email(params) {
		return /* @__PURE__ */ _email(ZodEmail, params);
	}
	const ZodGUID = /*@__PURE__*/ $constructor("ZodGUID", (inst, def) => {
		$ZodGUID.init(inst, def);
		ZodStringFormat.init(inst, def);
	});
	const ZodUUID = /*@__PURE__*/ $constructor("ZodUUID", (inst, def) => {
		$ZodUUID.init(inst, def);
		ZodStringFormat.init(inst, def);
	});
	const ZodURL = /*@__PURE__*/ $constructor("ZodURL", (inst, def) => {
		$ZodURL.init(inst, def);
		ZodStringFormat.init(inst, def);
	});
	function url(params) {
		return /* @__PURE__ */ _url(ZodURL, params);
	}
	const ZodEmoji = /*@__PURE__*/ $constructor("ZodEmoji", (inst, def) => {
		$ZodEmoji.init(inst, def);
		ZodStringFormat.init(inst, def);
	});
	const ZodNanoID = /*@__PURE__*/ $constructor("ZodNanoID", (inst, def) => {
		$ZodNanoID.init(inst, def);
		ZodStringFormat.init(inst, def);
	});
	/**
	* @deprecated CUID v1 is deprecated by its authors due to information leakage
	* (timestamps embedded in the id). Use {@link ZodCUID2} instead.
	* See https://github.com/paralleldrive/cuid.
	*/
	const ZodCUID = /*@__PURE__*/ $constructor("ZodCUID", (inst, def) => {
		$ZodCUID.init(inst, def);
		ZodStringFormat.init(inst, def);
	});
	const ZodCUID2 = /*@__PURE__*/ $constructor("ZodCUID2", (inst, def) => {
		$ZodCUID2.init(inst, def);
		ZodStringFormat.init(inst, def);
	});
	const ZodULID = /*@__PURE__*/ $constructor("ZodULID", (inst, def) => {
		$ZodULID.init(inst, def);
		ZodStringFormat.init(inst, def);
	});
	const ZodXID = /*@__PURE__*/ $constructor("ZodXID", (inst, def) => {
		$ZodXID.init(inst, def);
		ZodStringFormat.init(inst, def);
	});
	const ZodKSUID = /*@__PURE__*/ $constructor("ZodKSUID", (inst, def) => {
		$ZodKSUID.init(inst, def);
		ZodStringFormat.init(inst, def);
	});
	const ZodIPv4 = /*@__PURE__*/ $constructor("ZodIPv4", (inst, def) => {
		$ZodIPv4.init(inst, def);
		ZodStringFormat.init(inst, def);
	});
	const ZodIPv6 = /*@__PURE__*/ $constructor("ZodIPv6", (inst, def) => {
		$ZodIPv6.init(inst, def);
		ZodStringFormat.init(inst, def);
	});
	const ZodCIDRv4 = /*@__PURE__*/ $constructor("ZodCIDRv4", (inst, def) => {
		$ZodCIDRv4.init(inst, def);
		ZodStringFormat.init(inst, def);
	});
	const ZodCIDRv6 = /*@__PURE__*/ $constructor("ZodCIDRv6", (inst, def) => {
		$ZodCIDRv6.init(inst, def);
		ZodStringFormat.init(inst, def);
	});
	const ZodBase64 = /*@__PURE__*/ $constructor("ZodBase64", (inst, def) => {
		$ZodBase64.init(inst, def);
		ZodStringFormat.init(inst, def);
	});
	const ZodBase64URL = /*@__PURE__*/ $constructor("ZodBase64URL", (inst, def) => {
		$ZodBase64URL.init(inst, def);
		ZodStringFormat.init(inst, def);
	});
	const ZodE164 = /*@__PURE__*/ $constructor("ZodE164", (inst, def) => {
		$ZodE164.init(inst, def);
		ZodStringFormat.init(inst, def);
	});
	const ZodJWT = /*@__PURE__*/ $constructor("ZodJWT", (inst, def) => {
		$ZodJWT.init(inst, def);
		ZodStringFormat.init(inst, def);
	});
	const ZodNumber = /*@__PURE__*/ $constructor("ZodNumber", (inst, def) => {
		$ZodNumber.init(inst, def);
		ZodType.init(inst, def);
		inst._zod.processJSONSchema = (ctx, json, params) => numberProcessor(inst, ctx, json, params);
		_installLazyMethods(inst, "ZodNumber", {
			gt(value, params) {
				return this.check(/* @__PURE__ */ _gt(value, params));
			},
			gte(value, params) {
				return this.check(/* @__PURE__ */ _gte(value, params));
			},
			min(value, params) {
				return this.check(/* @__PURE__ */ _gte(value, params));
			},
			lt(value, params) {
				return this.check(/* @__PURE__ */ _lt(value, params));
			},
			lte(value, params) {
				return this.check(/* @__PURE__ */ _lte(value, params));
			},
			max(value, params) {
				return this.check(/* @__PURE__ */ _lte(value, params));
			},
			int(params) {
				return this.check(int(params));
			},
			safe(params) {
				return this.check(int(params));
			},
			positive(params) {
				return this.check(/* @__PURE__ */ _gt(0, params));
			},
			nonnegative(params) {
				return this.check(/* @__PURE__ */ _gte(0, params));
			},
			negative(params) {
				return this.check(/* @__PURE__ */ _lt(0, params));
			},
			nonpositive(params) {
				return this.check(/* @__PURE__ */ _lte(0, params));
			},
			multipleOf(value, params) {
				return this.check(/* @__PURE__ */ _multipleOf(value, params));
			},
			step(value, params) {
				return this.check(/* @__PURE__ */ _multipleOf(value, params));
			},
			finite() {
				return this;
			}
		});
		const bag = inst._zod.bag;
		inst.minValue = Math.max(bag.minimum ?? Number.NEGATIVE_INFINITY, bag.exclusiveMinimum ?? Number.NEGATIVE_INFINITY) ?? null;
		inst.maxValue = Math.min(bag.maximum ?? Number.POSITIVE_INFINITY, bag.exclusiveMaximum ?? Number.POSITIVE_INFINITY) ?? null;
		inst.isInt = (bag.format ?? "").includes("int") || Number.isSafeInteger(bag.multipleOf ?? .5);
		inst.isFinite = true;
		inst.format = bag.format ?? null;
	});
	function number$1(params) {
		return /* @__PURE__ */ _number(ZodNumber, params);
	}
	const ZodNumberFormat = /*@__PURE__*/ $constructor("ZodNumberFormat", (inst, def) => {
		$ZodNumberFormat.init(inst, def);
		ZodNumber.init(inst, def);
	});
	function int(params) {
		return /* @__PURE__ */ _int(ZodNumberFormat, params);
	}
	const ZodBoolean = /*@__PURE__*/ $constructor("ZodBoolean", (inst, def) => {
		$ZodBoolean.init(inst, def);
		ZodType.init(inst, def);
		inst._zod.processJSONSchema = (ctx, json, params) => booleanProcessor(inst, ctx, json, params);
	});
	function boolean(params) {
		return /* @__PURE__ */ _boolean(ZodBoolean, params);
	}
	const ZodNull = /*@__PURE__*/ $constructor("ZodNull", (inst, def) => {
		$ZodNull.init(inst, def);
		ZodType.init(inst, def);
		inst._zod.processJSONSchema = (ctx, json, params) => nullProcessor(inst, ctx, json, params);
	});
	function _null(params) {
		return /* @__PURE__ */ _null$1(ZodNull, params);
	}
	const ZodAny = /*@__PURE__*/ $constructor("ZodAny", (inst, def) => {
		$ZodAny.init(inst, def);
		ZodType.init(inst, def);
		inst._zod.processJSONSchema = (ctx, json, params) => void 0;
	});
	function any() {
		return /* @__PURE__ */ _any(ZodAny);
	}
	const ZodUnknown = /*@__PURE__*/ $constructor("ZodUnknown", (inst, def) => {
		$ZodUnknown.init(inst, def);
		ZodType.init(inst, def);
		inst._zod.processJSONSchema = (ctx, json, params) => void 0;
	});
	function unknown() {
		return /* @__PURE__ */ _unknown(ZodUnknown);
	}
	const ZodNever = /*@__PURE__*/ $constructor("ZodNever", (inst, def) => {
		$ZodNever.init(inst, def);
		ZodType.init(inst, def);
		inst._zod.processJSONSchema = (ctx, json, params) => neverProcessor(inst, ctx, json, params);
	});
	function never(params) {
		return /* @__PURE__ */ _never(ZodNever, params);
	}
	const ZodArray = /*@__PURE__*/ $constructor("ZodArray", (inst, def) => {
		$ZodArray.init(inst, def);
		ZodType.init(inst, def);
		inst._zod.processJSONSchema = (ctx, json, params) => arrayProcessor(inst, ctx, json, params);
		inst.element = def.element;
		_installLazyMethods(inst, "ZodArray", {
			min(n, params) {
				return this.check(/* @__PURE__ */ _minLength(n, params));
			},
			nonempty(params) {
				return this.check(/* @__PURE__ */ _minLength(1, params));
			},
			max(n, params) {
				return this.check(/* @__PURE__ */ _maxLength(n, params));
			},
			length(n, params) {
				return this.check(/* @__PURE__ */ _length(n, params));
			},
			unwrap() {
				return this.element;
			}
		});
	});
	function array(element, params) {
		return /* @__PURE__ */ _array(ZodArray, element, params);
	}
	const ZodObject = /*@__PURE__*/ $constructor("ZodObject", (inst, def) => {
		$ZodObjectJIT.init(inst, def);
		ZodType.init(inst, def);
		inst._zod.processJSONSchema = (ctx, json, params) => objectProcessor(inst, ctx, json, params);
		defineLazy(inst, "shape", () => {
			return def.shape;
		});
		_installLazyMethods(inst, "ZodObject", {
			keyof() {
				return _enum(Object.keys(this._zod.def.shape));
			},
			catchall(catchall) {
				return this.clone({
					...this._zod.def,
					catchall
				});
			},
			passthrough() {
				return this.clone({
					...this._zod.def,
					catchall: unknown()
				});
			},
			loose() {
				return this.clone({
					...this._zod.def,
					catchall: unknown()
				});
			},
			strict() {
				return this.clone({
					...this._zod.def,
					catchall: never()
				});
			},
			strip() {
				return this.clone({
					...this._zod.def,
					catchall: void 0
				});
			},
			extend(incoming) {
				return extend(this, incoming);
			},
			safeExtend(incoming) {
				return safeExtend(this, incoming);
			},
			merge(other) {
				return merge(this, other);
			},
			pick(mask) {
				return pick(this, mask);
			},
			omit(mask) {
				return omit(this, mask);
			},
			partial(...args) {
				return partial(ZodOptional, this, args[0]);
			},
			required(...args) {
				return required(ZodNonOptional, this, args[0]);
			}
		});
	});
	function object(shape, params) {
		const def = {
			type: "object",
			shape: shape ?? {},
			...normalizeParams(params)
		};
		return new ZodObject(def);
	}
	function looseObject(shape, params) {
		return new ZodObject({
			type: "object",
			shape,
			catchall: unknown(),
			...normalizeParams(params)
		});
	}
	const ZodUnion = /*@__PURE__*/ $constructor("ZodUnion", (inst, def) => {
		$ZodUnion.init(inst, def);
		ZodType.init(inst, def);
		inst._zod.processJSONSchema = (ctx, json, params) => unionProcessor(inst, ctx, json, params);
		inst.options = def.options;
	});
	function union(options, params) {
		return new ZodUnion({
			type: "union",
			options,
			...normalizeParams(params)
		});
	}
	const ZodDiscriminatedUnion = /*@__PURE__*/ $constructor("ZodDiscriminatedUnion", (inst, def) => {
		ZodUnion.init(inst, def);
		$ZodDiscriminatedUnion.init(inst, def);
	});
	function discriminatedUnion(discriminator, options, params) {
		return new ZodDiscriminatedUnion({
			type: "union",
			options,
			discriminator,
			...normalizeParams(params)
		});
	}
	const ZodIntersection = /*@__PURE__*/ $constructor("ZodIntersection", (inst, def) => {
		$ZodIntersection.init(inst, def);
		ZodType.init(inst, def);
		inst._zod.processJSONSchema = (ctx, json, params) => intersectionProcessor(inst, ctx, json, params);
	});
	function intersection(left, right) {
		return new ZodIntersection({
			type: "intersection",
			left,
			right
		});
	}
	const ZodRecord = /*@__PURE__*/ $constructor("ZodRecord", (inst, def) => {
		$ZodRecord.init(inst, def);
		ZodType.init(inst, def);
		inst._zod.processJSONSchema = (ctx, json, params) => recordProcessor(inst, ctx, json, params);
		inst.keyType = def.keyType;
		inst.valueType = def.valueType;
	});
	function record(keyType, valueType, params) {
		if (!valueType || !valueType._zod) return new ZodRecord({
			type: "record",
			keyType: string(),
			valueType: keyType,
			...normalizeParams(valueType)
		});
		return new ZodRecord({
			type: "record",
			keyType,
			valueType,
			...normalizeParams(params)
		});
	}
	const ZodEnum = /*@__PURE__*/ $constructor("ZodEnum", (inst, def) => {
		$ZodEnum.init(inst, def);
		ZodType.init(inst, def);
		inst._zod.processJSONSchema = (ctx, json, params) => enumProcessor(inst, ctx, json, params);
		inst.enum = def.entries;
		inst.options = Object.values(def.entries);
		const keys = new Set(Object.keys(def.entries));
		inst.extract = (values, params) => {
			const newEntries = {};
			for (const value of values) if (keys.has(value)) newEntries[value] = def.entries[value];
			else throw new Error(`Key ${value} not found in enum`);
			return new ZodEnum({
				...def,
				checks: [],
				...normalizeParams(params),
				entries: newEntries
			});
		};
		inst.exclude = (values, params) => {
			const newEntries = { ...def.entries };
			for (const value of values) if (keys.has(value)) delete newEntries[value];
			else throw new Error(`Key ${value} not found in enum`);
			return new ZodEnum({
				...def,
				checks: [],
				...normalizeParams(params),
				entries: newEntries
			});
		};
	});
	function _enum(values, params) {
		const entries = Array.isArray(values) ? Object.fromEntries(values.map((v) => [v, v])) : values;
		return new ZodEnum({
			type: "enum",
			entries,
			...normalizeParams(params)
		});
	}
	const ZodLiteral = /*@__PURE__*/ $constructor("ZodLiteral", (inst, def) => {
		$ZodLiteral.init(inst, def);
		ZodType.init(inst, def);
		inst._zod.processJSONSchema = (ctx, json, params) => literalProcessor(inst, ctx, json, params);
		inst.values = new Set(def.values);
		Object.defineProperty(inst, "value", { get() {
			if (def.values.length > 1) throw new Error("This schema contains multiple valid literal values. Use `.values` instead.");
			return def.values[0];
		} });
	});
	function literal(value, params) {
		return new ZodLiteral({
			type: "literal",
			values: Array.isArray(value) ? value : [value],
			...normalizeParams(params)
		});
	}
	const ZodTransform = /*@__PURE__*/ $constructor("ZodTransform", (inst, def) => {
		$ZodTransform.init(inst, def);
		ZodType.init(inst, def);
		inst._zod.processJSONSchema = (ctx, json, params) => transformProcessor(inst, ctx, json, params);
		inst._zod.parse = (payload, _ctx) => {
			if (_ctx.direction === "backward") throw new $ZodEncodeError(inst.constructor.name);
			payload.addIssue = (issue$1) => {
				if (typeof issue$1 === "string") payload.issues.push(issue(issue$1, payload.value, def));
				else {
					const _issue = issue$1;
					if (_issue.fatal) _issue.continue = false;
					_issue.code ?? (_issue.code = "custom");
					_issue.input ?? (_issue.input = payload.value);
					_issue.inst ?? (_issue.inst = inst);
					payload.issues.push(issue(_issue));
				}
			};
			const output = def.transform(payload.value, payload);
			if (output instanceof Promise) return output.then((output) => {
				payload.value = output;
				payload.fallback = true;
				return payload;
			});
			payload.value = output;
			payload.fallback = true;
			return payload;
		};
	});
	function transform(fn) {
		return new ZodTransform({
			type: "transform",
			transform: fn
		});
	}
	const ZodOptional = /*@__PURE__*/ $constructor("ZodOptional", (inst, def) => {
		$ZodOptional.init(inst, def);
		ZodType.init(inst, def);
		inst._zod.processJSONSchema = (ctx, json, params) => optionalProcessor(inst, ctx, json, params);
		inst.unwrap = () => inst._zod.def.innerType;
	});
	function optional(innerType) {
		return new ZodOptional({
			type: "optional",
			innerType
		});
	}
	const ZodExactOptional = /*@__PURE__*/ $constructor("ZodExactOptional", (inst, def) => {
		$ZodExactOptional.init(inst, def);
		ZodType.init(inst, def);
		inst._zod.processJSONSchema = (ctx, json, params) => optionalProcessor(inst, ctx, json, params);
		inst.unwrap = () => inst._zod.def.innerType;
	});
	function exactOptional(innerType) {
		return new ZodExactOptional({
			type: "optional",
			innerType
		});
	}
	const ZodNullable = /*@__PURE__*/ $constructor("ZodNullable", (inst, def) => {
		$ZodNullable.init(inst, def);
		ZodType.init(inst, def);
		inst._zod.processJSONSchema = (ctx, json, params) => nullableProcessor(inst, ctx, json, params);
		inst.unwrap = () => inst._zod.def.innerType;
	});
	function nullable(innerType) {
		return new ZodNullable({
			type: "nullable",
			innerType
		});
	}
	const ZodDefault = /*@__PURE__*/ $constructor("ZodDefault", (inst, def) => {
		$ZodDefault.init(inst, def);
		ZodType.init(inst, def);
		inst._zod.processJSONSchema = (ctx, json, params) => defaultProcessor(inst, ctx, json, params);
		inst.unwrap = () => inst._zod.def.innerType;
		inst.removeDefault = inst.unwrap;
	});
	function _default(innerType, defaultValue) {
		return new ZodDefault({
			type: "default",
			innerType,
			get defaultValue() {
				return typeof defaultValue === "function" ? defaultValue() : shallowClone(defaultValue);
			}
		});
	}
	const ZodPrefault = /*@__PURE__*/ $constructor("ZodPrefault", (inst, def) => {
		$ZodPrefault.init(inst, def);
		ZodType.init(inst, def);
		inst._zod.processJSONSchema = (ctx, json, params) => prefaultProcessor(inst, ctx, json, params);
		inst.unwrap = () => inst._zod.def.innerType;
	});
	function prefault(innerType, defaultValue) {
		return new ZodPrefault({
			type: "prefault",
			innerType,
			get defaultValue() {
				return typeof defaultValue === "function" ? defaultValue() : shallowClone(defaultValue);
			}
		});
	}
	const ZodNonOptional = /*@__PURE__*/ $constructor("ZodNonOptional", (inst, def) => {
		$ZodNonOptional.init(inst, def);
		ZodType.init(inst, def);
		inst._zod.processJSONSchema = (ctx, json, params) => nonoptionalProcessor(inst, ctx, json, params);
		inst.unwrap = () => inst._zod.def.innerType;
	});
	function nonoptional(innerType, params) {
		return new ZodNonOptional({
			type: "nonoptional",
			innerType,
			...normalizeParams(params)
		});
	}
	const ZodCatch = /*@__PURE__*/ $constructor("ZodCatch", (inst, def) => {
		$ZodCatch.init(inst, def);
		ZodType.init(inst, def);
		inst._zod.processJSONSchema = (ctx, json, params) => catchProcessor(inst, ctx, json, params);
		inst.unwrap = () => inst._zod.def.innerType;
		inst.removeCatch = inst.unwrap;
	});
	function _catch(innerType, catchValue) {
		return new ZodCatch({
			type: "catch",
			innerType,
			catchValue: typeof catchValue === "function" ? catchValue : () => catchValue
		});
	}
	const ZodPipe = /*@__PURE__*/ $constructor("ZodPipe", (inst, def) => {
		$ZodPipe.init(inst, def);
		ZodType.init(inst, def);
		inst._zod.processJSONSchema = (ctx, json, params) => pipeProcessor(inst, ctx, json, params);
		inst.in = def.in;
		inst.out = def.out;
	});
	function pipe(in_, out) {
		return new ZodPipe({
			type: "pipe",
			in: in_,
			out
		});
	}
	const ZodPreprocess = /*@__PURE__*/ $constructor("ZodPreprocess", (inst, def) => {
		ZodPipe.init(inst, def);
		$ZodPreprocess.init(inst, def);
	});
	const ZodReadonly = /*@__PURE__*/ $constructor("ZodReadonly", (inst, def) => {
		$ZodReadonly.init(inst, def);
		ZodType.init(inst, def);
		inst._zod.processJSONSchema = (ctx, json, params) => readonlyProcessor(inst, ctx, json, params);
		inst.unwrap = () => inst._zod.def.innerType;
	});
	function readonly(innerType) {
		return new ZodReadonly({
			type: "readonly",
			innerType
		});
	}
	const ZodLazy = /*@__PURE__*/ $constructor("ZodLazy", (inst, def) => {
		$ZodLazy.init(inst, def);
		ZodType.init(inst, def);
		inst._zod.processJSONSchema = (ctx, json, params) => lazyProcessor(inst, ctx, json, params);
		inst.unwrap = () => inst._zod.def.getter();
	});
	function lazy(getter) {
		return new ZodLazy({
			type: "lazy",
			getter
		});
	}
	const ZodCustom = /*@__PURE__*/ $constructor("ZodCustom", (inst, def) => {
		$ZodCustom.init(inst, def);
		ZodType.init(inst, def);
		inst._zod.processJSONSchema = (ctx, json, params) => customProcessor(inst, ctx, json, params);
	});
	function refine(fn, _params = {}) {
		return /* @__PURE__ */ _refine(ZodCustom, fn, _params);
	}
	function superRefine(fn, params) {
		return /* @__PURE__ */ _superRefine(fn, params);
	}
	function preprocess(fn, schema) {
		return new ZodPreprocess({
			type: "pipe",
			in: transform(fn),
			out: schema
		});
	}
	//#endregion
	//#region ../../node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/classic/compat.js
	/** @deprecated Use the raw string literal codes instead, e.g. "invalid_type". */
	const ZodIssueCode = {
		invalid_type: "invalid_type",
		too_big: "too_big",
		too_small: "too_small",
		invalid_format: "invalid_format",
		not_multiple_of: "not_multiple_of",
		unrecognized_keys: "unrecognized_keys",
		invalid_union: "invalid_union",
		invalid_key: "invalid_key",
		invalid_element: "invalid_element",
		invalid_value: "invalid_value",
		custom: "custom"
	};
	/** @deprecated Do not use. Stub definition, only included for zod-to-json-schema compatibility. */
	var ZodFirstPartyTypeKind;
	ZodFirstPartyTypeKind || (ZodFirstPartyTypeKind = {});
	//#endregion
	//#region ../../node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/classic/coerce.js
	function number(params) {
		return /* @__PURE__ */ _coercedNumber(ZodNumber, params);
	}
	//#endregion
	//#region ../../node_modules/.pnpm/@modelcontextprotocol+core@2.0.0/node_modules/@modelcontextprotocol/core/dist/auth-CUe6YdwF.mjs
	const LATEST_PROTOCOL_VERSION = "2025-11-25";
	const SUPPORTED_PROTOCOL_VERSIONS = [
		LATEST_PROTOCOL_VERSION,
		"2025-06-18",
		"2025-03-26",
		"2024-11-05",
		"2024-10-07"
	];
	/**
	* `_meta` key associating a message with a 2025-11-25 task.
	*
	* @deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only.
	*/
	const RELATED_TASK_META_KEY = "io.modelcontextprotocol/related-task";
	/**
	* `_meta` key carrying the MCP protocol version governing a request.
	*
	* For the HTTP transport, the value must match the `MCP-Protocol-Version` header.
	*/
	const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
	/**
	* `_meta` key identifying the client software making a request.
	*
	* Clients SHOULD include it on every request; the value is self-reported and
	* intended for display, logging, and debugging — servers should not rely on
	* it for behavior or security decisions.
	*/
	const CLIENT_INFO_META_KEY = "io.modelcontextprotocol/clientInfo";
	/**
	* `_meta` key identifying the server software producing a response.
	*
	* Servers SHOULD include it on every response; the value is self-reported and
	* intended for display, logging, and debugging — clients should not rely on
	* it for behavior or security decisions.
	*/
	const SERVER_INFO_META_KEY = "io.modelcontextprotocol/serverInfo";
	/**
	* `_meta` key carrying the client's capabilities for a request.
	*
	* Capabilities are declared per request rather than once at initialization;
	* servers must not infer capabilities from prior requests.
	*/
	const CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";
	/**
	* `_meta` key carrying the JSON-RPC ID of the `subscriptions/listen` request
	* that opened the stream a notification was delivered on.
	*
	* Stamped by the server on every notification delivered via a
	* `subscriptions/listen` stream (including the leading
	* `notifications/subscriptions/acknowledged`); on stdio, where all messages
	* share one channel, clients use it to correlate notifications with their
	* originating subscription. The value is the listen request's JSON-RPC ID
	* verbatim.
	*/
	const SUBSCRIPTION_ID_META_KEY = "io.modelcontextprotocol/subscriptionId";
	/**
	* `_meta` key carrying the desired log level for a request.
	*
	* When absent, the server must not send `notifications/message` notifications
	* for the request.
	*
	* @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577); remains
	* in the specification for at least twelve months.
	*/
	const LOG_LEVEL_META_KEY = "io.modelcontextprotocol/logLevel";
	const JSONValueSchema = lazy(() => union([
		string(),
		number$1(),
		boolean(),
		_null(),
		record(string(), JSONValueSchema),
		array(JSONValueSchema)
	]));
	const JSONObjectSchema = record(string(), JSONValueSchema);
	const JSONArraySchema = array(JSONValueSchema);
	/**
	* A progress token, used to associate progress notifications with the original request.
	*/
	const ProgressTokenSchema = union([string(), number$1().int()]);
	/**
	* An opaque token used to represent a cursor for pagination.
	*/
	const CursorSchema = string();
	/** @deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only. */
	const TaskMetadataSchema = object({ ttl: number$1().optional() });
	/**
	* Metadata for associating messages with a task.
	* Include this in the `_meta` field under the key `io.modelcontextprotocol/related-task`.
	*
	* @deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only.
	*/
	const RelatedTaskMetadataSchema = object({ taskId: string() });
	const RequestMetaSchema = looseObject({
		progressToken: ProgressTokenSchema.optional(),
		[RELATED_TASK_META_KEY]: RelatedTaskMetadataSchema.optional()
	});
	/**
	* Common params for any request.
	*/
	const BaseRequestParamsSchema = object({ _meta: RequestMetaSchema.optional() });
	/**
	* Common params for any task-augmented request.
	*
	* @deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only.
	*/
	const TaskAugmentedRequestParamsSchema = BaseRequestParamsSchema.extend({ task: TaskMetadataSchema.optional() });
	const RequestSchema = object({
		method: string(),
		params: BaseRequestParamsSchema.loose().optional()
	});
	const NotificationsParamsSchema = object({ _meta: RequestMetaSchema.optional() });
	const NotificationSchema = object({
		method: string(),
		params: NotificationsParamsSchema.loose().optional()
	});
	/**
	* The contents of a result's `_meta` field (the 2026-07-28 `ResultMetaObject`).
	* Loose — implementation-specific keys pass through.
	*
	* The serverInfo key identifies the server software producing the response
	* (servers SHOULD include it on every response; the value is self-reported
	* and intended for display, logging, and debugging). The getter defers the
	* `ImplementationSchema` reference, which is declared later in this file.
	*/
	const ResultMetaObjectSchema = looseObject({ get [SERVER_INFO_META_KEY]() {
		return ImplementationSchema.optional().catch(void 0);
	} });
	const ResultSchema = looseObject({ _meta: ResultMetaObjectSchema.optional() });
	/**
	* A uniquely identifying ID for a request in JSON-RPC.
	*/
	const RequestIdSchema = union([string(), number$1().int()]);
	/**
	* A request that expects a response.
	*/
	const JSONRPCRequestSchema = object({
		jsonrpc: literal("2.0"),
		id: RequestIdSchema,
		...RequestSchema.shape
	}).strict();
	/**
	* A notification which does not expect a response.
	*/
	const JSONRPCNotificationSchema = object({
		jsonrpc: literal("2.0"),
		...NotificationSchema.shape
	}).strict();
	/**
	* A successful (non-error) response to a request.
	*/
	const JSONRPCResultResponseSchema = object({
		jsonrpc: literal("2.0"),
		id: RequestIdSchema,
		result: ResultSchema
	}).strict();
	/**
	* A response to a request that indicates an error occurred.
	*/
	const JSONRPCErrorResponseSchema = object({
		jsonrpc: literal("2.0"),
		id: RequestIdSchema.optional(),
		error: object({
			code: number$1().int(),
			message: string(),
			data: unknown().optional()
		})
	}).strict();
	const JSONRPCMessageSchema = union([
		JSONRPCRequestSchema,
		JSONRPCNotificationSchema,
		JSONRPCResultResponseSchema,
		JSONRPCErrorResponseSchema
	]);
	const JSONRPCResponseSchema = union([JSONRPCResultResponseSchema, JSONRPCErrorResponseSchema]);
	/**
	* A response that indicates success but carries no data.
	*/
	const EmptyResultSchema = ResultSchema.strict();
	const CancelledNotificationParamsSchema = NotificationsParamsSchema.extend({
		requestId: RequestIdSchema.optional(),
		reason: string().optional()
	});
	/**
	* This notification can be sent by either side to indicate that it is cancelling a previously-issued request.
	*
	* The request SHOULD still be in-flight, but due to communication latency, it is always possible that this notification MAY arrive after the request has already finished.
	*
	* This notification indicates that the result will be unused, so any associated processing SHOULD cease.
	*
	* A client MUST NOT attempt to cancel its {@linkcode InitializeRequest | initialize} request.
	*/
	const CancelledNotificationSchema = NotificationSchema.extend({
		method: literal("notifications/cancelled"),
		params: CancelledNotificationParamsSchema
	});
	/**
	* Icon schema for use in {@link Tool | tools}, {@link Prompt | prompts}, {@link Resource | resources}, and {@link Implementation | implementations}.
	*/
	const IconSchema = object({
		src: string(),
		mimeType: string().optional(),
		sizes: array(string()).optional(),
		theme: _enum(["light", "dark"]).optional()
	});
	/**
	* Base schema to add `icons` property.
	*
	*/
	const IconsSchema = object({ icons: array(IconSchema).optional() });
	/**
	* Base metadata interface for common properties across {@link Resource | resources}, {@link Tool | tools}, {@link Prompt | prompts}, and {@link Implementation | implementations}.
	*/
	const BaseMetadataSchema = object({
		name: string(),
		title: string().optional()
	});
	/**
	* Describes the name and version of an MCP implementation.
	*/
	const ImplementationSchema = BaseMetadataSchema.extend({
		...BaseMetadataSchema.shape,
		...IconsSchema.shape,
		version: string(),
		websiteUrl: string().optional(),
		description: string().optional()
	});
	const ElicitationCapabilitySchema = preprocess((value) => {
		if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) return { form: {} };
		return value;
	}, intersection(object({
		form: intersection(object({ applyDefaults: boolean().optional() }), JSONObjectSchema).optional(),
		url: JSONObjectSchema.optional()
	}), JSONObjectSchema.optional()));
	/**
	* Task capabilities for clients, indicating which request types support task creation.
	*
	* @deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only.
	*/
	const ClientTasksCapabilitySchema = looseObject({
		list: JSONObjectSchema.optional(),
		cancel: JSONObjectSchema.optional(),
		requests: looseObject({
			sampling: looseObject({ createMessage: JSONObjectSchema.optional() }).optional(),
			elicitation: looseObject({ create: JSONObjectSchema.optional() }).optional()
		}).optional()
	});
	/**
	* Task capabilities for servers, indicating which request types support task creation.
	*
	* @deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only.
	*/
	const ServerTasksCapabilitySchema = looseObject({
		list: JSONObjectSchema.optional(),
		cancel: JSONObjectSchema.optional(),
		requests: looseObject({ tools: looseObject({ call: JSONObjectSchema.optional() }).optional() }).optional()
	});
	/**
	* Capabilities a client may support. Known capabilities are defined here, in this schema, but this is not a closed set: any client can define its own, additional capabilities.
	*/
	const ClientCapabilitiesSchema = object({
		experimental: record(string(), JSONObjectSchema).optional(),
		sampling: object({
			context: JSONObjectSchema.optional(),
			tools: JSONObjectSchema.optional()
		}).optional(),
		elicitation: ElicitationCapabilitySchema.optional(),
		roots: object({ listChanged: boolean().optional() }).optional(),
		tasks: ClientTasksCapabilitySchema.optional(),
		extensions: record(string(), JSONObjectSchema).optional()
	});
	const InitializeRequestParamsSchema = BaseRequestParamsSchema.extend({
		protocolVersion: string(),
		capabilities: ClientCapabilitiesSchema,
		clientInfo: ImplementationSchema
	});
	/**
	* This request is sent from the client to the server when it first connects, asking it to begin initialization.
	*/
	const InitializeRequestSchema = RequestSchema.extend({
		method: literal("initialize"),
		params: InitializeRequestParamsSchema
	});
	/**
	* Capabilities that a server may support. Known capabilities are defined here, in this schema, but this is not a closed set: any server can define its own, additional capabilities.
	*/
	const ServerCapabilitiesSchema = object({
		experimental: record(string(), JSONObjectSchema).optional(),
		logging: JSONObjectSchema.optional(),
		completions: JSONObjectSchema.optional(),
		prompts: object({ listChanged: boolean().optional() }).optional(),
		resources: object({
			subscribe: boolean().optional(),
			listChanged: boolean().optional()
		}).optional(),
		tools: object({ listChanged: boolean().optional() }).optional(),
		tasks: ServerTasksCapabilitySchema.optional(),
		extensions: record(string(), JSONObjectSchema).optional()
	});
	/**
	* After receiving an initialize request from the client, the server sends this response.
	*/
	const InitializeResultSchema = ResultSchema.extend({
		protocolVersion: string(),
		capabilities: ServerCapabilitiesSchema,
		serverInfo: ImplementationSchema,
		instructions: string().optional()
	});
	/**
	* This notification is sent from the client to the server after initialization has finished.
	*/
	const InitializedNotificationSchema = NotificationSchema.extend({
		method: literal("notifications/initialized"),
		params: NotificationsParamsSchema.optional()
	});
	/**
	* A request from the client asking the server to advertise its supported protocol
	* versions, capabilities, and other metadata (protocol revision 2026-07-28). Servers
	* MUST implement `server/discover`. Clients MAY call it but are not required to —
	* version negotiation can also happen inline via the per-request `_meta` envelope.
	*/
	const DiscoverRequestSchema = RequestSchema.extend({
		method: literal("server/discover"),
		params: BaseRequestParamsSchema.optional()
	});
	/**
	* The result returned by the server for a `server/discover` request.
	*/
	const DiscoverResultSchema = ResultSchema.extend({
		supportedVersions: array(string()),
		capabilities: ServerCapabilitiesSchema,
		instructions: string().optional()
	});
	/**
	* A ping, issued by either the server or the client, to check that the other party is still alive. The receiver must promptly respond, or else may be disconnected.
	*/
	const PingRequestSchema = RequestSchema.extend({
		method: literal("ping"),
		params: BaseRequestParamsSchema.optional()
	});
	const ProgressSchema = object({
		progress: number$1(),
		total: optional(number$1()),
		message: optional(string())
	});
	const ProgressNotificationParamsSchema = object({
		...NotificationsParamsSchema.shape,
		...ProgressSchema.shape,
		progressToken: ProgressTokenSchema
	});
	/**
	* An out-of-band notification used to inform the receiver of a progress update for a long-running request.
	*
	* @category notifications/progress
	*/
	const ProgressNotificationSchema = NotificationSchema.extend({
		method: literal("notifications/progress"),
		params: ProgressNotificationParamsSchema
	});
	const PaginatedRequestParamsSchema = BaseRequestParamsSchema.extend({ cursor: CursorSchema.optional() });
	const PaginatedRequestSchema = RequestSchema.extend({ params: PaginatedRequestParamsSchema.optional() });
	const PaginatedResultSchema = ResultSchema.extend({ nextCursor: CursorSchema.optional() });
	/**
	* The contents of a specific resource or sub-resource.
	*/
	const ResourceContentsSchema = object({
		uri: string(),
		mimeType: optional(string()),
		_meta: record(string(), unknown()).optional()
	});
	const TextResourceContentsSchema = ResourceContentsSchema.extend({ text: string() });
	/**
	* A Zod schema for validating Base64 strings that is more performant and
	* robust for very large inputs than the default regex-based check. It avoids
	* stack overflows by using the native `atob` function for validation.
	*/
	const Base64Schema = string().refine((val) => {
		try {
			atob(val);
			return true;
		} catch {
			return false;
		}
	}, { message: "Invalid Base64 string" });
	const BlobResourceContentsSchema = ResourceContentsSchema.extend({ blob: Base64Schema });
	/**
	* The sender or recipient of messages and data in a conversation.
	*/
	const RoleSchema = _enum(["user", "assistant"]);
	/**
	* Optional annotations providing clients additional context about a resource.
	*/
	const AnnotationsSchema = object({
		audience: array(RoleSchema).optional(),
		priority: number$1().min(0).max(1).optional(),
		lastModified: datetime({ offset: true }).optional()
	});
	/**
	* A known resource that the server is capable of reading.
	*/
	const ResourceSchema = object({
		...BaseMetadataSchema.shape,
		...IconsSchema.shape,
		uri: string(),
		description: optional(string()),
		mimeType: optional(string()),
		size: optional(number$1()),
		annotations: AnnotationsSchema.optional(),
		_meta: optional(looseObject({}))
	});
	/**
	* A template description for resources available on the server.
	*/
	const ResourceTemplateSchema = object({
		...BaseMetadataSchema.shape,
		...IconsSchema.shape,
		uriTemplate: string(),
		description: optional(string()),
		mimeType: optional(string()),
		annotations: AnnotationsSchema.optional(),
		_meta: optional(looseObject({}))
	});
	/**
	* Sent from the client to request a list of resources the server has.
	*/
	const ListResourcesRequestSchema = PaginatedRequestSchema.extend({ method: literal("resources/list") });
	/**
	* The server's response to a {@linkcode ListResourcesRequest | resources/list} request from the client.
	*/
	const ListResourcesResultSchema = PaginatedResultSchema.extend({ resources: array(ResourceSchema) });
	/**
	* Sent from the client to request a list of resource templates the server has.
	*/
	const ListResourceTemplatesRequestSchema = PaginatedRequestSchema.extend({ method: literal("resources/templates/list") });
	/**
	* The server's response to a {@linkcode ListResourceTemplatesRequest | resources/templates/list} request from the client.
	*/
	const ListResourceTemplatesResultSchema = PaginatedResultSchema.extend({ resourceTemplates: array(ResourceTemplateSchema) });
	const ResourceRequestParamsSchema = BaseRequestParamsSchema.extend({ uri: string() });
	/**
	* Parameters for a {@linkcode ReadResourceRequest | resources/read} request.
	*/
	const ReadResourceRequestParamsSchema = ResourceRequestParamsSchema;
	/**
	* Sent from the client to the server, to read a specific resource URI.
	*/
	const ReadResourceRequestSchema = RequestSchema.extend({
		method: literal("resources/read"),
		params: ReadResourceRequestParamsSchema
	});
	/**
	* The server's response to a {@linkcode ReadResourceRequest | resources/read} request from the client.
	*/
	const ReadResourceResultSchema = ResultSchema.extend({ contents: array(union([TextResourceContentsSchema, BlobResourceContentsSchema])) });
	/**
	* An optional notification from the server to the client, informing it that the list of resources it can read from has changed. This may be issued by servers without any previous subscription from the client.
	*/
	const ResourceListChangedNotificationSchema = NotificationSchema.extend({
		method: literal("notifications/resources/list_changed"),
		params: NotificationsParamsSchema.optional()
	});
	const SubscribeRequestParamsSchema = ResourceRequestParamsSchema;
	/**
	* Sent from the client to request `resources/updated` notifications from the server whenever a particular resource changes.
	*/
	const SubscribeRequestSchema = RequestSchema.extend({
		method: literal("resources/subscribe"),
		params: SubscribeRequestParamsSchema
	});
	const UnsubscribeRequestParamsSchema = ResourceRequestParamsSchema;
	/**
	* Sent from the client to request cancellation of {@linkcode ResourceUpdatedNotification | resources/updated} notifications from the server. This should follow a previous {@linkcode SubscribeRequest | resources/subscribe} request.
	*/
	const UnsubscribeRequestSchema = RequestSchema.extend({
		method: literal("resources/unsubscribe"),
		params: UnsubscribeRequestParamsSchema
	});
	/**
	* The set of notification types a client opts in to on a `subscriptions/listen`
	* request. Each type is opt-in; the server MUST NOT send a notification type
	* the client has not explicitly requested here.
	*/
	const SubscriptionFilterSchema = object({
		toolsListChanged: boolean().optional(),
		promptsListChanged: boolean().optional(),
		resourcesListChanged: boolean().optional(),
		resourceSubscriptions: array(string()).optional()
	});
	const SubscriptionsListenRequestParamsSchema = BaseRequestParamsSchema.extend({ notifications: SubscriptionFilterSchema });
	/**
	* Sent from the client to open a long-lived channel for receiving notifications
	* outside the context of a specific request (protocol revision 2026-07-28).
	* Replaces the previous HTTP GET endpoint and `resources/subscribe`.
	*/
	const SubscriptionsListenRequestSchema = RequestSchema.extend({
		method: literal("subscriptions/listen"),
		params: SubscriptionsListenRequestParamsSchema
	});
	const SubscriptionsAcknowledgedNotificationParamsSchema = NotificationsParamsSchema.extend({ notifications: SubscriptionFilterSchema });
	/**
	* Sent by the server as the first message on a `subscriptions/listen` stream
	* to acknowledge that the subscription has been established and report which
	* notification types it agreed to honor (protocol revision 2026-07-28).
	*/
	const SubscriptionsAcknowledgedNotificationSchema = NotificationSchema.extend({
		method: literal("notifications/subscriptions/acknowledged"),
		params: SubscriptionsAcknowledgedNotificationParamsSchema
	});
	/**
	* `_meta` for a {@linkcode SubscriptionsListenResult}: the listen request's
	* JSON-RPC ID under the canonical subscription-id key (mirroring the same key
	* on every notification delivered on the stream). Extends
	* {@linkcode ResultMetaObjectSchema}, so the optional serverInfo key is typed
	* here too.
	*/
	const SubscriptionsListenResultMetaSchema = ResultMetaObjectSchema.extend({ [SUBSCRIPTION_ID_META_KEY]: RequestIdSchema });
	/**
	* The response to a `subscriptions/listen` request, signalling that the
	* subscription has ended gracefully (for example, during server shutdown).
	* Because the listen stream is long-lived, this result is sent only when the
	* server tears the subscription down; an abrupt transport close carries no
	* response. The result body is otherwise empty.
	*/
	const SubscriptionsListenResultSchema = ResultSchema.extend({ _meta: SubscriptionsListenResultMetaSchema });
	/**
	* Parameters for a {@linkcode ResourceUpdatedNotification | notifications/resources/updated} notification.
	*/
	const ResourceUpdatedNotificationParamsSchema = NotificationsParamsSchema.extend({ uri: string() });
	/**
	* A notification from the server to the client, informing it that a resource has changed and may need to be read again. This should only be sent if the client previously sent a {@linkcode SubscribeRequest | resources/subscribe} request.
	*/
	const ResourceUpdatedNotificationSchema = NotificationSchema.extend({
		method: literal("notifications/resources/updated"),
		params: ResourceUpdatedNotificationParamsSchema
	});
	/**
	* Describes an argument that a prompt can accept.
	*/
	const PromptArgumentSchema = object({
		name: string(),
		description: optional(string()),
		required: optional(boolean())
	});
	/**
	* A prompt or prompt template that the server offers.
	*/
	const PromptSchema = object({
		...BaseMetadataSchema.shape,
		...IconsSchema.shape,
		description: optional(string()),
		arguments: optional(array(PromptArgumentSchema)),
		_meta: optional(looseObject({}))
	});
	/**
	* Sent from the client to request a list of prompts and prompt templates the server has.
	*/
	const ListPromptsRequestSchema = PaginatedRequestSchema.extend({ method: literal("prompts/list") });
	/**
	* The server's response to a {@linkcode ListPromptsRequest | prompts/list} request from the client.
	*/
	const ListPromptsResultSchema = PaginatedResultSchema.extend({ prompts: array(PromptSchema) });
	/**
	* Parameters for a {@linkcode GetPromptRequest | prompts/get} request.
	*/
	const GetPromptRequestParamsSchema = BaseRequestParamsSchema.extend({
		name: string(),
		arguments: record(string(), string()).optional()
	});
	/**
	* Used by the client to get a prompt provided by the server.
	*/
	const GetPromptRequestSchema = RequestSchema.extend({
		method: literal("prompts/get"),
		params: GetPromptRequestParamsSchema
	});
	/**
	* Text provided to or from an LLM.
	*/
	const TextContentSchema = object({
		type: literal("text"),
		text: string(),
		annotations: AnnotationsSchema.optional(),
		_meta: record(string(), unknown()).optional()
	});
	/**
	* An image provided to or from an LLM.
	*/
	const ImageContentSchema = object({
		type: literal("image"),
		data: Base64Schema,
		mimeType: string(),
		annotations: AnnotationsSchema.optional(),
		_meta: record(string(), unknown()).optional()
	});
	/**
	* Audio content provided to or from an LLM.
	*/
	const AudioContentSchema = object({
		type: literal("audio"),
		data: Base64Schema,
		mimeType: string(),
		annotations: AnnotationsSchema.optional(),
		_meta: record(string(), unknown()).optional()
	});
	/**
	* A tool call request from an assistant (LLM).
	* Represents the assistant's request to use a tool.
	*
	* @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577); remains
	* in the specification for at least twelve months. Migrate to calling LLM
	* provider APIs directly.
	*/
	const ToolUseContentSchema = object({
		type: literal("tool_use"),
		name: string(),
		id: string(),
		input: record(string(), unknown()),
		_meta: record(string(), unknown()).optional()
	});
	/**
	* The contents of a resource, embedded into a prompt or tool call result.
	*/
	const EmbeddedResourceSchema = object({
		type: literal("resource"),
		resource: union([TextResourceContentsSchema, BlobResourceContentsSchema]),
		annotations: AnnotationsSchema.optional(),
		_meta: record(string(), unknown()).optional()
	});
	/**
	* A resource that the server is capable of reading, included in a prompt or tool call result.
	*
	* Note: resource links returned by tools are not guaranteed to appear in the results of {@linkcode ListResourcesRequest | resources/list} requests.
	*/
	const ResourceLinkSchema = ResourceSchema.extend({ type: literal("resource_link") });
	/**
	* A content block that can be used in prompts and tool results.
	*/
	const ContentBlockSchema = union([
		TextContentSchema,
		ImageContentSchema,
		AudioContentSchema,
		ResourceLinkSchema,
		EmbeddedResourceSchema
	]);
	/**
	* Describes a message returned as part of a prompt.
	*/
	const PromptMessageSchema = object({
		role: RoleSchema,
		content: ContentBlockSchema
	});
	/**
	* The server's response to a {@linkcode GetPromptRequest | prompts/get} request from the client.
	*/
	const GetPromptResultSchema = ResultSchema.extend({
		description: string().optional(),
		messages: array(PromptMessageSchema)
	});
	/**
	* An optional notification from the server to the client, informing it that the list of prompts it offers has changed. This may be issued by servers without any previous subscription from the client.
	*/
	const PromptListChangedNotificationSchema = NotificationSchema.extend({
		method: literal("notifications/prompts/list_changed"),
		params: NotificationsParamsSchema.optional()
	});
	/**
	* Additional properties describing a `Tool` to clients.
	*
	* NOTE: all properties in {@linkcode ToolAnnotations} are **hints**.
	* They are not guaranteed to provide a faithful description of
	* tool behavior (including descriptive properties like `title`).
	*
	* Clients should never make tool use decisions based on `ToolAnnotations`
	* received from untrusted servers.
	*/
	const ToolAnnotationsSchema = object({
		title: string().optional(),
		readOnlyHint: boolean().optional(),
		destructiveHint: boolean().optional(),
		idempotentHint: boolean().optional(),
		openWorldHint: boolean().optional()
	});
	/**
	* Execution-related properties for a tool.
	*/
	const ToolExecutionSchema = object({ taskSupport: _enum([
		"required",
		"optional",
		"forbidden"
	]).optional() });
	/**
	* Definition for a tool the client can call.
	*/
	const ToolSchema = object({
		...BaseMetadataSchema.shape,
		...IconsSchema.shape,
		description: string().optional(),
		inputSchema: object({
			type: literal("object"),
			properties: record(string(), JSONValueSchema).optional(),
			required: array(string()).optional()
		}).catchall(unknown()),
		outputSchema: looseObject({ $schema: string().optional() }).optional(),
		annotations: ToolAnnotationsSchema.optional(),
		execution: ToolExecutionSchema.optional(),
		_meta: record(string(), unknown()).optional()
	});
	/**
	* Sent from the client to request a list of tools the server has.
	*/
	const ListToolsRequestSchema = PaginatedRequestSchema.extend({ method: literal("tools/list") });
	/**
	* The server's response to a {@linkcode ListToolsRequest | tools/list} request from the client.
	*/
	const ListToolsResultSchema = PaginatedResultSchema.extend({ tools: array(ToolSchema) });
	/**
	* The server's response to a tool call.
	*/
	const CallToolResultSchema = ResultSchema.extend({
		content: array(ContentBlockSchema).default([]),
		structuredContent: unknown().optional(),
		isError: boolean().optional()
	});
	/**
	* {@linkcode CallToolResultSchema} extended with backwards compatibility to protocol version 2024-10-07.
	*/
	const CompatibilityCallToolResultSchema = CallToolResultSchema.or(ResultSchema.extend({ toolResult: unknown() }));
	/**
	* Parameters for a `tools/call` request.
	*/
	const CallToolRequestParamsSchema = TaskAugmentedRequestParamsSchema.extend({
		name: string(),
		arguments: record(string(), unknown()).optional()
	});
	/**
	* Used by the client to invoke a tool provided by the server.
	*/
	const CallToolRequestSchema = RequestSchema.extend({
		method: literal("tools/call"),
		params: CallToolRequestParamsSchema
	});
	/**
	* An optional notification from the server to the client, informing it that the list of tools it offers has changed. This may be issued by servers without any previous subscription from the client.
	*/
	const ToolListChangedNotificationSchema = NotificationSchema.extend({
		method: literal("notifications/tools/list_changed"),
		params: NotificationsParamsSchema.optional()
	});
	/**
	* Base schema for list changed subscription options (without callback).
	* Used internally for Zod validation of `autoRefresh` and `debounceMs`.
	*/
	const ListChangedOptionsBaseSchema = object({
		autoRefresh: boolean().default(true),
		debounceMs: number$1().int().nonnegative().default(300)
	});
	/**
	* The severity of a log message.
	*
	* @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577); remains
	* in the specification for at least twelve months. Migrate to stderr logging
	* (STDIO servers) or OpenTelemetry.
	*/
	const LoggingLevelSchema = _enum([
		"debug",
		"info",
		"notice",
		"warning",
		"error",
		"critical",
		"alert",
		"emergency"
	]);
	/**
	* Parameters for a `logging/setLevel` request.
	*
	* @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577); remains
	* in the specification for at least twelve months. Migrate to stderr logging
	* (STDIO servers) or OpenTelemetry.
	*/
	const SetLevelRequestParamsSchema = BaseRequestParamsSchema.extend({ level: LoggingLevelSchema });
	/**
	* A request from the client to the server, to enable or adjust logging.
	*
	* @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577); remains
	* in the specification for at least twelve months. Migrate to stderr logging
	* (STDIO servers) or OpenTelemetry.
	*/
	const SetLevelRequestSchema = RequestSchema.extend({
		method: literal("logging/setLevel"),
		params: SetLevelRequestParamsSchema
	});
	/**
	* Parameters for a `notifications/message` notification.
	*
	* @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577); remains
	* in the specification for at least twelve months. Migrate to stderr logging
	* (STDIO servers) or OpenTelemetry.
	*/
	const LoggingMessageNotificationParamsSchema = NotificationsParamsSchema.extend({
		level: LoggingLevelSchema,
		logger: string().optional(),
		data: unknown()
	});
	/**
	* Notification of a log message passed from server to client. If no `logging/setLevel` request has been sent from the client, the server MAY decide which messages to send automatically.
	*
	* @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577); remains
	* in the specification for at least twelve months. Migrate to stderr logging
	* (STDIO servers) or OpenTelemetry.
	*/
	const LoggingMessageNotificationSchema = NotificationSchema.extend({
		method: literal("notifications/message"),
		params: LoggingMessageNotificationParamsSchema
	});
	/**
	* Hints to use for model selection.
	*
	* @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577); remains
	* in the specification for at least twelve months. Migrate to calling LLM
	* provider APIs directly.
	*/
	const ModelHintSchema = object({ name: string().optional() });
	/**
	* The server's preferences for model selection, requested of the client during sampling.
	*
	* @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577); remains
	* in the specification for at least twelve months. Migrate to calling LLM
	* provider APIs directly.
	*/
	const ModelPreferencesSchema = object({
		hints: array(ModelHintSchema).optional(),
		costPriority: number$1().min(0).max(1).optional(),
		speedPriority: number$1().min(0).max(1).optional(),
		intelligencePriority: number$1().min(0).max(1).optional()
	});
	/**
	* Controls tool usage behavior in sampling requests.
	*
	* @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577); remains
	* in the specification for at least twelve months. Migrate to calling LLM
	* provider APIs directly.
	*/
	const ToolChoiceSchema = object({ mode: _enum([
		"auto",
		"required",
		"none"
	]).optional() });
	/**
	* The result of a tool execution, provided by the user (server).
	* Represents the outcome of invoking a tool requested via `ToolUseContent`.
	*
	* @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577); remains
	* in the specification for at least twelve months. Migrate to calling LLM
	* provider APIs directly.
	*/
	const ToolResultContentSchema = object({
		type: literal("tool_result"),
		toolUseId: string().describe("The unique identifier for the corresponding tool call."),
		content: array(ContentBlockSchema),
		structuredContent: unknown().optional(),
		isError: boolean().optional(),
		_meta: record(string(), unknown()).optional()
	});
	/**
	* Basic content types for sampling responses (without tool use).
	* Used for backwards-compatible {@linkcode CreateMessageResult} when tools are not used.
	*
	* @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577); remains
	* in the specification for at least twelve months. Migrate to calling LLM
	* provider APIs directly.
	*/
	const SamplingContentSchema = discriminatedUnion("type", [
		TextContentSchema,
		ImageContentSchema,
		AudioContentSchema
	]);
	/**
	* Content block types allowed in sampling messages.
	* This includes text, image, audio, tool use requests, and tool results.
	*
	* @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577); remains
	* in the specification for at least twelve months. Migrate to calling LLM
	* provider APIs directly.
	*/
	const SamplingMessageContentBlockSchema = discriminatedUnion("type", [
		TextContentSchema,
		ImageContentSchema,
		AudioContentSchema,
		ToolUseContentSchema,
		ToolResultContentSchema
	]);
	/**
	* Describes a message issued to or received from an LLM API.
	*
	* @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577); remains
	* in the specification for at least twelve months. Migrate to calling LLM
	* provider APIs directly.
	*/
	const SamplingMessageSchema = object({
		role: RoleSchema,
		content: union([SamplingMessageContentBlockSchema, array(SamplingMessageContentBlockSchema)]),
		_meta: record(string(), unknown()).optional()
	});
	/**
	* Parameters for a `sampling/createMessage` request.
	*
	* @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577); remains
	* in the specification for at least twelve months. Migrate to calling LLM
	* provider APIs directly.
	*/
	const CreateMessageRequestParamsSchema = TaskAugmentedRequestParamsSchema.extend({
		messages: array(SamplingMessageSchema),
		modelPreferences: ModelPreferencesSchema.optional(),
		systemPrompt: string().optional(),
		includeContext: _enum([
			"none",
			"thisServer",
			"allServers"
		]).optional(),
		temperature: number$1().optional(),
		maxTokens: number$1().int(),
		stopSequences: array(string()).optional(),
		metadata: JSONObjectSchema.optional(),
		tools: array(ToolSchema).optional(),
		toolChoice: ToolChoiceSchema.optional()
	});
	/**
	* A request from the server to sample an LLM via the client. The client has full discretion over which model to select. The client should also inform the user before beginning sampling, to allow them to inspect the request (human in the loop) and decide whether to approve it.
	*
	* @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577); remains
	* in the specification for at least twelve months. Migrate to calling LLM
	* provider APIs directly.
	*/
	const CreateMessageRequestSchema = RequestSchema.extend({
		method: literal("sampling/createMessage"),
		params: CreateMessageRequestParamsSchema
	});
	/**
	* The client's response to a `sampling/create_message` request from the server.
	* This is the backwards-compatible version that returns single content (no arrays).
	* Used when the request does not include tools.
	*
	* @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577); remains
	* in the specification for at least twelve months. Migrate to calling LLM
	* provider APIs directly.
	*/
	const CreateMessageResultSchema = ResultSchema.extend({
		model: string(),
		stopReason: optional(_enum([
			"endTurn",
			"stopSequence",
			"maxTokens"
		]).or(string())),
		role: RoleSchema,
		content: SamplingContentSchema
	});
	/**
	* The client's response to a `sampling/create_message` request when tools were provided.
	* This version supports array content for tool use flows.
	*
	* @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577); remains
	* in the specification for at least twelve months. Migrate to calling LLM
	* provider APIs directly.
	*/
	const CreateMessageResultWithToolsSchema = ResultSchema.extend({
		model: string(),
		stopReason: optional(_enum([
			"endTurn",
			"stopSequence",
			"maxTokens",
			"toolUse"
		]).or(string())),
		role: RoleSchema,
		content: union([SamplingMessageContentBlockSchema, array(SamplingMessageContentBlockSchema)])
	});
	/**
	* Primitive schema definition for boolean fields.
	*/
	const BooleanSchemaSchema = object({
		type: literal("boolean"),
		title: string().optional(),
		description: string().optional(),
		default: boolean().optional()
	});
	/**
	* Primitive schema definition for string fields.
	*/
	const StringSchemaSchema = object({
		type: literal("string"),
		title: string().optional(),
		description: string().optional(),
		minLength: number$1().optional(),
		maxLength: number$1().optional(),
		format: _enum([
			"email",
			"uri",
			"date",
			"date-time"
		]).optional(),
		default: string().optional()
	});
	/**
	* Primitive schema definition for number fields.
	*/
	const NumberSchemaSchema = object({
		type: _enum(["number", "integer"]),
		title: string().optional(),
		description: string().optional(),
		minimum: number$1().optional(),
		maximum: number$1().optional(),
		default: number$1().optional()
	});
	/**
	* Schema for single-selection enumeration without display titles for options.
	*/
	const UntitledSingleSelectEnumSchemaSchema = object({
		type: literal("string"),
		title: string().optional(),
		description: string().optional(),
		enum: array(string()),
		default: string().optional()
	});
	/**
	* Schema for single-selection enumeration with display titles for each option.
	*/
	const TitledSingleSelectEnumSchemaSchema = object({
		type: literal("string"),
		title: string().optional(),
		description: string().optional(),
		oneOf: array(object({
			const: string(),
			title: string()
		})),
		default: string().optional()
	});
	/**
	* Use {@linkcode TitledSingleSelectEnumSchema} instead.
	* This interface will be removed in a future version.
	*/
	const LegacyTitledEnumSchemaSchema = object({
		type: literal("string"),
		title: string().optional(),
		description: string().optional(),
		enum: array(string()),
		enumNames: array(string()).optional(),
		default: string().optional()
	});
	const SingleSelectEnumSchemaSchema = union([UntitledSingleSelectEnumSchemaSchema, TitledSingleSelectEnumSchemaSchema]);
	/**
	* Schema for multiple-selection enumeration without display titles for options.
	*/
	const UntitledMultiSelectEnumSchemaSchema = object({
		type: literal("array"),
		title: string().optional(),
		description: string().optional(),
		minItems: number$1().optional(),
		maxItems: number$1().optional(),
		items: object({
			type: literal("string"),
			enum: array(string())
		}),
		default: array(string()).optional()
	});
	/**
	* Schema for multiple-selection enumeration with display titles for each option.
	*/
	const TitledMultiSelectEnumSchemaSchema = object({
		type: literal("array"),
		title: string().optional(),
		description: string().optional(),
		minItems: number$1().optional(),
		maxItems: number$1().optional(),
		items: object({ anyOf: array(object({
			const: string(),
			title: string()
		})) }),
		default: array(string()).optional()
	});
	/**
	* Combined schema for multiple-selection enumeration
	*/
	const MultiSelectEnumSchemaSchema = union([UntitledMultiSelectEnumSchemaSchema, TitledMultiSelectEnumSchemaSchema]);
	/**
	* Primitive schema definition for enum fields.
	*/
	const EnumSchemaSchema = union([
		LegacyTitledEnumSchemaSchema,
		SingleSelectEnumSchemaSchema,
		MultiSelectEnumSchemaSchema
	]);
	/**
	* Union of all primitive schema definitions.
	*/
	const PrimitiveSchemaDefinitionSchema = union([
		EnumSchemaSchema,
		BooleanSchemaSchema,
		StringSchemaSchema,
		NumberSchemaSchema
	]);
	/**
	* Parameters for an `elicitation/create` request for form-based elicitation.
	*/
	const ElicitRequestFormParamsSchema = TaskAugmentedRequestParamsSchema.extend({
		mode: literal("form").optional(),
		message: string(),
		requestedSchema: object({
			type: literal("object"),
			properties: record(string(), PrimitiveSchemaDefinitionSchema),
			required: array(string()).optional()
		}).catchall(unknown())
	});
	/**
	* Parameters for an {@linkcode ElicitRequest | elicitation/create} request for URL-based elicitation.
	*/
	const ElicitRequestURLParamsSchema = TaskAugmentedRequestParamsSchema.extend({
		mode: literal("url"),
		message: string(),
		elicitationId: string(),
		url: string().url()
	});
	/**
	* The parameters for a request to elicit additional information from the user via the client.
	*/
	const ElicitRequestParamsSchema = union([ElicitRequestFormParamsSchema, ElicitRequestURLParamsSchema]);
	/**
	* A request from the server to elicit user input via the client.
	* The client should present the message and form fields to the user (form mode)
	* or navigate to a URL (URL mode).
	*/
	const ElicitRequestSchema = RequestSchema.extend({
		method: literal("elicitation/create"),
		params: ElicitRequestParamsSchema
	});
	/**
	* Parameters for a {@linkcode ElicitationCompleteNotification | notifications/elicitation/complete} notification.
	*
	* @deprecated Removed from the spec by #2891 (2026-07-28). The client learns the outcome
	* of an out-of-band interaction by retrying the original request; no server-initiated
	* completion signal exists in the 2026-07-28 revision. Kept here for the 2025-era flow
	* only. The 2026-07-28 wire codec excludes this notification.
	* @category notifications/elicitation/complete
	*/
	const ElicitationCompleteNotificationParamsSchema = NotificationsParamsSchema.extend({ elicitationId: string() });
	/**
	* A notification from the server to the client, informing it of a completion of an out-of-band elicitation request.
	*
	* @deprecated Removed from the spec by #2891 (2026-07-28). The client learns the outcome
	* of an out-of-band interaction by retrying the original request; no server-initiated
	* completion signal exists in the 2026-07-28 revision. Kept here for the 2025-era flow
	* only. The 2026-07-28 wire codec excludes this notification.
	* @category notifications/elicitation/complete
	*/
	const ElicitationCompleteNotificationSchema = NotificationSchema.extend({
		method: literal("notifications/elicitation/complete"),
		params: ElicitationCompleteNotificationParamsSchema
	});
	/**
	* The client's response to an {@linkcode ElicitRequest | elicitation/create} request from the server.
	*/
	const ElicitResultSchema = ResultSchema.extend({
		action: _enum([
			"accept",
			"decline",
			"cancel"
		]),
		content: preprocess((val) => val === null ? void 0 : val, record(string(), union([
			string(),
			number$1(),
			boolean(),
			array(string())
		])).optional())
	});
	/**
	* A reference to a resource or resource template definition.
	*/
	const ResourceTemplateReferenceSchema = object({
		type: literal("ref/resource"),
		uri: string()
	});
	/**
	* Identifies a prompt.
	*/
	const PromptReferenceSchema = object({
		type: literal("ref/prompt"),
		name: string()
	});
	/**
	* Parameters for a {@linkcode CompleteRequest | completion/complete} request.
	*/
	const CompleteRequestParamsSchema = BaseRequestParamsSchema.extend({
		ref: union([PromptReferenceSchema, ResourceTemplateReferenceSchema]),
		argument: object({
			name: string(),
			value: string()
		}),
		context: object({ arguments: record(string(), string()).optional() }).optional()
	});
	/**
	* A request from the client to the server, to ask for completion options.
	*/
	const CompleteRequestSchema = RequestSchema.extend({
		method: literal("completion/complete"),
		params: CompleteRequestParamsSchema
	});
	/**
	* The server's response to a {@linkcode CompleteRequest | completion/complete} request
	*/
	const CompleteResultSchema = ResultSchema.extend({ completion: looseObject({
		values: array(string()).max(100),
		total: optional(number$1().int()),
		hasMore: optional(boolean())
	}) });
	/**
	* Represents a root directory or file that the server can operate on.
	*
	* @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577); remains
	* in the specification for at least twelve months. Migrate to passing paths via
	* tool parameters, resource URIs, or configuration.
	*/
	const RootSchema = object({
		uri: string().startsWith("file://"),
		name: string().optional(),
		_meta: record(string(), unknown()).optional()
	});
	/**
	* Sent from the server to request a list of root URIs from the client.
	*
	* @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577); remains
	* in the specification for at least twelve months. Migrate to passing paths via
	* tool parameters, resource URIs, or configuration.
	*/
	const ListRootsRequestSchema = RequestSchema.extend({
		method: literal("roots/list"),
		params: BaseRequestParamsSchema.optional()
	});
	/**
	* The client's response to a `roots/list` request from the server.
	*
	* @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577); remains
	* in the specification for at least twelve months. Migrate to passing paths via
	* tool parameters, resource URIs, or configuration.
	*/
	const ListRootsResultSchema = ResultSchema.extend({ roots: array(RootSchema) });
	/**
	* A notification from the client to the server, informing it that the list of roots has changed.
	*
	* @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577); remains
	* in the specification for at least twelve months. Migrate to passing paths via
	* tool parameters, resource URIs, or configuration.
	*/
	const RootsListChangedNotificationSchema = NotificationSchema.extend({
		method: literal("notifications/roots/list_changed"),
		params: NotificationsParamsSchema.optional()
	});
	/**
	* Task creation parameters, used to ask that the server create a task to represent a request.
	*
	* @deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only.
	*/
	const TaskCreationParamsSchema = looseObject({
		ttl: number$1().optional(),
		pollInterval: number$1().optional()
	});
	/**
	* The status of a task.
	*
	* @deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only.
	*/
	const TaskStatusSchema = _enum([
		"working",
		"input_required",
		"completed",
		"failed",
		"cancelled"
	]);
	/**
	* A pollable state object associated with a request.
	*
	* @deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only.
	*/
	const TaskSchema = object({
		taskId: string(),
		status: TaskStatusSchema,
		ttl: union([number$1(), _null()]),
		createdAt: string(),
		lastUpdatedAt: string(),
		pollInterval: optional(number$1()),
		statusMessage: optional(string())
	});
	/**
	* Result returned when a task is created, containing the task data wrapped in a `task` field.
	*
	* @deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only.
	*/
	const CreateTaskResultSchema = ResultSchema.extend({ task: TaskSchema });
	/**
	* Parameters for task status notification.
	*
	* @deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only.
	*/
	const TaskStatusNotificationParamsSchema = NotificationsParamsSchema.merge(TaskSchema);
	/**
	* A notification sent when a task's status changes.
	*
	* @deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only.
	*/
	const TaskStatusNotificationSchema = NotificationSchema.extend({
		method: literal("notifications/tasks/status"),
		params: TaskStatusNotificationParamsSchema
	});
	/**
	* A request to get the state of a specific task.
	*
	* @deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only.
	*/
	const GetTaskRequestSchema = RequestSchema.extend({
		method: literal("tasks/get"),
		params: BaseRequestParamsSchema.extend({ taskId: string() })
	});
	/**
	* The response to a {@linkcode GetTaskRequest | tasks/get} request.
	*
	* @deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only.
	*/
	const GetTaskResultSchema = ResultSchema.merge(TaskSchema);
	/**
	* A request to get the result of a specific task.
	*
	* @deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only.
	*/
	const GetTaskPayloadRequestSchema = RequestSchema.extend({
		method: literal("tasks/result"),
		params: BaseRequestParamsSchema.extend({ taskId: string() })
	});
	/**
	* The response to a `tasks/result` request.
	* The structure matches the result type of the original request.
	* For example, a {@linkcode CallToolRequest | tools/call} task would return the `CallToolResult` structure.
	*
	*
	* @deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only.
	*/
	const GetTaskPayloadResultSchema = ResultSchema.loose();
	/**
	* A request to list tasks.
	*
	* @deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only.
	*/
	const ListTasksRequestSchema = PaginatedRequestSchema.extend({ method: literal("tasks/list") });
	/**
	* The response to a {@linkcode ListTasksRequest | tasks/list} request.
	*
	* @deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only.
	*/
	const ListTasksResultSchema = PaginatedResultSchema.extend({ tasks: array(TaskSchema) });
	/**
	* A request to cancel a specific task.
	*
	* @deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only.
	*/
	const CancelTaskRequestSchema = RequestSchema.extend({
		method: literal("tasks/cancel"),
		params: BaseRequestParamsSchema.extend({ taskId: string() })
	});
	/**
	* The response to a {@linkcode CancelTaskRequest | tasks/cancel} request.
	*
	* @deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only.
	*/
	const CancelTaskResultSchema = ResultSchema.merge(TaskSchema);
	const ClientRequestSchema = union([
		PingRequestSchema,
		InitializeRequestSchema,
		DiscoverRequestSchema,
		CompleteRequestSchema,
		SetLevelRequestSchema,
		GetPromptRequestSchema,
		ListPromptsRequestSchema,
		ListResourcesRequestSchema,
		ListResourceTemplatesRequestSchema,
		ReadResourceRequestSchema,
		SubscribeRequestSchema,
		UnsubscribeRequestSchema,
		SubscriptionsListenRequestSchema,
		CallToolRequestSchema,
		ListToolsRequestSchema
	]);
	const ClientNotificationSchema = union([
		CancelledNotificationSchema,
		ProgressNotificationSchema,
		InitializedNotificationSchema,
		RootsListChangedNotificationSchema
	]);
	const ClientResultSchema = union([
		EmptyResultSchema,
		CreateMessageResultSchema,
		CreateMessageResultWithToolsSchema,
		ElicitResultSchema,
		ListRootsResultSchema
	]);
	const ServerRequestSchema = union([
		PingRequestSchema,
		CreateMessageRequestSchema,
		ElicitRequestSchema,
		ListRootsRequestSchema
	]);
	const ServerNotificationSchema = union([
		CancelledNotificationSchema,
		ProgressNotificationSchema,
		LoggingMessageNotificationSchema,
		ResourceUpdatedNotificationSchema,
		ResourceListChangedNotificationSchema,
		ToolListChangedNotificationSchema,
		PromptListChangedNotificationSchema,
		SubscriptionsAcknowledgedNotificationSchema,
		ElicitationCompleteNotificationSchema
	]);
	const ServerResultSchema = union([
		EmptyResultSchema,
		InitializeResultSchema,
		DiscoverResultSchema,
		CompleteResultSchema,
		GetPromptResultSchema,
		ListPromptsResultSchema,
		ListResourcesResultSchema,
		ListResourceTemplatesResultSchema,
		ReadResourceResultSchema,
		CallToolResultSchema,
		ListToolsResultSchema,
		SubscriptionsListenResultSchema
	]);
	/**
	* Reusable URL validation that disallows `javascript:` scheme
	*/
	const SafeUrlSchema = url().superRefine((val, ctx) => {
		if (!URL.canParse(val)) {
			ctx.addIssue({
				code: ZodIssueCode.custom,
				message: "URL must be parseable",
				fatal: true
			});
			return NEVER;
		}
	}).refine((url) => {
		const u = new URL(url);
		return u.protocol !== "javascript:" && u.protocol !== "data:" && u.protocol !== "vbscript:";
	}, { message: "URL cannot use javascript:, data:, or vbscript: scheme" });
	/**
	* RFC 9728 OAuth Protected Resource Metadata
	*/
	const OAuthProtectedResourceMetadataSchema = looseObject({
		resource: string().url(),
		authorization_servers: array(SafeUrlSchema).optional(),
		jwks_uri: string().url().optional(),
		scopes_supported: array(string()).optional(),
		bearer_methods_supported: array(string()).optional(),
		resource_signing_alg_values_supported: array(string()).optional(),
		resource_name: string().optional(),
		resource_documentation: string().optional(),
		resource_policy_uri: string().url().optional(),
		resource_tos_uri: string().url().optional(),
		tls_client_certificate_bound_access_tokens: boolean().optional(),
		authorization_details_types_supported: array(string()).optional(),
		dpop_signing_alg_values_supported: array(string()).optional(),
		dpop_bound_access_tokens_required: boolean().optional()
	});
	/**
	* RFC 8414 OAuth 2.0 Authorization Server Metadata
	*/
	const OAuthMetadataSchema = looseObject({
		issuer: string(),
		authorization_endpoint: SafeUrlSchema,
		token_endpoint: SafeUrlSchema,
		registration_endpoint: SafeUrlSchema.optional(),
		scopes_supported: array(string()).optional(),
		response_types_supported: array(string()),
		response_modes_supported: array(string()).optional(),
		grant_types_supported: array(string()).optional(),
		token_endpoint_auth_methods_supported: array(string()).optional(),
		token_endpoint_auth_signing_alg_values_supported: array(string()).optional(),
		service_documentation: SafeUrlSchema.optional(),
		revocation_endpoint: SafeUrlSchema.optional(),
		revocation_endpoint_auth_methods_supported: array(string()).optional(),
		revocation_endpoint_auth_signing_alg_values_supported: array(string()).optional(),
		introspection_endpoint: string().optional(),
		introspection_endpoint_auth_methods_supported: array(string()).optional(),
		introspection_endpoint_auth_signing_alg_values_supported: array(string()).optional(),
		code_challenge_methods_supported: array(string()).optional(),
		client_id_metadata_document_supported: boolean().optional(),
		authorization_response_iss_parameter_supported: boolean().optional().catch(void 0)
	});
	/**
	* OpenID Connect Discovery 1.0 Provider Metadata
	*
	* @see https://openid.net/specs/openid-connect-discovery-1_0.html#ProviderMetadata
	*/
	const OpenIdProviderMetadataSchema = looseObject({
		issuer: string(),
		authorization_endpoint: SafeUrlSchema,
		token_endpoint: SafeUrlSchema,
		userinfo_endpoint: SafeUrlSchema.optional(),
		jwks_uri: SafeUrlSchema,
		registration_endpoint: SafeUrlSchema.optional(),
		scopes_supported: array(string()).optional(),
		response_types_supported: array(string()),
		response_modes_supported: array(string()).optional(),
		grant_types_supported: array(string()).optional(),
		acr_values_supported: array(string()).optional(),
		subject_types_supported: array(string()),
		id_token_signing_alg_values_supported: array(string()),
		id_token_encryption_alg_values_supported: array(string()).optional(),
		id_token_encryption_enc_values_supported: array(string()).optional(),
		userinfo_signing_alg_values_supported: array(string()).optional(),
		userinfo_encryption_alg_values_supported: array(string()).optional(),
		userinfo_encryption_enc_values_supported: array(string()).optional(),
		request_object_signing_alg_values_supported: array(string()).optional(),
		request_object_encryption_alg_values_supported: array(string()).optional(),
		request_object_encryption_enc_values_supported: array(string()).optional(),
		token_endpoint_auth_methods_supported: array(string()).optional(),
		token_endpoint_auth_signing_alg_values_supported: array(string()).optional(),
		display_values_supported: array(string()).optional(),
		claim_types_supported: array(string()).optional(),
		claims_supported: array(string()).optional(),
		service_documentation: string().optional(),
		claims_locales_supported: array(string()).optional(),
		ui_locales_supported: array(string()).optional(),
		claims_parameter_supported: boolean().optional(),
		request_parameter_supported: boolean().optional(),
		request_uri_parameter_supported: boolean().optional(),
		require_request_uri_registration: boolean().optional(),
		op_policy_uri: SafeUrlSchema.optional(),
		op_tos_uri: SafeUrlSchema.optional(),
		client_id_metadata_document_supported: boolean().optional(),
		authorization_response_iss_parameter_supported: boolean().optional().catch(void 0)
	});
	/**
	* OpenID Connect Discovery metadata that may include OAuth 2.0 fields
	* This schema represents the real-world scenario where OIDC providers
	* return a mix of OpenID Connect and OAuth 2.0 metadata fields
	*/
	const OpenIdProviderDiscoveryMetadataSchema = object({
		...OpenIdProviderMetadataSchema.shape,
		...OAuthMetadataSchema.pick({ code_challenge_methods_supported: true }).shape
	});
	/**
	* OAuth 2.1 token response
	*/
	const OAuthTokensSchema = object({
		access_token: string(),
		id_token: string().optional(),
		token_type: string(),
		expires_in: number().optional(),
		scope: string().optional(),
		refresh_token: string().optional()
	}).strip();
	/**
	* RFC 8693 §2.2.1 Token Exchange response for ID-JAG tokens.
	*
	* `token_type` is intentionally optional: per RFC 8693 §2.2.1 it is informational when
	* the issued token is not an access token, and per RFC 6749 §5.1 it is case-insensitive,
	* so strict checking rejects conformant IdPs.
	*/
	const IdJagTokenExchangeResponseSchema = object({
		issued_token_type: literal("urn:ietf:params:oauth:token-type:id-jag"),
		access_token: string(),
		token_type: string().optional(),
		expires_in: number$1().optional(),
		scope: string().optional()
	}).strip();
	/**
	* OAuth 2.1 error response
	*/
	const OAuthErrorResponseSchema = object({
		error: string(),
		error_description: string().optional(),
		error_uri: string().optional()
	});
	/**
	* Optional version of {@linkcode SafeUrlSchema} that allows empty string for backward compatibility on `tos_uri` and `logo_uri`
	*/
	const OptionalSafeUrlSchema = SafeUrlSchema.optional().or(literal("").transform(() => void 0));
	/**
	* RFC 7591 OAuth 2.0 Dynamic Client Registration metadata
	*/
	const OAuthClientMetadataSchema = object({
		redirect_uris: array(SafeUrlSchema),
		token_endpoint_auth_method: string().optional(),
		grant_types: array(string()).optional(),
		response_types: array(string()).optional(),
		application_type: string().optional(),
		client_name: string().optional(),
		client_uri: SafeUrlSchema.optional(),
		logo_uri: OptionalSafeUrlSchema,
		scope: string().optional(),
		contacts: array(string()).optional(),
		tos_uri: OptionalSafeUrlSchema,
		policy_uri: string().optional(),
		jwks_uri: SafeUrlSchema.optional(),
		jwks: any().optional(),
		software_id: string().optional(),
		software_version: string().optional(),
		software_statement: string().optional()
	}).strip();
	/**
	* RFC 7591 OAuth 2.0 Dynamic Client Registration client information
	*/
	const OAuthClientInformationSchema = object({
		client_id: string(),
		client_secret: string().optional(),
		client_id_issued_at: number$1().optional(),
		client_secret_expires_at: number$1().optional()
	}).strip();
	/**
	* RFC 7591 OAuth 2.0 Dynamic Client Registration full response (client information plus metadata)
	*/
	const OAuthClientInformationFullSchema = OAuthClientMetadataSchema.merge(OAuthClientInformationSchema);
	/**
	* RFC 7591 OAuth 2.0 Dynamic Client Registration error response
	*/
	const OAuthClientRegistrationErrorSchema = object({
		error: string(),
		error_description: string().optional()
	}).strip();
	/**
	* RFC 7009 OAuth 2.0 Token Revocation request
	*/
	const OAuthTokenRevocationRequestSchema = object({
		token: string(),
		token_type_hint: string().optional()
	}).strip();
	//#endregion
	//#region ../../node_modules/.pnpm/@modelcontextprotocol+client@2.0.0/node_modules/@modelcontextprotocol/client/dist/src-D_zzAWoS.mjs
	/**
	* Cross-bundle `instanceof` support for the SDK error classes.
	*
	* `@modelcontextprotocol/client` and `@modelcontextprotocol/server` each bundle their
	* own copy of `core-internal`, so an error constructed by one package fails a
	* prototype-identity `instanceof` against the same class re-exported by the other —
	* exactly the check a dual-role process (gateway, host, in-process test) writes.
	*
	* Instead of prototype identity, branded classes stamp every instance with the brand
	* strings of its class chain under a registry symbol (`Symbol.for`, shared across
	* bundles and realms), and resolve `instanceof` via `Symbol.hasInstance` against the
	* brand set. Ordinary prototype-based `instanceof` is kept as a fallback so behavior
	* is unchanged for anything unbranded.
	*
	* A class participates by defining an **own** `mcpBrand` static (via a `static {}`
	* block, so nothing reaches the declaration files — a declared `protected static`
	* field would make the constructor types nominally incompatible across the bundled
	* copies) and (for hierarchy roots) installing {@linkcode brandedHasInstance} as
	* `Symbol.hasInstance`. User-defined subclasses that do not declare their own brand
	* keep plain prototype semantics — a foreign base-class instance never satisfies
	* `instanceof UserSubclass`.
	*
	* Prior art — the same stamp-and-hook shape ships at scale elsewhere: Node core
	* (stream.Writable since 2017, Console via a marker symbol, diagnostics_channel),
	* undici's whole error hierarchy (vendored into Node as fetch), googleapis/gaxios
	* (GaxiosError, Symbol.for marker), AWS SDK v3's ServiceException (which pairs a
	* Symbol.hasInstance override with a static isInstance guard, as we do), and zod v4
	* (Symbol.hasInstance on every schema class for cross-version interop).
	*
	* Contract notes:
	* - Participation criterion: **every error class exported from a public package that
	*   callers are documented to `instanceof` must be branded.** The per-package
	*   errorBrandConformance tests walk the export surfaces and fail naming any
	*   exported Error subclass that has not opted in.
	* - Brands assert **identity, not shape**: brand strings are version-less, so an
	*   instance from one SDK version matches the class of another. Members added to a
	*   branded class in a later version may be absent on a matched instance — read
	*   fields defensively, and treat branded classes as additive-only. The escape
	*   hatch when a release must break a branded class's read contract: change that
	*   class's brand string in the same release, which cleanly severs cross-version
	*   matching for that class. The per-package brand pins make the rename
	*   deliberate: errorSurfacePins.test.ts owns the core-internal brands, and each
	*   package's errorBrandConformance test pins its package-local ones.
	* - Cross-bundle matching requires **both** copies to be at or after the release
	*   that introduced branding; against an older copy, behavior degrades to plain
	*   prototype `instanceof` in both directions.
	* - A consumer re-bundling the SDK with property mangling (`mangle.props`) would
	*   break the brand statics; default esbuild/webpack/terser settings do not.
	*/
	/** Registry symbol — identical across bundled copies and realms. */
	const BRANDS = Symbol.for("mcp.sdk.errorBrands");
	/**
	* Stamp `instance` with the brand of every class in `ctor`'s chain that declares an
	* own `mcpBrand`. Call once from the hierarchy root's constructor with `new.target` —
	* subclasses inherit the stamping without touching their constructors.
	*
	* Constructor-time only: never stamp arbitrary objects. A stamped non-instance would
	* satisfy `instanceof` while lacking the prototype members (getters like `.status`)
	* that callers reach for after the check.
	*/
	function stampErrorBrands(instance, ctor) {
		const brands = /* @__PURE__ */ new Set();
		let current = ctor;
		while (typeof current === "function") {
			const brand = current.mcpBrand;
			if (Object.prototype.hasOwnProperty.call(current, "mcpBrand") && typeof brand === "string") brands.add(brand);
			current = Object.getPrototypeOf(current);
		}
		if (brands.size === 0) return;
		Object.defineProperty(instance, BRANDS, {
			value: brands,
			enumerable: false,
			configurable: true
		});
	}
	/**
	* `Symbol.hasInstance` implementation for branded hierarchy roots. Matches when the
	* value carries the **own** brand of the class being tested against (cross-bundle
	* path), falling back to ordinary prototype-based `instanceof` otherwise.
	*/
	function brandedHasInstance(cls, value) {
		try {
			if (typeof value === "object" && value !== null && Object.prototype.hasOwnProperty.call(cls, "mcpBrand") && typeof cls.mcpBrand === "string" && Object.prototype.hasOwnProperty.call(value, BRANDS)) {
				const carried = value[BRANDS];
				if (carried && typeof carried.has === "function" && carried.has(cls.mcpBrand)) return true;
			}
		} catch {}
		return Function.prototype[Symbol.hasInstance].call(cls, value);
	}
	/**
	* OAuth error codes as defined by {@link https://datatracker.ietf.org/doc/html/rfc6749#section-5.2 | RFC 6749}
	* and extensions.
	*/
	let OAuthErrorCode = /* @__PURE__ */ function(OAuthErrorCode$1) {
		/**
		* The request is missing a required parameter, includes an invalid parameter value,
		* includes a parameter more than once, or is otherwise malformed.
		*/
		OAuthErrorCode$1["InvalidRequest"] = "invalid_request";
		/**
		* Client authentication failed (e.g., unknown client, no client authentication included,
		* or unsupported authentication method).
		*/
		OAuthErrorCode$1["InvalidClient"] = "invalid_client";
		/**
		* The provided authorization grant or refresh token is invalid, expired, revoked,
		* does not match the redirection URI used in the authorization request, or was issued to another client.
		*/
		OAuthErrorCode$1["InvalidGrant"] = "invalid_grant";
		/**
		* The authenticated client is not authorized to use this authorization grant type.
		*/
		OAuthErrorCode$1["UnauthorizedClient"] = "unauthorized_client";
		/**
		* The authorization grant type is not supported by the authorization server.
		*/
		OAuthErrorCode$1["UnsupportedGrantType"] = "unsupported_grant_type";
		/**
		* The requested scope is invalid, unknown, malformed, or exceeds the scope granted by the resource owner.
		*/
		OAuthErrorCode$1["InvalidScope"] = "invalid_scope";
		/**
		* The resource owner or authorization server denied the request.
		*/
		OAuthErrorCode$1["AccessDenied"] = "access_denied";
		/**
		* The authorization server encountered an unexpected condition that prevented it from fulfilling the request.
		*/
		OAuthErrorCode$1["ServerError"] = "server_error";
		/**
		* The authorization server is currently unable to handle the request due to temporary overloading or maintenance.
		*/
		OAuthErrorCode$1["TemporarilyUnavailable"] = "temporarily_unavailable";
		/**
		* The authorization server does not support obtaining an authorization code using this method.
		*/
		OAuthErrorCode$1["UnsupportedResponseType"] = "unsupported_response_type";
		/**
		* The authorization server does not support the requested token type.
		*/
		OAuthErrorCode$1["UnsupportedTokenType"] = "unsupported_token_type";
		/**
		* The access token provided is expired, revoked, malformed, or invalid for other reasons.
		*/
		OAuthErrorCode$1["InvalidToken"] = "invalid_token";
		/**
		* The HTTP method used is not allowed for this endpoint. (Custom, non-standard error)
		*/
		OAuthErrorCode$1["MethodNotAllowed"] = "method_not_allowed";
		/**
		* Rate limit exceeded. (Custom, non-standard error based on RFC 6585)
		*/
		OAuthErrorCode$1["TooManyRequests"] = "too_many_requests";
		/**
		* The client metadata is invalid. (Custom error for dynamic client registration - RFC 7591)
		*/
		OAuthErrorCode$1["InvalidClientMetadata"] = "invalid_client_metadata";
		/**
		* The value of one or more redirection URIs is invalid. (Dynamic client registration - RFC 7591 §3.2.2)
		*/
		OAuthErrorCode$1["InvalidRedirectUri"] = "invalid_redirect_uri";
		/**
		* The request requires higher privileges than provided by the access token.
		*/
		OAuthErrorCode$1["InsufficientScope"] = "insufficient_scope";
		/**
		* The requested resource is invalid, missing, unknown, or malformed. (Custom error for resource indicators - RFC 8707)
		*/
		OAuthErrorCode$1["InvalidTarget"] = "invalid_target";
		return OAuthErrorCode$1;
	}({});
	/**
	* OAuth error class for all OAuth-related errors.
	*/
	var OAuthError = class OAuthError extends Error {
		static {
			Object.defineProperty(this, "mcpBrand", { value: "mcp.OAuthError" });
		}
		static [Symbol.hasInstance](value) {
			return brandedHasInstance(this, value);
		}
		/**
		* Brand-based type guard: equivalent to `value instanceof this`, as an
		* explicit static predicate (the axios/AWS-SDK `isInstance` style). Reads
		* the caller's own brand via `this`, so every branded subclass gets a
		* correctly-scoped guard by inheritance. Must be invoked on the class —
		* in callback position write `v => SdkError.isInstance(v)`, not
		* `.filter(SdkError.isInstance)` (detached calls throw rather than
		* silently matching nothing).
		*/
		static isInstance(value) {
			if (typeof this !== "function") throw new TypeError("isInstance must be called on the class (e.g. `SdkError.isInstance(value)`); for callbacks use `v => SdkError.isInstance(v)`");
			return brandedHasInstance(this, value);
		}
		constructor(code, message, errorUri) {
			super(message);
			this.code = code;
			this.errorUri = errorUri;
			this.name = "OAuthError";
			stampErrorBrands(this, new.target);
		}
		/**
		* Converts the error to a standard OAuth error response object.
		*/
		toResponseObject() {
			const response = {
				error: this.code,
				error_description: this.message
			};
			if (this.errorUri) response.error_uri = this.errorUri;
			return response;
		}
		/**
		* Creates an {@linkcode OAuthError} from an OAuth error response.
		*/
		static fromResponse(response) {
			return new OAuthError(response.error, response.error_description ?? response.error, response.error_uri);
		}
	};
	/**
	* Error codes for SDK errors (local errors that never cross the wire).
	* Unlike {@linkcode ProtocolErrorCode} which uses numeric JSON-RPC codes, `SdkErrorCode` uses
	* descriptive string values for better developer experience.
	*
	* These errors are thrown locally by the SDK and are never serialized as
	* JSON-RPC error responses.
	*/
	let SdkErrorCode = /* @__PURE__ */ function(SdkErrorCode$1) {
		/** Transport is not connected */
		SdkErrorCode$1["NotConnected"] = "NOT_CONNECTED";
		/** Transport is already connected */
		SdkErrorCode$1["AlreadyConnected"] = "ALREADY_CONNECTED";
		/** Protocol is not initialized */
		SdkErrorCode$1["NotInitialized"] = "NOT_INITIALIZED";
		/** Required capability is not supported by the remote side */
		SdkErrorCode$1["CapabilityNotSupported"] = "CAPABILITY_NOT_SUPPORTED";
		/** Request timed out waiting for response */
		SdkErrorCode$1["RequestTimeout"] = "REQUEST_TIMEOUT";
		/** Connection was closed */
		SdkErrorCode$1["ConnectionClosed"] = "CONNECTION_CLOSED";
		/** Failed to send message */
		SdkErrorCode$1["SendFailed"] = "SEND_FAILED";
		/** Response result failed local schema validation */
		SdkErrorCode$1["InvalidResult"] = "INVALID_RESULT";
		/**
		* The response carried a `resultType` discriminator (protocol revision
		* 2026-07-28) naming a result kind this client cannot consume yet, e.g.
		* `input_required`. The kind is carried in `data.resultType`.
		*/
		SdkErrorCode$1["UnsupportedResultType"] = "UNSUPPORTED_RESULT_TYPE";
		/**
		* The multi-round-trip auto-fulfilment driver exhausted its round cap
		* (`inputRequired.maxRounds`) without the server returning a complete
		* result. `data.rounds` carries the cap that was hit and
		* `data.lastResult` carries the last `input_required` payload received
		* (`{ inputRequests, requestState? }`), so callers can inspect or resume
		* the flow manually.
		*/
		SdkErrorCode$1["InputRequiredRoundsExceeded"] = "INPUT_REQUIRED_ROUNDS_EXCEEDED";
		/**
		* The auto-aggregating no-`cursor` `listTools()` / `listPrompts()` /
		* `listResources()` / `listResourceTemplates()` walk hit the
		* `ClientOptions.listMaxPages` cap without the server's pagination
		* converging. `data.method` carries the list verb and
		* `data.listMaxPages` the cap that was hit; raise the cap or fall back to
		* explicit per-page `{ cursor }` calls.
		*/
		SdkErrorCode$1["ListPaginationExceeded"] = "LIST_PAGINATION_EXCEEDED";
		/**
		* The spec method being sent does not exist on the negotiated protocol
		* version's wire era (e.g. `tasks/get` toward a 2026-07-28 peer, or
		* `server/discover` toward a 2025-era peer). Raised locally, before
		* anything reaches the transport. The method and era are carried in
		* `data.method` / `data.era`.
		*/
		SdkErrorCode$1["MethodNotSupportedByProtocolVersion"] = "METHOD_NOT_SUPPORTED_BY_PROTOCOL_VERSION";
		/**
		* Protocol-era negotiation at connect time failed without producing either a
		* usable modern (2026-07-28+) era or a definitive legacy fallback signal —
		* e.g. the negotiation mode forbids falling back (`pin`), the probe hit a
		* network failure, or the server answered the probe with a 5xx (a typed
		* connect error, never an era verdict).
		*
		* Negotiation-phase only: this code is never used once an era is
		* established. Auth walls never carry it: a 401/403 rejecting the probe
		* uses {@linkcode ClientHttpAuthentication} / {@linkcode ClientHttpForbidden}
		* instead, so era-recovery flows keyed on this code (e.g. cached-verdict
		* gateways) can never persist a verdict for an unauthorized exchange.
		*/
		SdkErrorCode$1["EraNegotiationFailed"] = "ERA_NEGOTIATION_FAILED";
		SdkErrorCode$1["ClientHttpNotImplemented"] = "CLIENT_HTTP_NOT_IMPLEMENTED";
		/**
		* HTTP 401 authentication failure: the transport's re-auth retry still got
		* 401 (`Server returned 401 after re-authentication`), or the version
		* negotiation probe was rejected 401 with no `authProvider` configured
		* (`Version negotiation failed: the server requires authorization (HTTP 401)`).
		* Carried on an {@linkcode SdkHttpError} with `status: 401`.
		*/
		SdkErrorCode$1["ClientHttpAuthentication"] = "CLIENT_HTTP_AUTHENTICATION";
		/**
		* HTTP 403 denial: the step-up re-authorization retry limit was reached,
		* or the version negotiation probe was rejected 403
		* (`Version negotiation failed: the server denied access (HTTP 403)`).
		* Carried on an {@linkcode SdkHttpError} with `status: 403`.
		*/
		SdkErrorCode$1["ClientHttpForbidden"] = "CLIENT_HTTP_FORBIDDEN";
		SdkErrorCode$1["ClientHttpUnexpectedContent"] = "CLIENT_HTTP_UNEXPECTED_CONTENT";
		SdkErrorCode$1["ClientHttpFailedToOpenStream"] = "CLIENT_HTTP_FAILED_TO_OPEN_STREAM";
		SdkErrorCode$1["ClientHttpFailedToTerminateSession"] = "CLIENT_HTTP_FAILED_TO_TERMINATE_SESSION";
		return SdkErrorCode$1;
	}({});
	/**
	* SDK errors are local errors that never cross the wire.
	* They are distinct from {@linkcode ProtocolError} which represents JSON-RPC protocol errors
	* that are serialized and sent as error responses.
	*
	* @example
	* ```ts source="./sdkErrors.examples.ts#SdkError_basicUsage"
	* try {
	*     // Throwing an SDK error
	*     throw new SdkError(SdkErrorCode.NotConnected, 'Transport is not connected');
	* } catch (error) {
	*     // Checking error type by code
	*     if (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout) {
	*         // Handle timeout
	*     }
	* }
	* ```
	*/
	var SdkError = class extends Error {
		static {
			Object.defineProperty(this, "mcpBrand", { value: "mcp.SdkError" });
		}
		static [Symbol.hasInstance](value) {
			return brandedHasInstance(this, value);
		}
		/**
		* Brand-based type guard: equivalent to `value instanceof this`, as an
		* explicit static predicate (the axios/AWS-SDK `isInstance` style). Reads
		* the caller's own brand via `this`, so every branded subclass gets a
		* correctly-scoped guard by inheritance. Must be invoked on the class —
		* in callback position write `v => SdkError.isInstance(v)`, not
		* `.filter(SdkError.isInstance)` (detached calls throw rather than
		* silently matching nothing).
		*/
		static isInstance(value) {
			if (typeof this !== "function") throw new TypeError("isInstance must be called on the class (e.g. `SdkError.isInstance(value)`); for callbacks use `v => SdkError.isInstance(v)`");
			return brandedHasInstance(this, value);
		}
		constructor(code, message, data) {
			super(message);
			this.code = code;
			this.data = data;
			this.name = "SdkError";
			stampErrorBrands(this, new.target);
		}
	};
	/**
	* An {@linkcode SdkError} subclass for HTTP transport failures.
	*
	* Thrown by the streamable HTTP transport when the server responds with a
	* non-OK status code. Narrows {@linkcode SdkError.data | data} to
	* {@linkcode SdkHttpErrorData} so consumers can inspect the HTTP status
	* without unsafe casting.
	*
	* @example
	* ```ts source="./sdkErrors.examples.ts#SdkHttpError_basicUsage"
	* if (error instanceof SdkHttpError) {
	*     console.log(error.status); // number
	*     console.log(error.statusText); // string | undefined
	* }
	* ```
	*/
	var SdkHttpError = class extends SdkError {
		static {
			Object.defineProperty(this, "mcpBrand", { value: "mcp.SdkHttpError" });
		}
		constructor(code, message, data) {
			super(code, message, data);
			this.name = "SdkHttpError";
		}
		get status() {
			return this.data.status;
		}
		get statusText() {
			return this.data.statusText;
		}
	};
	/**
	* Utilities for handling OAuth resource URIs.
	*/
	/**
	* Converts a server URL to a resource URL by removing the fragment.
	* {@link https://datatracker.ietf.org/doc/html/rfc8707#section-2 | RFC 8707 section 2}
	* states that resource URIs "MUST NOT include a fragment component".
	* Keeps everything else unchanged (scheme, domain, port, path, query).
	*/
	function resourceUrlFromServerUrl(url) {
		const resourceURL = typeof url === "string" ? new URL(url) : new URL(url.href);
		resourceURL.hash = "";
		return resourceURL;
	}
	/**
	* Checks if a requested resource URL matches a configured resource URL.
	* A requested resource matches if it has the same scheme, domain, port,
	* and its path starts with the configured resource's path.
	*
	* @param options - The options object
	* @param options.requestedResource - The resource URL being requested
	* @param options.configuredResource - The resource URL that has been configured
	* @returns true if the requested resource matches the configured resource, false otherwise
	*/
	function checkResourceAllowed({ requestedResource, configuredResource }) {
		const requested = typeof requestedResource === "string" ? new URL(requestedResource) : new URL(requestedResource.href);
		const configured = typeof configuredResource === "string" ? new URL(configuredResource) : new URL(configuredResource.href);
		if (requested.origin !== configured.origin) return false;
		if (requested.pathname.length < configured.pathname.length) return false;
		const requestedPath = requested.pathname.endsWith("/") ? requested.pathname : requested.pathname + "/";
		const configuredPath = configured.pathname.endsWith("/") ? configured.pathname : configured.pathname + "/";
		return requestedPath.startsWith(configuredPath);
	}
	/**
	* The first protocol revision of the modern (2026-07-28) era. Revision identifiers
	* are ISO dates, so lexicographic comparison orders them chronologically.
	*/
	const FIRST_MODERN_PROTOCOL_VERSION = "2026-07-28";
	/**
	* Modern-era protocol revisions this SDK can negotiate via `server/discover`.
	* Deliberately separate from {@linkcode SUPPORTED_PROTOCOL_VERSIONS} (the legacy
	* `initialize` list), so adding a revision here can never leak a modern version
	* string into a 2025-era handshake. Internal — not part of the public API surface.
	*/
	const SUPPORTED_MODERN_PROTOCOL_VERSIONS = [FIRST_MODERN_PROTOCOL_VERSION];
	/** Whether the given protocol revision belongs to the modern (2026-07-28+) era. */
	function isModernProtocolVersion(version) {
		return version >= FIRST_MODERN_PROTOCOL_VERSION;
	}
	/** The legacy-era (pre-2026-07-28) subset of a supported-versions list, in the list's own preference order. */
	function legacyProtocolVersions(versions) {
		return versions.filter((version) => !isModernProtocolVersion(version));
	}
	/** The modern-era (2026-07-28+) subset of a supported-versions list, in the list's own preference order. */
	function modernProtocolVersions(versions) {
		return versions.filter((version) => isModernProtocolVersion(version));
	}
	/**
	* SEP-2106 §4.3 TextContent auto-append, era-agnostic, called from BOTH
	* codecs' {@link WireCodec.projectCallToolResult}: when `structuredContent`
	* is a non-object value (array/primitive/`null`) and the handler authored no
	* `type:'text'` block, append `{type:'text', text: JSON.stringify(value)}`.
	* Object-shaped (or absent) `structuredContent` returns the same reference.
	*
	* Leaf module: imported by both era codec modules, so it must NOT import from
	* `./codec.js` (which value-imports the rev codecs at top level — that would
	* make a runtime cycle and a TDZ hazard for entries that evaluate a rev codec
	* module first).
	*/
	function appendTextFallbackForNonObject(result) {
		const sc = result.structuredContent;
		if (sc === void 0) return result;
		if (!(typeof sc !== "object" || sc === null || Array.isArray(sc))) return result;
		if (result.content?.some((c) => c.type === "text") ?? false) return result;
		return {
			...result,
			content: [...result.content ?? [], {
				type: "text",
				text: JSON.stringify(sc)
			}]
		};
	}
	/**
	* Result-family keys that must never default into a `{content: []}` tools/call
	* success. Shared by the 2025 wire-seam schema and server normalization.
	* Leaf module (like `textFallback.ts`): imported by registry/server paths, so
	* it must NOT import from `./codec.js` — that would close a runtime cycle.
	*/
	const TOOL_RESULT_FOREIGN_FAMILY_KEYS = [
		"task",
		"inputRequests",
		"requestState"
	];
	/**
	* Single owner of the v1-parity ruling: a plain-object tool result without `content` (and
	* without foreign-family keys) gains `content: []`. Shared by the 2025 wire seam and server-side handler normalization.
	*/
	function normalizeContentlessToolResult(value) {
		if (value === null || typeof value !== "object" || Array.isArray(value) || value.content !== void 0 || TOOL_RESULT_FOREIGN_FAMILY_KEYS.some((key) => key in value)) return value;
		return {
			...value,
			content: []
		};
	}
	/**
	* Complete frozen 2025-11-25 wire schemas. Self-contained — no imports from
	* the public/neutral types/schemas.ts. The neutral layer is the public-API
	* superset and is free to evolve (e.g., SEP-2106 widening); this file is the
	* 2025 wire-parse contract (Q10-L2 byte-identity) and is BEHAVIOR-FROZEN.
	*
	* This is the era's complete frozen wire-parse contract — both the 2025-only
	* delta (the deprecated task family, the era role unions) AND frozen copies of
	* every era-shared shape (Tool, CallToolResult, Initialize*, ContentBlock,
	* prompts/resources/completion/elicitation, …). The 2026-era codec
	* (`wire/rev2026-07-28/`) is symmetrically self-contained in the same way.
	*
	* The 2025-only delta (the task message surface, restored types-only by #2248
	* for interop with task-capable 2025 peers) is parsed ONLY through this era's
	* registry; the deprecated Task* schemas also live (marked `@deprecated`) in
	* the neutral schema layer so the public types stay nameable without a
	* cross-layer import — nameability is constant, runtime availability is
	* version-keyed — but appear in no API signature. Q1 increment 2 — deletions
	* are physical: the
	* 2026-era REGISTRY has no Task* methods (its frozen building-block copies do
	* carry the deprecated Task* sub-schemas by composition — soft contamination,
	* tracked for anchor-exactness adjudication).
	*
	* The only cross-layer dependency is `import type { JSONObject, JSONValue }`
	* from the neutral types barrel — pure structural type aliases with no parse
	* behavior. No runtime schema is shared with the neutral layer.
	*/
	function build$1() {
		const JSONValueSchema$1 = lazy(() => union([
			string(),
			number$1(),
			boolean(),
			_null(),
			record(string(), JSONValueSchema$1),
			array(JSONValueSchema$1)
		]));
		const JSONObjectSchema$1 = record(string(), JSONValueSchema$1);
		/**
		* A progress token, used to associate progress notifications with the original request.
		*/
		const ProgressTokenSchema$1 = union([string(), number$1().int()]);
		/**
		* An opaque token used to represent a cursor for pagination.
		*/
		const CursorSchema$1 = string();
		/** @deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only. */
		const TaskMetadataSchema$1 = object({ ttl: number$1().optional() });
		/**
		* Metadata for associating messages with a task.
		* Include this in the `_meta` field under the key `io.modelcontextprotocol/related-task`.
		*
		* @deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only.
		*/
		const RelatedTaskMetadataSchema$1 = object({ taskId: string() });
		const RequestMetaSchema$1 = looseObject({
			progressToken: ProgressTokenSchema$1.optional(),
			"io.modelcontextprotocol/related-task": RelatedTaskMetadataSchema$1.optional()
		});
		/**
		* Common params for any request.
		*/
		const BaseRequestParamsSchema$1 = object({ _meta: RequestMetaSchema$1.optional() });
		/**
		* Common params for any task-augmented request.
		*
		* @deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only.
		*/
		const TaskAugmentedRequestParamsSchema$1 = BaseRequestParamsSchema$1.extend({ task: TaskMetadataSchema$1.optional() });
		const RequestSchema$1 = object({
			method: string(),
			params: BaseRequestParamsSchema$1.loose().optional()
		});
		const NotificationsParamsSchema$1 = object({ _meta: RequestMetaSchema$1.optional() });
		const NotificationSchema$1 = object({
			method: string(),
			params: NotificationsParamsSchema$1.loose().optional()
		});
		const ResultSchema$1 = looseObject({ _meta: RequestMetaSchema$1.optional() });
		/**
		* A uniquely identifying ID for a request in JSON-RPC.
		*/
		const RequestIdSchema$1 = union([string(), number$1().int()]);
		/**
		* A response that indicates success but carries no data.
		*/
		const EmptyResultSchema$1 = ResultSchema$1.strict();
		const CancelledNotificationParamsSchema$1 = NotificationsParamsSchema$1.extend({
			requestId: RequestIdSchema$1.optional(),
			reason: string().optional()
		});
		/**
		* This notification can be sent by either side to indicate that it is cancelling a previously-issued request.
		*
		* The request SHOULD still be in-flight, but due to communication latency, it is always possible that this notification MAY arrive after the request has already finished.
		*
		* This notification indicates that the result will be unused, so any associated processing SHOULD cease.
		*
		* A client MUST NOT attempt to cancel its {@linkcode InitializeRequest | initialize} request.
		*/
		const CancelledNotificationSchema$1 = NotificationSchema$1.extend({
			method: literal("notifications/cancelled"),
			params: CancelledNotificationParamsSchema$1
		});
		/**
		* Icon schema for use in {@link Tool | tools}, {@link Prompt | prompts}, {@link Resource | resources}, and {@link Implementation | implementations}.
		*/
		const IconSchema$1 = object({
			src: string(),
			mimeType: string().optional(),
			sizes: array(string()).optional(),
			theme: _enum(["light", "dark"]).optional()
		});
		/**
		* Base schema to add `icons` property.
		*
		*/
		const IconsSchema$1 = object({ icons: array(IconSchema$1).optional() });
		/**
		* Base metadata interface for common properties across {@link Resource | resources}, {@link Tool | tools}, {@link Prompt | prompts}, and {@link Implementation | implementations}.
		*/
		const BaseMetadataSchema$1 = object({
			name: string(),
			title: string().optional()
		});
		/**
		* Describes the name and version of an MCP implementation.
		*/
		const ImplementationSchema$1 = BaseMetadataSchema$1.extend({
			...BaseMetadataSchema$1.shape,
			...IconsSchema$1.shape,
			version: string(),
			websiteUrl: string().optional(),
			description: string().optional()
		});
		const ElicitationCapabilitySchema = preprocess((value) => {
			if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) return { form: {} };
			return value;
		}, intersection(object({
			form: intersection(object({ applyDefaults: boolean().optional() }), JSONObjectSchema$1).optional(),
			url: JSONObjectSchema$1.optional()
		}), JSONObjectSchema$1.optional()));
		/**
		* Task capabilities for clients, indicating which request types support task creation.
		*
		* @deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only.
		*/
		const ClientTasksCapabilitySchema$1 = looseObject({
			list: JSONObjectSchema$1.optional(),
			cancel: JSONObjectSchema$1.optional(),
			requests: looseObject({
				sampling: looseObject({ createMessage: JSONObjectSchema$1.optional() }).optional(),
				elicitation: looseObject({ create: JSONObjectSchema$1.optional() }).optional()
			}).optional()
		});
		/**
		* Task capabilities for servers, indicating which request types support task creation.
		*
		* @deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only.
		*/
		const ServerTasksCapabilitySchema$1 = looseObject({
			list: JSONObjectSchema$1.optional(),
			cancel: JSONObjectSchema$1.optional(),
			requests: looseObject({ tools: looseObject({ call: JSONObjectSchema$1.optional() }).optional() }).optional()
		});
		/**
		* Capabilities a client may support. Known capabilities are defined here, in this schema, but this is not a closed set: any client can define its own, additional capabilities.
		*/
		const ClientCapabilitiesSchema$1 = object({
			experimental: record(string(), JSONObjectSchema$1).optional(),
			sampling: object({
				context: JSONObjectSchema$1.optional(),
				tools: JSONObjectSchema$1.optional()
			}).optional(),
			elicitation: ElicitationCapabilitySchema.optional(),
			roots: object({ listChanged: boolean().optional() }).optional(),
			tasks: ClientTasksCapabilitySchema$1.optional(),
			extensions: record(string(), JSONObjectSchema$1).optional()
		});
		const InitializeRequestParamsSchema$1 = BaseRequestParamsSchema$1.extend({
			protocolVersion: string(),
			capabilities: ClientCapabilitiesSchema$1,
			clientInfo: ImplementationSchema$1
		});
		/**
		* This request is sent from the client to the server when it first connects, asking it to begin initialization.
		*/
		const InitializeRequestSchema$1 = RequestSchema$1.extend({
			method: literal("initialize"),
			params: InitializeRequestParamsSchema$1
		});
		/**
		* Capabilities that a server may support. Known capabilities are defined here, in this schema, but this is not a closed set: any server can define its own, additional capabilities.
		*/
		const ServerCapabilitiesSchema$1 = object({
			experimental: record(string(), JSONObjectSchema$1).optional(),
			logging: JSONObjectSchema$1.optional(),
			completions: JSONObjectSchema$1.optional(),
			prompts: object({ listChanged: boolean().optional() }).optional(),
			resources: object({
				subscribe: boolean().optional(),
				listChanged: boolean().optional()
			}).optional(),
			tools: object({ listChanged: boolean().optional() }).optional(),
			tasks: ServerTasksCapabilitySchema$1.optional(),
			extensions: record(string(), JSONObjectSchema$1).optional()
		});
		/**
		* After receiving an initialize request from the client, the server sends this response.
		*/
		const InitializeResultSchema$1 = ResultSchema$1.extend({
			protocolVersion: string(),
			capabilities: ServerCapabilitiesSchema$1,
			serverInfo: ImplementationSchema$1,
			instructions: string().optional()
		});
		/**
		* This notification is sent from the client to the server after initialization has finished.
		*/
		const InitializedNotificationSchema$1 = NotificationSchema$1.extend({
			method: literal("notifications/initialized"),
			params: NotificationsParamsSchema$1.optional()
		});
		/**
		* A ping, issued by either the server or the client, to check that the other party is still alive. The receiver must promptly respond, or else may be disconnected.
		*/
		const PingRequestSchema$1 = RequestSchema$1.extend({
			method: literal("ping"),
			params: BaseRequestParamsSchema$1.optional()
		});
		const ProgressSchema$1 = object({
			progress: number$1(),
			total: optional(number$1()),
			message: optional(string())
		});
		const ProgressNotificationParamsSchema$1 = object({
			...NotificationsParamsSchema$1.shape,
			...ProgressSchema$1.shape,
			progressToken: ProgressTokenSchema$1
		});
		/**
		* An out-of-band notification used to inform the receiver of a progress update for a long-running request.
		*
		* @category notifications/progress
		*/
		const ProgressNotificationSchema$1 = NotificationSchema$1.extend({
			method: literal("notifications/progress"),
			params: ProgressNotificationParamsSchema$1
		});
		const PaginatedRequestParamsSchema$1 = BaseRequestParamsSchema$1.extend({ cursor: CursorSchema$1.optional() });
		const PaginatedRequestSchema$1 = RequestSchema$1.extend({ params: PaginatedRequestParamsSchema$1.optional() });
		const PaginatedResultSchema$1 = ResultSchema$1.extend({ nextCursor: CursorSchema$1.optional() });
		/**
		* The contents of a specific resource or sub-resource.
		*/
		const ResourceContentsSchema$1 = object({
			uri: string(),
			mimeType: optional(string()),
			_meta: record(string(), unknown()).optional()
		});
		const TextResourceContentsSchema$1 = ResourceContentsSchema$1.extend({ text: string() });
		/**
		* A Zod schema for validating Base64 strings that is more performant and
		* robust for very large inputs than the default regex-based check. It avoids
		* stack overflows by using the native `atob` function for validation.
		*/
		const Base64Schema = string().refine((val) => {
			try {
				atob(val);
				return true;
			} catch {
				return false;
			}
		}, { message: "Invalid Base64 string" });
		const BlobResourceContentsSchema$1 = ResourceContentsSchema$1.extend({ blob: Base64Schema });
		/**
		* The sender or recipient of messages and data in a conversation.
		*/
		const RoleSchema$1 = _enum(["user", "assistant"]);
		/**
		* Optional annotations providing clients additional context about a resource.
		*/
		const AnnotationsSchema$1 = object({
			audience: array(RoleSchema$1).optional(),
			priority: number$1().min(0).max(1).optional(),
			lastModified: datetime({ offset: true }).optional()
		});
		/**
		* A known resource that the server is capable of reading.
		*/
		const ResourceSchema$1 = object({
			...BaseMetadataSchema$1.shape,
			...IconsSchema$1.shape,
			uri: string(),
			description: optional(string()),
			mimeType: optional(string()),
			size: optional(number$1()),
			annotations: AnnotationsSchema$1.optional(),
			_meta: optional(looseObject({}))
		});
		/**
		* A template description for resources available on the server.
		*/
		const ResourceTemplateSchema$1 = object({
			...BaseMetadataSchema$1.shape,
			...IconsSchema$1.shape,
			uriTemplate: string(),
			description: optional(string()),
			mimeType: optional(string()),
			annotations: AnnotationsSchema$1.optional(),
			_meta: optional(looseObject({}))
		});
		/**
		* Sent from the client to request a list of resources the server has.
		*/
		const ListResourcesRequestSchema$1 = PaginatedRequestSchema$1.extend({ method: literal("resources/list") });
		/**
		* The server's response to a {@linkcode ListResourcesRequest | resources/list} request from the client.
		*/
		const ListResourcesResultSchema$1 = PaginatedResultSchema$1.extend({ resources: array(ResourceSchema$1) });
		/**
		* Sent from the client to request a list of resource templates the server has.
		*/
		const ListResourceTemplatesRequestSchema$1 = PaginatedRequestSchema$1.extend({ method: literal("resources/templates/list") });
		/**
		* The server's response to a {@linkcode ListResourceTemplatesRequest | resources/templates/list} request from the client.
		*/
		const ListResourceTemplatesResultSchema$1 = PaginatedResultSchema$1.extend({ resourceTemplates: array(ResourceTemplateSchema$1) });
		const ResourceRequestParamsSchema$1 = BaseRequestParamsSchema$1.extend({ uri: string() });
		/**
		* Parameters for a {@linkcode ReadResourceRequest | resources/read} request.
		*/
		const ReadResourceRequestParamsSchema$1 = ResourceRequestParamsSchema$1;
		/**
		* Sent from the client to the server, to read a specific resource URI.
		*/
		const ReadResourceRequestSchema$1 = RequestSchema$1.extend({
			method: literal("resources/read"),
			params: ReadResourceRequestParamsSchema$1
		});
		/**
		* The server's response to a {@linkcode ReadResourceRequest | resources/read} request from the client.
		*/
		const ReadResourceResultSchema$1 = ResultSchema$1.extend({ contents: array(union([TextResourceContentsSchema$1, BlobResourceContentsSchema$1])) });
		/**
		* An optional notification from the server to the client, informing it that the list of resources it can read from has changed. This may be issued by servers without any previous subscription from the client.
		*/
		const ResourceListChangedNotificationSchema$1 = NotificationSchema$1.extend({
			method: literal("notifications/resources/list_changed"),
			params: NotificationsParamsSchema$1.optional()
		});
		const SubscribeRequestParamsSchema$1 = ResourceRequestParamsSchema$1;
		/**
		* Sent from the client to request `resources/updated` notifications from the server whenever a particular resource changes.
		*/
		const SubscribeRequestSchema$1 = RequestSchema$1.extend({
			method: literal("resources/subscribe"),
			params: SubscribeRequestParamsSchema$1
		});
		const UnsubscribeRequestParamsSchema$1 = ResourceRequestParamsSchema$1;
		/**
		* Sent from the client to request cancellation of {@linkcode ResourceUpdatedNotification | resources/updated} notifications from the server. This should follow a previous {@linkcode SubscribeRequest | resources/subscribe} request.
		*/
		const UnsubscribeRequestSchema$1 = RequestSchema$1.extend({
			method: literal("resources/unsubscribe"),
			params: UnsubscribeRequestParamsSchema$1
		});
		/**
		* Parameters for a {@linkcode ResourceUpdatedNotification | notifications/resources/updated} notification.
		*/
		const ResourceUpdatedNotificationParamsSchema$1 = NotificationsParamsSchema$1.extend({ uri: string() });
		/**
		* A notification from the server to the client, informing it that a resource has changed and may need to be read again. This should only be sent if the client previously sent a {@linkcode SubscribeRequest | resources/subscribe} request.
		*/
		const ResourceUpdatedNotificationSchema$1 = NotificationSchema$1.extend({
			method: literal("notifications/resources/updated"),
			params: ResourceUpdatedNotificationParamsSchema$1
		});
		/**
		* Describes an argument that a prompt can accept.
		*/
		const PromptArgumentSchema$1 = object({
			name: string(),
			description: optional(string()),
			required: optional(boolean())
		});
		/**
		* A prompt or prompt template that the server offers.
		*/
		const PromptSchema$1 = object({
			...BaseMetadataSchema$1.shape,
			...IconsSchema$1.shape,
			description: optional(string()),
			arguments: optional(array(PromptArgumentSchema$1)),
			_meta: optional(looseObject({}))
		});
		/**
		* Sent from the client to request a list of prompts and prompt templates the server has.
		*/
		const ListPromptsRequestSchema$1 = PaginatedRequestSchema$1.extend({ method: literal("prompts/list") });
		/**
		* The server's response to a {@linkcode ListPromptsRequest | prompts/list} request from the client.
		*/
		const ListPromptsResultSchema$1 = PaginatedResultSchema$1.extend({ prompts: array(PromptSchema$1) });
		/**
		* Parameters for a {@linkcode GetPromptRequest | prompts/get} request.
		*/
		const GetPromptRequestParamsSchema$1 = BaseRequestParamsSchema$1.extend({
			name: string(),
			arguments: record(string(), string()).optional()
		});
		/**
		* Used by the client to get a prompt provided by the server.
		*/
		const GetPromptRequestSchema$1 = RequestSchema$1.extend({
			method: literal("prompts/get"),
			params: GetPromptRequestParamsSchema$1
		});
		/**
		* Text provided to or from an LLM.
		*/
		const TextContentSchema$1 = object({
			type: literal("text"),
			text: string(),
			annotations: AnnotationsSchema$1.optional(),
			_meta: record(string(), unknown()).optional()
		});
		/**
		* An image provided to or from an LLM.
		*/
		const ImageContentSchema$1 = object({
			type: literal("image"),
			data: Base64Schema,
			mimeType: string(),
			annotations: AnnotationsSchema$1.optional(),
			_meta: record(string(), unknown()).optional()
		});
		/**
		* Audio content provided to or from an LLM.
		*/
		const AudioContentSchema$1 = object({
			type: literal("audio"),
			data: Base64Schema,
			mimeType: string(),
			annotations: AnnotationsSchema$1.optional(),
			_meta: record(string(), unknown()).optional()
		});
		/**
		* A tool call request from an assistant (LLM).
		* Represents the assistant's request to use a tool.
		*
		* @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577); remains
		* in the specification for at least twelve months. Migrate to calling LLM
		* provider APIs directly.
		*/
		const ToolUseContentSchema$1 = object({
			type: literal("tool_use"),
			name: string(),
			id: string(),
			input: record(string(), unknown()),
			_meta: record(string(), unknown()).optional()
		});
		/**
		* The contents of a resource, embedded into a prompt or tool call result.
		*/
		const EmbeddedResourceSchema$1 = object({
			type: literal("resource"),
			resource: union([TextResourceContentsSchema$1, BlobResourceContentsSchema$1]),
			annotations: AnnotationsSchema$1.optional(),
			_meta: record(string(), unknown()).optional()
		});
		/**
		* A resource that the server is capable of reading, included in a prompt or tool call result.
		*
		* Note: resource links returned by tools are not guaranteed to appear in the results of {@linkcode ListResourcesRequest | resources/list} requests.
		*/
		const ResourceLinkSchema$1 = ResourceSchema$1.extend({ type: literal("resource_link") });
		/**
		* A content block that can be used in prompts and tool results.
		*/
		const ContentBlockSchema$1 = union([
			TextContentSchema$1,
			ImageContentSchema$1,
			AudioContentSchema$1,
			ResourceLinkSchema$1,
			EmbeddedResourceSchema$1
		]);
		/**
		* Describes a message returned as part of a prompt.
		*/
		const PromptMessageSchema$1 = object({
			role: RoleSchema$1,
			content: ContentBlockSchema$1
		});
		/**
		* The server's response to a {@linkcode GetPromptRequest | prompts/get} request from the client.
		*/
		const GetPromptResultSchema$1 = ResultSchema$1.extend({
			description: string().optional(),
			messages: array(PromptMessageSchema$1)
		});
		/**
		* An optional notification from the server to the client, informing it that the list of prompts it offers has changed. This may be issued by servers without any previous subscription from the client.
		*/
		const PromptListChangedNotificationSchema$1 = NotificationSchema$1.extend({
			method: literal("notifications/prompts/list_changed"),
			params: NotificationsParamsSchema$1.optional()
		});
		/**
		* Additional properties describing a `Tool` to clients.
		*
		* NOTE: all properties in {@linkcode ToolAnnotations} are **hints**.
		* They are not guaranteed to provide a faithful description of
		* tool behavior (including descriptive properties like `title`).
		*
		* Clients should never make tool use decisions based on `ToolAnnotations`
		* received from untrusted servers.
		*/
		const ToolAnnotationsSchema$1 = object({
			title: string().optional(),
			readOnlyHint: boolean().optional(),
			destructiveHint: boolean().optional(),
			idempotentHint: boolean().optional(),
			openWorldHint: boolean().optional()
		});
		/**
		* Execution-related properties for a tool.
		*/
		const ToolExecutionSchema$1 = object({ taskSupport: _enum([
			"required",
			"optional",
			"forbidden"
		]).optional() });
		/**
		* Definition for a tool the client can call.
		*/
		const ToolSchema$1 = object({
			...BaseMetadataSchema$1.shape,
			...IconsSchema$1.shape,
			description: string().optional(),
			inputSchema: object({
				type: literal("object"),
				properties: record(string(), JSONValueSchema$1).optional(),
				required: array(string()).optional()
			}).catchall(unknown()),
			outputSchema: object({
				type: literal("object"),
				properties: record(string(), JSONValueSchema$1).optional(),
				required: array(string()).optional()
			}).catchall(unknown()).optional(),
			annotations: ToolAnnotationsSchema$1.optional(),
			execution: ToolExecutionSchema$1.optional(),
			_meta: record(string(), unknown()).optional()
		});
		/**
		* Sent from the client to request a list of tools the server has.
		*/
		const ListToolsRequestSchema$1 = PaginatedRequestSchema$1.extend({ method: literal("tools/list") });
		/**
		* The server's response to a {@linkcode ListToolsRequest | tools/list} request from the client.
		*/
		const ListToolsResultSchema$1 = PaginatedResultSchema$1.extend({ tools: array(ToolSchema$1) });
		/**
		* The server's response to a tool call.
		*/
		const CallToolResultSchema$1 = ResultSchema$1.extend({
			content: array(ContentBlockSchema$1),
			structuredContent: record(string(), unknown()).optional(),
			isError: boolean().optional()
		});
		/**
		* Parameters for a `tools/call` request.
		*/
		const CallToolRequestParamsSchema$1 = TaskAugmentedRequestParamsSchema$1.extend({
			name: string(),
			arguments: record(string(), unknown()).optional()
		});
		/**
		* Used by the client to invoke a tool provided by the server.
		*/
		const CallToolRequestSchema$1 = RequestSchema$1.extend({
			method: literal("tools/call"),
			params: CallToolRequestParamsSchema$1
		});
		/**
		* An optional notification from the server to the client, informing it that the list of tools it offers has changed. This may be issued by servers without any previous subscription from the client.
		*/
		const ToolListChangedNotificationSchema$1 = NotificationSchema$1.extend({
			method: literal("notifications/tools/list_changed"),
			params: NotificationsParamsSchema$1.optional()
		});
		/**
		* The severity of a log message.
		*
		* @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577); remains
		* in the specification for at least twelve months. Migrate to stderr logging
		* (STDIO servers) or OpenTelemetry.
		*/
		const LoggingLevelSchema$1 = _enum([
			"debug",
			"info",
			"notice",
			"warning",
			"error",
			"critical",
			"alert",
			"emergency"
		]);
		/**
		* Parameters for a `logging/setLevel` request.
		*
		* @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577); remains
		* in the specification for at least twelve months. Migrate to stderr logging
		* (STDIO servers) or OpenTelemetry.
		*/
		const SetLevelRequestParamsSchema$1 = BaseRequestParamsSchema$1.extend({ level: LoggingLevelSchema$1 });
		/**
		* A request from the client to the server, to enable or adjust logging.
		*
		* @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577); remains
		* in the specification for at least twelve months. Migrate to stderr logging
		* (STDIO servers) or OpenTelemetry.
		*/
		const SetLevelRequestSchema$1 = RequestSchema$1.extend({
			method: literal("logging/setLevel"),
			params: SetLevelRequestParamsSchema$1
		});
		/**
		* Parameters for a `notifications/message` notification.
		*
		* @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577); remains
		* in the specification for at least twelve months. Migrate to stderr logging
		* (STDIO servers) or OpenTelemetry.
		*/
		const LoggingMessageNotificationParamsSchema$1 = NotificationsParamsSchema$1.extend({
			level: LoggingLevelSchema$1,
			logger: string().optional(),
			data: unknown()
		});
		/**
		* Notification of a log message passed from server to client. If no `logging/setLevel` request has been sent from the client, the server MAY decide which messages to send automatically.
		*
		* @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577); remains
		* in the specification for at least twelve months. Migrate to stderr logging
		* (STDIO servers) or OpenTelemetry.
		*/
		const LoggingMessageNotificationSchema$1 = NotificationSchema$1.extend({
			method: literal("notifications/message"),
			params: LoggingMessageNotificationParamsSchema$1
		});
		/**
		* Hints to use for model selection.
		*
		* @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577); remains
		* in the specification for at least twelve months. Migrate to calling LLM
		* provider APIs directly.
		*/
		const ModelHintSchema$1 = object({ name: string().optional() });
		/**
		* The server's preferences for model selection, requested of the client during sampling.
		*
		* @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577); remains
		* in the specification for at least twelve months. Migrate to calling LLM
		* provider APIs directly.
		*/
		const ModelPreferencesSchema$1 = object({
			hints: array(ModelHintSchema$1).optional(),
			costPriority: number$1().min(0).max(1).optional(),
			speedPriority: number$1().min(0).max(1).optional(),
			intelligencePriority: number$1().min(0).max(1).optional()
		});
		/**
		* Controls tool usage behavior in sampling requests.
		*
		* @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577); remains
		* in the specification for at least twelve months. Migrate to calling LLM
		* provider APIs directly.
		*/
		const ToolChoiceSchema$1 = object({ mode: _enum([
			"auto",
			"required",
			"none"
		]).optional() });
		/**
		* The result of a tool execution, provided by the user (server).
		* Represents the outcome of invoking a tool requested via `ToolUseContent`.
		*
		* @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577); remains
		* in the specification for at least twelve months. Migrate to calling LLM
		* provider APIs directly.
		*/
		const ToolResultContentSchema$1 = object({
			type: literal("tool_result"),
			toolUseId: string().describe("The unique identifier for the corresponding tool call."),
			content: array(ContentBlockSchema$1),
			structuredContent: object({}).loose().optional(),
			isError: boolean().optional(),
			_meta: record(string(), unknown()).optional()
		});
		/**
		* Basic content types for sampling responses (without tool use).
		* Used for backwards-compatible {@linkcode CreateMessageResult} when tools are not used.
		*
		* @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577); remains
		* in the specification for at least twelve months. Migrate to calling LLM
		* provider APIs directly.
		*/
		const SamplingContentSchema$1 = discriminatedUnion("type", [
			TextContentSchema$1,
			ImageContentSchema$1,
			AudioContentSchema$1
		]);
		/**
		* Content block types allowed in sampling messages.
		* This includes text, image, audio, tool use requests, and tool results.
		*
		* @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577); remains
		* in the specification for at least twelve months. Migrate to calling LLM
		* provider APIs directly.
		*/
		const SamplingMessageContentBlockSchema$1 = discriminatedUnion("type", [
			TextContentSchema$1,
			ImageContentSchema$1,
			AudioContentSchema$1,
			ToolUseContentSchema$1,
			ToolResultContentSchema$1
		]);
		/**
		* Describes a message issued to or received from an LLM API.
		*
		* @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577); remains
		* in the specification for at least twelve months. Migrate to calling LLM
		* provider APIs directly.
		*/
		const SamplingMessageSchema$1 = object({
			role: RoleSchema$1,
			content: union([SamplingMessageContentBlockSchema$1, array(SamplingMessageContentBlockSchema$1)]),
			_meta: record(string(), unknown()).optional()
		});
		/**
		* Parameters for a `sampling/createMessage` request.
		*
		* @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577); remains
		* in the specification for at least twelve months. Migrate to calling LLM
		* provider APIs directly.
		*/
		const CreateMessageRequestParamsSchema$1 = TaskAugmentedRequestParamsSchema$1.extend({
			messages: array(SamplingMessageSchema$1),
			modelPreferences: ModelPreferencesSchema$1.optional(),
			systemPrompt: string().optional(),
			includeContext: _enum([
				"none",
				"thisServer",
				"allServers"
			]).optional(),
			temperature: number$1().optional(),
			maxTokens: number$1().int(),
			stopSequences: array(string()).optional(),
			metadata: JSONObjectSchema$1.optional(),
			tools: array(ToolSchema$1).optional(),
			toolChoice: ToolChoiceSchema$1.optional()
		});
		/**
		* A request from the server to sample an LLM via the client. The client has full discretion over which model to select. The client should also inform the user before beginning sampling, to allow them to inspect the request (human in the loop) and decide whether to approve it.
		*
		* @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577); remains
		* in the specification for at least twelve months. Migrate to calling LLM
		* provider APIs directly.
		*/
		const CreateMessageRequestSchema$1 = RequestSchema$1.extend({
			method: literal("sampling/createMessage"),
			params: CreateMessageRequestParamsSchema$1
		});
		/**
		* The client's response to a `sampling/create_message` request from the server.
		* This is the backwards-compatible version that returns single content (no arrays).
		* Used when the request does not include tools.
		*
		* @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577); remains
		* in the specification for at least twelve months. Migrate to calling LLM
		* provider APIs directly.
		*/
		const CreateMessageResultSchema$1 = ResultSchema$1.extend({
			model: string(),
			stopReason: optional(_enum([
				"endTurn",
				"stopSequence",
				"maxTokens"
			]).or(string())),
			role: RoleSchema$1,
			content: SamplingContentSchema$1
		});
		/**
		* The client's response to a `sampling/create_message` request when tools were provided.
		* This version supports array content for tool use flows.
		*
		* @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577); remains
		* in the specification for at least twelve months. Migrate to calling LLM
		* provider APIs directly.
		*/
		const CreateMessageResultWithToolsSchema$1 = ResultSchema$1.extend({
			model: string(),
			stopReason: optional(_enum([
				"endTurn",
				"stopSequence",
				"maxTokens",
				"toolUse"
			]).or(string())),
			role: RoleSchema$1,
			content: union([SamplingMessageContentBlockSchema$1, array(SamplingMessageContentBlockSchema$1)])
		});
		/**
		* Primitive schema definition for boolean fields.
		*/
		const BooleanSchemaSchema$1 = object({
			type: literal("boolean"),
			title: string().optional(),
			description: string().optional(),
			default: boolean().optional()
		});
		/**
		* Primitive schema definition for string fields.
		*/
		const StringSchemaSchema$1 = object({
			type: literal("string"),
			title: string().optional(),
			description: string().optional(),
			minLength: number$1().optional(),
			maxLength: number$1().optional(),
			format: _enum([
				"email",
				"uri",
				"date",
				"date-time"
			]).optional(),
			default: string().optional()
		});
		/**
		* Primitive schema definition for number fields.
		*/
		const NumberSchemaSchema$1 = object({
			type: _enum(["number", "integer"]),
			title: string().optional(),
			description: string().optional(),
			minimum: number$1().optional(),
			maximum: number$1().optional(),
			default: number$1().optional()
		});
		/**
		* Schema for single-selection enumeration without display titles for options.
		*/
		const UntitledSingleSelectEnumSchemaSchema$1 = object({
			type: literal("string"),
			title: string().optional(),
			description: string().optional(),
			enum: array(string()),
			default: string().optional()
		});
		/**
		* Schema for single-selection enumeration with display titles for each option.
		*/
		const TitledSingleSelectEnumSchemaSchema$1 = object({
			type: literal("string"),
			title: string().optional(),
			description: string().optional(),
			oneOf: array(object({
				const: string(),
				title: string()
			})),
			default: string().optional()
		});
		/**
		* Use {@linkcode TitledSingleSelectEnumSchema} instead.
		* This interface will be removed in a future version.
		*/
		const LegacyTitledEnumSchemaSchema$1 = object({
			type: literal("string"),
			title: string().optional(),
			description: string().optional(),
			enum: array(string()),
			enumNames: array(string()).optional(),
			default: string().optional()
		});
		const SingleSelectEnumSchemaSchema$1 = union([UntitledSingleSelectEnumSchemaSchema$1, TitledSingleSelectEnumSchemaSchema$1]);
		/**
		* Schema for multiple-selection enumeration without display titles for options.
		*/
		const UntitledMultiSelectEnumSchemaSchema$1 = object({
			type: literal("array"),
			title: string().optional(),
			description: string().optional(),
			minItems: number$1().optional(),
			maxItems: number$1().optional(),
			items: object({
				type: literal("string"),
				enum: array(string())
			}),
			default: array(string()).optional()
		});
		/**
		* Schema for multiple-selection enumeration with display titles for each option.
		*/
		const TitledMultiSelectEnumSchemaSchema$1 = object({
			type: literal("array"),
			title: string().optional(),
			description: string().optional(),
			minItems: number$1().optional(),
			maxItems: number$1().optional(),
			items: object({ anyOf: array(object({
				const: string(),
				title: string()
			})) }),
			default: array(string()).optional()
		});
		/**
		* Combined schema for multiple-selection enumeration
		*/
		const MultiSelectEnumSchemaSchema$1 = union([UntitledMultiSelectEnumSchemaSchema$1, TitledMultiSelectEnumSchemaSchema$1]);
		/**
		* Primitive schema definition for enum fields.
		*/
		const EnumSchemaSchema$1 = union([
			LegacyTitledEnumSchemaSchema$1,
			SingleSelectEnumSchemaSchema$1,
			MultiSelectEnumSchemaSchema$1
		]);
		/**
		* Union of all primitive schema definitions.
		*/
		const PrimitiveSchemaDefinitionSchema$1 = union([
			EnumSchemaSchema$1,
			BooleanSchemaSchema$1,
			StringSchemaSchema$1,
			NumberSchemaSchema$1
		]);
		/**
		* Parameters for an `elicitation/create` request for form-based elicitation.
		*/
		const ElicitRequestFormParamsSchema$1 = TaskAugmentedRequestParamsSchema$1.extend({
			mode: literal("form").optional(),
			message: string(),
			requestedSchema: object({
				type: literal("object"),
				properties: record(string(), PrimitiveSchemaDefinitionSchema$1),
				required: array(string()).optional()
			}).catchall(unknown())
		});
		/**
		* Parameters for an {@linkcode ElicitRequest | elicitation/create} request for URL-based elicitation.
		*/
		const ElicitRequestURLParamsSchema$1 = TaskAugmentedRequestParamsSchema$1.extend({
			mode: literal("url"),
			message: string(),
			elicitationId: string(),
			url: string().url()
		});
		/**
		* The parameters for a request to elicit additional information from the user via the client.
		*/
		const ElicitRequestParamsSchema$1 = union([ElicitRequestFormParamsSchema$1, ElicitRequestURLParamsSchema$1]);
		/**
		* A request from the server to elicit user input via the client.
		* The client should present the message and form fields to the user (form mode)
		* or navigate to a URL (URL mode).
		*/
		const ElicitRequestSchema$1 = RequestSchema$1.extend({
			method: literal("elicitation/create"),
			params: ElicitRequestParamsSchema$1
		});
		/**
		* Parameters for a {@linkcode ElicitationCompleteNotification | notifications/elicitation/complete} notification.
		*
		* @category notifications/elicitation/complete
		*/
		const ElicitationCompleteNotificationParamsSchema$1 = NotificationsParamsSchema$1.extend({ elicitationId: string() });
		/**
		* A notification from the server to the client, informing it of a completion of an out-of-band elicitation request.
		*
		* @category notifications/elicitation/complete
		*/
		const ElicitationCompleteNotificationSchema$1 = NotificationSchema$1.extend({
			method: literal("notifications/elicitation/complete"),
			params: ElicitationCompleteNotificationParamsSchema$1
		});
		/**
		* The client's response to an {@linkcode ElicitRequest | elicitation/create} request from the server.
		*/
		const ElicitResultSchema$1 = ResultSchema$1.extend({
			action: _enum([
				"accept",
				"decline",
				"cancel"
			]),
			content: preprocess((val) => val === null ? void 0 : val, record(string(), union([
				string(),
				number$1(),
				boolean(),
				array(string())
			])).optional())
		});
		/**
		* A reference to a resource or resource template definition.
		*/
		const ResourceTemplateReferenceSchema$1 = object({
			type: literal("ref/resource"),
			uri: string()
		});
		/**
		* Identifies a prompt.
		*/
		const PromptReferenceSchema$1 = object({
			type: literal("ref/prompt"),
			name: string()
		});
		/**
		* Parameters for a {@linkcode CompleteRequest | completion/complete} request.
		*/
		const CompleteRequestParamsSchema$1 = BaseRequestParamsSchema$1.extend({
			ref: union([PromptReferenceSchema$1, ResourceTemplateReferenceSchema$1]),
			argument: object({
				name: string(),
				value: string()
			}),
			context: object({ arguments: record(string(), string()).optional() }).optional()
		});
		/**
		* A request from the client to the server, to ask for completion options.
		*/
		const CompleteRequestSchema$1 = RequestSchema$1.extend({
			method: literal("completion/complete"),
			params: CompleteRequestParamsSchema$1
		});
		/**
		* The server's response to a {@linkcode CompleteRequest | completion/complete} request
		*/
		const CompleteResultSchema$1 = ResultSchema$1.extend({ completion: looseObject({
			values: array(string()).max(100),
			total: optional(number$1().int()),
			hasMore: optional(boolean())
		}) });
		/**
		* Represents a root directory or file that the server can operate on.
		*
		* @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577); remains
		* in the specification for at least twelve months. Migrate to passing paths via
		* tool parameters, resource URIs, or configuration.
		*/
		const RootSchema$1 = object({
			uri: string().startsWith("file://"),
			name: string().optional(),
			_meta: record(string(), unknown()).optional()
		});
		/**
		* Sent from the server to request a list of root URIs from the client.
		*
		* @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577); remains
		* in the specification for at least twelve months. Migrate to passing paths via
		* tool parameters, resource URIs, or configuration.
		*/
		const ListRootsRequestSchema$1 = RequestSchema$1.extend({
			method: literal("roots/list"),
			params: BaseRequestParamsSchema$1.optional()
		});
		/**
		* The client's response to a `roots/list` request from the server.
		*
		* @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577); remains
		* in the specification for at least twelve months. Migrate to passing paths via
		* tool parameters, resource URIs, or configuration.
		*/
		const ListRootsResultSchema$1 = ResultSchema$1.extend({ roots: array(RootSchema$1) });
		/**
		* A notification from the client to the server, informing it that the list of roots has changed.
		*
		* @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577); remains
		* in the specification for at least twelve months. Migrate to passing paths via
		* tool parameters, resource URIs, or configuration.
		*/
		const RootsListChangedNotificationSchema$1 = NotificationSchema$1.extend({
			method: literal("notifications/roots/list_changed"),
			params: NotificationsParamsSchema$1.optional()
		});
		/**
		* Task creation parameters, used to ask that the server create a task to represent a request.
		*
		* @deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only.
		*/
		const TaskCreationParamsSchema$1 = looseObject({
			ttl: number$1().optional(),
			pollInterval: number$1().optional()
		});
		/**
		* The status of a task.
		*
		* @deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only.
		*/
		const TaskStatusSchema$1 = _enum([
			"working",
			"input_required",
			"completed",
			"failed",
			"cancelled"
		]);
		/**
		* A pollable state object associated with a request.
		*
		* @deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only.
		*/
		const TaskSchema$1 = object({
			taskId: string(),
			status: TaskStatusSchema$1,
			ttl: union([number$1(), _null()]),
			createdAt: string(),
			lastUpdatedAt: string(),
			pollInterval: optional(number$1()),
			statusMessage: optional(string())
		});
		/**
		* Result returned when a task is created, containing the task data wrapped in a `task` field.
		*
		* @deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only.
		*/
		const CreateTaskResultSchema$1 = ResultSchema$1.extend({ task: TaskSchema$1 });
		/**
		* Parameters for task status notification.
		*
		* @deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only.
		*/
		const TaskStatusNotificationParamsSchema$1 = NotificationsParamsSchema$1.merge(TaskSchema$1);
		/**
		* A notification sent when a task's status changes.
		*
		* @deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only.
		*/
		const TaskStatusNotificationSchema$1 = NotificationSchema$1.extend({
			method: literal("notifications/tasks/status"),
			params: TaskStatusNotificationParamsSchema$1
		});
		/**
		* A request to get the state of a specific task.
		*
		* @deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only.
		*/
		const GetTaskRequestSchema$1 = RequestSchema$1.extend({
			method: literal("tasks/get"),
			params: BaseRequestParamsSchema$1.extend({ taskId: string() })
		});
		/**
		* The response to a {@linkcode GetTaskRequest | tasks/get} request.
		*
		* @deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only.
		*/
		const GetTaskResultSchema$1 = ResultSchema$1.merge(TaskSchema$1);
		/**
		* A request to get the result of a specific task.
		*
		* @deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only.
		*/
		const GetTaskPayloadRequestSchema$1 = RequestSchema$1.extend({
			method: literal("tasks/result"),
			params: BaseRequestParamsSchema$1.extend({ taskId: string() })
		});
		/**
		* The response to a `tasks/result` request.
		* The structure matches the result type of the original request.
		* For example, a {@linkcode CallToolRequest | tools/call} task would return the `CallToolResult` structure.
		*
		*
		* @deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only.
		*/
		const GetTaskPayloadResultSchema$1 = ResultSchema$1.loose();
		/**
		* A request to list tasks.
		*
		* @deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only.
		*/
		const ListTasksRequestSchema$1 = PaginatedRequestSchema$1.extend({ method: literal("tasks/list") });
		/**
		* The response to a {@linkcode ListTasksRequest | tasks/list} request.
		*
		* @deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only.
		*/
		const ListTasksResultSchema$1 = PaginatedResultSchema$1.extend({ tasks: array(TaskSchema$1) });
		/**
		* A request to cancel a specific task.
		*
		* @deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only.
		*/
		const CancelTaskRequestSchema$1 = RequestSchema$1.extend({
			method: literal("tasks/cancel"),
			params: BaseRequestParamsSchema$1.extend({ taskId: string() })
		});
		return {
			JSONValueSchema: JSONValueSchema$1,
			JSONObjectSchema: JSONObjectSchema$1,
			ProgressTokenSchema: ProgressTokenSchema$1,
			CursorSchema: CursorSchema$1,
			TaskMetadataSchema: TaskMetadataSchema$1,
			RelatedTaskMetadataSchema: RelatedTaskMetadataSchema$1,
			RequestMetaSchema: RequestMetaSchema$1,
			BaseRequestParamsSchema: BaseRequestParamsSchema$1,
			TaskAugmentedRequestParamsSchema: TaskAugmentedRequestParamsSchema$1,
			RequestSchema: RequestSchema$1,
			NotificationsParamsSchema: NotificationsParamsSchema$1,
			NotificationSchema: NotificationSchema$1,
			ResultSchema: ResultSchema$1,
			RequestIdSchema: RequestIdSchema$1,
			EmptyResultSchema: EmptyResultSchema$1,
			CancelledNotificationParamsSchema: CancelledNotificationParamsSchema$1,
			CancelledNotificationSchema: CancelledNotificationSchema$1,
			IconSchema: IconSchema$1,
			IconsSchema: IconsSchema$1,
			BaseMetadataSchema: BaseMetadataSchema$1,
			ImplementationSchema: ImplementationSchema$1,
			ClientTasksCapabilitySchema: ClientTasksCapabilitySchema$1,
			ServerTasksCapabilitySchema: ServerTasksCapabilitySchema$1,
			ClientCapabilitiesSchema: ClientCapabilitiesSchema$1,
			InitializeRequestParamsSchema: InitializeRequestParamsSchema$1,
			InitializeRequestSchema: InitializeRequestSchema$1,
			ServerCapabilitiesSchema: ServerCapabilitiesSchema$1,
			InitializeResultSchema: InitializeResultSchema$1,
			InitializedNotificationSchema: InitializedNotificationSchema$1,
			PingRequestSchema: PingRequestSchema$1,
			ProgressSchema: ProgressSchema$1,
			ProgressNotificationParamsSchema: ProgressNotificationParamsSchema$1,
			ProgressNotificationSchema: ProgressNotificationSchema$1,
			PaginatedRequestParamsSchema: PaginatedRequestParamsSchema$1,
			PaginatedRequestSchema: PaginatedRequestSchema$1,
			PaginatedResultSchema: PaginatedResultSchema$1,
			ResourceContentsSchema: ResourceContentsSchema$1,
			TextResourceContentsSchema: TextResourceContentsSchema$1,
			BlobResourceContentsSchema: BlobResourceContentsSchema$1,
			RoleSchema: RoleSchema$1,
			AnnotationsSchema: AnnotationsSchema$1,
			ResourceSchema: ResourceSchema$1,
			ResourceTemplateSchema: ResourceTemplateSchema$1,
			ListResourcesRequestSchema: ListResourcesRequestSchema$1,
			ListResourcesResultSchema: ListResourcesResultSchema$1,
			ListResourceTemplatesRequestSchema: ListResourceTemplatesRequestSchema$1,
			ListResourceTemplatesResultSchema: ListResourceTemplatesResultSchema$1,
			ResourceRequestParamsSchema: ResourceRequestParamsSchema$1,
			ReadResourceRequestParamsSchema: ReadResourceRequestParamsSchema$1,
			ReadResourceRequestSchema: ReadResourceRequestSchema$1,
			ReadResourceResultSchema: ReadResourceResultSchema$1,
			ResourceListChangedNotificationSchema: ResourceListChangedNotificationSchema$1,
			SubscribeRequestParamsSchema: SubscribeRequestParamsSchema$1,
			SubscribeRequestSchema: SubscribeRequestSchema$1,
			UnsubscribeRequestParamsSchema: UnsubscribeRequestParamsSchema$1,
			UnsubscribeRequestSchema: UnsubscribeRequestSchema$1,
			ResourceUpdatedNotificationParamsSchema: ResourceUpdatedNotificationParamsSchema$1,
			ResourceUpdatedNotificationSchema: ResourceUpdatedNotificationSchema$1,
			PromptArgumentSchema: PromptArgumentSchema$1,
			PromptSchema: PromptSchema$1,
			ListPromptsRequestSchema: ListPromptsRequestSchema$1,
			ListPromptsResultSchema: ListPromptsResultSchema$1,
			GetPromptRequestParamsSchema: GetPromptRequestParamsSchema$1,
			GetPromptRequestSchema: GetPromptRequestSchema$1,
			TextContentSchema: TextContentSchema$1,
			ImageContentSchema: ImageContentSchema$1,
			AudioContentSchema: AudioContentSchema$1,
			ToolUseContentSchema: ToolUseContentSchema$1,
			EmbeddedResourceSchema: EmbeddedResourceSchema$1,
			ResourceLinkSchema: ResourceLinkSchema$1,
			ContentBlockSchema: ContentBlockSchema$1,
			PromptMessageSchema: PromptMessageSchema$1,
			GetPromptResultSchema: GetPromptResultSchema$1,
			PromptListChangedNotificationSchema: PromptListChangedNotificationSchema$1,
			ToolAnnotationsSchema: ToolAnnotationsSchema$1,
			ToolExecutionSchema: ToolExecutionSchema$1,
			ToolSchema: ToolSchema$1,
			ListToolsRequestSchema: ListToolsRequestSchema$1,
			ListToolsResultSchema: ListToolsResultSchema$1,
			CallToolResultSchema: CallToolResultSchema$1,
			CallToolRequestParamsSchema: CallToolRequestParamsSchema$1,
			CallToolRequestSchema: CallToolRequestSchema$1,
			ToolListChangedNotificationSchema: ToolListChangedNotificationSchema$1,
			LoggingLevelSchema: LoggingLevelSchema$1,
			SetLevelRequestParamsSchema: SetLevelRequestParamsSchema$1,
			SetLevelRequestSchema: SetLevelRequestSchema$1,
			LoggingMessageNotificationParamsSchema: LoggingMessageNotificationParamsSchema$1,
			LoggingMessageNotificationSchema: LoggingMessageNotificationSchema$1,
			ModelHintSchema: ModelHintSchema$1,
			ModelPreferencesSchema: ModelPreferencesSchema$1,
			ToolChoiceSchema: ToolChoiceSchema$1,
			ToolResultContentSchema: ToolResultContentSchema$1,
			SamplingContentSchema: SamplingContentSchema$1,
			SamplingMessageContentBlockSchema: SamplingMessageContentBlockSchema$1,
			SamplingMessageSchema: SamplingMessageSchema$1,
			CreateMessageRequestParamsSchema: CreateMessageRequestParamsSchema$1,
			CreateMessageRequestSchema: CreateMessageRequestSchema$1,
			CreateMessageResultSchema: CreateMessageResultSchema$1,
			CreateMessageResultWithToolsSchema: CreateMessageResultWithToolsSchema$1,
			BooleanSchemaSchema: BooleanSchemaSchema$1,
			StringSchemaSchema: StringSchemaSchema$1,
			NumberSchemaSchema: NumberSchemaSchema$1,
			UntitledSingleSelectEnumSchemaSchema: UntitledSingleSelectEnumSchemaSchema$1,
			TitledSingleSelectEnumSchemaSchema: TitledSingleSelectEnumSchemaSchema$1,
			LegacyTitledEnumSchemaSchema: LegacyTitledEnumSchemaSchema$1,
			SingleSelectEnumSchemaSchema: SingleSelectEnumSchemaSchema$1,
			UntitledMultiSelectEnumSchemaSchema: UntitledMultiSelectEnumSchemaSchema$1,
			TitledMultiSelectEnumSchemaSchema: TitledMultiSelectEnumSchemaSchema$1,
			MultiSelectEnumSchemaSchema: MultiSelectEnumSchemaSchema$1,
			EnumSchemaSchema: EnumSchemaSchema$1,
			PrimitiveSchemaDefinitionSchema: PrimitiveSchemaDefinitionSchema$1,
			ElicitRequestFormParamsSchema: ElicitRequestFormParamsSchema$1,
			ElicitRequestURLParamsSchema: ElicitRequestURLParamsSchema$1,
			ElicitRequestParamsSchema: ElicitRequestParamsSchema$1,
			ElicitRequestSchema: ElicitRequestSchema$1,
			ElicitationCompleteNotificationParamsSchema: ElicitationCompleteNotificationParamsSchema$1,
			ElicitationCompleteNotificationSchema: ElicitationCompleteNotificationSchema$1,
			ElicitResultSchema: ElicitResultSchema$1,
			ResourceTemplateReferenceSchema: ResourceTemplateReferenceSchema$1,
			PromptReferenceSchema: PromptReferenceSchema$1,
			CompleteRequestParamsSchema: CompleteRequestParamsSchema$1,
			CompleteRequestSchema: CompleteRequestSchema$1,
			CompleteResultSchema: CompleteResultSchema$1,
			RootSchema: RootSchema$1,
			ListRootsRequestSchema: ListRootsRequestSchema$1,
			ListRootsResultSchema: ListRootsResultSchema$1,
			RootsListChangedNotificationSchema: RootsListChangedNotificationSchema$1,
			TaskCreationParamsSchema: TaskCreationParamsSchema$1,
			TaskStatusSchema: TaskStatusSchema$1,
			TaskSchema: TaskSchema$1,
			CreateTaskResultSchema: CreateTaskResultSchema$1,
			TaskStatusNotificationParamsSchema: TaskStatusNotificationParamsSchema$1,
			TaskStatusNotificationSchema: TaskStatusNotificationSchema$1,
			GetTaskRequestSchema: GetTaskRequestSchema$1,
			GetTaskResultSchema: GetTaskResultSchema$1,
			GetTaskPayloadRequestSchema: GetTaskPayloadRequestSchema$1,
			GetTaskPayloadResultSchema: GetTaskPayloadResultSchema$1,
			ListTasksRequestSchema: ListTasksRequestSchema$1,
			ListTasksResultSchema: ListTasksResultSchema$1,
			CancelTaskRequestSchema: CancelTaskRequestSchema$1,
			CancelTaskResultSchema: ResultSchema$1.merge(TaskSchema$1),
			ClientRequestSchema: union([
				PingRequestSchema$1,
				InitializeRequestSchema$1,
				CompleteRequestSchema$1,
				SetLevelRequestSchema$1,
				GetPromptRequestSchema$1,
				ListPromptsRequestSchema$1,
				ListResourcesRequestSchema$1,
				ListResourceTemplatesRequestSchema$1,
				ReadResourceRequestSchema$1,
				SubscribeRequestSchema$1,
				UnsubscribeRequestSchema$1,
				CallToolRequestSchema$1,
				ListToolsRequestSchema$1,
				GetTaskRequestSchema$1,
				GetTaskPayloadRequestSchema$1,
				ListTasksRequestSchema$1,
				CancelTaskRequestSchema$1
			]),
			ClientNotificationSchema: union([
				CancelledNotificationSchema$1,
				ProgressNotificationSchema$1,
				InitializedNotificationSchema$1,
				RootsListChangedNotificationSchema$1,
				TaskStatusNotificationSchema$1
			]),
			ClientResultSchema: union([
				EmptyResultSchema$1,
				CreateMessageResultSchema$1,
				CreateMessageResultWithToolsSchema$1,
				ElicitResultSchema$1,
				ListRootsResultSchema$1,
				GetTaskResultSchema$1,
				ListTasksResultSchema$1,
				CreateTaskResultSchema$1
			]),
			ServerRequestSchema: union([
				PingRequestSchema$1,
				CreateMessageRequestSchema$1,
				ElicitRequestSchema$1,
				ListRootsRequestSchema$1,
				GetTaskRequestSchema$1,
				GetTaskPayloadRequestSchema$1,
				ListTasksRequestSchema$1,
				CancelTaskRequestSchema$1
			]),
			ServerNotificationSchema: union([
				CancelledNotificationSchema$1,
				ProgressNotificationSchema$1,
				LoggingMessageNotificationSchema$1,
				ResourceUpdatedNotificationSchema$1,
				ResourceListChangedNotificationSchema$1,
				ToolListChangedNotificationSchema$1,
				PromptListChangedNotificationSchema$1,
				TaskStatusNotificationSchema$1,
				ElicitationCompleteNotificationSchema$1
			]),
			ServerResultSchema: union([
				EmptyResultSchema$1,
				InitializeResultSchema$1,
				CompleteResultSchema$1,
				GetPromptResultSchema$1,
				ListPromptsResultSchema$1,
				ListResourcesResultSchema$1,
				ListResourceTemplatesResultSchema$1,
				ReadResourceResultSchema$1,
				CallToolResultSchema$1,
				ListToolsResultSchema$1,
				GetTaskResultSchema$1,
				ListTasksResultSchema$1,
				CreateTaskResultSchema$1
			]),
			CallToolResultWireSchema: unknown().superRefine((value, ctx) => {
				if (typeof value !== "object" || value === null || Array.isArray(value) || value.content !== void 0) return;
				for (const key of TOOL_RESULT_FOREIGN_FAMILY_KEYS) if (key in value) {
					ctx.addIssue({
						code: "custom",
						message: `content is required when the body carries '${key}' — another result family cannot default into an empty tools/call success`
					});
					return;
				}
			}).transform(normalizeContentlessToolResult).pipe(CallToolResultSchema$1)
		};
	}
	let memo$1;
	/**
	* Builds the era wire-schema set on first call and returns the same object
	* thereafter. Module evaluation stays construction-free so importing the
	* era codec/registry costs nothing until the first validation actually
	* needs a schema; the registry, the codec, and the eager `schemas.ts`
	* shim all pull through this memo, so reference identity holds across
	* every consumer.
	*/
	function buildSchemas2025() {
		return memo$1 ??= build$1();
	}
	/**
	* SEP-2106 legacy `outputSchema` wrap helpers (2025-era projection only).
	*
	* The neutral / 2026-07-28 model lets a tool's `outputSchema` carry any JSON
	* Schema root. The 2025-11-25 wire shape requires `type:'object'` at the root,
	* so when an era-blind handler advertises a non-object root, the 2025 codec's
	* `encodeResult('tools/list', …)` projects it down to
	* `{type:'object', properties:{result:<natural>}, required:['result']}`, and
	* `projectCallToolResult` wraps the matching `structuredContent` as
	* `{result:<value>}`. The 2026 codec's projections are the identity.
	*
	* These helpers are wire-layer property — they exist so the projection can
	* live behind {@link WireCodec.encodeResult} / {@link WireCodec.projectCallToolResult}
	* and never be re-derived in shared/ or server-side code.
	*/
	/**
	* Whether a JSON Schema's root is non-object: either an explicit non-object
	* `type`, or a typeless root such as `{anyOf:[…]}`. Object-shaped typeless
	* roots that the schema-conversion layer can prove are objects are stamped
	* `type:'object'` upstream, so they reach this predicate as object roots.
	*/
	function isNonObjectJsonSchemaRoot(json) {
		return json["type"] !== "object";
	}
	/**
	* Keyword-position keys whose values are instance data (not subschemas). A
	* `{$ref:…}` appearing inside one is a literal value, not a JSON Pointer to
	* rewrite. Only consulted when the current object is in keyword position —
	* a PROPERTY named `default`/`const` (under `properties`/`$defs`/…) is a name
	* position whose value IS a subschema and is recursed into.
	*/
	const REF_REWRITE_DATA_POSITION_KEYS = /* @__PURE__ */ new Set([
		"const",
		"enum",
		"default",
		"examples"
	]);
	/**
	* Keyword-position keys whose value is a name→subschema map. Entries inside
	* such a map are in NAME position: their keys are author-chosen property
	* names (which may collide with JSON Schema keywords), their values are
	* subschemas to recurse into.
	*/
	const REF_REWRITE_NAME_MAP_KEYS = /* @__PURE__ */ new Set([
		"properties",
		"patternProperties",
		"$defs",
		"definitions",
		"dependentSchemas",
		"dependencies"
	]);
	/**
	* Whether a subtree's `$id` establishes a new resolution base. A fragment-only
	* `$id` (`"#item"`, the draft-07/06 spelling of 2020-12's `$anchor`) does not
	* change the RFC 3986 base URI — same-document pointers inside still resolve
	* against the document root and must be rewritten.
	*/
	function establishesNewBase(id) {
		return id !== void 0 && !(typeof id === "string" && id.startsWith("#"));
	}
	/**
	* Wrap a non-object output schema in the 2025-era envelope:
	* `{type:'object', properties:{result:<natural>}, required:['result']}`.
	*
	* Same-document `$ref` / `$dynamicRef` JSON Pointers inside the natural schema
	* (e.g. `#/properties/foo` produced by zod for de-duplicated/recursive types)
	* are rewritten to account for the new `#/properties/result` root: bare `#` →
	* `#/properties/result`, `#/…` → `#/properties/result/…`. Cross-document refs
	* (anything not starting with `#`) are left untouched.
	*
	* The rewrite is position-aware: data-valued keywords
	* (`const`/`enum`/`default`/`examples`) in keyword position are NOT descended
	* into; the same names appearing as property names under
	* `properties`/`patternProperties`/`$defs`/`definitions`/`dependentSchemas`/
	* `dependencies` ARE descended into (they're subschemas). The rewrite is also
	* `$id`-scoped: if the natural root carries a base-establishing `$id` no
	* pointer is rewritten (same-document refs inside resolve against the embedded
	* `$id` base, not the wrapper root), and any subtree that establishes its own
	* `$id` is left untouched for the same reason. Fragment-only `$id` (`"#item"`,
	* draft-07's anchor spelling) does not establish a base and IS descended into.
	*/
	function wrapOutputSchemaForLegacy(natural) {
		const $schema = typeof natural["$schema"] === "string" ? natural["$schema"] : void 0;
		if (establishesNewBase(natural["$id"])) return {
			...$schema !== void 0 && { $schema },
			type: "object",
			properties: { result: natural },
			required: ["result"]
		};
		const convertRecursiveRefs = declares2019Dialect(natural["$schema"]) && natural["$recursiveAnchor"] !== true;
		const rewriteRefs = (node, parentIsNameMap) => {
			if (Array.isArray(node)) return node.map((item) => rewriteRefs(item, false));
			if (node === null || typeof node !== "object") return node;
			if (!parentIsNameMap && establishesNewBase(node["$id"])) return node;
			const out = {};
			let convertedRecursion = false;
			for (const [k, v] of Object.entries(node)) if (parentIsNameMap) out[k] = rewriteRefs(v, false);
			else if ((k === "$ref" || k === "$dynamicRef") && typeof v === "string") out[k] = v === "#" ? "#/properties/result" : v.startsWith("#/") ? `#/properties/result${v.slice(1)}` : v;
			else if (k === "$recursiveRef" && v === "#" && convertRecursiveRefs) convertedRecursion = true;
			else if (REF_REWRITE_DATA_POSITION_KEYS.has(k)) out[k] = v;
			else if (REF_REWRITE_NAME_MAP_KEYS.has(k)) out[k] = rewriteRefs(v, true);
			else out[k] = rewriteRefs(v, false);
			if (convertedRecursion) if ("$ref" in out) out["allOf"] = [...Array.isArray(out["allOf"]) ? out["allOf"] : [], { $ref: "#/properties/result" }];
			else out["$ref"] = "#/properties/result";
			return out;
		};
		return {
			...$schema !== void 0 && { $schema },
			type: "object",
			properties: { result: rewriteRefs(natural, false) },
			required: ["result"]
		};
	}
	const requestMethodKeys$1 = {
		ping: null,
		initialize: null,
		"completion/complete": null,
		"logging/setLevel": null,
		"prompts/get": null,
		"prompts/list": null,
		"resources/list": null,
		"resources/templates/list": null,
		"resources/read": null,
		"resources/subscribe": null,
		"resources/unsubscribe": null,
		"tools/call": null,
		"tools/list": null,
		"tasks/get": null,
		"tasks/result": null,
		"tasks/list": null,
		"tasks/cancel": null,
		"sampling/createMessage": null,
		"elicitation/create": null,
		"roots/list": null
	};
	const notificationMethodKeys$1 = {
		"notifications/cancelled": null,
		"notifications/progress": null,
		"notifications/initialized": null,
		"notifications/roots/list_changed": null,
		"notifications/tasks/status": null,
		"notifications/message": null,
		"notifications/resources/updated": null,
		"notifications/resources/list_changed": null,
		"notifications/tools/list_changed": null,
		"notifications/prompts/list_changed": null,
		"notifications/elicitation/complete": null
	};
	const resultMethodKeys = {
		ping: null,
		initialize: null,
		"completion/complete": null,
		"logging/setLevel": null,
		"prompts/get": null,
		"prompts/list": null,
		"resources/list": null,
		"resources/templates/list": null,
		"resources/read": null,
		"resources/subscribe": null,
		"resources/unsubscribe": null,
		"tools/call": null,
		"tools/list": null,
		"sampling/createMessage": null,
		"elicitation/create": null,
		"roots/list": null
	};
	let maps$1;
	function registryMaps() {
		if (maps$1) return maps$1;
		const s = buildSchemas2025();
		maps$1 = {
			requestSchemas: {
				ping: s.PingRequestSchema,
				initialize: s.InitializeRequestSchema,
				"completion/complete": s.CompleteRequestSchema,
				"logging/setLevel": s.SetLevelRequestSchema,
				"prompts/get": s.GetPromptRequestSchema,
				"prompts/list": s.ListPromptsRequestSchema,
				"resources/list": s.ListResourcesRequestSchema,
				"resources/templates/list": s.ListResourceTemplatesRequestSchema,
				"resources/read": s.ReadResourceRequestSchema,
				"resources/subscribe": s.SubscribeRequestSchema,
				"resources/unsubscribe": s.UnsubscribeRequestSchema,
				"tools/call": s.CallToolRequestSchema,
				"tools/list": s.ListToolsRequestSchema,
				"tasks/get": s.GetTaskRequestSchema,
				"tasks/result": s.GetTaskPayloadRequestSchema,
				"tasks/list": s.ListTasksRequestSchema,
				"tasks/cancel": s.CancelTaskRequestSchema,
				"sampling/createMessage": s.CreateMessageRequestSchema,
				"elicitation/create": s.ElicitRequestSchema,
				"roots/list": s.ListRootsRequestSchema
			},
			notificationSchemas: {
				"notifications/cancelled": s.CancelledNotificationSchema,
				"notifications/progress": s.ProgressNotificationSchema,
				"notifications/initialized": s.InitializedNotificationSchema,
				"notifications/roots/list_changed": s.RootsListChangedNotificationSchema,
				"notifications/tasks/status": s.TaskStatusNotificationSchema,
				"notifications/message": s.LoggingMessageNotificationSchema,
				"notifications/resources/updated": s.ResourceUpdatedNotificationSchema,
				"notifications/resources/list_changed": s.ResourceListChangedNotificationSchema,
				"notifications/tools/list_changed": s.ToolListChangedNotificationSchema,
				"notifications/prompts/list_changed": s.PromptListChangedNotificationSchema,
				"notifications/elicitation/complete": s.ElicitationCompleteNotificationSchema
			},
			resultSchemas: {
				ping: s.EmptyResultSchema,
				initialize: s.InitializeResultSchema,
				"completion/complete": s.CompleteResultSchema,
				"logging/setLevel": s.EmptyResultSchema,
				"prompts/get": s.GetPromptResultSchema,
				"prompts/list": s.ListPromptsResultSchema,
				"resources/list": s.ListResourcesResultSchema,
				"resources/templates/list": s.ListResourceTemplatesResultSchema,
				"resources/read": s.ReadResourceResultSchema,
				"resources/subscribe": s.EmptyResultSchema,
				"resources/unsubscribe": s.EmptyResultSchema,
				"tools/call": s.CallToolResultWireSchema,
				"tools/list": s.ListToolsResultSchema,
				"sampling/createMessage": s.CreateMessageResultWithToolsSchema,
				"elicitation/create": s.ElicitResultSchema,
				"roots/list": s.ListRootsResultSchema
			}
		};
		return maps$1;
	}
	/** The 2025-era request-method set (registry membership = the deletion story). */
	function hasRequestMethod2025(method) {
		return Object.prototype.hasOwnProperty.call(requestMethodKeys$1, method);
	}
	/** The 2025-era notification-method set. */
	function hasNotificationMethod2025(method) {
		return Object.prototype.hasOwnProperty.call(notificationMethodKeys$1, method);
	}
	/** Result-map membership: exactly the era's typed-method subset (no task entries, no 2026-only methods). */
	function hasResultMethod(method) {
		return Object.prototype.hasOwnProperty.call(resultMethodKeys, method);
	}
	function getResultSchema(method) {
		return hasResultMethod(method) ? registryMaps().resultSchemas[method] : void 0;
	}
	function getRequestSchema(method) {
		return hasRequestMethod2025(method) ? registryMaps().requestSchemas[method] : void 0;
	}
	function getNotificationSchema(method) {
		return hasNotificationMethod2025(method) ? registryMaps().notificationSchemas[method] : void 0;
	}
	Object.keys(requestMethodKeys$1);
	Object.keys(notificationMethodKeys$1);
	function isPlainObject$4(value) {
		return value !== null && typeof value === "object" && !Array.isArray(value);
	}
	/** Tri-state wrap of an optional Zod schema lookup (the function-only contract). */
	function triState$1(schema, raw) {
		if (schema === void 0) return {
			ok: false,
			reason: "not-in-era"
		};
		const parsed = schema.safeParse(raw);
		return parsed.success ? {
			ok: true,
			value: parsed.data
		} : {
			ok: false,
			reason: "invalid",
			message: String(parsed.error)
		};
	}
	const NOT_IN_ERA$1 = {
		ok: false,
		reason: "not-in-era"
	};
	/** Whether a `tools/list` entry advertises a non-object `outputSchema` root that needs the SEP-2106 legacy wrap. */
	function toolNeedsLegacyWrap(t) {
		return isPlainObject$4(t) && isPlainObject$4(t["outputSchema"]) && isNonObjectJsonSchemaRoot(t["outputSchema"]);
	}
	/** The wire→neutral trust boundary: a decoded 2025-era wire result is adopted as the neutral `Result` here (the module's single deliberate assertion). */
	function toNeutralResult(value) {
		return value;
	}
	const rev2025Codec = {
		era: "2025-11-25",
		hasRequestMethod: hasRequestMethod2025,
		hasNotificationMethod: hasNotificationMethod2025,
		validateRequest: (method, raw) => triState$1(getRequestSchema(method), raw),
		validateResult: (method, raw) => triState$1(getResultSchema(method), raw),
		validateNotification: (method, raw) => triState$1(getNotificationSchema(method), raw),
		hasInputRequestMethod: () => false,
		validateInputRequest: () => NOT_IN_ERA$1,
		validateInputResponse: () => NOT_IN_ERA$1,
		samplingResultVariant: ((hasTools, raw) => {
			const s = buildSchemas2025();
			return triState$1(hasTools ? s.CreateMessageResultWithToolsSchema : s.CreateMessageResultSchema, raw);
		}),
		outboundEnvelope: (_material) => void 0,
		validateEnvelopeMeta: (_meta) => [],
		projectCallToolResult(result, advertisedOutputSchema) {
			const withText = appendTextFallbackForNonObject(result);
			const sc = withText.structuredContent;
			if (sc === void 0) return withText;
			const valueIsNonObject = typeof sc !== "object" || sc === null || Array.isArray(sc);
			const schemaWrapped = advertisedOutputSchema !== void 0 && isNonObjectJsonSchemaRoot(advertisedOutputSchema);
			if (!valueIsNonObject && !schemaWrapped) return withText;
			return {
				...withText,
				structuredContent: { result: sc }
			};
		},
		decodeResult(_method, raw) {
			if (isPlainObject$4(raw) && "resultType" in raw) {
				const stripped = { ...raw };
				delete stripped["resultType"];
				return {
					kind: "complete",
					result: toNeutralResult(stripped)
				};
			}
			return {
				kind: "complete",
				result: toNeutralResult(raw)
			};
		},
		encodeResult(method, result) {
			if (method !== "tools/list") return result;
			const tools = result.tools;
			if (!Array.isArray(tools) || !tools.some((t) => toolNeedsLegacyWrap(t))) return result;
			return {
				...result,
				tools: tools.map((t) => toolNeedsLegacyWrap(t) ? {
					...t,
					outputSchema: wrapOutputSchemaForLegacy(t.outputSchema)
				} : t)
			};
		},
		encodeErrorCode: (code) => code === -32002 ? -32602 : code,
		checkInboundEnvelope: (_material) => void 0
	};
	/**
	* 2026-era wire schemas (protocol revision 2026-07-28).
	*
	* Fully self-contained — no runtime imports from types/schemas.ts. The
	* neutral types/schemas.ts layer is the public-API superset and is free to
	* evolve; this file is the 2026 wire-parse contract and is BEHAVIOR-FROZEN
	* against the 2026-07-28 anchor. Every era-shared building block (content
	* blocks, resources, prompts, capabilities, notifications, …) that the wire
	* shapes compose is a frozen LOCAL copy — verbatim from the neutral layer at
	* the point this revision was sealed, dependencies first. The only cross-layer
	* dependency is `import type { JSONObject, JSONValue }` from the neutral types
	* barrel — pure structural type aliases with no parse behavior.
	*
	* This module is the only place the per-request `_meta` envelope is modeled.
	* The envelope is wire-only vocabulary: the protocol layer lifts it off
	* inbound requests before any handler runs and surfaces it at
	* `ctx.mcpReq.envelope`; the 2026-era codec enforces its requiredness at
	* dispatch time (`checkInboundEnvelope`) - the former neutral-schema JSDoc
	* deferral ("enforced per request at dispatch time, not here") is now
	* discharged by that codec step.
	*
	* No 2025-era traffic ever touches this module, so requiredness here is
	* bare and spec-exact (the shared-schema `.catch` hazards do not apply).
	*
	* SPEC-CURRENCY RE-SEAL (2026-07-17): the 2026-07-28 revision was re-sealed
	* upstream by spec PR #3002 (commit 71e30695, merged 2026-07-15 — after the
	* previous anchor pin f68d864a): the envelope's `clientInfo` demoted from
	* required to SHOULD, and `DiscoverResult.serverInfo` moved from the result
	* body to the new `ResultMetaObject` key
	* `_meta['io.modelcontextprotocol/serverInfo']` (optional on every result).
	* The shapes below are the re-sealed anchor, exactly — no pre-#3002 shape is
	* modeled anywhere (per ruling: the final revision is the only 2026-07-28).
	*/
	function build() {
		const JSONValueSchema$1 = lazy(() => union([
			string(),
			number$1(),
			boolean(),
			_null(),
			record(string(), JSONValueSchema$1),
			array(JSONValueSchema$1)
		]));
		const JSONObjectSchema$1 = record(string(), JSONValueSchema$1);
		/**
		* A progress token, used to associate progress notifications with the original request.
		*/
		const ProgressTokenSchema$1 = union([string(), number$1().int()]);
		/**
		* An opaque token used to represent a cursor for pagination.
		*/
		const CursorSchema$1 = string();
		/**
		* A uniquely identifying ID for a request in JSON-RPC.
		*/
		const RequestIdSchema$1 = union([string(), number$1().int()]);
		/**
		* The sender or recipient of messages and data in a conversation.
		*/
		const RoleSchema$1 = _enum(["user", "assistant"]);
		/**
		* The severity of a log message.
		*/
		const LoggingLevelSchema$1 = _enum([
			"debug",
			"info",
			"notice",
			"warning",
			"error",
			"critical",
			"alert",
			"emergency"
		]);
		/**
		* A Zod schema for validating Base64 strings that is more performant and
		* robust for very large inputs than the default regex-based check. It avoids
		* stack overflows by using the native `atob` function for validation.
		*/
		const Base64Schema = string().refine((val) => {
			try {
				atob(val);
				return true;
			} catch {
				return false;
			}
		}, { message: "Invalid Base64 string" });
		/** @deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only. */
		const TaskMetadataSchema$1 = object({ ttl: number$1().optional() });
		/** @deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only. */
		const RelatedTaskMetadataSchema$1 = object({ taskId: string() });
		const RequestMetaSchema$1 = looseObject({
			progressToken: ProgressTokenSchema$1.optional(),
			"io.modelcontextprotocol/related-task": RelatedTaskMetadataSchema$1.optional()
		});
		const BaseRequestParamsSchema$1 = object({ _meta: RequestMetaSchema$1.optional() });
		/** @deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only. */
		const TaskAugmentedRequestParamsSchema$1 = BaseRequestParamsSchema$1.extend({ task: TaskMetadataSchema$1.optional() });
		const NotificationsParamsSchema$1 = object({ _meta: RequestMetaSchema$1.optional() });
		const NotificationSchema$1 = object({
			method: string(),
			params: NotificationsParamsSchema$1.loose().optional()
		});
		const IconSchema$1 = object({
			src: string(),
			mimeType: string().optional(),
			sizes: array(string()).optional(),
			theme: _enum(["light", "dark"]).optional()
		});
		const IconsSchema$1 = object({ icons: array(IconSchema$1).optional() });
		const BaseMetadataSchema$1 = object({
			name: string(),
			title: string().optional()
		});
		const ImplementationSchema$1 = BaseMetadataSchema$1.extend({
			...BaseMetadataSchema$1.shape,
			...IconsSchema$1.shape,
			version: string(),
			websiteUrl: string().optional(),
			description: string().optional()
		});
		const ElicitationCapabilitySchema = preprocess((value) => {
			if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) return { form: {} };
			return value;
		}, intersection(object({
			form: intersection(object({ applyDefaults: boolean().optional() }), JSONObjectSchema$1).optional(),
			url: JSONObjectSchema$1.optional()
		}), JSONObjectSchema$1.optional()));
		/** @deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only. */
		const ClientTasksCapabilitySchema$1 = looseObject({
			list: JSONObjectSchema$1.optional(),
			cancel: JSONObjectSchema$1.optional(),
			requests: looseObject({
				sampling: looseObject({ createMessage: JSONObjectSchema$1.optional() }).optional(),
				elicitation: looseObject({ create: JSONObjectSchema$1.optional() }).optional()
			}).optional()
		});
		/** @deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only. */
		const ServerTasksCapabilitySchema$1 = looseObject({
			list: JSONObjectSchema$1.optional(),
			cancel: JSONObjectSchema$1.optional(),
			requests: looseObject({ tools: looseObject({ call: JSONObjectSchema$1.optional() }).optional() }).optional()
		});
		const ClientCapabilitiesSchema$1 = object({
			experimental: record(string(), JSONObjectSchema$1).optional(),
			sampling: object({
				context: JSONObjectSchema$1.optional(),
				tools: JSONObjectSchema$1.optional()
			}).optional(),
			elicitation: ElicitationCapabilitySchema.optional(),
			roots: object({ listChanged: boolean().optional() }).optional(),
			tasks: ClientTasksCapabilitySchema$1.optional(),
			extensions: record(string(), JSONObjectSchema$1).optional()
		});
		const ServerCapabilitiesSchema$1 = object({
			experimental: record(string(), JSONObjectSchema$1).optional(),
			logging: JSONObjectSchema$1.optional(),
			completions: JSONObjectSchema$1.optional(),
			prompts: object({ listChanged: boolean().optional() }).optional(),
			resources: object({
				subscribe: boolean().optional(),
				listChanged: boolean().optional()
			}).optional(),
			tools: object({ listChanged: boolean().optional() }).optional(),
			tasks: ServerTasksCapabilitySchema$1.optional(),
			extensions: record(string(), JSONObjectSchema$1).optional()
		});
		const ProgressSchema$1 = object({
			progress: number$1(),
			total: optional(number$1()),
			message: optional(string())
		});
		const ProgressNotificationParamsSchema$1 = object({
			...NotificationsParamsSchema$1.shape,
			...ProgressSchema$1.shape,
			progressToken: ProgressTokenSchema$1
		});
		const ProgressNotificationSchema$1 = NotificationSchema$1.extend({
			method: literal("notifications/progress"),
			params: ProgressNotificationParamsSchema$1
		});
		const LoggingMessageNotificationParamsSchema$1 = NotificationsParamsSchema$1.extend({
			level: LoggingLevelSchema$1,
			logger: string().optional(),
			data: unknown()
		});
		const LoggingMessageNotificationSchema$1 = NotificationSchema$1.extend({
			method: literal("notifications/message"),
			params: LoggingMessageNotificationParamsSchema$1
		});
		const ResourceContentsSchema$1 = object({
			uri: string(),
			mimeType: optional(string()),
			_meta: record(string(), unknown()).optional()
		});
		const TextResourceContentsSchema$1 = ResourceContentsSchema$1.extend({ text: string() });
		const BlobResourceContentsSchema$1 = ResourceContentsSchema$1.extend({ blob: Base64Schema });
		const AnnotationsSchema$1 = object({
			audience: array(RoleSchema$1).optional(),
			priority: number$1().min(0).max(1).optional(),
			lastModified: datetime({ offset: true }).optional()
		});
		const ResourceSchema$1 = object({
			...BaseMetadataSchema$1.shape,
			...IconsSchema$1.shape,
			uri: string(),
			description: optional(string()),
			mimeType: optional(string()),
			size: optional(number$1()),
			annotations: AnnotationsSchema$1.optional(),
			_meta: optional(looseObject({}))
		});
		const ResourceTemplateSchema$1 = object({
			...BaseMetadataSchema$1.shape,
			...IconsSchema$1.shape,
			uriTemplate: string(),
			description: optional(string()),
			mimeType: optional(string()),
			annotations: AnnotationsSchema$1.optional(),
			_meta: optional(looseObject({}))
		});
		const ResourceListChangedNotificationSchema$1 = NotificationSchema$1.extend({
			method: literal("notifications/resources/list_changed"),
			params: NotificationsParamsSchema$1.optional()
		});
		const ResourceUpdatedNotificationParamsSchema$1 = NotificationsParamsSchema$1.extend({ uri: string() });
		const ResourceUpdatedNotificationSchema$1 = NotificationSchema$1.extend({
			method: literal("notifications/resources/updated"),
			params: ResourceUpdatedNotificationParamsSchema$1
		});
		const PromptArgumentSchema$1 = object({
			name: string(),
			description: optional(string()),
			required: optional(boolean())
		});
		const PromptSchema$1 = object({
			...BaseMetadataSchema$1.shape,
			...IconsSchema$1.shape,
			description: optional(string()),
			arguments: optional(array(PromptArgumentSchema$1)),
			_meta: optional(looseObject({}))
		});
		const PromptListChangedNotificationSchema$1 = NotificationSchema$1.extend({
			method: literal("notifications/prompts/list_changed"),
			params: NotificationsParamsSchema$1.optional()
		});
		const TextContentSchema$1 = object({
			type: literal("text"),
			text: string(),
			annotations: AnnotationsSchema$1.optional(),
			_meta: record(string(), unknown()).optional()
		});
		const ImageContentSchema$1 = object({
			type: literal("image"),
			data: Base64Schema,
			mimeType: string(),
			annotations: AnnotationsSchema$1.optional(),
			_meta: record(string(), unknown()).optional()
		});
		const AudioContentSchema$1 = object({
			type: literal("audio"),
			data: Base64Schema,
			mimeType: string(),
			annotations: AnnotationsSchema$1.optional(),
			_meta: record(string(), unknown()).optional()
		});
		const ToolUseContentSchema$1 = object({
			type: literal("tool_use"),
			name: string(),
			id: string(),
			input: record(string(), unknown()),
			_meta: record(string(), unknown()).optional()
		});
		const EmbeddedResourceSchema$1 = object({
			type: literal("resource"),
			resource: union([TextResourceContentsSchema$1, BlobResourceContentsSchema$1]),
			annotations: AnnotationsSchema$1.optional(),
			_meta: record(string(), unknown()).optional()
		});
		const ResourceLinkSchema$1 = ResourceSchema$1.extend({ type: literal("resource_link") });
		const ContentBlockSchema$1 = union([
			TextContentSchema$1,
			ImageContentSchema$1,
			AudioContentSchema$1,
			ResourceLinkSchema$1,
			EmbeddedResourceSchema$1
		]);
		const PromptMessageSchema$1 = object({
			role: RoleSchema$1,
			content: ContentBlockSchema$1
		});
		const ToolAnnotationsSchema$1 = object({
			title: string().optional(),
			readOnlyHint: boolean().optional(),
			destructiveHint: boolean().optional(),
			idempotentHint: boolean().optional(),
			openWorldHint: boolean().optional()
		});
		const ToolListChangedNotificationSchema$1 = NotificationSchema$1.extend({
			method: literal("notifications/tools/list_changed"),
			params: NotificationsParamsSchema$1.optional()
		});
		const ModelHintSchema$1 = object({ name: string().optional() });
		const ModelPreferencesSchema$1 = object({
			hints: array(ModelHintSchema$1).optional(),
			costPriority: number$1().min(0).max(1).optional(),
			speedPriority: number$1().min(0).max(1).optional(),
			intelligencePriority: number$1().min(0).max(1).optional()
		});
		const ToolChoiceSchema$1 = object({ mode: _enum([
			"auto",
			"required",
			"none"
		]).optional() });
		const BooleanSchemaSchema$1 = object({
			type: literal("boolean"),
			title: string().optional(),
			description: string().optional(),
			default: boolean().optional()
		});
		const StringSchemaSchema$1 = object({
			type: literal("string"),
			title: string().optional(),
			description: string().optional(),
			minLength: number$1().optional(),
			maxLength: number$1().optional(),
			format: _enum([
				"email",
				"uri",
				"date",
				"date-time"
			]).optional(),
			default: string().optional()
		});
		const NumberSchemaSchema$1 = object({
			type: _enum(["number", "integer"]),
			title: string().optional(),
			description: string().optional(),
			minimum: number$1().optional(),
			maximum: number$1().optional(),
			default: number$1().optional()
		});
		const UntitledSingleSelectEnumSchemaSchema$1 = object({
			type: literal("string"),
			title: string().optional(),
			description: string().optional(),
			enum: array(string()),
			default: string().optional()
		});
		const TitledSingleSelectEnumSchemaSchema$1 = object({
			type: literal("string"),
			title: string().optional(),
			description: string().optional(),
			oneOf: array(object({
				const: string(),
				title: string()
			})),
			default: string().optional()
		});
		const LegacyTitledEnumSchemaSchema$1 = object({
			type: literal("string"),
			title: string().optional(),
			description: string().optional(),
			enum: array(string()),
			enumNames: array(string()).optional(),
			default: string().optional()
		});
		const SingleSelectEnumSchemaSchema$1 = union([UntitledSingleSelectEnumSchemaSchema$1, TitledSingleSelectEnumSchemaSchema$1]);
		const UntitledMultiSelectEnumSchemaSchema$1 = object({
			type: literal("array"),
			title: string().optional(),
			description: string().optional(),
			minItems: number$1().optional(),
			maxItems: number$1().optional(),
			items: object({
				type: literal("string"),
				enum: array(string())
			}),
			default: array(string()).optional()
		});
		const TitledMultiSelectEnumSchemaSchema$1 = object({
			type: literal("array"),
			title: string().optional(),
			description: string().optional(),
			minItems: number$1().optional(),
			maxItems: number$1().optional(),
			items: object({ anyOf: array(object({
				const: string(),
				title: string()
			})) }),
			default: array(string()).optional()
		});
		const MultiSelectEnumSchemaSchema$1 = union([UntitledMultiSelectEnumSchemaSchema$1, TitledMultiSelectEnumSchemaSchema$1]);
		const EnumSchemaSchema$1 = union([
			LegacyTitledEnumSchemaSchema$1,
			SingleSelectEnumSchemaSchema$1,
			MultiSelectEnumSchemaSchema$1
		]);
		const PrimitiveSchemaDefinitionSchema$1 = union([
			EnumSchemaSchema$1,
			BooleanSchemaSchema$1,
			StringSchemaSchema$1,
			NumberSchemaSchema$1
		]);
		const ElicitRequestFormParamsSchema$1 = TaskAugmentedRequestParamsSchema$1.extend({
			mode: literal("form").optional(),
			message: string(),
			requestedSchema: object({
				type: literal("object"),
				properties: record(string(), PrimitiveSchemaDefinitionSchema$1),
				required: array(string()).optional()
			}).catchall(unknown())
		});
		const ResourceTemplateReferenceSchema$1 = object({
			type: literal("ref/resource"),
			uri: string()
		});
		const PromptReferenceSchema$1 = object({
			type: literal("ref/prompt"),
			name: string()
		});
		const RootSchema$1 = object({
			uri: string().startsWith("file://"),
			name: string().optional(),
			_meta: record(string(), unknown()).optional()
		});
		const sharedClientCapabilityShape = ClientCapabilitiesSchema$1.shape;
		const ClientCapabilities2026Schema = object({
			experimental: sharedClientCapabilityShape.experimental,
			sampling: sharedClientCapabilityShape.sampling,
			elicitation: sharedClientCapabilityShape.elicitation,
			roots: sharedClientCapabilityShape.roots,
			extensions: sharedClientCapabilityShape.extensions
		});
		const sharedServerCapabilityShape = ServerCapabilitiesSchema$1.shape;
		const ServerCapabilities2026Schema = object({
			experimental: sharedServerCapabilityShape.experimental,
			logging: sharedServerCapabilityShape.logging,
			completions: sharedServerCapabilityShape.completions,
			prompts: sharedServerCapabilityShape.prompts,
			resources: sharedServerCapabilityShape.resources,
			tools: sharedServerCapabilityShape.tools,
			extensions: sharedServerCapabilityShape.extensions
		});
		/**
		* The per-request `_meta` envelope carried by every request under protocol revision
		* 2026-07-28: the protocol version governing the request, the client implementation
		* info, and the client's capabilities — declared per request rather than once at
		* initialization — plus the optional log-level opt-in.
		*
		* This schema models the complete envelope on its own (loose: foreign keys
		* pass through - the lift extracts exactly the reserved keys, so enforcement
		* never sees extension material). Requiredness is enforced per request at
		* dispatch time by the 2026-era codec's `checkInboundEnvelope` step.
		*/
		const RequestMetaEnvelopeSchema = looseObject({
			progressToken: ProgressTokenSchema$1.optional(),
			[PROTOCOL_VERSION_META_KEY]: string(),
			[CLIENT_INFO_META_KEY]: ImplementationSchema$1.optional(),
			[CLIENT_CAPABILITIES_META_KEY]: ClientCapabilities2026Schema,
			[LOG_LEVEL_META_KEY]: LoggingLevelSchema$1.optional()
		});
		/** 2026-era Tool: anchor-exact — no `execution` (deleted vocabulary). */
		const ToolSchema$1 = object({
			...BaseMetadataSchema$1.shape,
			...IconsSchema$1.shape,
			description: string().optional(),
			inputSchema: looseObject({
				$schema: string().optional(),
				type: literal("object")
			}),
			outputSchema: looseObject({ $schema: string().optional() }).optional(),
			annotations: ToolAnnotationsSchema$1.optional(),
			_meta: record(string(), unknown()).optional()
		});
		/** 2026-era ToolResultContent (anchor-exact: `structuredContent?: unknown`). */
		const ToolResultContentSchema$1 = object({
			type: literal("tool_result"),
			toolUseId: string(),
			content: array(ContentBlockSchema$1),
			structuredContent: unknown().optional(),
			isError: boolean().optional(),
			_meta: record(string(), unknown()).optional()
		});
		/** 2026-era sampling content union (composes the forked tool-result shape). */
		const SamplingMessageContentBlockSchema$1 = union([
			TextContentSchema$1,
			ImageContentSchema$1,
			AudioContentSchema$1,
			ToolUseContentSchema$1,
			ToolResultContentSchema$1
		]);
		/** 2026-era SamplingMessage (anchor-exact: single block or array). */
		const SamplingMessageSchema$1 = object({
			role: RoleSchema$1,
			content: union([SamplingMessageContentBlockSchema$1, array(SamplingMessageContentBlockSchema$1)]),
			_meta: record(string(), unknown()).optional()
		});
		/** Open union per the anchor: 'complete' | 'input_required' | string. */
		const ResultTypeSchema = string();
		/**
		* Result `_meta` (anchor `ResultMetaObject`, added by spec PR #3002):
		* loose, with the serverInfo key typed when present; the outbound stamp
		* is the encode contract's `stampServerInfoMeta` step.
		*/
		const ResultMetaSchema = looseObject({ [SERVER_INFO_META_KEY]: ImplementationSchema$1.optional().catch(void 0) });
		const wireMeta = ResultMetaSchema.optional();
		function wireResult(shape) {
			return looseObject({
				_meta: wireMeta,
				resultType: ResultTypeSchema.default("complete"),
				...shape
			});
		}
		const ResultSchema$1 = wireResult({});
		const PaginatedResultSchema$1 = wireResult({ nextCursor: CursorSchema$1.optional() });
		const CallToolResultSchema$1 = wireResult({
			content: array(ContentBlockSchema$1),
			structuredContent: unknown().optional(),
			isError: boolean().optional()
		});
		const ListToolsResultSchema$1 = wireResult({
			ttlMs: number$1().int().min(0),
			cacheScope: _enum(["public", "private"]),
			tools: array(ToolSchema$1),
			nextCursor: CursorSchema$1.optional()
		});
		const ListPromptsResultSchema$1 = wireResult({
			ttlMs: number$1().int().min(0),
			cacheScope: _enum(["public", "private"]),
			prompts: array(PromptSchema$1),
			nextCursor: CursorSchema$1.optional()
		});
		const GetPromptResultSchema$1 = wireResult({
			description: string().optional(),
			messages: array(PromptMessageSchema$1)
		});
		const ListResourcesResultSchema$1 = wireResult({
			ttlMs: number$1().int().min(0),
			cacheScope: _enum(["public", "private"]),
			resources: array(ResourceSchema$1),
			nextCursor: CursorSchema$1.optional()
		});
		const ListResourceTemplatesResultSchema$1 = wireResult({
			ttlMs: number$1().int().min(0),
			cacheScope: _enum(["public", "private"]),
			resourceTemplates: array(ResourceTemplateSchema$1),
			nextCursor: CursorSchema$1.optional()
		});
		const ReadResourceResultSchema$1 = wireResult({
			ttlMs: number$1().int().min(0),
			cacheScope: _enum(["public", "private"]),
			contents: array(union([TextResourceContentsSchema$1, BlobResourceContentsSchema$1]))
		});
		const CompleteResultSchema$1 = wireResult({ completion: object({
			values: array(string()).max(100),
			total: number$1().int().optional(),
			hasMore: boolean().optional()
		}).loose() });
		/** CacheableResult (SEP-2549): ttlMs and cacheScope REQUIRED per the anchor. */
		const CacheableResultSchema = wireResult({
			ttlMs: number$1().int().min(0),
			cacheScope: _enum(["public", "private"])
		});
		const DiscoverResultSchema$1 = wireResult({
			ttlMs: number$1().int().min(0).catch(0),
			cacheScope: _enum(["public", "private"]).catch("private"),
			supportedVersions: array(string()),
			capabilities: ServerCapabilities2026Schema,
			instructions: string().optional()
		});
		/** 2026-era CreateMessageRequestParams (anchor-exact: forked SamplingMessage/Tool, no task augmentation). */
		const CreateMessageRequestParamsSchema$1 = object({
			messages: array(SamplingMessageSchema$1),
			modelPreferences: ModelPreferencesSchema$1.optional(),
			systemPrompt: string().optional(),
			includeContext: _enum([
				"none",
				"thisServer",
				"allServers"
			]).optional(),
			temperature: number$1().optional(),
			maxTokens: number$1().int(),
			stopSequences: array(string()).optional(),
			metadata: JSONObjectSchema$1.optional(),
			tools: array(ToolSchema$1).optional(),
			toolChoice: ToolChoiceSchema$1.optional()
		});
		/** 2026-era embedded sampling request (de-JSON-RPC'd). */
		const CreateMessageRequestSchema$1 = object({
			method: literal("sampling/createMessage"),
			params: CreateMessageRequestParamsSchema$1
		});
		/**
		* 2026-era embedded roots listing request (de-JSON-RPC'd). Embedded input
		* requests do NOT carry the per-request `_meta` envelope on this revision —
		* the anchor declares a bare optional `_meta` on `params`.
		*/
		const ListRootsRequestSchema$1 = object({
			method: literal("roots/list"),
			params: object({ _meta: record(string(), unknown()).optional() }).optional()
		});
		/** 2026-era embedded sampling response (anchor-exact: extends the forked SamplingMessage). */
		const CreateMessageResultSchema$1 = object({
			...SamplingMessageSchema$1.shape,
			model: string(),
			stopReason: string().optional()
		});
		/** 2026-era embedded roots listing response (anchor-exact: bare `roots` array). */
		const ListRootsResultSchema$1 = object({ roots: array(RootSchema$1) });
		/** 2026-era embedded elicitation response (anchor-exact: bare result, restricted content value types). */
		const ElicitResultSchema$1 = object({
			action: _enum([
				"accept",
				"decline",
				"cancel"
			]),
			content: record(string(), union([
				string(),
				number$1(),
				boolean(),
				array(string())
			])).optional()
		});
		/**
		* 2026-era URL-mode elicitation params (anchor-exact fork): the draft removed
		* `elicitationId` (and the `notifications/elicitation/complete` channel it
		* keyed) — the shared schema keeps the field because it is required on the
		* frozen 2025-11-25 revision.
		*/
		const ElicitRequestURLParamsSchema$1 = object({
			mode: literal("url"),
			message: string(),
			url: string().url()
		});
		/** 2026-era elicitation params (form mode is revision-identical; URL mode is the fork above). */
		const ElicitRequestParamsSchema$1 = union([ElicitRequestFormParamsSchema$1, ElicitRequestURLParamsSchema$1]);
		/** 2026-era embedded elicitation request (de-JSON-RPC'd; see the URL-mode fork above). */
		const ElicitRequestSchema$1 = object({
			method: literal("elicitation/create"),
			params: ElicitRequestParamsSchema$1
		});
		/** A single embedded input request (one of the three demoted server→client requests). */
		const InputRequestSchema = union([
			CreateMessageRequestSchema$1,
			ListRootsRequestSchema$1,
			ElicitRequestSchema$1
		]);
		/** A single embedded input response — the BARE result union (never a `{method, result}` wrapper). */
		const InputResponseSchema = union([
			CreateMessageResultSchema$1,
			ListRootsResultSchema$1,
			ElicitResultSchema$1
		]);
		/** Map of embedded input requests, keyed by server-assigned identifiers. */
		const InputRequestsSchema = record(string(), InputRequestSchema);
		/** Map of embedded input responses, keyed by the corresponding request identifiers. */
		const InputResponsesSchema = record(string(), InputResponseSchema);
		/**
		* The wire InputRequiredResult: `resultType: 'input_required'` plus at least
		* one of `inputRequests` / `requestState` (the at-least-one rule is enforced
		* at the server seam, not by this parse shape).
		*/
		const InputRequiredResultSchema = wireResult({
			inputRequests: InputRequestsSchema.optional(),
			requestState: string().optional()
		});
		/** The retry-channel members carried by client-initiated requests on this revision. */
		const retryParamsShape = {
			inputResponses: InputResponsesSchema.optional(),
			requestState: string().optional()
		};
		/** Anchor InputResponseRequestParams: the retry channel on top of the required request `_meta` envelope. */
		const InputResponseRequestParamsSchema = object({
			_meta: RequestMetaEnvelopeSchema,
			...retryParamsShape
		});
		/** Post-lift request `_meta` (progressToken + extension keys; loose). */
		const DispatchRequestMetaSchema = looseObject({ progressToken: ProgressTokenSchema$1.optional() });
		function wireRequest(method, paramsShape) {
			return object({
				method: literal(method),
				params: object({
					_meta: RequestMetaEnvelopeSchema,
					...paramsShape
				})
			});
		}
		function dispatchRequest(method, paramsShape) {
			return object({
				method: literal(method),
				params: object({
					_meta: DispatchRequestMetaSchema.optional(),
					...paramsShape
				}).optional()
			});
		}
		const callToolParamsShape = {
			name: string(),
			arguments: record(string(), unknown()).optional(),
			...retryParamsShape
		};
		const paginatedParamsShape = { cursor: CursorSchema$1.optional() };
		const CallToolRequestSchema$1 = wireRequest("tools/call", callToolParamsShape);
		const ListToolsRequestSchema$1 = wireRequest("tools/list", paginatedParamsShape);
		const ListPromptsRequestSchema$1 = wireRequest("prompts/list", paginatedParamsShape);
		const GetPromptRequestSchema$1 = wireRequest("prompts/get", {
			name: string(),
			arguments: record(string(), string()).optional(),
			...retryParamsShape
		});
		const ListResourcesRequestSchema$1 = wireRequest("resources/list", paginatedParamsShape);
		const ListResourceTemplatesRequestSchema$1 = wireRequest("resources/templates/list", paginatedParamsShape);
		const ReadResourceRequestSchema$1 = wireRequest("resources/read", {
			uri: string(),
			...retryParamsShape
		});
		const completeParamsShape = {
			ref: union([PromptReferenceSchema$1, ResourceTemplateReferenceSchema$1]),
			argument: object({
				name: string(),
				value: string()
			}),
			context: object({ arguments: record(string(), string()).optional() }).optional()
		};
		const CompleteRequestSchema$1 = wireRequest("completion/complete", completeParamsShape);
		const DiscoverRequestSchema$1 = wireRequest("server/discover", {});
		/** Anchor SubscriptionFilter (2026-only). */
		const SubscriptionFilterSchema$1 = object({
			toolsListChanged: boolean().optional(),
			promptsListChanged: boolean().optional(),
			resourcesListChanged: boolean().optional(),
			resourceSubscriptions: array(string()).optional()
		});
		const subscriptionsListenParamsShape = { notifications: SubscriptionFilterSchema$1 };
		const SubscriptionsListenRequestSchema$1 = wireRequest("subscriptions/listen", subscriptionsListenParamsShape);
		/**
		* Anchor SubscriptionsListenResultMeta — required subscriptionId stamp on
		* the graceful-close result. Extends `ResultMetaObject` since spec PR
		* #3002 (composed, so the serverInfo key and its leniency stay single-sourced).
		*/
		const SubscriptionsListenResultMetaSchema$1 = ResultMetaSchema.extend({ "io.modelcontextprotocol/subscriptionId": RequestIdSchema$1 });
		/**
		* Anchor SubscriptionsListenResult (2026-only). The empty `subscriptions/listen`
		* response signalling that the subscription has ended gracefully (server
		* shutdown). An abrupt transport close carries no response — the client treats
		* stream-close-without-result as a disconnect.
		*/
		const SubscriptionsListenResultSchema$1 = looseObject({
			_meta: SubscriptionsListenResultMetaSchema$1,
			resultType: ResultTypeSchema.default("complete")
		});
		/** Dispatch (post-lift) request schemas, keyed by method — registry-internal. */
		const dispatchRequestSchemas = {
			"tools/call": dispatchRequest("tools/call", callToolParamsShape),
			"tools/list": dispatchRequest("tools/list", paginatedParamsShape),
			"prompts/get": dispatchRequest("prompts/get", {
				name: string(),
				arguments: record(string(), string()).optional()
			}),
			"prompts/list": dispatchRequest("prompts/list", paginatedParamsShape),
			"resources/list": dispatchRequest("resources/list", paginatedParamsShape),
			"resources/templates/list": dispatchRequest("resources/templates/list", paginatedParamsShape),
			"resources/read": dispatchRequest("resources/read", { uri: string() }),
			"completion/complete": dispatchRequest("completion/complete", completeParamsShape),
			"server/discover": dispatchRequest("server/discover", {}),
			"subscriptions/listen": dispatchRequest("subscriptions/listen", subscriptionsListenParamsShape)
		};
		/** Dispatch (post-lift) result schemas, keyed by method — what the funnel
		* validates AFTER `decodeResult` consumed `resultType`. */
		function liftedResult(shape) {
			return looseObject({
				_meta: wireMeta,
				...shape
			});
		}
		const dispatchResultSchemas = {
			"tools/call": liftedResult({
				content: array(ContentBlockSchema$1),
				structuredContent: unknown().optional(),
				isError: boolean().optional()
			}),
			"tools/list": liftedResult({
				ttlMs: number$1().int().min(0),
				cacheScope: _enum(["public", "private"]),
				tools: array(ToolSchema$1),
				nextCursor: CursorSchema$1.optional()
			}),
			"prompts/get": liftedResult({
				description: string().optional(),
				messages: array(PromptMessageSchema$1)
			}),
			"prompts/list": liftedResult({
				ttlMs: number$1().int().min(0),
				cacheScope: _enum(["public", "private"]),
				prompts: array(PromptSchema$1),
				nextCursor: CursorSchema$1.optional()
			}),
			"resources/list": liftedResult({
				ttlMs: number$1().int().min(0),
				cacheScope: _enum(["public", "private"]),
				resources: array(ResourceSchema$1),
				nextCursor: CursorSchema$1.optional()
			}),
			"resources/templates/list": liftedResult({
				ttlMs: number$1().int().min(0),
				cacheScope: _enum(["public", "private"]),
				resourceTemplates: array(ResourceTemplateSchema$1),
				nextCursor: CursorSchema$1.optional()
			}),
			"resources/read": liftedResult({
				ttlMs: number$1().int().min(0),
				cacheScope: _enum(["public", "private"]),
				contents: array(union([TextResourceContentsSchema$1, BlobResourceContentsSchema$1]))
			}),
			"completion/complete": liftedResult({ completion: object({
				values: array(string()).max(100),
				total: number$1().int().optional(),
				hasMore: boolean().optional()
			}).loose() }),
			"server/discover": liftedResult({
				ttlMs: number$1().int().min(0).catch(0),
				cacheScope: _enum(["public", "private"]).catch("private"),
				supportedVersions: array(string()),
				capabilities: ServerCapabilities2026Schema,
				instructions: string().optional()
			}),
			"subscriptions/listen": liftedResult({})
		};
		/**
		* Notification `_meta` (anchor `NotificationMetaObject`): loose, with the
		* subscriptions/listen demux key typed when present. Only the anchor-exact
		* SHAPE is modeled here — listen delivery itself (filter gating, demux,
		* teardown) is #14 scope and not implemented by this module.
		*/
		const NotificationMetaSchema = looseObject({ "io.modelcontextprotocol/subscriptionId": RequestIdSchema$1.optional() });
		/** Anchor SubscriptionsAcknowledgedNotification (2026-only). */
		const SubscriptionsAcknowledgedNotificationSchema$1 = object({
			method: literal("notifications/subscriptions/acknowledged"),
			params: object({
				_meta: NotificationMetaSchema.optional(),
				notifications: SubscriptionFilterSchema$1
			})
		});
		/**
		* 2026-era `notifications/cancelled` params (anchor-exact fork): `requestId`
		* is REQUIRED on this revision — the shared schema keeps it optional because
		* the frozen 2025-11-25 shape declares it optional (task cancellation goes
		* through `tasks/cancel` there). Requiredness is bare because no 2025-era
		* traffic touches this module.
		*/
		const CancelledNotificationParamsSchema$1 = object({
			_meta: NotificationMetaSchema.optional(),
			requestId: RequestIdSchema$1,
			reason: string().optional()
		});
		/** 2026-era `notifications/cancelled` (see the params fork above). */
		const CancelledNotificationSchema$1 = object({
			method: literal("notifications/cancelled"),
			params: CancelledNotificationParamsSchema$1
		});
		const notificationSchemas2026 = {
			"notifications/cancelled": CancelledNotificationSchema$1,
			"notifications/progress": ProgressNotificationSchema$1,
			"notifications/message": LoggingMessageNotificationSchema$1,
			"notifications/resources/updated": ResourceUpdatedNotificationSchema$1,
			"notifications/resources/list_changed": ResourceListChangedNotificationSchema$1,
			"notifications/tools/list_changed": ToolListChangedNotificationSchema$1,
			"notifications/prompts/list_changed": PromptListChangedNotificationSchema$1,
			"notifications/subscriptions/acknowledged": SubscriptionsAcknowledgedNotificationSchema$1
		};
		const wireResultResponse = (result) => object({
			jsonrpc: literal("2.0"),
			id: union([string(), number$1().int()]),
			result
		}).strict();
		return {
			JSONValueSchema: JSONValueSchema$1,
			JSONObjectSchema: JSONObjectSchema$1,
			ProgressTokenSchema: ProgressTokenSchema$1,
			CursorSchema: CursorSchema$1,
			RequestIdSchema: RequestIdSchema$1,
			RoleSchema: RoleSchema$1,
			LoggingLevelSchema: LoggingLevelSchema$1,
			TaskMetadataSchema: TaskMetadataSchema$1,
			RelatedTaskMetadataSchema: RelatedTaskMetadataSchema$1,
			RequestMetaSchema: RequestMetaSchema$1,
			BaseRequestParamsSchema: BaseRequestParamsSchema$1,
			TaskAugmentedRequestParamsSchema: TaskAugmentedRequestParamsSchema$1,
			NotificationsParamsSchema: NotificationsParamsSchema$1,
			NotificationSchema: NotificationSchema$1,
			IconSchema: IconSchema$1,
			IconsSchema: IconsSchema$1,
			BaseMetadataSchema: BaseMetadataSchema$1,
			ImplementationSchema: ImplementationSchema$1,
			ClientTasksCapabilitySchema: ClientTasksCapabilitySchema$1,
			ServerTasksCapabilitySchema: ServerTasksCapabilitySchema$1,
			ClientCapabilitiesSchema: ClientCapabilitiesSchema$1,
			ServerCapabilitiesSchema: ServerCapabilitiesSchema$1,
			ProgressSchema: ProgressSchema$1,
			ProgressNotificationParamsSchema: ProgressNotificationParamsSchema$1,
			ProgressNotificationSchema: ProgressNotificationSchema$1,
			LoggingMessageNotificationParamsSchema: LoggingMessageNotificationParamsSchema$1,
			LoggingMessageNotificationSchema: LoggingMessageNotificationSchema$1,
			ResourceContentsSchema: ResourceContentsSchema$1,
			TextResourceContentsSchema: TextResourceContentsSchema$1,
			BlobResourceContentsSchema: BlobResourceContentsSchema$1,
			AnnotationsSchema: AnnotationsSchema$1,
			ResourceSchema: ResourceSchema$1,
			ResourceTemplateSchema: ResourceTemplateSchema$1,
			ResourceListChangedNotificationSchema: ResourceListChangedNotificationSchema$1,
			ResourceUpdatedNotificationParamsSchema: ResourceUpdatedNotificationParamsSchema$1,
			ResourceUpdatedNotificationSchema: ResourceUpdatedNotificationSchema$1,
			PromptArgumentSchema: PromptArgumentSchema$1,
			PromptSchema: PromptSchema$1,
			PromptListChangedNotificationSchema: PromptListChangedNotificationSchema$1,
			TextContentSchema: TextContentSchema$1,
			ImageContentSchema: ImageContentSchema$1,
			AudioContentSchema: AudioContentSchema$1,
			ToolUseContentSchema: ToolUseContentSchema$1,
			EmbeddedResourceSchema: EmbeddedResourceSchema$1,
			ResourceLinkSchema: ResourceLinkSchema$1,
			ContentBlockSchema: ContentBlockSchema$1,
			PromptMessageSchema: PromptMessageSchema$1,
			ToolAnnotationsSchema: ToolAnnotationsSchema$1,
			ToolListChangedNotificationSchema: ToolListChangedNotificationSchema$1,
			ModelHintSchema: ModelHintSchema$1,
			ModelPreferencesSchema: ModelPreferencesSchema$1,
			ToolChoiceSchema: ToolChoiceSchema$1,
			BooleanSchemaSchema: BooleanSchemaSchema$1,
			StringSchemaSchema: StringSchemaSchema$1,
			NumberSchemaSchema: NumberSchemaSchema$1,
			UntitledSingleSelectEnumSchemaSchema: UntitledSingleSelectEnumSchemaSchema$1,
			TitledSingleSelectEnumSchemaSchema: TitledSingleSelectEnumSchemaSchema$1,
			LegacyTitledEnumSchemaSchema: LegacyTitledEnumSchemaSchema$1,
			SingleSelectEnumSchemaSchema: SingleSelectEnumSchemaSchema$1,
			UntitledMultiSelectEnumSchemaSchema: UntitledMultiSelectEnumSchemaSchema$1,
			TitledMultiSelectEnumSchemaSchema: TitledMultiSelectEnumSchemaSchema$1,
			MultiSelectEnumSchemaSchema: MultiSelectEnumSchemaSchema$1,
			EnumSchemaSchema: EnumSchemaSchema$1,
			PrimitiveSchemaDefinitionSchema: PrimitiveSchemaDefinitionSchema$1,
			ElicitRequestFormParamsSchema: ElicitRequestFormParamsSchema$1,
			ResourceTemplateReferenceSchema: ResourceTemplateReferenceSchema$1,
			PromptReferenceSchema: PromptReferenceSchema$1,
			RootSchema: RootSchema$1,
			ClientCapabilities2026Schema,
			ServerCapabilities2026Schema,
			RequestMetaEnvelopeSchema,
			ToolSchema: ToolSchema$1,
			ToolResultContentSchema: ToolResultContentSchema$1,
			SamplingMessageContentBlockSchema: SamplingMessageContentBlockSchema$1,
			SamplingMessageSchema: SamplingMessageSchema$1,
			ResultTypeSchema,
			ResultMetaSchema,
			ResultSchema: ResultSchema$1,
			PaginatedResultSchema: PaginatedResultSchema$1,
			CallToolResultSchema: CallToolResultSchema$1,
			ListToolsResultSchema: ListToolsResultSchema$1,
			ListPromptsResultSchema: ListPromptsResultSchema$1,
			GetPromptResultSchema: GetPromptResultSchema$1,
			ListResourcesResultSchema: ListResourcesResultSchema$1,
			ListResourceTemplatesResultSchema: ListResourceTemplatesResultSchema$1,
			ReadResourceResultSchema: ReadResourceResultSchema$1,
			CompleteResultSchema: CompleteResultSchema$1,
			CacheableResultSchema,
			DiscoverResultSchema: DiscoverResultSchema$1,
			CreateMessageRequestParamsSchema: CreateMessageRequestParamsSchema$1,
			CreateMessageRequestSchema: CreateMessageRequestSchema$1,
			ListRootsRequestSchema: ListRootsRequestSchema$1,
			CreateMessageResultSchema: CreateMessageResultSchema$1,
			ListRootsResultSchema: ListRootsResultSchema$1,
			ElicitResultSchema: ElicitResultSchema$1,
			ElicitRequestURLParamsSchema: ElicitRequestURLParamsSchema$1,
			ElicitRequestParamsSchema: ElicitRequestParamsSchema$1,
			ElicitRequestSchema: ElicitRequestSchema$1,
			InputRequestSchema,
			InputResponseSchema,
			InputRequestsSchema,
			InputResponsesSchema,
			InputRequiredResultSchema,
			InputResponseRequestParamsSchema,
			CallToolRequestSchema: CallToolRequestSchema$1,
			ListToolsRequestSchema: ListToolsRequestSchema$1,
			ListPromptsRequestSchema: ListPromptsRequestSchema$1,
			GetPromptRequestSchema: GetPromptRequestSchema$1,
			ListResourcesRequestSchema: ListResourcesRequestSchema$1,
			ListResourceTemplatesRequestSchema: ListResourceTemplatesRequestSchema$1,
			ReadResourceRequestSchema: ReadResourceRequestSchema$1,
			CompleteRequestSchema: CompleteRequestSchema$1,
			DiscoverRequestSchema: DiscoverRequestSchema$1,
			SubscriptionFilterSchema: SubscriptionFilterSchema$1,
			SubscriptionsListenRequestSchema: SubscriptionsListenRequestSchema$1,
			SubscriptionsListenResultMetaSchema: SubscriptionsListenResultMetaSchema$1,
			SubscriptionsListenResultSchema: SubscriptionsListenResultSchema$1,
			dispatchRequestSchemas,
			dispatchResultSchemas,
			NotificationMetaSchema,
			SubscriptionsAcknowledgedNotificationSchema: SubscriptionsAcknowledgedNotificationSchema$1,
			CancelledNotificationParamsSchema: CancelledNotificationParamsSchema$1,
			CancelledNotificationSchema: CancelledNotificationSchema$1,
			notificationSchemas2026,
			JSONRPCResultResponseSchema: wireResultResponse(ResultSchema$1),
			CallToolResultResponseSchema: wireResultResponse(union([CallToolResultSchema$1, InputRequiredResultSchema])),
			ListToolsResultResponseSchema: wireResultResponse(ListToolsResultSchema$1),
			ListPromptsResultResponseSchema: wireResultResponse(ListPromptsResultSchema$1),
			GetPromptResultResponseSchema: wireResultResponse(union([GetPromptResultSchema$1, InputRequiredResultSchema])),
			ListResourcesResultResponseSchema: wireResultResponse(ListResourcesResultSchema$1),
			ListResourceTemplatesResultResponseSchema: wireResultResponse(ListResourceTemplatesResultSchema$1),
			ReadResourceResultResponseSchema: wireResultResponse(union([ReadResourceResultSchema$1, InputRequiredResultSchema])),
			CompleteResultResponseSchema: wireResultResponse(CompleteResultSchema$1),
			DiscoverResultResponseSchema: wireResultResponse(DiscoverResultSchema$1)
		};
	}
	let memo;
	/**
	* Builds the era wire-schema set on first call and returns the same object
	* thereafter. Module evaluation stays construction-free so importing the
	* era codec/registry costs nothing until the first validation actually
	* needs a schema; the registry, the codec, and the eager `schemas.ts`
	* shim all pull through this memo, so reference identity holds across
	* every consumer.
	*/
	function buildSchemas2026() {
		return memo ??= build();
	}
	/**
	* The operations whose results are cacheable on the 2026-07-28 revision (the
	* `CacheableResult` extenders). This list is closed: no other operation's
	* result ever receives cache fields from the SDK.
	*/
	const CACHEABLE_RESULT_METHODS = [
		"tools/list",
		"prompts/list",
		"resources/list",
		"resources/templates/list",
		"resources/read",
		"server/discover"
	];
	/** Whether the given method's result is cacheable on the 2026-07-28 revision. */
	function isCacheableResultMethod(method) {
		return CACHEABLE_RESULT_METHODS.includes(method);
	}
	/**
	* The symbol-keyed carrier for a configured cache hint on a result object.
	* Symbol properties are invisible to JSON serialization, so the carrier can be
	* attached era-blind: only the 2026-era encode seam consumes it.
	*/
	const RESULT_CACHE_HINT_FALLBACK = Symbol("modelcontextprotocol.resultCacheHintFallback");
	/** Reads the configured cache-hint fallback attached to a result, if any. */
	function cacheHintFallbackOf(result) {
		return result[RESULT_CACHE_HINT_FALLBACK];
	}
	/**
	* Whether a value is a valid `ttlMs`: a non-negative safe integer. Safe
	* integers are required because the wire schemas validate `ttlMs` as an
	* integer within `Number.MIN_SAFE_INTEGER`/`Number.MAX_SAFE_INTEGER`; a value
	* outside that range is treated as invalid here so it falls through to the
	* next author instead of being emitted and rejected downstream.
	*/
	function isValidCacheTtlMs(value) {
		return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
	}
	/** Whether a value is a valid `cacheScope`. */
	function isValidCacheScope(value) {
		return value === "public" || value === "private";
	}
	/**
	* Error codes for protocol errors that cross the wire as JSON-RPC error responses.
	* These follow the JSON-RPC specification and MCP-specific extensions.
	*/
	let ProtocolErrorCode = /* @__PURE__ */ function(ProtocolErrorCode$1) {
		ProtocolErrorCode$1[ProtocolErrorCode$1["ParseError"] = -32700] = "ParseError";
		ProtocolErrorCode$1[ProtocolErrorCode$1["InvalidRequest"] = -32600] = "InvalidRequest";
		ProtocolErrorCode$1[ProtocolErrorCode$1["MethodNotFound"] = -32601] = "MethodNotFound";
		ProtocolErrorCode$1[ProtocolErrorCode$1["InvalidParams"] = -32602] = "InvalidParams";
		ProtocolErrorCode$1[ProtocolErrorCode$1["InternalError"] = -32603] = "InternalError";
		/**
		* Resource not found.
		*
		* Receive-tolerated only: the SDK never EMITS `-32002` — `resources/read`
		* misses answer `-32602` (Invalid Params) on every protocol revision per
		* the 2026-07-28 spec MUST, and a handler-thrown `-32002` is mapped to
		* `-32602` at the era encode seam. The member stays importable so clients
		* can recognise `-32002` from peers built on earlier SDK releases (the
		* spec's "clients SHOULD also accept `-32002`" backwards-compatibility
		* clause). Throw `ResourceNotFoundError` instead.
		*/
		ProtocolErrorCode$1[ProtocolErrorCode$1["ResourceNotFound"] = -32002] = "ResourceNotFound";
		/**
		* Processing the request requires a capability the client did not declare
		* in the request's `clientCapabilities` (protocol revision 2026-07-28).
		*/
		ProtocolErrorCode$1[ProtocolErrorCode$1["MissingRequiredClientCapability"] = -32021] = "MissingRequiredClientCapability";
		/**
		* The request's protocol version is unknown to the server or unsupported
		* by it (protocol revision 2026-07-28).
		*/
		ProtocolErrorCode$1[ProtocolErrorCode$1["UnsupportedProtocolVersion"] = -32022] = "UnsupportedProtocolVersion";
		ProtocolErrorCode$1[ProtocolErrorCode$1["UrlElicitationRequired"] = -32042] = "UrlElicitationRequired";
		return ProtocolErrorCode$1;
	}({});
	/**
	* Protocol errors are JSON-RPC errors that cross the wire as error responses.
	* They use numeric error codes from the {@linkcode ProtocolErrorCode} enum.
	*
	* `instanceof` on this class (and its subclasses) is brand-matched, so it works
	* across separately bundled copies of the SDK — e.g. an error constructed by
	* `@modelcontextprotocol/client` matches the class re-exported by
	* `@modelcontextprotocol/server` in the same process.
	*/
	var ProtocolError = class ProtocolError extends Error {
		static {
			Object.defineProperty(this, "mcpBrand", { value: "mcp.ProtocolError" });
		}
		static [Symbol.hasInstance](value) {
			return brandedHasInstance(this, value);
		}
		/**
		* Brand-based type guard: equivalent to `value instanceof this`, as an
		* explicit static predicate (the axios/AWS-SDK `isInstance` style). Reads
		* the caller's own brand via `this`, so every branded subclass gets a
		* correctly-scoped guard by inheritance. Must be invoked on the class —
		* in callback position write `v => SdkError.isInstance(v)`, not
		* `.filter(SdkError.isInstance)` (detached calls throw rather than
		* silently matching nothing).
		*/
		static isInstance(value) {
			if (typeof this !== "function") throw new TypeError("isInstance must be called on the class (e.g. `SdkError.isInstance(value)`); for callbacks use `v => SdkError.isInstance(v)`");
			return brandedHasInstance(this, value);
		}
		constructor(code, message, data) {
			super(message);
			this.code = code;
			this.data = data;
			this.name = "ProtocolError";
			stampErrorBrands(this, new.target);
		}
		/**
		* Factory method to create the appropriate error type based on the error code and data
		*/
		static fromError(code, message, data) {
			if (code === ProtocolErrorCode.UrlElicitationRequired && data) {
				const errorData = data;
				if (errorData.elicitations) return new UrlElicitationRequiredError(errorData.elicitations, message);
			}
			if (code === ProtocolErrorCode.UnsupportedProtocolVersion && data) {
				const errorData = data;
				if (Array.isArray(errorData.supported) && typeof errorData.requested === "string") return new UnsupportedProtocolVersionError({
					supported: errorData.supported,
					requested: errorData.requested
				}, message);
			}
			if (code === ProtocolErrorCode.InvalidParams || code === ProtocolErrorCode.ResourceNotFound) {
				const errorData = data;
				if (typeof errorData?.uri === "string" && (code === ProtocolErrorCode.ResourceNotFound || Object.keys(errorData).length === 1)) return new ResourceNotFoundError(errorData.uri, message);
			}
			if (code === ProtocolErrorCode.MissingRequiredClientCapability && data) {
				const errorData = data;
				if (errorData.requiredCapabilities !== null && typeof errorData.requiredCapabilities === "object" && !Array.isArray(errorData.requiredCapabilities)) return new MissingRequiredClientCapabilityError({ requiredCapabilities: errorData.requiredCapabilities }, message);
			}
			return new ProtocolError(code, message, data);
		}
	};
	/**
	* Error type for a `resources/read` miss: the requested resource does not
	* exist. The wire code is `-32602` (Invalid Params) on every protocol
	* revision — the spec MUST for revision 2026-07-28, and the value the v1.x
	* SDK has always emitted on earlier revisions. The error data echoes the
	* requested URI.
	*
	* Recognise this error by checking `error.data` is exactly `{ uri: string }`
	* (a `-32602` whose data carries `uri` and nothing else is resource-not-found;
	* any other `-32602` is an ordinary Invalid Params). For backwards compatibility, clients should also
	* accept `-32002` as resource not found — earlier SDK builds emitted that
	* code, and {@linkcode ProtocolError.fromError} reconstructs this class for
	* either code **when `error.data` carries `uri`** (a bare `-32002` without
	* `data.uri` stays a generic {@linkcode ProtocolError}). `instanceof` checks
	* are brand-matched and work across separately bundled copies of the SDK.
	*/
	var ResourceNotFoundError = class extends ProtocolError {
		static {
			Object.defineProperty(this, "mcpBrand", { value: "mcp.ResourceNotFoundError" });
		}
		constructor(uri, message = `Resource not found: ${uri}`) {
			super(ProtocolErrorCode.InvalidParams, message, { uri });
		}
		/** The URI that was requested and not found. */
		get uri() {
			return this.data.uri;
		}
	};
	/**
	* Specialized error type when a tool requires a URL mode elicitation.
	* This makes it nicer for the client to handle since there is specific data to work with instead of just a code to check against.
	*/
	var UrlElicitationRequiredError = class extends ProtocolError {
		static {
			Object.defineProperty(this, "mcpBrand", { value: "mcp.UrlElicitationRequiredError" });
		}
		constructor(elicitations, message = `URL elicitation${elicitations.length > 1 ? "s" : ""} required`) {
			super(ProtocolErrorCode.UrlElicitationRequired, message, { elicitations });
		}
		get elicitations() {
			return this.data?.elicitations ?? [];
		}
	};
	/**
	* Error type for the `-32022` UnsupportedProtocolVersion protocol error (protocol
	* revision 2026-07-28): the request's protocol version is unknown to the server or
	* unsupported by it.
	*
	* The error data lists the protocol versions the receiver supports (`supported`),
	* so the sender can choose a mutually supported version and retry, and echoes the
	* version that was requested (`requested`).
	*/
	var UnsupportedProtocolVersionError = class extends ProtocolError {
		static {
			Object.defineProperty(this, "mcpBrand", { value: "mcp.UnsupportedProtocolVersionError" });
		}
		constructor(data, message = `Unsupported protocol version: ${data.requested}`) {
			super(ProtocolErrorCode.UnsupportedProtocolVersion, message, data);
		}
		/**
		* Protocol versions the receiver supports.
		*/
		get supported() {
			return this.data.supported;
		}
		/**
		* The protocol version that was requested.
		*/
		get requested() {
			return this.data.requested;
		}
	};
	/**
	* Error type for the `-32021` MissingRequiredClientCapability protocol error
	* (protocol revision 2026-07-28): processing the request requires a capability
	* the client did not declare in the request's `clientCapabilities`.
	*
	* The error data lists the missing capabilities (`requiredCapabilities`) in
	* the `ClientCapabilities` shape, so the client can see exactly what it would
	* have to declare for the request to be served. On HTTP, the response status
	* is `400 Bad Request`.
	*
	* Recognize this error by its code and `data.requiredCapabilities`, or by
	* `instanceof` — checks are brand-matched and work across separately bundled
	* copies of the SDK.
	*/
	var MissingRequiredClientCapabilityError = class extends ProtocolError {
		static {
			Object.defineProperty(this, "mcpBrand", { value: "mcp.MissingRequiredClientCapabilityError" });
		}
		constructor(data, message = `Missing required client capabilities: ${Object.keys(data.requiredCapabilities).join(", ")}`) {
			super(ProtocolErrorCode.MissingRequiredClientCapability, message, data);
		}
		/**
		* The capabilities the server requires from the client to process the
		* request (only the missing capabilities are listed).
		*/
		get requiredCapabilities() {
			return this.data.requiredCapabilities;
		}
	};
	/** The default cache policy when neither the handler nor configuration provides one. */
	const DEFAULT_CACHE_TTL_MS = 0;
	const DEFAULT_CACHE_SCOPE = "private";
	/**
	* Request methods whose spec result vocabulary goes beyond `'complete'` on the
	* 2026-07-28 revision: their results may be `input_required` (multi
	* round-trip requests), so a handler-provided `resultType` passes through the
	* stamp untouched. `subscriptions/listen` is NOT in this set: it never emits
	* a JSON-RPC result — termination is stream close (HTTP) or
	* `notifications/cancelled` (stdio) per the spec.
	*/
	const EXTENDED_RESULT_TYPE_METHODS = [
		"tools/call",
		"prompts/get",
		"resources/read"
	];
	/**
	* Step 1 of the encode contract: ensure the outbound result carries the
	* required `resultType` discriminator.
	*
	* - No handler-provided value → stamp `'complete'`.
	* - Handler-provided `'complete'` → kept as-is.
	* - Handler-provided non-`'complete'` value on a method whose vocabulary
	*   allows it ({@linkcode EXTENDED_RESULT_TYPE_METHODS}) → passes through.
	*   The value is forwarded verbatim — the wire vocabulary is an open union and
	*   the SDK does not validate the string, so emitting a `resultType` the
	*   negotiated revision does not define is the handler author's
	*   responsibility.
	* - Handler-provided non-`'complete'` value on any other method → internal
	*   error (loud): the value would be mis-typed on the wire, and silently
	*   rewriting it would hide a server bug.
	*/
	function stampResultType(method, result) {
		const provided = result["resultType"];
		if (provided === void 0) return {
			...result,
			resultType: "complete"
		};
		if (provided === "complete") return result;
		if (EXTENDED_RESULT_TYPE_METHODS.includes(method)) return result;
		throw new ProtocolError(ProtocolErrorCode.InternalError, `Handler for ${method} returned resultType '${String(provided)}', but results of ${method} only support 'complete' on protocol revision 2026-07-28`);
	}
	/**
	* Step 2 of the encode contract: fill the required `ttlMs`/`cacheScope` fields
	* on cacheable results.
	*
	* Applies only when the (post-stamp) `resultType` is `'complete'` and the
	* method is one of the cacheable operations; everything else is returned
	* untouched apart from removing the configured-hint carrier. Field resolution
	* is per field, most specific author first: a valid handler-returned value,
	* then the configured cache hint attached by the server layer, then the
	* defaults. Handler-returned values are validated at encode time (`ttlMs`
	* must be a non-negative integer, `cacheScope` must be `'public'` or
	* `'private'`); invalid values are ignored rather than emitted.
	*/
	function fillCacheFields(method, result) {
		const fallback = cacheHintFallbackOf(result);
		if (result["resultType"] !== "complete" || !isCacheableResultMethod(method)) return fallback === void 0 ? result : stripCacheHintFallback(result);
		const provided = result;
		const ttlMs = isValidCacheTtlMs(provided["ttlMs"]) ? provided["ttlMs"] : resolveTtlMs(fallback);
		const cacheScope = isValidCacheScope(provided["cacheScope"]) ? provided["cacheScope"] : resolveCacheScope(fallback);
		const filled = {
			...provided,
			ttlMs,
			cacheScope
		};
		delete filled[RESULT_CACHE_HINT_FALLBACK];
		return filled;
	}
	function isPlainObject$3(value) {
		return value !== null && typeof value === "object" && !Array.isArray(value);
	}
	/**
	* Step 3 of the encode contract: stamp the server's identity into the
	* result's `_meta` under `io.modelcontextprotocol/serverInfo` (spec PR #3002:
	* servers SHOULD include it on every response).
	*
	* - No `serverInfo` supplied (a client instance, or a hand-constructed
	*   protocol object) → identity function.
	* - The result's `_meta` already carries the key → kept as-is (the handler
	*   is the more specific author; mirrors the cache-fill resolution order).
	* - A present-but-non-object `_meta` (a dynamic-caller bug) → kept as-is:
	*   the stamp never rewrites handler material, and the malformed value fails
	*   loudly at the peer instead of being silently replaced here.
	* - Otherwise → the key is added, preserving any other `_meta` entries.
	*
	* Runs for every result regardless of `resultType`: the anchor types
	* `Result._meta` as `ResultMetaObject` on all results, `input_required`
	* included.
	*/
	function stampServerInfoMeta(result, serverInfo) {
		if (serverInfo === void 0) return result;
		const meta = result["_meta"];
		if (meta === void 0) return {
			...result,
			_meta: { [SERVER_INFO_META_KEY]: serverInfo }
		};
		if (!isPlainObject$3(meta)) return result;
		if (meta["io.modelcontextprotocol/serverInfo"] !== void 0) return result;
		return {
			...result,
			_meta: {
				...meta,
				[SERVER_INFO_META_KEY]: serverInfo
			}
		};
	}
	function resolveTtlMs(fallback) {
		return fallback !== void 0 && isValidCacheTtlMs(fallback.ttlMs) ? fallback.ttlMs : DEFAULT_CACHE_TTL_MS;
	}
	function resolveCacheScope(fallback) {
		return fallback !== void 0 && isValidCacheScope(fallback.cacheScope) ? fallback.cacheScope : DEFAULT_CACHE_SCOPE;
	}
	function stripCacheHintFallback(result) {
		const copy = { ...result };
		delete copy[RESULT_CACHE_HINT_FALLBACK];
		return copy;
	}
	/**
	* In-band input-request vocabulary of the 2026-07-28 revision (SEP-2322
	* multi round-trip requests), dispatch view.
	*
	* The three former server→client wire requests (`elicitation/create`,
	* `sampling/createMessage`, `roots/list`) are NOT wire request methods on
	* this revision — they are demoted to de-JSON-RPC'd payloads embedded in an
	* `input_required` result. The multi-round-trip driver dispatches those
	* embedded payloads to the client's registered handlers through the normal
	* handler machinery, and these are the schemas that dispatch parses them
	* with: lenient where the anchor's wire-true artifacts are strict (an
	* embedded request never carries the per-request `_meta` envelope), exact
	* where the vocabulary forks (the sampling shapes compose the forked
	* SamplingMessage/Tool payloads).
	*
	* Registry membership is intentionally NOT granted here — these methods stay
	* absent from the 2026-era request registry (a peer sending one as a wire
	* request still gets −32601 by absence). Only the codec's
	* `inputRequestSchema`/`inputResponseSchema` accessors expose them.
	*/
	/** The embedded input-request methods of the 2026-07-28 revision. */
	const INPUT_REQUEST_METHODS_2026 = [
		"elicitation/create",
		"sampling/createMessage",
		"roots/list"
	];
	let maps;
	function inputSchemaMaps() {
		if (maps) return maps;
		const s = buildSchemas2026();
		maps = {
			request: {
				"elicitation/create": object({
					method: literal("elicitation/create"),
					params: s.ElicitRequestParamsSchema
				}),
				"sampling/createMessage": object({
					method: literal("sampling/createMessage"),
					params: s.CreateMessageRequestParamsSchema
				}),
				"roots/list": object({
					method: literal("roots/list"),
					params: looseObject({}).optional()
				})
			},
			response: {
				"elicitation/create": s.ElicitResultSchema,
				"sampling/createMessage": s.CreateMessageResultSchema,
				"roots/list": s.ListRootsResultSchema
			}
		};
		return maps;
	}
	function isInputRequestMethod2026(method) {
		return INPUT_REQUEST_METHODS_2026.includes(method);
	}
	function getInputRequestSchema2026(method) {
		return isInputRequestMethod2026(method) ? inputSchemaMaps().request[method] : void 0;
	}
	function getInputResponseSchema2026(method) {
		return isInputRequestMethod2026(method) ? inputSchemaMaps().response[method] : void 0;
	}
	const requestMethodKeys = {
		"tools/call": null,
		"tools/list": null,
		"prompts/get": null,
		"prompts/list": null,
		"resources/list": null,
		"resources/templates/list": null,
		"resources/read": null,
		"completion/complete": null,
		"server/discover": null,
		"subscriptions/listen": null
	};
	const notificationMethodKeys = {
		"notifications/cancelled": null,
		"notifications/progress": null,
		"notifications/message": null,
		"notifications/resources/updated": null,
		"notifications/resources/list_changed": null,
		"notifications/tools/list_changed": null,
		"notifications/prompts/list_changed": null,
		"notifications/subscriptions/acknowledged": null
	};
	/** The 2026-era request-method set (registry membership = the deletion story). */
	function hasRequestMethod2026(method) {
		return Object.prototype.hasOwnProperty.call(requestMethodKeys, method);
	}
	/** The 2026-era notification-method set. */
	function hasNotificationMethod2026(method) {
		return Object.prototype.hasOwnProperty.call(notificationMethodKeys, method);
	}
	/** Result-map membership (same key set as the request map on this era). */
	function hasResultMethod2026(method) {
		return Object.prototype.hasOwnProperty.call(requestMethodKeys, method);
	}
	function getRequestSchema2026(method) {
		return hasRequestMethod2026(method) ? buildSchemas2026().dispatchRequestSchemas[method] : void 0;
	}
	function getResultSchema2026(method) {
		return hasResultMethod2026(method) ? buildSchemas2026().dispatchResultSchemas[method] : void 0;
	}
	function getNotificationSchema2026(method) {
		return hasNotificationMethod2026(method) ? buildSchemas2026().notificationSchemas2026[method] : void 0;
	}
	Object.keys(requestMethodKeys);
	Object.keys(notificationMethodKeys);
	function isPlainObject$2(value) {
		return value !== null && typeof value === "object" && !Array.isArray(value);
	}
	/** Tri-state wrap of an optional Zod schema lookup (the function-only contract). */
	function triState(schema, raw) {
		if (schema === void 0) return {
			ok: false,
			reason: "not-in-era"
		};
		const parsed = schema.safeParse(raw);
		return parsed.success ? {
			ok: true,
			value: parsed.data
		} : {
			ok: false,
			reason: "invalid",
			message: String(parsed.error)
		};
	}
	const NOT_IN_ERA = {
		ok: false,
		reason: "not-in-era"
	};
	/**
	* The reserved `_meta` keys an envelope must carry on this era (in reporting
	* order). `clientInfo` is NOT here: spec PR #3002 demoted it to SHOULD, so a
	* request without it is accepted (a present-but-malformed value still fails
	* the envelope schema parse below).
	*/
	const REQUIRED_ENVELOPE_KEYS = [PROTOCOL_VERSION_META_KEY, CLIENT_CAPABILITIES_META_KEY];
	/** Strip the known deleted-field set from an outbound result (Q1-SD3 iii). */
	function enforceDeletedFields(method, result) {
		let next = result;
		let copied = false;
		const copy = () => {
			if (!copied) {
				next = { ...next };
				copied = true;
			}
			return next;
		};
		const tools = result.tools;
		if (method === "tools/list" && Array.isArray(tools) && tools.some((tool) => isPlainObject$2(tool) && "execution" in tool)) copy().tools = tools.map((tool) => {
			if (!isPlainObject$2(tool) || !("execution" in tool)) return tool;
			const rest = { ...tool };
			delete rest["execution"];
			return rest;
		});
		const capabilities = result.capabilities;
		if (isPlainObject$2(capabilities) && "tasks" in capabilities) {
			const rest = { ...capabilities };
			delete rest["tasks"];
			copy().capabilities = rest;
		}
		return next;
	}
	const rev2026Codec = {
		era: "2026-07-28",
		hasRequestMethod: hasRequestMethod2026,
		hasNotificationMethod: hasNotificationMethod2026,
		hasInputRequestMethod: (method) => getInputRequestSchema2026(method) !== void 0,
		validateRequest: (method, raw) => triState(getRequestSchema2026(method), raw),
		validateResult: (method, raw) => triState(getResultSchema2026(method), raw),
		validateNotification: (method, raw) => triState(getNotificationSchema2026(method), raw),
		validateInputRequest: (method, raw) => triState(getInputRequestSchema2026(method), raw),
		validateInputResponse: (method, raw) => triState(getInputResponseSchema2026(method), raw),
		samplingResultVariant: () => NOT_IN_ERA,
		outboundEnvelope(material) {
			return {
				[PROTOCOL_VERSION_META_KEY]: material.protocolVersion,
				[CLIENT_INFO_META_KEY]: material.clientInfo,
				[CLIENT_CAPABILITIES_META_KEY]: material.clientCapabilities,
				...material.logLevel !== void 0 && { ["io.modelcontextprotocol/logLevel"]: material.logLevel }
			};
		},
		validateEnvelopeMeta(meta) {
			const issues = [];
			for (const key of REQUIRED_ENVELOPE_KEYS) if (!(key in meta)) issues.push({
				key,
				problem: "missing"
			});
			const parsed = buildSchemas2026().RequestMetaEnvelopeSchema.safeParse(meta);
			if (!parsed.success) for (const issue of parsed.error.issues) {
				const path = issue.path.map(String);
				const key = path.length > 0 ? path.join(".") : "_meta";
				if (path.length === 1 && issues.some((existing) => existing.key === key && existing.problem === "missing")) continue;
				issues.push({
					key,
					problem: issue.message
				});
			}
			return issues;
		},
		projectCallToolResult: (result) => appendTextFallbackForNonObject(result),
		inputRequestSchema: getInputRequestSchema2026,
		decodeResult(method, raw) {
			if (!isPlainObject$2(raw)) return {
				kind: "invalid",
				error: new SdkError(SdkErrorCode.InvalidResult, `Invalid result for ${method}: not an object`, { method })
			};
			const rawResultType = raw["resultType"];
			if (rawResultType === void 0) return {
				kind: "invalid",
				error: new SdkError(SdkErrorCode.InvalidResult, `Invalid result for ${method}: missing required resultType — servers implementing protocol revision 2026-07-28 MUST include it (the absent-means-complete bridge applies only to earlier-revision servers)`, {
					method,
					violation: "missing-resultType"
				})
			};
			if (typeof rawResultType !== "string") return {
				kind: "invalid",
				error: new SdkError(SdkErrorCode.InvalidResult, `Invalid result for ${method}: non-string resultType`, {
					method,
					resultType: rawResultType
				})
			};
			if (rawResultType === "input_required") {
				const rawInputRequests = raw["inputRequests"];
				const inputRequests = isPlainObject$2(rawInputRequests) ? rawInputRequests : {};
				const requestState = raw["requestState"];
				if (Object.keys(inputRequests).length === 0 && typeof requestState !== "string") return {
					kind: "invalid",
					error: new SdkError(SdkErrorCode.InvalidResult, `Invalid result for ${method}: input_required carries neither inputRequests nor requestState (every input_required result must include at least one of the two)`, {
						method,
						violation: "input-required-missing-both"
					})
				};
				return {
					kind: "input_required",
					inputRequests,
					...typeof requestState === "string" && { requestState }
				};
			}
			if (rawResultType !== "complete") return {
				kind: "invalid",
				error: new SdkError(SdkErrorCode.UnsupportedResultType, `Unsupported result type '${rawResultType}' for ${method}`, {
					resultType: rawResultType,
					method
				})
			};
			const wireResultSchemas = getWireResultSchemas();
			const wireSchema = Object.hasOwn(wireResultSchemas, method) ? wireResultSchemas[method] : void 0;
			if (wireSchema !== void 0) {
				const parsed = wireSchema.safeParse(raw);
				if (!parsed.success) return {
					kind: "invalid",
					error: new SdkError(SdkErrorCode.InvalidResult, `Invalid result for ${method}: ${parsed.error}`, { method })
				};
			}
			const lifted = { ...raw };
			delete lifted["resultType"];
			return {
				kind: "complete",
				result: lifted
			};
		},
		encodeResult(method, result, serverInfo) {
			return stampServerInfoMeta(fillCacheFields(method, stampResultType(method, enforceDeletedFields(method, result))), serverInfo);
		},
		encodeErrorCode: (code) => code === -32002 ? -32602 : code,
		checkInboundEnvelope(material) {
			if (material.envelope === void 0) return "Request is missing the required _meta envelope for protocol revision 2026-07-28 (io.modelcontextprotocol/protocolVersion, io.modelcontextprotocol/clientCapabilities)";
			const parsed = buildSchemas2026().RequestMetaEnvelopeSchema.safeParse(material.envelope);
			if (!parsed.success) return `Invalid _meta envelope for protocol revision 2026-07-28: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`;
		}
	};
	/** Wire-true result wrappers consulted by decode step 2, keyed by method —
	* built once through the era's schema memo on the first decode. */
	let wireResultSchemasMemo;
	function getWireResultSchemas() {
		if (wireResultSchemasMemo) return wireResultSchemasMemo;
		const s = buildSchemas2026();
		wireResultSchemasMemo = {
			"tools/call": s.CallToolResultSchema,
			"tools/list": s.ListToolsResultSchema,
			"prompts/get": s.GetPromptResultSchema,
			"prompts/list": s.ListPromptsResultSchema,
			"resources/list": s.ListResourcesResultSchema,
			"resources/templates/list": s.ListResourceTemplatesResultSchema,
			"resources/read": s.ReadResourceResultSchema,
			"completion/complete": s.CompleteResultSchema,
			"server/discover": s.DiscoverResultSchema
		};
		return wireResultSchemasMemo;
	}
	/**
	* The modern wire revision literal. Internal only — deliberately NOT a public
	* constant (G-D2-4: no public modern-version constant ships before era-aware
	* list semantics exist).
	*/
	const MODERN_WIRE_REVISION = "2026-07-28";
	/**
	* Era resolution, many-to-one (Q1-SD1): every modern-era revision
	* (`>= 2026-07-28`) → the 2026-era codec; every legacy revision (the five
	* `SUPPORTED_PROTOCOL_VERSIONS`) and `undefined`/unknown → the 2025-era
	* codec (the DV-13 default posture — hand-constructed instances and
	* unclassified traffic are legacy-era). This is the same era predicate the
	* rest of the SDK uses ({@link isModernProtocolVersion}); a pinned modern
	* revision other than the literal '2026-07-28' must still resolve modern.
	*/
	function codecForVersion(version) {
		return version !== void 0 && isModernProtocolVersion(version) ? rev2026Codec : rev2025Codec;
	}
	/**
	* The wire era an edge classification names (Q2 — produced at the
	* transport/entry edge; this layer only CONSUMES it). The dispatch funnel no
	* longer resolves a codec FROM the classification: era is instance state, and
	* a classified inbound message is VALIDATED against the instance era — a
	* mismatch is an entry/routing error, never a per-message era switch. The
	* exact `revision` wins over the coarse era flag when both are present.
	*/
	function classifiedWireEra(classification) {
		if (classification.revision !== void 0) return codecForVersion(classification.revision).era;
		return classification.era === "modern" ? rev2026Codec.era : rev2025Codec.era;
	}
	/**
	* The derived spec-method universe: the union of every codec registry. A
	* method in this set is era-gated at dispatch and send time; a method outside
	* it is a consumer-owned extension method (era-blind, schema-explicit).
	* Derived from the registries — never hand-curated (the LEGACY_ONLY_METHODS
	* table class is exactly what registry membership replaces).
	*/
	function isSpecRequestMethod(method) {
		return ALL_CODECS.some((codec) => codec.hasRequestMethod(method));
	}
	function isSpecNotificationMethod(method) {
		return ALL_CODECS.some((codec) => codec.hasNotificationMethod(method));
	}
	const ALL_CODECS = [rev2025Codec, rev2026Codec];
	var schemas_exports = /* @__PURE__ */ __exportAll({
		AnnotationsSchema: () => AnnotationsSchema,
		AudioContentSchema: () => AudioContentSchema,
		BaseMetadataSchema: () => BaseMetadataSchema,
		BaseRequestParamsSchema: () => BaseRequestParamsSchema,
		BlobResourceContentsSchema: () => BlobResourceContentsSchema,
		BooleanSchemaSchema: () => BooleanSchemaSchema,
		CallToolRequestParamsSchema: () => CallToolRequestParamsSchema,
		CallToolRequestSchema: () => CallToolRequestSchema,
		CallToolResultSchema: () => CallToolResultSchema,
		CancelTaskRequestSchema: () => CancelTaskRequestSchema,
		CancelTaskResultSchema: () => CancelTaskResultSchema,
		CancelledNotificationParamsSchema: () => CancelledNotificationParamsSchema,
		CancelledNotificationSchema: () => CancelledNotificationSchema,
		ClientCapabilitiesSchema: () => ClientCapabilitiesSchema,
		ClientNotificationSchema: () => ClientNotificationSchema,
		ClientRequestSchema: () => ClientRequestSchema,
		ClientResultSchema: () => ClientResultSchema,
		ClientTasksCapabilitySchema: () => ClientTasksCapabilitySchema,
		CompatibilityCallToolResultSchema: () => CompatibilityCallToolResultSchema,
		CompleteRequestParamsSchema: () => CompleteRequestParamsSchema,
		CompleteRequestSchema: () => CompleteRequestSchema,
		CompleteResultSchema: () => CompleteResultSchema,
		ContentBlockSchema: () => ContentBlockSchema,
		CreateMessageRequestParamsSchema: () => CreateMessageRequestParamsSchema,
		CreateMessageRequestSchema: () => CreateMessageRequestSchema,
		CreateMessageResultSchema: () => CreateMessageResultSchema,
		CreateMessageResultWithToolsSchema: () => CreateMessageResultWithToolsSchema,
		CreateTaskResultSchema: () => CreateTaskResultSchema,
		CursorSchema: () => CursorSchema,
		DiscoverRequestSchema: () => DiscoverRequestSchema,
		DiscoverResultSchema: () => DiscoverResultSchema,
		ElicitRequestFormParamsSchema: () => ElicitRequestFormParamsSchema,
		ElicitRequestParamsSchema: () => ElicitRequestParamsSchema,
		ElicitRequestSchema: () => ElicitRequestSchema,
		ElicitRequestURLParamsSchema: () => ElicitRequestURLParamsSchema,
		ElicitResultSchema: () => ElicitResultSchema,
		ElicitationCompleteNotificationParamsSchema: () => ElicitationCompleteNotificationParamsSchema,
		ElicitationCompleteNotificationSchema: () => ElicitationCompleteNotificationSchema,
		EmbeddedResourceSchema: () => EmbeddedResourceSchema,
		EmptyResultSchema: () => EmptyResultSchema,
		EnumSchemaSchema: () => EnumSchemaSchema,
		GetPromptRequestParamsSchema: () => GetPromptRequestParamsSchema,
		GetPromptRequestSchema: () => GetPromptRequestSchema,
		GetPromptResultSchema: () => GetPromptResultSchema,
		GetTaskPayloadRequestSchema: () => GetTaskPayloadRequestSchema,
		GetTaskPayloadResultSchema: () => GetTaskPayloadResultSchema,
		GetTaskRequestSchema: () => GetTaskRequestSchema,
		GetTaskResultSchema: () => GetTaskResultSchema,
		IconSchema: () => IconSchema,
		IconsSchema: () => IconsSchema,
		ImageContentSchema: () => ImageContentSchema,
		ImplementationSchema: () => ImplementationSchema,
		InitializeRequestParamsSchema: () => InitializeRequestParamsSchema,
		InitializeRequestSchema: () => InitializeRequestSchema,
		InitializeResultSchema: () => InitializeResultSchema,
		InitializedNotificationSchema: () => InitializedNotificationSchema,
		JSONArraySchema: () => JSONArraySchema,
		JSONObjectSchema: () => JSONObjectSchema,
		JSONRPCErrorResponseSchema: () => JSONRPCErrorResponseSchema,
		JSONRPCMessageSchema: () => JSONRPCMessageSchema,
		JSONRPCNotificationSchema: () => JSONRPCNotificationSchema,
		JSONRPCRequestSchema: () => JSONRPCRequestSchema,
		JSONRPCResponseSchema: () => JSONRPCResponseSchema,
		JSONRPCResultResponseSchema: () => JSONRPCResultResponseSchema,
		JSONValueSchema: () => JSONValueSchema,
		LegacyTitledEnumSchemaSchema: () => LegacyTitledEnumSchemaSchema,
		ListChangedOptionsBaseSchema: () => ListChangedOptionsBaseSchema,
		ListPromptsRequestSchema: () => ListPromptsRequestSchema,
		ListPromptsResultSchema: () => ListPromptsResultSchema,
		ListResourceTemplatesRequestSchema: () => ListResourceTemplatesRequestSchema,
		ListResourceTemplatesResultSchema: () => ListResourceTemplatesResultSchema,
		ListResourcesRequestSchema: () => ListResourcesRequestSchema,
		ListResourcesResultSchema: () => ListResourcesResultSchema,
		ListRootsRequestSchema: () => ListRootsRequestSchema,
		ListRootsResultSchema: () => ListRootsResultSchema,
		ListTasksRequestSchema: () => ListTasksRequestSchema,
		ListTasksResultSchema: () => ListTasksResultSchema,
		ListToolsRequestSchema: () => ListToolsRequestSchema,
		ListToolsResultSchema: () => ListToolsResultSchema,
		LoggingLevelSchema: () => LoggingLevelSchema,
		LoggingMessageNotificationParamsSchema: () => LoggingMessageNotificationParamsSchema,
		LoggingMessageNotificationSchema: () => LoggingMessageNotificationSchema,
		ModelHintSchema: () => ModelHintSchema,
		ModelPreferencesSchema: () => ModelPreferencesSchema,
		MultiSelectEnumSchemaSchema: () => MultiSelectEnumSchemaSchema,
		NotificationSchema: () => NotificationSchema,
		NotificationsParamsSchema: () => NotificationsParamsSchema,
		NumberSchemaSchema: () => NumberSchemaSchema,
		PaginatedRequestParamsSchema: () => PaginatedRequestParamsSchema,
		PaginatedRequestSchema: () => PaginatedRequestSchema,
		PaginatedResultSchema: () => PaginatedResultSchema,
		PingRequestSchema: () => PingRequestSchema,
		PrimitiveSchemaDefinitionSchema: () => PrimitiveSchemaDefinitionSchema,
		ProgressNotificationParamsSchema: () => ProgressNotificationParamsSchema,
		ProgressNotificationSchema: () => ProgressNotificationSchema,
		ProgressSchema: () => ProgressSchema,
		ProgressTokenSchema: () => ProgressTokenSchema,
		PromptArgumentSchema: () => PromptArgumentSchema,
		PromptListChangedNotificationSchema: () => PromptListChangedNotificationSchema,
		PromptMessageSchema: () => PromptMessageSchema,
		PromptReferenceSchema: () => PromptReferenceSchema,
		PromptSchema: () => PromptSchema,
		ReadResourceRequestParamsSchema: () => ReadResourceRequestParamsSchema,
		ReadResourceRequestSchema: () => ReadResourceRequestSchema,
		ReadResourceResultSchema: () => ReadResourceResultSchema,
		RelatedTaskMetadataSchema: () => RelatedTaskMetadataSchema,
		RequestIdSchema: () => RequestIdSchema,
		RequestMetaSchema: () => RequestMetaSchema,
		RequestSchema: () => RequestSchema,
		ResourceContentsSchema: () => ResourceContentsSchema,
		ResourceLinkSchema: () => ResourceLinkSchema,
		ResourceListChangedNotificationSchema: () => ResourceListChangedNotificationSchema,
		ResourceRequestParamsSchema: () => ResourceRequestParamsSchema,
		ResourceSchema: () => ResourceSchema,
		ResourceTemplateReferenceSchema: () => ResourceTemplateReferenceSchema,
		ResourceTemplateSchema: () => ResourceTemplateSchema,
		ResourceUpdatedNotificationParamsSchema: () => ResourceUpdatedNotificationParamsSchema,
		ResourceUpdatedNotificationSchema: () => ResourceUpdatedNotificationSchema,
		ResultMetaObjectSchema: () => ResultMetaObjectSchema,
		ResultSchema: () => ResultSchema,
		RoleSchema: () => RoleSchema,
		RootSchema: () => RootSchema,
		RootsListChangedNotificationSchema: () => RootsListChangedNotificationSchema,
		SamplingContentSchema: () => SamplingContentSchema,
		SamplingMessageContentBlockSchema: () => SamplingMessageContentBlockSchema,
		SamplingMessageSchema: () => SamplingMessageSchema,
		ServerCapabilitiesSchema: () => ServerCapabilitiesSchema,
		ServerNotificationSchema: () => ServerNotificationSchema,
		ServerRequestSchema: () => ServerRequestSchema,
		ServerResultSchema: () => ServerResultSchema,
		ServerTasksCapabilitySchema: () => ServerTasksCapabilitySchema,
		SetLevelRequestParamsSchema: () => SetLevelRequestParamsSchema,
		SetLevelRequestSchema: () => SetLevelRequestSchema,
		SingleSelectEnumSchemaSchema: () => SingleSelectEnumSchemaSchema,
		StringSchemaSchema: () => StringSchemaSchema,
		SubscribeRequestParamsSchema: () => SubscribeRequestParamsSchema,
		SubscribeRequestSchema: () => SubscribeRequestSchema,
		SubscriptionFilterSchema: () => SubscriptionFilterSchema,
		SubscriptionsAcknowledgedNotificationParamsSchema: () => SubscriptionsAcknowledgedNotificationParamsSchema,
		SubscriptionsAcknowledgedNotificationSchema: () => SubscriptionsAcknowledgedNotificationSchema,
		SubscriptionsListenRequestParamsSchema: () => SubscriptionsListenRequestParamsSchema,
		SubscriptionsListenRequestSchema: () => SubscriptionsListenRequestSchema,
		SubscriptionsListenResultMetaSchema: () => SubscriptionsListenResultMetaSchema,
		SubscriptionsListenResultSchema: () => SubscriptionsListenResultSchema,
		TaskAugmentedRequestParamsSchema: () => TaskAugmentedRequestParamsSchema,
		TaskCreationParamsSchema: () => TaskCreationParamsSchema,
		TaskMetadataSchema: () => TaskMetadataSchema,
		TaskSchema: () => TaskSchema,
		TaskStatusNotificationParamsSchema: () => TaskStatusNotificationParamsSchema,
		TaskStatusNotificationSchema: () => TaskStatusNotificationSchema,
		TaskStatusSchema: () => TaskStatusSchema,
		TextContentSchema: () => TextContentSchema,
		TextResourceContentsSchema: () => TextResourceContentsSchema,
		TitledMultiSelectEnumSchemaSchema: () => TitledMultiSelectEnumSchemaSchema,
		TitledSingleSelectEnumSchemaSchema: () => TitledSingleSelectEnumSchemaSchema,
		ToolAnnotationsSchema: () => ToolAnnotationsSchema,
		ToolChoiceSchema: () => ToolChoiceSchema,
		ToolExecutionSchema: () => ToolExecutionSchema,
		ToolListChangedNotificationSchema: () => ToolListChangedNotificationSchema,
		ToolResultContentSchema: () => ToolResultContentSchema,
		ToolSchema: () => ToolSchema,
		ToolUseContentSchema: () => ToolUseContentSchema,
		UnsubscribeRequestParamsSchema: () => UnsubscribeRequestParamsSchema,
		UnsubscribeRequestSchema: () => UnsubscribeRequestSchema,
		UntitledMultiSelectEnumSchemaSchema: () => UntitledMultiSelectEnumSchemaSchema,
		UntitledSingleSelectEnumSchemaSchema: () => UntitledSingleSelectEnumSchemaSchema
	});
	const isJSONRPCRequest = (value) => JSONRPCRequestSchema.safeParse(value).success;
	const isJSONRPCNotification = (value) => JSONRPCNotificationSchema.safeParse(value).success;
	/**
	* Checks if a value is a valid {@linkcode JSONRPCResultResponse}.
	* @param value - The value to check.
	*
	* @returns True if the value is a valid {@linkcode JSONRPCResultResponse}, false otherwise.
	*/
	const isJSONRPCResultResponse = (value) => JSONRPCResultResponseSchema.safeParse(value).success;
	/**
	* Checks if a value is a valid {@linkcode JSONRPCErrorResponse}.
	* @param value - The value to check.
	*
	* @returns True if the value is a valid {@linkcode JSONRPCErrorResponse}, false otherwise.
	*/
	const isJSONRPCErrorResponse = (value) => JSONRPCErrorResponseSchema.safeParse(value).success;
	/**
	* Checks whether a value is an input-required result (protocol revision
	* 2026-07-28): the multi-round-trip return shape discriminated by
	* `resultType: 'input_required'`.
	*
	* This is a discriminator check, not a full validator — the at-least-one rule
	* (`inputRequests` or `requestState`) is enforced by the `inputRequired()`
	* builder and re-checked by the server seam for hand-built values.
	*
	* @param value - The value to check.
	* @returns True if the value carries the `input_required` discriminator.
	*/
	const isInputRequiredResult = (value) => typeof value === "object" && value !== null && !Array.isArray(value) && value.resultType === "input_required";
	const isInitializeRequest = (value) => InitializeRequestSchema.safeParse(value).success;
	const isInitializedNotification = (value) => InitializedNotificationSchema.safeParse(value).success;
	/** The fixed prefix every custom-parameter header carries. */
	const MCP_PARAM_HEADER_PREFIX = "Mcp-Param-";
	/** The schema-extension property name a tool's `inputSchema` carries. */
	const X_MCP_HEADER_KEY = "x-mcp-header";
	/**
	* RFC 9110 §5.1 `token` syntax (`1*tchar`). Rejects empty, space, control
	* characters (including CR/LF), and the listed delimiters.
	*/
	const RFC9110_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
	/**
	* JSON Schema `type` values the spec admits on an `x-mcp-header` property.
	*
	* The spec text names `integer`, `string`, `boolean` and explicitly excludes
	* `number`. The published conformance referee at the pinned release ships its
	* `http-custom-headers` scenario with two `type: "number"` `x-mcp-header`
	* parameters and expects the client to mirror them, so `number` is accepted
	* here so that the conformance gate passes; the discrepancy is tracked
	* upstream. Everything else (`object`, `array`, `null`, absent) is rejected.
	*/
	const PERMITTED_X_MCP_HEADER_TYPES = /* @__PURE__ */ new Set([
		"string",
		"integer",
		"boolean",
		"number"
	]);
	/**
	* Scan a tool's JSON-serialized `inputSchema` for `x-mcp-header` declarations
	* and validate every constraint the spec places on them. Returns either the
	* collected declarations (possibly empty) or the first violated constraint.
	*
	* The walk descends through `properties` at any depth (the spec's "any nesting
	* depth" clause). The static-reachability MUST is enforced as a structural
	* sweep: every position the chain MUST NOT pass through (`items`/
	* `additionalProperties`, `oneOf`/`anyOf`/`allOf`/`not`, `if`/`then`/`else`,
	* `$defs`, `$ref` targets within `$defs`) is visited too, and an
	* `x-mcp-header` found anywhere on that path invalidates the schema — "an
	* annotation anywhere else makes the tool definition invalid".
	*/
	function scanXMcpHeaderDeclarations(inputSchema) {
		const declarations = [];
		const seenLower = /* @__PURE__ */ new Map();
		const visit = (node, path, reachable) => {
			if (node === null || typeof node !== "object") return void 0;
			const schema = node;
			if (X_MCP_HEADER_KEY in schema) {
				if (!reachable || path.length === 0) return `${pathName(path)}: x-mcp-header is only permitted on properties statically reachable via a chain of 'properties' keys (not under items, additionalProperties, oneOf/anyOf/allOf/not, if/then/else, or $ref)`;
				const raw = schema[X_MCP_HEADER_KEY];
				if (typeof raw !== "string" || raw.length === 0) return `${pathName(path)}: x-mcp-header MUST be a non-empty string`;
				if (!RFC9110_TOKEN.test(raw)) return `${pathName(path)}: x-mcp-header '${raw}' is not a valid RFC 9110 token (no spaces, control characters or HTTP delimiters)`;
				const type = typeof schema.type === "string" ? schema.type : void 0;
				if (type === void 0 || !PERMITTED_X_MCP_HEADER_TYPES.has(type)) return `${pathName(path)}: x-mcp-header is only permitted on primitive-typed properties (string, integer, boolean); got ${type ?? "<none>"}`;
				const lower = raw.toLowerCase();
				const prior = seenLower.get(lower);
				if (prior !== void 0) return `x-mcp-header '${raw}' is not case-insensitively unique (also declared as '${prior}')`;
				seenLower.set(lower, raw);
				declarations.push({
					path,
					headerName: raw,
					type
				});
			}
			const properties = schema.properties;
			if (properties !== null && typeof properties === "object") for (const [key, child] of Object.entries(properties)) {
				const fault$1 = visit(child, [...path, key], reachable);
				if (fault$1 !== void 0) return fault$1;
			}
			for (const k of NON_REACHABLE_SUBSCHEMA_KEYWORDS) {
				const sub = schema[k];
				if (sub === void 0) continue;
				const branches = Array.isArray(sub) ? sub : sub !== null && typeof sub === "object" && OBJECT_VALUED_SUBSCHEMA_KEYWORDS.has(k) ? Object.values(sub) : [sub];
				for (const branch of branches) {
					const fault$1 = visit(branch, [...path, `<${k}>`], false);
					if (fault$1 !== void 0) return fault$1;
				}
			}
		};
		const fault = visit(inputSchema, [], true);
		return fault === void 0 ? {
			valid: true,
			declarations
		} : {
			valid: false,
			reason: fault
		};
	}
	/**
	* JSON Schema keywords whose subschemas the SEP-2243 static-reachability
	* constraint excludes from the `properties`-only chain. An `x-mcp-header`
	* found under any of these invalidates the tool definition.
	*/
	const NON_REACHABLE_SUBSCHEMA_KEYWORDS = [
		"items",
		"prefixItems",
		"contains",
		"additionalProperties",
		"unevaluatedProperties",
		"unevaluatedItems",
		"propertyNames",
		"patternProperties",
		"dependentSchemas",
		"oneOf",
		"anyOf",
		"allOf",
		"not",
		"if",
		"then",
		"else",
		"$defs",
		"definitions"
	];
	/**
	* Subschema-carrying keywords whose value is a `name → subschema` object
	* (not a single subschema or array of subschemas). The visit branches over
	* `Object.values()` for these.
	*/
	const OBJECT_VALUED_SUBSCHEMA_KEYWORDS = /* @__PURE__ */ new Set([
		"patternProperties",
		"dependentSchemas",
		"$defs",
		"definitions"
	]);
	function pathName(path) {
		return path.length === 0 ? "<root>" : path.join(".");
	}
	const BASE64_SENTINEL_PREFIX = "=?base64?";
	const BASE64_SENTINEL_SUFFIX = "?=";
	/**
	* Convert a primitive argument value to its string representation per the
	* spec's type-conversion rules: strings pass through, integers and numbers
	* become their decimal string, booleans become lowercase `'true'` / `'false'`.
	* Non-finite numbers and integers outside the safe range are refused (the
	* caller treats `undefined` as "do not emit a header for this value").
	*/
	function mcpParamPrimitiveToString(value) {
		if (typeof value === "string") return value;
		if (typeof value === "boolean") return value ? "true" : "false";
		if (typeof value === "number") {
			if (!Number.isFinite(value)) return void 0;
			if (Number.isInteger(value) && !Number.isSafeInteger(value)) return void 0;
			return String(value);
		}
	}
	/**
	* `true` when `s` cannot be safely represented as a plain ASCII HTTP field
	* value per RFC 9110 §5.5: it contains a byte outside `0x20–0x7E` / `0x09`, it
	* has leading or trailing whitespace (which field parsing strips), or it
	* already matches the Base64 sentinel pattern (the spec's "to avoid ambiguity"
	* rule).
	*/
	function needsBase64(s) {
		if (s.length === 0) return true;
		if (s.startsWith(BASE64_SENTINEL_PREFIX) && s.endsWith(BASE64_SENTINEL_SUFFIX)) return true;
		if (s !== s.trim()) return true;
		for (let i = 0; i < s.length; i++) {
			const c = s.codePointAt(i);
			if (c === 9 || c >= 32 && c <= 126) continue;
			return true;
		}
		return false;
	}
	function utf8ToBase64(s) {
		const bytes = new TextEncoder().encode(s);
		let bin = "";
		for (const b of bytes) bin += String.fromCodePoint(b);
		return btoa(bin);
	}
	/**
	* Encode a string value as an HTTP field value per the spec's value-encoding
	* rules: a value that is already a safe plain-ASCII field value is passed
	* through unchanged; anything else is wrapped as `=?base64?{b64-of-utf8}?=`.
	*/
	function encodeMcpParamValue(value) {
		return needsBase64(value) ? `${BASE64_SENTINEL_PREFIX}${utf8ToBase64(value)}${BASE64_SENTINEL_SUFFIX}` : value;
	}
	function valueAtPath(root, path) {
		let node = root;
		for (const key of path) {
			if (node === null || typeof node !== "object") return void 0;
			node = node[key];
		}
		return node;
	}
	/**
	* Build the `Mcp-Param-{Name}` headers for one `tools/call` from a scan of the
	* tool's `inputSchema` and the call's `arguments`. A declaration whose value is
	* `null` or absent in `arguments` is omitted (the spec's "client MUST omit the
	* header" rows); a value that is not a primitive of the declared kind is
	* omitted rather than emitted malformed.
	*/
	function buildMcpParamHeaders(declarations, args) {
		const out = {};
		for (const decl of declarations) {
			const raw = valueAtPath(args, decl.path);
			if (raw === void 0 || raw === null) continue;
			const stringValue = mcpParamPrimitiveToString(raw);
			if (stringValue === void 0) continue;
			out[`${MCP_PARAM_HEADER_PREFIX}${decl.headerName}`] = encodeMcpParamValue(stringValue);
		}
		return out;
	}
	ProtocolErrorCode.InvalidRequest, ProtocolErrorCode.UnsupportedProtocolVersion, ProtocolErrorCode.InvalidParams, ProtocolErrorCode.MethodNotFound, ProtocolErrorCode.InvalidParams, ProtocolErrorCode.MissingRequiredClientCapability;
	ProtocolErrorCode.ParseError, ProtocolErrorCode.InvalidRequest, ProtocolErrorCode.MethodNotFound, ProtocolErrorCode.UnsupportedProtocolVersion, ProtocolErrorCode.MissingRequiredClientCapability;
	/**
	* Internal Zod schema utilities for protocol handling.
	* These are used internally by the SDK for protocol message validation.
	*/
	/**
	* Parses data against a Zod schema (synchronous).
	* Returns a discriminated union with success/error.
	*/
	function parseSchema(schema, data) {
		return safeParse(schema, data);
	}
	/**
	* Union of the declared shape keys across several Zod object schemas.
	*/
	function shapeKeys(schemas) {
		return new Set(schemas.flatMap((schema) => Object.keys(schema.shape)));
	}
	/**
	* Standard Schema utilities for user-provided schemas.
	* Supports Zod v4, Valibot, ArkType, and other Standard Schema implementations.
	* @see https://standardschema.dev
	*/
	function isStandardSchema(schema) {
		if (schema == null) return false;
		const schemaType = typeof schema;
		if (schemaType !== "object" && schemaType !== "function") return false;
		if (!("~standard" in schema)) return false;
		return typeof schema["~standard"]?.validate === "function";
	}
	let warnedZodFallback = false;
	/** JSON Schema draft targeted by every conversion; shared so pattern references above stay in lockstep. */
	const JSON_SCHEMA_CONVERSION_TARGET = "draft-2020-12";
	/**
	* Converts a StandardSchema to JSON Schema for use as an MCP tool/prompt schema.
	*
	* MCP requires `type: "object"` at the root of tool `inputSchema` and prompt
	* argument schemas; `outputSchema` may have any JSON Schema root (SEP-2106).
	* Zod's discriminated unions emit `{oneOf: [...]}` without a top-level `type`,
	* so for `io: 'input'` this function defaults `type` to `"object"` when absent
	* and throws on an explicit non-object `type` (e.g. `z.string()`). For
	* `io: 'output'` a non-object root is returned as-is; the `"object"` default is
	* applied only when the root is provably object-shaped.
	*/
	function standardSchemaToJsonSchema(schema, io = "input") {
		const std = schema["~standard"];
		let result;
		if (std.jsonSchema) result = std.jsonSchema[io]({ target: JSON_SCHEMA_CONVERSION_TARGET });
		else if (std.vendor === "zod") {
			if (!("_zod" in schema)) throw new Error("Schema appears to be from zod 3, which the SDK cannot convert to JSON Schema. Upgrade to zod >=4.2.0, or wrap your JSON Schema with fromJsonSchema().");
			if (!warnedZodFallback) {
				warnedZodFallback = true;
				console.warn("[mcp-sdk] Your zod version does not implement `~standard.jsonSchema` (added in zod 4.2.0). Falling back to z.toJSONSchema(). Upgrade to zod >=4.2.0 to silence this warning.");
			}
			result = toJSONSchema(schema, {
				target: JSON_SCHEMA_CONVERSION_TARGET,
				io
			});
		} else throw new Error(`Schema library "${std.vendor}" does not implement StandardJSONSchemaV1 (\`~standard.jsonSchema\`). Upgrade to a version that does, or wrap your JSON Schema with fromJsonSchema().`);
		if (io === "output") {
			if (result.type !== void 0) return result;
			return isProvablyObjectShapedRoot(result) ? {
				type: "object",
				...result
			} : result;
		}
		if (result.type !== void 0 && result.type !== "object") throw new Error(`MCP tool and prompt schemas must describe objects (got type: ${JSON.stringify(result.type)}). Wrap your schema in z.object({...}) or equivalent.`);
		return {
			type: "object",
			...result
		};
	}
	/**
	* A typeless JSON Schema root is "provably object-shaped" when either it carries object keywords
	* directly (`properties`/`patternProperties`/`additionalProperties`/`required`), or it is a
	* composition (`oneOf`/`anyOf`/`allOf`) whose every member is itself `type:'object'` or recursively
	* provably object-shaped (e.g. a nested `discriminatedUnion`). `$ref` is not followed. Used to
	* decide whether stamping `type:'object'` is safe (redundant-but-valid) versus self-contradictory.
	*/
	function isProvablyObjectShapedRoot(schema) {
		if ("properties" in schema || "patternProperties" in schema || "additionalProperties" in schema || "required" in schema) return true;
		for (const key of [
			"oneOf",
			"anyOf",
			"allOf"
		]) {
			const members = schema[key];
			if (Array.isArray(members) && members.length > 0) return members.every((m) => m !== null && typeof m === "object" && (m.type === "object" || isProvablyObjectShapedRoot(m)));
		}
		return false;
	}
	function formatIssue(issue) {
		if (!issue.path?.length) return issue.message;
		return `${issue.path.map((p) => String(typeof p === "object" ? p.key : p)).join(".")}: ${issue.message}`;
	}
	async function validateStandardSchema(schema, data) {
		const result = await schema["~standard"].validate(data);
		if (result.issues && result.issues.length > 0) return {
			success: false,
			error: result.issues.map((i) => formatIssue(i)).join(", ")
		};
		return {
			success: true,
			data: result.value
		};
	}
	function zodEmittedPattern(schema) {
		const jsonSchema = toJSONSchema(schema, {
			target: JSON_SCHEMA_CONVERSION_TARGET,
			io: "input"
		});
		return typeof jsonSchema.pattern === "string" ? jsonSchema.pattern : void 0;
	}
	const DATETIME_FRACTION_DIGITS = /\\\.\\d\{(\d+)\}/;
	function datetimeReferenceSchemas(pattern) {
		const fractionDigits = DATETIME_FRACTION_DIGITS.exec(pattern);
		const precisions = [
			void 0,
			-1,
			0
		];
		if (fractionDigits) precisions.push(Number(fractionDigits[1]));
		return [false, true].flatMap((local) => [false, true].flatMap((offset) => precisions.map((precision) => datetime({
			local,
			offset,
			precision
		}))));
	}
	function referencePatternsForFormat(format, pattern) {
		let referenceSchemas;
		switch (format) {
			case "email":
				referenceSchemas = [email()];
				break;
			case "uri":
				referenceSchemas = [url()];
				break;
			case "date":
				referenceSchemas = [date$1()];
				break;
			case "date-time": referenceSchemas = datetimeReferenceSchemas(pattern);
		}
		return new Set(referenceSchemas.map((schema) => zodEmittedPattern(schema)).filter((emitted) => emitted !== void 0));
	}
	/** Whether `pattern` is the library's own realization of `format` (droppable) rather than a user customization. */
	function isLibraryFormatPattern(format, pattern, vendor) {
		if (vendor !== "zod") return true;
		return referencePatternsForFormat(format, pattern).has(pattern);
	}
	function isJsonObject(value) {
		return typeof value === "object" && value !== null && !Array.isArray(value);
	}
	function convertStandardElicitationSchema(schema) {
		try {
			return standardSchemaToJsonSchema(schema, "input");
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Elicitation requestedSchema must describe an object with flat primitive properties: ${detail}`);
		}
	}
	const ANNOTATION_ONLY_JSON_SCHEMA_KEYWORDS = /* @__PURE__ */ new Set([
		"$comment",
		"deprecated",
		"description",
		"examples",
		"readOnly",
		"title",
		"writeOnly"
	]);
	function isAnnotationOnlyJsonSchemaKeyword(key) {
		return ANNOTATION_ONLY_JSON_SCHEMA_KEYWORDS.has(key) || key.startsWith("x-");
	}
	const ROOT_KEYS = /* @__PURE__ */ new Set(["$schema", ...Object.keys(ElicitRequestFormParamsSchema.shape.requestedSchema.shape)]);
	const PROPERTY_KEYS_BY_TYPE = {
		string: shapeKeys([
			StringSchemaSchema,
			UntitledSingleSelectEnumSchemaSchema,
			TitledSingleSelectEnumSchemaSchema,
			LegacyTitledEnumSchemaSchema
		]),
		number: shapeKeys([NumberSchemaSchema]),
		integer: shapeKeys([NumberSchemaSchema]),
		boolean: shapeKeys([BooleanSchemaSchema]),
		array: shapeKeys([UntitledMultiSelectEnumSchemaSchema, TitledMultiSelectEnumSchemaSchema])
	};
	const SUPPORTED_STRING_FORMATS = new Set(StringSchemaSchema.shape.format.unwrap().options);
	/** Walks one property node: keeps grammar keys, drops the library format pattern, rejects unknown constraints. */
	function walkProperty(node, path, vendor, unsupported) {
		if (!isJsonObject(node)) return node;
		const allowedKeys = typeof node.type === "string" && Object.hasOwn(PROPERTY_KEYS_BY_TYPE, node.type) ? PROPERTY_KEYS_BY_TYPE[node.type] : void 0;
		if (allowedKeys === void 0) return node;
		const pruned = {};
		for (const [key, value] of Object.entries(node)) if (allowedKeys.has(key) || isAnnotationOnlyJsonSchemaKeyword(key)) pruned[key] = value;
		else if (key === "pattern" && node.type === "string" && typeof node.format === "string") {
			if (!SUPPORTED_STRING_FORMATS.has(node.format)) pruned[key] = value;
			else if (typeof value !== "string" || !isLibraryFormatPattern(node.format, value, vendor)) unsupported.push(`${path}.${key}`);
		} else unsupported.push(`${path}.${key}`);
		return pruned;
	}
	/** Walks the schema root: keeps the spec root keys, drops annotations, rejects the rest. */
	function walkRequestedSchema(converted, vendor) {
		const pruned = {};
		const unsupported = [];
		for (const [key, value] of Object.entries(converted)) if (key === "properties" && isJsonObject(value)) pruned[key] = Object.fromEntries(Object.entries(value).map(([name, node]) => [name, walkProperty(node, `properties.${name}`, vendor, unsupported)]));
		else if (ROOT_KEYS.has(key)) pruned[key] = value;
		else if (!isAnnotationOnlyJsonSchemaKeyword(key)) unsupported.push(key);
		if (unsupported.length > 0) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Elicitation requestedSchema contains unsupported JSON Schema constraint(s) after Standard Schema conversion: ${unsupported.join(", ")}`);
		return pruned;
	}
	/** Names the properties that fail value validation, instead of surfacing a raw union dump. */
	function describeUnsupportedProperties(pruned, fallback) {
		if (!isJsonObject(pruned.properties)) return fallback;
		const offenders = Object.entries(pruned.properties).filter(([, node]) => !parseSchema(PrimitiveSchemaDefinitionSchema, node).success).map(([name]) => `properties.${name}`);
		return offenders.length > 0 ? offenders.join(", ") : fallback;
	}
	function findDroppedConstraintPaths(original, parsed, path = "") {
		if (Array.isArray(original) && Array.isArray(parsed)) return original.flatMap((item, index) => findDroppedConstraintPaths(item, parsed[index], `${path}[${index}]`));
		if (!isJsonObject(original) || !isJsonObject(parsed)) return [];
		return Object.entries(original).flatMap(([key, value]) => {
			const childPath = path ? `${path}.${key}` : key;
			if (!Object.prototype.hasOwnProperty.call(parsed, key)) return isAnnotationOnlyJsonSchemaKeyword(key) ? [] : [childPath];
			return findDroppedConstraintPaths(value, parsed[key], childPath);
		});
	}
	/** Converts an authoring-friendly elicitation input into its wire-ready form. */
	function normalizeElicitInputParams(input) {
		if (!isStandardSchema(input.requestedSchema)) return {
			...input,
			mode: "form",
			requestedSchema: input.requestedSchema
		};
		const vendor = input.requestedSchema["~standard"].vendor;
		const pruned = walkRequestedSchema(convertStandardElicitationSchema(input.requestedSchema), vendor);
		const parsed = parseSchema(ElicitRequestFormParamsSchema.shape.requestedSchema, pruned);
		if (!parsed.success) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Elicitation requestedSchema only supports flat primitive properties (string, number, integer, boolean, and string enums): ${describeUnsupportedProperties(pruned, parsed.error.message)}`);
		const droppedConstraints = findDroppedConstraintPaths(pruned, parsed.data);
		if (droppedConstraints.length > 0) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Elicitation requestedSchema contains unsupported JSON Schema constraint(s) after Standard Schema conversion: ${droppedConstraints.join(", ")}`);
		const danglingRequired = (parsed.data.required ?? []).filter((key) => !Object.prototype.hasOwnProperty.call(parsed.data.properties, key));
		if (danglingRequired.length > 0) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Elicitation requestedSchema lists required properties that are not defined in properties: ${danglingRequired.join(", ")}`);
		return {
			...input,
			mode: "form",
			requestedSchema: parsed.data
		};
	}
	/**
	* Authoring helpers for multi-round-trip requests (protocol revision
	* 2026-07-28).
	*
	* A handler for one of the multi-round-trip methods (`tools/call`,
	* `prompts/get`, `resources/read`) requests additional client input by
	* returning an {@linkcode InputRequiredResult} instead of a final result. The
	* helpers here build that return value and its embedded requests as NEUTRAL
	* values; only the 2026-07-28 wire codec maps them to/from the wire. The
	* 2025-era codec has no input-required vocabulary — on a 2025-era request the
	* server's legacy shim (on by default) fulfils the embedded requests as real
	* server→client requests and re-enters the handler, so the same return shape
	* serves both eras; `ServerOptions.inputRequired.legacyShim: false` restores
	* the pre-shim loud failure.
	*
	* There is no nominal brand: `resultType: 'input_required'` is the
	* discriminator, and hand-built result literals are equally legal — the
	* server seam re-checks the at-least-one rule for them.
	*/
	function buildInputRequired(spec) {
		const hasInputRequests = spec.inputRequests !== void 0 && Object.keys(spec.inputRequests).length > 0;
		const hasRequestState = typeof spec.requestState === "string";
		if (!hasInputRequests && !hasRequestState) throw new TypeError("inputRequired() requires at least one of inputRequests (with at least one entry) or requestState (spec: every InputRequiredResult MUST include at least one of the two)");
		return {
			resultType: "input_required",
			...spec.inputRequests !== void 0 && { inputRequests: spec.inputRequests },
			...spec.requestState !== void 0 && { requestState: spec.requestState }
		};
	}
	Object.assign(buildInputRequired, {
		elicit(params) {
			try {
				return {
					method: "elicitation/create",
					params: normalizeElicitInputParams(params)
				};
			} catch (error) {
				throw error instanceof ProtocolError ? new TypeError(error.message, { cause: error }) : error;
			}
		},
		elicitUrl(params) {
			return {
				method: "elicitation/create",
				params: {
					...params,
					mode: "url"
				}
			};
		},
		createMessage(params) {
			return {
				method: "sampling/createMessage",
				params
			};
		},
		listRoots() {
			return { method: "roots/list" };
		}
	});
	/**
	* The multi-round-trip auto-fulfilment driver (protocol revision 2026-07-28).
	*
	* When a request to one of the multi-round-trip methods comes back as
	* `input_required`, the driver fulfils the embedded input requests by
	* dispatching them to the client's already-registered handlers (elicitation,
	* sampling, roots — one generic engine, no per-feature API), then retries the
	* original request with the collected `inputResponses` and a byte-exact echo
	* of `requestState`, on a fresh request id, until the server returns a
	* complete result or the round cap is exhausted.
	*
	* The driver is a LAYER OVER THE MANUAL PATH: each retry is issued with the
	* same primitive a manual caller uses (`allowInputRequired` semantics — the
	* retry hands back the next `input_required` payload instead of recursing),
	* so the loop, the cap, and the pacing live in one place and disabling
	* auto-fulfilment (`inputRequired.autoFulfill: false`) simply skips this
	* module. Timeouts ride the EXISTING knobs: the per-leg `timeout` applies to
	* every wire leg unchanged, and `maxTotalTimeout` bounds the whole flow by
	* shrinking the budget passed to each leg — no new timer system.
	*/
	/**
	* Whether the multi-round-trip driver fulfils `input_required` results
	* automatically when the consumer has not configured
	* `inputRequired.autoFulfill`. The single switch for the default posture.
	*/
	const DEFAULT_INPUT_REQUIRED_AUTO_FULFILL = true;
	/**
	* Default round cap for the auto-fulfilment driver (both request legs and
	* requestState-only legs count). Aligned with the other SDK client engines.
	*/
	const DEFAULT_INPUT_REQUIRED_MAX_ROUNDS = 10;
	/**
	* Fixed pacing applied before retrying a requestState-only (load-shedding)
	* leg — a leg that carries no embedded input requests, so nothing slows the
	* loop down naturally. Counted in the same round cap.
	*/
	const REQUEST_STATE_ONLY_LEG_PACING_MS = 250;
	function resolveInputRequiredDriverConfig(options) {
		return {
			autoFulfill: options?.autoFulfill ?? DEFAULT_INPUT_REQUIRED_AUTO_FULFILL,
			maxRounds: options?.maxRounds ?? DEFAULT_INPUT_REQUIRED_MAX_ROUNDS
		};
	}
	/** Builds the retry params: original params + this round's responses + byte-exact requestState echo. */
	function buildInputRequiredRetryParams(originalParams, responses, requestState) {
		const hasResponses = responses !== void 0 && Object.keys(responses).length > 0;
		if (!hasResponses && requestState === void 0) return originalParams;
		return {
			...originalParams,
			...hasResponses && { inputResponses: responses },
			...requestState !== void 0 && { requestState }
		};
	}
	/**
	* The message both multi-round-trip loops emit when the round cap is
	* exhausted — the client driver as a typed error, the server-side legacy
	* shim as its per-family failure. One formatter so the texts cannot drift
	* (hosts and models read the tool-result copy verbatim).
	*/
	function inputRequiredRoundsExceededMessage(method, maxRounds) {
		return `Multi-round-trip request '${method}' still required input after ${maxRounds} rounds (inputRequired.maxRounds)`;
	}
	/**
	* Abortable delay: resolves after `ms`, or rejects with the signal's reason
	* (wrapped in an `SdkError` when it isn't already one) if the signal aborts
	* first. Aborting after resolution is a no-op. Shared with the server-side
	* legacy shim (the pacing semantics must match per era).
	*/
	function sleep(ms, signal) {
		return new Promise((resolve, reject) => {
			if (signal?.aborted) {
				reject(signal.reason instanceof SdkError ? signal.reason : new SdkError(SdkErrorCode.RequestTimeout, String(signal.reason)));
				return;
			}
			const timer = setTimeout(() => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			}, ms);
			const onAbort = () => {
				clearTimeout(timer);
				reject(signal?.reason instanceof SdkError ? signal.reason : new SdkError(SdkErrorCode.RequestTimeout, String(signal?.reason)));
			};
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}
	/**
	* A per-round abort linked to the caller's signal: the embedded sibling
	* dispatches share it, so the first failure (or a caller abort) cancels the
	* others instead of leaving them running. Shared with the server-side legacy
	* shim (the abort-linkage semantics must match per era).
	*/
	function linkedRoundAbort(outer) {
		const controller = new AbortController();
		const onOuterAbort = () => controller.abort(outer?.reason);
		outer?.addEventListener("abort", onOuterAbort, { once: true });
		if (outer?.aborted) controller.abort(outer.reason);
		return {
			signal: controller.signal,
			abort: (reason) => controller.abort(reason),
			dispose: () => outer?.removeEventListener("abort", onOuterAbort)
		};
	}
	/**
	* Runs the auto-fulfilment loop for one originating request. Resolves with
	* the final complete result (already validated by the retry leg) or rejects
	* with a typed error.
	*
	* `flowStartedAt` is the timestamp the ORIGINAL request was issued at (not
	* when the driver started): `maxTotalTimeout` bounds the whole flow, so the
	* first wire leg counts against the budget too. When omitted, accounting
	* starts when the driver starts.
	*/
	async function runInputRequiredDriver(args) {
		const { config, method, originalParams, requestOptions, hooks, signal } = args;
		const startedAt = args.flowStartedAt ?? Date.now();
		let payload = args.firstPayload;
		let round = 0;
		while (true) {
			round += 1;
			if (round > config.maxRounds) throw new SdkError(SdkErrorCode.InputRequiredRoundsExceeded, inputRequiredRoundsExceededMessage(method, config.maxRounds), {
				rounds: config.maxRounds,
				lastResult: {
					inputRequests: payload.inputRequests,
					...payload.requestState !== void 0 && { requestState: payload.requestState }
				}
			});
			requestOptions.onprogress?.({
				progress: round,
				message: `Fulfilling input required by '${method}' (round ${round})`
			});
			const entries = Object.entries(payload.inputRequests ?? {});
			let responses;
			if (entries.length > 0) {
				const round$1 = linkedRoundAbort(signal);
				try {
					const fulfilled = await Promise.all(entries.map(async ([key, entry]) => {
						try {
							return [key, await hooks.dispatchInputRequest(key, entry, round$1.signal)];
						} catch (error) {
							round$1.abort(error);
							throw error;
						}
					}));
					responses = Object.fromEntries(fulfilled);
				} finally {
					round$1.dispose();
				}
			} else await sleep(REQUEST_STATE_ONLY_LEG_PACING_MS, signal);
			const legOptions = { ...requestOptions.timeout !== void 0 && { timeout: requestOptions.timeout } };
			if (requestOptions.maxTotalTimeout !== void 0) {
				const totalElapsed = Date.now() - startedAt;
				const remaining = requestOptions.maxTotalTimeout - totalElapsed;
				if (remaining <= 0) throw new SdkError(SdkErrorCode.RequestTimeout, "Maximum total timeout exceeded", {
					maxTotalTimeout: requestOptions.maxTotalTimeout,
					totalElapsed
				});
				legOptions.maxTotalTimeout = remaining;
			}
			const result = await hooks.retry(buildInputRequiredRetryParams(originalParams, responses, payload.requestState), legOptions);
			if (isInputRequiredResult(result)) {
				payload = {
					inputRequests: result.inputRequests ?? {},
					...result.requestState !== void 0 && { requestState: result.requestState }
				};
				continue;
			}
			return result;
		}
	}
	/**
	* Explicit allowlist of protocol Zod schemas that correspond to a public spec type in `types.ts`.
	*
	* This intentionally excludes internal helper schemas exported from `schemas.ts` that have no
	* matching public type (e.g. `ListChangedOptionsBaseSchema`, `BaseRequestParamsSchema`,
	* `NotificationsParamsSchema`, `ClientTasksCapabilitySchema`, `ServerTasksCapabilitySchema`).
	* Keeping the list explicit means new public spec types must be added here deliberately, and
	* internals never leak into `SpecTypeName`.
	*
	* `ResourceTemplateSchema` is included; its public type is exported as `ResourceTemplateType`
	* (the bare name collides with the server package's `ResourceTemplate` class), so
	* `SpecTypes['ResourceTemplate']` is structurally equal to `ResourceTemplateType` rather than to
	* a type literally named `ResourceTemplate`.
	*/
	const SPEC_SCHEMA_KEYS = [
		"AnnotationsSchema",
		"AudioContentSchema",
		"BaseMetadataSchema",
		"BlobResourceContentsSchema",
		"BooleanSchemaSchema",
		"CallToolRequestSchema",
		"CallToolRequestParamsSchema",
		"CallToolResultSchema",
		"CancelledNotificationSchema",
		"CancelledNotificationParamsSchema",
		"CancelTaskRequestSchema",
		"CancelTaskResultSchema",
		"ClientCapabilitiesSchema",
		"ClientNotificationSchema",
		"ClientRequestSchema",
		"ClientResultSchema",
		"CompatibilityCallToolResultSchema",
		"CompleteRequestSchema",
		"CompleteRequestParamsSchema",
		"CompleteResultSchema",
		"ContentBlockSchema",
		"CreateMessageRequestSchema",
		"CreateMessageRequestParamsSchema",
		"CreateMessageResultSchema",
		"CreateMessageResultWithToolsSchema",
		"CreateTaskResultSchema",
		"CursorSchema",
		"DiscoverRequestSchema",
		"DiscoverResultSchema",
		"ElicitationCompleteNotificationSchema",
		"ElicitationCompleteNotificationParamsSchema",
		"ElicitRequestSchema",
		"ElicitRequestFormParamsSchema",
		"ElicitRequestParamsSchema",
		"ElicitRequestURLParamsSchema",
		"ElicitResultSchema",
		"EmbeddedResourceSchema",
		"EmptyResultSchema",
		"EnumSchemaSchema",
		"GetPromptRequestSchema",
		"GetPromptRequestParamsSchema",
		"GetPromptResultSchema",
		"GetTaskPayloadRequestSchema",
		"GetTaskPayloadResultSchema",
		"GetTaskRequestSchema",
		"GetTaskResultSchema",
		"IconSchema",
		"IconsSchema",
		"ImageContentSchema",
		"ImplementationSchema",
		"InitializedNotificationSchema",
		"InitializeRequestSchema",
		"InitializeRequestParamsSchema",
		"InitializeResultSchema",
		"JSONArraySchema",
		"JSONObjectSchema",
		"JSONRPCErrorResponseSchema",
		"JSONRPCMessageSchema",
		"JSONRPCNotificationSchema",
		"JSONRPCRequestSchema",
		"JSONRPCResponseSchema",
		"JSONRPCResultResponseSchema",
		"JSONValueSchema",
		"LegacyTitledEnumSchemaSchema",
		"ListPromptsRequestSchema",
		"ListPromptsResultSchema",
		"ListResourcesRequestSchema",
		"ListResourcesResultSchema",
		"ListResourceTemplatesRequestSchema",
		"ListResourceTemplatesResultSchema",
		"ListRootsRequestSchema",
		"ListRootsResultSchema",
		"ListTasksRequestSchema",
		"ListTasksResultSchema",
		"ListToolsRequestSchema",
		"ListToolsResultSchema",
		"LoggingLevelSchema",
		"LoggingMessageNotificationSchema",
		"LoggingMessageNotificationParamsSchema",
		"ModelHintSchema",
		"ModelPreferencesSchema",
		"MultiSelectEnumSchemaSchema",
		"NotificationSchema",
		"NumberSchemaSchema",
		"PaginatedRequestSchema",
		"PaginatedRequestParamsSchema",
		"PaginatedResultSchema",
		"PingRequestSchema",
		"PrimitiveSchemaDefinitionSchema",
		"ProgressSchema",
		"ProgressNotificationSchema",
		"ProgressNotificationParamsSchema",
		"ProgressTokenSchema",
		"PromptSchema",
		"PromptArgumentSchema",
		"PromptListChangedNotificationSchema",
		"PromptMessageSchema",
		"PromptReferenceSchema",
		"ReadResourceRequestSchema",
		"ReadResourceRequestParamsSchema",
		"ReadResourceResultSchema",
		"RelatedTaskMetadataSchema",
		"RequestSchema",
		"RequestIdSchema",
		"RequestMetaSchema",
		"ResourceSchema",
		"ResourceContentsSchema",
		"ResourceLinkSchema",
		"ResourceListChangedNotificationSchema",
		"ResourceRequestParamsSchema",
		"ResourceTemplateSchema",
		"ResourceTemplateReferenceSchema",
		"ResourceUpdatedNotificationSchema",
		"ResourceUpdatedNotificationParamsSchema",
		"ResultMetaObjectSchema",
		"ResultSchema",
		"RoleSchema",
		"RootSchema",
		"RootsListChangedNotificationSchema",
		"SamplingContentSchema",
		"SamplingMessageSchema",
		"SamplingMessageContentBlockSchema",
		"ServerCapabilitiesSchema",
		"ServerNotificationSchema",
		"ServerRequestSchema",
		"ServerResultSchema",
		"SetLevelRequestSchema",
		"SetLevelRequestParamsSchema",
		"SingleSelectEnumSchemaSchema",
		"StringSchemaSchema",
		"SubscribeRequestSchema",
		"SubscribeRequestParamsSchema",
		"SubscriptionFilterSchema",
		"SubscriptionsAcknowledgedNotificationSchema",
		"SubscriptionsAcknowledgedNotificationParamsSchema",
		"SubscriptionsListenRequestSchema",
		"SubscriptionsListenRequestParamsSchema",
		"SubscriptionsListenResultSchema",
		"SubscriptionsListenResultMetaSchema",
		"TaskAugmentedRequestParamsSchema",
		"TaskCreationParamsSchema",
		"TaskMetadataSchema",
		"TaskSchema",
		"TaskStatusSchema",
		"TaskStatusNotificationSchema",
		"TaskStatusNotificationParamsSchema",
		"TextContentSchema",
		"TextResourceContentsSchema",
		"TitledMultiSelectEnumSchemaSchema",
		"TitledSingleSelectEnumSchemaSchema",
		"ToolSchema",
		"ToolAnnotationsSchema",
		"ToolChoiceSchema",
		"ToolExecutionSchema",
		"ToolListChangedNotificationSchema",
		"ToolResultContentSchema",
		"ToolUseContentSchema",
		"UnsubscribeRequestSchema",
		"UnsubscribeRequestParamsSchema",
		"UntitledMultiSelectEnumSchemaSchema",
		"UntitledSingleSelectEnumSchemaSchema"
	];
	const authSchemas = {
		IdJagTokenExchangeResponseSchema,
		OAuthClientInformationFullSchema,
		OAuthClientInformationSchema,
		OAuthClientMetadataSchema,
		OAuthClientRegistrationErrorSchema,
		OAuthErrorResponseSchema,
		OAuthMetadataSchema,
		OAuthProtectedResourceMetadataSchema,
		OAuthTokenRevocationRequestSchema,
		OAuthTokensSchema,
		OpenIdProviderDiscoveryMetadataSchema,
		OpenIdProviderMetadataSchema
	};
	const _specTypeSchemas = {};
	const _isSpecType = {};
	function register(key, schema) {
		const name = key.slice(0, -6);
		_specTypeSchemas[name] = schema;
		_isSpecType[name] = (v) => schema.safeParse(v).success;
	}
	for (const key of SPEC_SCHEMA_KEYS) register(key, schemas_exports[key]);
	for (const [key, schema] of Object.entries(authSchemas)) register(key, schema);
	Object.freeze(_specTypeSchemas);
	/**
	* Type predicates for every MCP spec type, keyed by type name.
	*
	* Returns `true` if the value satisfies the schema's input type (`z.input<>`, before defaults and
	* transforms are applied), and narrows to that input type. For schemas with `.default()` or
	* `.preprocess()`, this may accept values that do not structurally match the named output type;
	* for example `isSpecType.CallToolResult({})` is `true` because `content` has a default. Use
	* `specTypeSchemas.X['~standard'].validate(value)` when you need the validated output value.
	*
	* Each guard is a standalone function, so it can be passed directly as a callback.
	*
	* @example
	* ```ts source="./specTypeSchema.examples.ts#isSpecType_basicUsage"
	* if (isSpecType.ContentBlock(value)) {
	*     // value is ContentBlock
	* }
	*
	* const blocks = mixed.filter(isSpecType.ContentBlock);
	* ```
	*/
	const isSpecType = Object.freeze(_isSpecType);
	function bootstrapOutboundCodec(method) {
		switch (method) {
			case "initialize":
			case "notifications/initialized": return codecForVersion(void 0);
			case "server/discover": return codecForVersion(MODERN_WIRE_REVISION);
			default: return;
		}
	}
	/**
	* The reserved per-request `_meta` envelope keys (protocol revision
	* 2026-07-28). The protocol layer lifts these out of inbound `_meta` before
	* handlers run and surfaces them at `ctx.mcpReq.envelope` — they are
	* wire-level bookkeeping, not handler material.
	*/
	const RESERVED_ENVELOPE_META_KEYS = [
		PROTOCOL_VERSION_META_KEY,
		CLIENT_INFO_META_KEY,
		CLIENT_CAPABILITIES_META_KEY,
		LOG_LEVEL_META_KEY
	];
	/**
	* Top-level params members carrying multi-round-trip driver material
	* (protocol revision 2026-07-28). The spec reserves these names on
	* client-initiated REQUESTS only — notification params keep them untouched
	* (a vendor notification may legitimately use the same names).
	*/
	const RETRY_PARAMS_KEYS = ["inputResponses", "requestState"];
	/**
	* Lift wire-only material out of an inbound message so handlers see exactly
	* the 2025-era shape, and surface it for the protocol layer (requests: via
	* `ctx.mcpReq`). What counts as wire-only depends on the message kind: the
	* reserved envelope `_meta` keys are reserved on every message, while the
	* multi-round-trip retry fields (`inputResponses`/`requestState`) are
	* reserved on client-initiated requests only — so notifications get only the
	* envelope lift, and their top-level params stay untouched. Messages without
	* wire-only material are returned unchanged (same reference).
	*/
	function liftWireOnlyMaterial(message, kind) {
		const params = message.params;
		if (!isPlainObject$1(params)) return {
			message,
			lifted: {}
		};
		const meta = params._meta;
		const envelopeKeys = isPlainObject$1(meta) ? RESERVED_ENVELOPE_META_KEYS.filter((key) => key in meta) : [];
		const retryKeys = kind === "request" ? RETRY_PARAMS_KEYS.filter((key) => key in params) : [];
		if (envelopeKeys.length === 0 && retryKeys.length === 0) return {
			message,
			lifted: {}
		};
		const lifted = {};
		const nextParams = { ...params };
		if (envelopeKeys.length > 0 && isPlainObject$1(meta)) {
			const envelope = {};
			const nextMeta = { ...meta };
			for (const key of envelopeKeys) {
				envelope[key] = meta[key];
				delete nextMeta[key];
			}
			lifted.envelope = envelope;
			if (Object.keys(nextMeta).length > 0) nextParams._meta = nextMeta;
			else delete nextParams._meta;
		}
		for (const key of retryKeys) {
			if (key === "inputResponses") lifted.inputResponses = nextParams[key];
			if (key === "requestState") lifted.requestState = nextParams[key];
			delete nextParams[key];
		}
		return {
			message: {
				...message,
				params: nextParams
			},
			lifted
		};
	}
	/**
	* Standard Schema adapter over the era codec's `validateResult` function (the
	* function-only WireCodec contract exposes no schema objects). Used by the
	* spec-method `request()` overload so the request funnel keeps a single
	* `StandardSchemaV1`-shaped validation seam for both spec and explicit-schema
	* paths.
	*
	* Returns `undefined` when the method has no result entry on this era's
	* registry — the caller maps that to the synchronous "pass a result schema"
	* TypeError, exactly matching the pre-function-only behavior the
	* typedMapAlignment suite pins (the result map deliberately excludes the
	* `tasks/*` methods, so the spec-method overload refuses them up front).
	*/
	function codecResultValidator(codec, method) {
		const probe = codec.validateResult(method, void 0);
		if (!probe.ok && probe.reason === "not-in-era") return void 0;
		return { "~standard": {
			version: 1,
			vendor: "mcp-wire-codec",
			validate(value) {
				const outcome = codec.validateResult(method, value);
				if (outcome.ok) return { value: outcome.value };
				return { issues: [{ message: outcome.reason === "invalid" ? outcome.message : `not-in-era: ${method}` }] };
			}
		} };
	}
	/**
	* Builds the `ctx.mcpReq.requestState` accessor for a resolved value. The
	* `as T` below is the one place {@linkcode RequestStateAccessor}'s
	* caller-asserted typing is implemented — no implementation can produce an
	* arbitrary `T` from a runtime value honestly.
	*/
	function requestStateAccessor(value) {
		return () => value;
	}
	/** Shared no-state accessor: the common case allocates nothing per request. */
	const NO_REQUEST_STATE = requestStateAccessor(void 0);
	/**
	* Implements MCP protocol framing on top of a pluggable transport, including
	* features like request/response linking, notifications, and progress.
	*
	* `Protocol` is abstract; `Client` and `Server` are the concrete role-specific
	* implementations most code should use.
	*/
	var Protocol = class {
		_transport;
		_requestMessageId = 0;
		_requestHandlers = /* @__PURE__ */ new Map();
		_requestHandlerAbortControllers = /* @__PURE__ */ new Map();
		_notificationHandlers = /* @__PURE__ */ new Map();
		_responseHandlers = /* @__PURE__ */ new Map();
		_progressHandlers = /* @__PURE__ */ new Map();
		_timeoutInfo = /* @__PURE__ */ new Map();
		_pendingDebouncedNotifications = /* @__PURE__ */ new Set();
		/**
		* The protocol version negotiated for the current connection (`undefined`
		* before negotiation completes), which determines the wire era this
		* instance speaks. Set by the SDK's negotiation and initialize paths
		* (`Client.connect`, `Server._oninitialize`).
		*/
		_negotiatedProtocolVersion;
		static {}
		_supportedProtocolVersions;
		/**
		* Callback for when the connection is closed for any reason.
		*
		* This is invoked when {@linkcode Protocol.close | close()} is called as well.
		*/
		onclose;
		/**
		* Callback for when an error occurs.
		*
		* Note that errors are not necessarily fatal; they are used for reporting any kind of exceptional condition out of band.
		*/
		onerror;
		/**
		* A handler to invoke for any request types that do not have their own handler installed.
		*/
		fallbackRequestHandler;
		/**
		* A handler to invoke for any notification types that do not have their own handler installed.
		*/
		fallbackNotificationHandler;
		constructor(_options) {
			this._options = _options;
			this._supportedProtocolVersions = _options?.supportedProtocolVersions ?? SUPPORTED_PROTOCOL_VERSIONS;
			this.setNotificationHandler("notifications/cancelled", (notification) => {
				this._oncancel(notification);
			});
			this.setNotificationHandler("notifications/progress", (notification) => {
				this._onprogress(notification);
			});
			this.setRequestHandler("ping", (_request) => ({}));
		}
		/**
		* Drop consult for inbound messages whose transport did not classify them
		* at the edge — long-lived channels such as stdio, where a role class may
		* need to decline traffic the negotiated era has no answer for (the
		* client-side inbound-request drop on modern-era connections: the
		* 2026-07-28 era has no server→client request channel, and on stdio the
		* client must never write JSON-RPC responses).
		*
		* Consulted ONLY when the transport supplied no
		* {@linkcode MessageExtraInfo.classification}: edge-classified traffic
		* never reaches the hook. Returning `'drop'` discards the message without
		* writing any response (requests are surfaced via `onerror`). The base
		* implementation returns `undefined`: unclassified traffic keeps today's
		* dispatch path unchanged. Era selection never happens here — era is
		* instance state, owned by the serving entry that constructed and
		* connected the instance.
		*/
		_shouldDropInbound(_message) {}
		/**
		* The per-request `_meta` envelope this instance attaches to every outgoing
		* request and notification, when one applies. The base implementation
		* returns `undefined` (no envelope — the 2025-era posture, so legacy-era
		* outbound traffic is byte-identical to a build without this seam).
		* `Client` overrides it on a connection that negotiated a modern (2026-07-28+)
		* era to return the reserved protocol-version / client-info /
		* client-capabilities keys. User-supplied `_meta` keys take precedence over
		* the auto-attached ones.
		*/
		_outboundMetaEnvelope() {}
		/**
		* Attach this instance's outbound `_meta` envelope (when one is configured)
		* to a request or notification. A no-op when the seam returns `undefined`
		* — the message returns by reference, so the legacy-era wire stays
		* byte-identical. User-supplied `_meta` keys are spread last so they win
		* over the auto-attached envelope keys.
		*/
		_envelopeOutbound(message) {
			const envelope = this._outboundMetaEnvelope();
			if (envelope === void 0) return message;
			const params = message.params ?? {};
			return {
				...message,
				params: {
					...params,
					_meta: {
						...envelope,
						...params._meta
					}
				}
			};
		}
		/**
		* Extension point for non-`complete` decoded results in the response
		* funnel: a result the wire codec discriminated into a kind other than
		* `'complete'` or `'invalid'` is handed here for the role class to
		* resolve. The base default surfaces it as a typed
		* {@linkcode SdkErrorCode.UnsupportedResultType} error (no retry).
		*
		* Intended consumers (named so the seam stays accountable):
		* - the `Client`'s multi-round-trip auto-fulfilment engine, which fulfils
		*   `'input_required'` results through the registered
		*   elicitation/sampling/roots handlers and retries via `flow.retry`;
		* - a future client-side terminal-result handler for
		*   `subscriptions/listen`, when the spec defines one.
		*
		* `Server` instances never receive `input_required` responses on their
		* outbound legs and leave the base behavior in place.
		*/
		_resolveNonCompleteResult(decoded, flow) {
			return Promise.reject(new SdkError(SdkErrorCode.UnsupportedResultType, `Unsupported result type '${decoded.kind}' for ${flow.request.method}`, {
				resultType: decoded.kind,
				method: flow.request.method
			}));
		}
		/**
		* Protected accessor for a registered request handler. Used by role
		* classes that dispatch synthesized requests through the same stored
		* handler chain (e.g. the `Client` fulfilling an embedded multi-round-trip
		* input request).
		*/
		_getRequestHandler(method) {
			return this._requestHandlers.get(method);
		}
		async _oncancel(notification) {
			if (!notification.params.requestId) return;
			this._requestHandlerAbortControllers.get(notification.params.requestId)?.abort(notification.params.reason);
		}
		_setupTimeout(messageId, timeout, maxTotalTimeout, onTimeout, resetTimeoutOnProgress = false) {
			this._timeoutInfo.set(messageId, {
				timeoutId: setTimeout(onTimeout, timeout),
				startTime: Date.now(),
				timeout,
				maxTotalTimeout,
				resetTimeoutOnProgress,
				onTimeout
			});
		}
		_resetTimeout(messageId) {
			const info = this._timeoutInfo.get(messageId);
			if (!info) return false;
			const totalElapsed = Date.now() - info.startTime;
			if (info.maxTotalTimeout && totalElapsed >= info.maxTotalTimeout) {
				this._timeoutInfo.delete(messageId);
				throw new SdkError(SdkErrorCode.RequestTimeout, "Maximum total timeout exceeded", {
					maxTotalTimeout: info.maxTotalTimeout,
					totalElapsed
				});
			}
			clearTimeout(info.timeoutId);
			info.timeoutId = setTimeout(info.onTimeout, info.timeout);
			return true;
		}
		_cleanupTimeout(messageId) {
			const info = this._timeoutInfo.get(messageId);
			if (info) {
				clearTimeout(info.timeoutId);
				this._timeoutInfo.delete(messageId);
			}
		}
		/**
		* Attaches to the given transport, starts it, and starts listening for messages.
		*
		* The caller assumes ownership of the {@linkcode Transport}, replacing any callbacks that have already been set, and expects that it is the only user of the {@linkcode Transport} instance going forward.
		*/
		async connect(transport) {
			this._transport = transport;
			const _onclose = this.transport?.onclose;
			this._transport.onclose = () => {
				try {
					_onclose?.();
				} finally {
					this._onclose();
				}
			};
			const _onerror = this.transport?.onerror;
			this._transport.onerror = (error) => {
				_onerror?.(error);
				this._onerror(error);
			};
			const _onmessage = this._transport?.onmessage;
			this._transport.onmessage = (message, extra) => {
				_onmessage?.(message, extra);
				if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) this._onresponse(message);
				else if (isJSONRPCRequest(message)) this._onrequest(message, extra);
				else if (isJSONRPCNotification(message)) this._onnotification(message, extra);
				else this._onerror(/* @__PURE__ */ new Error(`Unknown message type: ${JSON.stringify(message)}`));
			};
			transport.setSupportedProtocolVersions?.(this._supportedProtocolVersions);
			await this._transport.start();
		}
		/**
		* Transport-close hook. Subclass overrides MUST call `super._onclose()`
		* after their own cleanup — base teardown (response-handler settlement,
		* timeout clearing, in-flight request abort) does not run otherwise.
		*/
		_onclose() {
			const responseHandlers = this._responseHandlers;
			this._responseHandlers = /* @__PURE__ */ new Map();
			this._progressHandlers.clear();
			this._pendingDebouncedNotifications.clear();
			for (const info of this._timeoutInfo.values()) clearTimeout(info.timeoutId);
			this._timeoutInfo.clear();
			const requestHandlerAbortControllers = this._requestHandlerAbortControllers;
			this._requestHandlerAbortControllers = /* @__PURE__ */ new Map();
			const error = new SdkError(SdkErrorCode.ConnectionClosed, "Connection closed");
			this._transport = void 0;
			try {
				this.onclose?.();
			} finally {
				for (const handler of responseHandlers.values()) handler(error);
				for (const controller of requestHandlerAbortControllers.values()) controller.abort(error);
			}
		}
		_onerror(error) {
			this.onerror?.(error);
		}
		/**
		* Inbound-notification dispatch. Subclass overrides MUST delegate
		* unmatched traffic to `super._onnotification(rawNotification, extra)` —
		* an override that consumes only what it owns and falls through to base
		* dispatch for everything else.
		*/
		_onnotification(rawNotification, extra) {
			const { message: notification } = liftWireOnlyMaterial(rawNotification, "notification");
			const codec = this._negotiatedWireCodec();
			if (extra?.classification === void 0 && this._shouldDropInbound(rawNotification) === "drop") return;
			if (extra?.classification !== void 0) {
				const classified = classifiedWireEra(extra.classification);
				if (classified !== codec.era) {
					this._onerror(/* @__PURE__ */ new Error(`Era mismatch on inbound notification '${notification.method}': classified as ${classified} but this instance serves ${codec.era}`));
					return;
				}
			}
			if (isSpecNotificationMethod(notification.method) && !codec.hasNotificationMethod(notification.method)) return;
			const handler = this._notificationHandlers.get(notification.method);
			const fallback = this.fallbackNotificationHandler;
			if (handler === void 0 && fallback === void 0) return;
			Promise.resolve().then(() => handler === void 0 ? fallback(notification) : handler(notification, codec)).catch((error) => this._onerror(/* @__PURE__ */ new Error(`Uncaught error in notification handler: ${error}`)));
		}
		_onrequest(rawRequest, extra) {
			const { message: request, lifted } = liftWireOnlyMaterial(rawRequest, "request");
			const codec = this._negotiatedWireCodec();
			if (extra?.classification === void 0 && this._shouldDropInbound(rawRequest) === "drop") {
				this._onerror(/* @__PURE__ */ new Error(`Dropped inbound request '${rawRequest.method}': not servable on this connection's protocol era`));
				return;
			}
			const capturedTransport = this._transport;
			const sendErrorResponse = (code, message, data) => {
				const errorResponse = {
					jsonrpc: "2.0",
					id: request.id,
					error: {
						code,
						message,
						...data !== void 0 && { data }
					}
				};
				capturedTransport?.send(errorResponse).catch((error) => this._onerror(/* @__PURE__ */ new Error(`Failed to send an error response: ${error}`)));
			};
			if (extra?.classification !== void 0) {
				const classified = classifiedWireEra(extra.classification);
				if (classified !== codec.era) {
					this._onerror(/* @__PURE__ */ new Error(`Era mismatch on inbound request '${request.method}': classified as ${classified} but this instance serves ${codec.era}`));
					const requested = extra.classification.revision ?? classified;
					sendErrorResponse(ProtocolErrorCode.UnsupportedProtocolVersion, `Unsupported protocol version: ${requested}`, {
						supported: this._supportedProtocolVersions,
						requested
					});
					return;
				}
			}
			if (isSpecRequestMethod(request.method) && !codec.hasRequestMethod(request.method)) {
				sendErrorResponse(ProtocolErrorCode.MethodNotFound, "Method not found");
				return;
			}
			const handler = this._requestHandlers.get(request.method) ?? this.fallbackRequestHandler;
			if (handler === void 0) {
				sendErrorResponse(ProtocolErrorCode.MethodNotFound, "Method not found");
				return;
			}
			const envelopeError = codec.checkInboundEnvelope(lifted);
			if (envelopeError !== void 0) {
				sendErrorResponse(ProtocolErrorCode.InvalidParams, envelopeError);
				return;
			}
			const sendNotification = (notification, options) => this._notificationViaCodec(this._resolveOutboundCodec(notification.method), notification, {
				...options,
				relatedRequestId: request.id
			});
			const sendRequest = (r, resultSchema, options) => this._requestWithSchemaViaCodec(this._resolveOutboundCodec(r.method), r, resultSchema, {
				...options,
				relatedRequestId: request.id
			});
			const abortController = new AbortController();
			this._requestHandlerAbortControllers.set(request.id, abortController);
			const partitionedInputResponses = lifted.inputResponses === void 0 ? void 0 : partitionInputResponses(lifted.inputResponses);
			const baseCtx = {
				sessionId: capturedTransport?.sessionId,
				mcpReq: {
					id: request.id,
					method: request.method,
					_meta: request.params?._meta,
					...lifted.envelope !== void 0 && { envelope: lifted.envelope },
					...partitionedInputResponses !== void 0 && { inputResponses: partitionedInputResponses.accepted },
					...partitionedInputResponses !== void 0 && partitionedInputResponses.droppedKeys.length > 0 && { droppedInputResponseKeys: partitionedInputResponses.droppedKeys },
					requestState: lifted.requestState === void 0 ? NO_REQUEST_STATE : requestStateAccessor(lifted.requestState),
					signal: abortController.signal,
					send: ((r, schemaOrOptions, maybeOptions) => {
						const sendCodec = this._resolveOutboundCodec(r.method);
						this._assertOutboundRequestInEra(sendCodec, r.method);
						if (isStandardSchema(schemaOrOptions)) return sendRequest(r, schemaOrOptions, maybeOptions);
						const validate = codecResultValidator(sendCodec, r.method);
						if (validate === void 0) throw new TypeError(`'${r.method}' is not a spec method; pass a result schema as the second argument to ctx.mcpReq.send().`);
						return sendRequest(r, validate, schemaOrOptions);
					}),
					notify: sendNotification
				},
				http: extra?.authInfo ? { authInfo: extra.authInfo } : void 0
			};
			const ctx = this.buildContext(baseCtx, extra);
			Promise.resolve().then(() => handler(request, ctx)).then(async (result) => {
				if (abortController.signal.aborted) return;
				let encoded;
				try {
					encoded = codec.encodeResult(request.method, result, this._outboundServerInfo());
				} catch (error) {
					this._onerror(/* @__PURE__ */ new Error(`Failed to encode result for ${request.method}: ${error}`));
					sendErrorResponse(ProtocolErrorCode.InternalError, "Internal error");
					return;
				}
				const response = {
					result: encoded,
					jsonrpc: "2.0",
					id: request.id
				};
				await capturedTransport?.send(response);
			}, async (error) => {
				if (abortController.signal.aborted) return;
				const thrownCode = Number.isSafeInteger(error["code"]) ? error["code"] : ProtocolErrorCode.InternalError;
				const errorResponse = {
					jsonrpc: "2.0",
					id: request.id,
					error: {
						code: codec.encodeErrorCode(thrownCode),
						message: error.message ?? "Internal error",
						...error["data"] !== void 0 && { data: error["data"] }
					}
				};
				await capturedTransport?.send(errorResponse);
			}).catch((error) => this._onerror(/* @__PURE__ */ new Error(`Failed to send response: ${error}`))).finally(() => {
				if (this._requestHandlerAbortControllers.get(request.id) === abortController) this._requestHandlerAbortControllers.delete(request.id);
			});
		}
		_onprogress(notification) {
			const { progressToken, ...params } = notification.params;
			const messageId = Number(progressToken);
			const handler = this._progressHandlers.get(messageId);
			if (!handler) {
				this._onerror(/* @__PURE__ */ new Error(`Received a progress notification for an unknown token: ${JSON.stringify(notification)}`));
				return;
			}
			const responseHandler = this._responseHandlers.get(messageId);
			const timeoutInfo = this._timeoutInfo.get(messageId);
			if (timeoutInfo && responseHandler && timeoutInfo.resetTimeoutOnProgress) try {
				this._resetTimeout(messageId);
			} catch (error) {
				this._responseHandlers.delete(messageId);
				this._progressHandlers.delete(messageId);
				this._cleanupTimeout(messageId);
				responseHandler(error);
				return;
			}
			handler(params);
		}
		/**
		* Inbound-response dispatch. Subclass overrides MUST delegate unmatched
		* traffic to `super._onresponse(response)` — an override that consumes
		* only what it owns and falls through to base dispatch for everything
		* else.
		*/
		_onresponse(response) {
			const messageId = Number(response.id);
			const handler = this._responseHandlers.get(messageId);
			if (handler === void 0) {
				this._onerror(/* @__PURE__ */ new Error(`Received a response for an unknown message ID: ${JSON.stringify(response)}`));
				return;
			}
			this._responseHandlers.delete(messageId);
			this._cleanupTimeout(messageId);
			this._progressHandlers.delete(messageId);
			if (isJSONRPCResultResponse(response)) handler(response);
			else handler(ProtocolError.fromError(response.error.code, response.error.message, response.error.data));
		}
		get transport() {
			return this._transport;
		}
		/**
		* Closes the connection.
		*/
		async close() {
			await this._transport?.close();
		}
		request(request, schemaOrOptions, maybeOptions) {
			const codec = this._resolveOutboundCodec(request.method);
			this._assertOutboundRequestInEra(codec, request.method);
			if (isStandardSchema(schemaOrOptions)) return this._requestWithSchemaViaCodec(codec, request, schemaOrOptions, maybeOptions);
			const validate = codecResultValidator(codec, request.method);
			if (validate === void 0) throw new TypeError(`'${request.method}' is not a spec method; pass a result schema as the second argument to request().`);
			return this._requestWithSchemaViaCodec(codec, request, validate, schemaOrOptions);
		}
		/**
		* The wire codec for this instance's negotiated era — the phase-2 truth:
		* everything an established connection sends and receives resolves
		* through it. Legacy until a version has been negotiated.
		*/
		_negotiatedWireCodec() {
			return codecForVersion(this._negotiatedProtocolVersion);
		}
		/**
		* Protected accessor for the instance's negotiated wire codec, for role
		* classes (Client/Server/McpServer) routing era-dependent behavior
		* through the codec's function-only surface — `samplingResultVariant`,
		* `outboundEnvelope`, `projectCallToolResult` — instead of branching on
		* the protocol version themselves.
		*/
		_wireCodec() {
			return this._negotiatedWireCodec();
		}
		/**
		* Outbound codec resolution: while the negotiated version is still unset
		* (the negotiation window), lifecycle messages are bootstrap-pinned BY
		* METHOD — they self-identify their era (`initialize` IS the legacy
		* handshake, `server/discover` IS the modern probe). Once a version has
		* been negotiated, the instance era is authoritative for everything — a
		* negotiated session never re-routes a method onto the other era.
		*/
		_resolveOutboundCodec(method) {
			if (this._negotiatedProtocolVersion === void 0) {
				const pinned = bootstrapOutboundCodec(method);
				if (pinned) return pinned;
			}
			return this._negotiatedWireCodec();
		}
		/**
		* Era gate for outbound requests — deletions are physical in BOTH
		* directions: sending a spec method that the resolved era does not define
		* dies locally with a typed error before anything reaches the transport.
		* Methods outside the spec universe are consumer-owned extension methods
		* and stay era-blind.
		*/
		_assertOutboundRequestInEra(codec, method) {
			if (isSpecRequestMethod(method) && !codec.hasRequestMethod(method)) throw new SdkError(SdkErrorCode.MethodNotSupportedByProtocolVersion, `Method '${method}' is not supported by the negotiated protocol version (wire era ${codec.era})`, {
				method,
				era: codec.era
			});
		}
		/**
		* Sends a request and waits for a response, using the provided schema for
		* validation instead of the era registry's method-keyed entry.
		*
		* This is the internal implementation used by SDK methods whose result
		* schema cannot be expressed as a method-keyed registry entry — the one
		* surviving case is `server.createMessage`, whose result schema depends
		* on the REQUEST params (tools vs no tools) — and by callers passing
		* explicit compatibility schemas. Spec methods are still era-gated here:
		* an explicit schema never smuggles a deleted method onto the wire.
		*/
		_requestWithSchema(request, resultSchema, options) {
			const codec = this._resolveOutboundCodec(request.method);
			this._assertOutboundRequestInEra(codec, request.method);
			return this._requestWithSchemaViaCodec(codec, request, resultSchema, options);
		}
		/**
		* The request funnel proper, keyed by the resolved era codec: the codec
		* owns result decoding (raw-first `resultType` discrimination — V-1 —
		* and the era's lift posture) before the schema validation step.
		*/
		_requestWithSchemaViaCodec(codec, request, resultSchema, options) {
			const { relatedRequestId, resumptionToken, onresumptiontoken, headers } = options ?? {};
			const flowStartedAt = Date.now();
			let onAbort;
			let cleanupMessageId;
			return new Promise((resolve, reject) => {
				const earlyReject = (error) => {
					reject(error);
				};
				if (!this._transport) {
					earlyReject(/* @__PURE__ */ new Error("Not connected"));
					return;
				}
				if (this._options?.enforceStrictCapabilities === true) try {
					this.assertCapabilityForMethod(request.method);
				} catch (error) {
					earlyReject(error);
					return;
				}
				if (options?.signal?.aborted) {
					const reason = options.signal.reason;
					throw reason instanceof SdkError ? reason : new SdkError(SdkErrorCode.RequestTimeout, String(reason));
				}
				const requestAbort = codec.era === "2026-07-28" && this._transport.hasPerRequestStream === true ? new AbortController() : void 0;
				const messageId = this._requestMessageId++;
				cleanupMessageId = messageId;
				const jsonrpcRequest = {
					...request,
					jsonrpc: "2.0",
					id: messageId
				};
				if (options?.onprogress) {
					this._progressHandlers.set(messageId, options.onprogress);
					jsonrpcRequest.params = {
						...request.params,
						_meta: {
							...request.params?._meta,
							progressToken: messageId
						}
					};
				}
				const outbound = this._envelopeOutbound(jsonrpcRequest);
				let responseReceived = false;
				const cancel = (reason) => {
					if (responseReceived) return;
					this._progressHandlers.delete(messageId);
					if (requestAbort === void 0) this._transport?.send(this._envelopeOutbound({
						jsonrpc: "2.0",
						method: "notifications/cancelled",
						params: {
							requestId: messageId,
							reason: String(reason)
						}
					}), {
						relatedRequestId,
						resumptionToken,
						onresumptiontoken
					}).catch((error) => this._onerror(/* @__PURE__ */ new Error(`Failed to send cancellation: ${error}`)));
					else requestAbort.abort();
					reject(reason instanceof SdkError ? reason : new SdkError(SdkErrorCode.RequestTimeout, String(reason)));
				};
				this._responseHandlers.set(messageId, (response) => {
					if (options?.signal?.aborted) return;
					responseReceived = true;
					if (response instanceof Error) return reject(response);
					let decoded;
					try {
						decoded = codec.decodeResult(request.method, response.result);
					} catch (error) {
						return reject(error instanceof Error ? error : new Error(String(error)));
					}
					if (decoded.kind === "invalid") return reject(decoded.error);
					if (decoded.kind === "input_required") {
						if (options?.allowInputRequired === true) return resolve(manualInputRequiredValue(decoded));
						const flow = {
							codec,
							request,
							resultSchema,
							options,
							flowStartedAt,
							retry: (params, legOptions) => this._requestWithSchemaViaCodec(codec, params === void 0 ? { method: request.method } : {
								method: request.method,
								params
							}, resultSchema, legOptions)
						};
						return resolve(this._resolveNonCompleteResult(decoded, flow));
					}
					const result = decoded.result;
					validateStandardSchema(resultSchema, result).then((parseResult) => {
						if (parseResult.success) resolve(parseResult.data);
						else reject(new SdkError(SdkErrorCode.InvalidResult, `Invalid result for ${request.method}: ${parseResult.error}`));
					}, reject);
				});
				onAbort = () => cancel(options?.signal?.reason);
				options?.signal?.addEventListener("abort", onAbort, { once: true });
				const timeout = options?.timeout ?? 6e4;
				const timeoutHandler = () => cancel(new SdkError(SdkErrorCode.RequestTimeout, "Request timed out", { timeout }));
				this._setupTimeout(messageId, timeout, options?.maxTotalTimeout, timeoutHandler, options?.resetTimeoutOnProgress ?? false);
				this._transport.send(outbound, {
					relatedRequestId,
					resumptionToken,
					onresumptiontoken,
					headers,
					requestSignal: requestAbort?.signal
				}).catch((error) => {
					this._progressHandlers.delete(messageId);
					reject(error);
				});
			}).finally(() => {
				if (onAbort) options?.signal?.removeEventListener("abort", onAbort);
				if (cleanupMessageId !== void 0) {
					this._responseHandlers.delete(cleanupMessageId);
					this._cleanupTimeout(cleanupMessageId);
				}
			});
		}
		/**
		* Emits a notification, which is a one-way message that does not expect a response.
		*/
		async notification(notification, options) {
			return this._notificationViaCodec(this._resolveOutboundCodec(notification.method), notification, options);
		}
		/**
		* The notification funnel proper, keyed by the resolved era codec —
		* direct sends and related notifications (`ctx.mcpReq.notify`) alike
		* resolve through the instance's negotiated era at send time.
		*/
		async _notificationViaCodec(codec, notification, options) {
			if (!this._transport) throw new SdkError(SdkErrorCode.NotConnected, "Not connected");
			if (isSpecNotificationMethod(notification.method) && !codec.hasNotificationMethod(notification.method)) throw new SdkError(SdkErrorCode.MethodNotSupportedByProtocolVersion, `Notification '${notification.method}' is not supported by the negotiated protocol version (wire era ${codec.era})`, {
				method: notification.method,
				era: codec.era
			});
			this.assertNotificationCapability(notification.method);
			const jsonrpcNotification = this._envelopeOutbound({
				jsonrpc: "2.0",
				...notification
			});
			if ((this._options?.debouncedNotificationMethods ?? []).includes(notification.method) && !notification.params && !options?.relatedRequestId) {
				if (this._pendingDebouncedNotifications.has(notification.method)) return;
				this._pendingDebouncedNotifications.add(notification.method);
				Promise.resolve().then(() => {
					this._pendingDebouncedNotifications.delete(notification.method);
					if (!this._transport) return;
					this._transport?.send(jsonrpcNotification, options).catch((error) => this._onerror(error));
				});
				return;
			}
			await this._transport.send(jsonrpcNotification, options);
		}
		setRequestHandler(method, schemasOrHandler, maybeHandler) {
			this.assertRequestHandlerCapability(method);
			let stored;
			if (typeof schemasOrHandler === "function") {
				if (!isSpecRequestMethod(method)) throw new TypeError(`'${method}' is not a spec request method; pass schemas as the second argument to setRequestHandler().`);
				stored = (request, ctx) => {
					const dispatchCodec = this._negotiatedWireCodec();
					let outcome = dispatchCodec.validateRequest(method, request);
					if (!outcome.ok && outcome.reason === "not-in-era") outcome = dispatchCodec.validateInputRequest(method, request);
					if (!outcome.ok) {
						if (outcome.reason === "not-in-era") throw new ProtocolError(ProtocolErrorCode.InternalError, `No wire schema for ${method} in the resolved era`);
						throw new Error(outcome.message);
					}
					return Promise.resolve(schemasOrHandler(outcome.value, ctx));
				};
			} else if (maybeHandler) stored = async (request, ctx) => {
				const parsed = await validateStandardSchema(schemasOrHandler.params, { ...request.params });
				if (!parsed.success) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid params for ${method}: ${parsed.error}`);
				return maybeHandler(parsed.data, ctx);
			};
			else throw new TypeError("setRequestHandler: handler is required");
			this._requestHandlers.set(method, this._wrapHandler(method, stored));
		}
		/**
		* Hook for subclasses to wrap a registered request handler with role-specific
		* validation or behavior (e.g. `Server` validates `tools/call` results, `Client`
		* validates `elicitation/create` mode and result). Runs for both the 2-arg and
		* 3-arg registration paths. The default implementation is identity.
		*
		* Subclasses overriding this hook avoid redeclaring `setRequestHandler`'s overload set.
		*/
		_wrapHandler(_method, handler) {
			return handler;
		}
		/**
		* Hook for subclasses to supply the implementation identity the 2026-era
		* encode seam stamps into outbound result `_meta` under
		* `io.modelcontextprotocol/serverInfo` (spec PR #3002: servers SHOULD
		* identify themselves on every response). The default is `undefined` — no
		* stamp. Only `Server` overrides this: the key identifies the software
		* producing a response, and the 2025-era codec never stamps anything
		* regardless (the never-stamp guarantee).
		*/
		_outboundServerInfo() {}
		/**
		* Removes the request handler for the given method.
		*/
		removeRequestHandler(method) {
			this._requestHandlers.delete(method);
		}
		/**
		* Asserts that a request handler has not already been set for the given method, in preparation for a new one being automatically installed.
		*/
		assertCanSetRequestHandler(method) {
			if (this._requestHandlers.has(method)) throw new Error(`A request handler for ${method} already exists, which would be overridden`);
		}
		setNotificationHandler(method, schemasOrHandler, maybeHandler) {
			if (typeof schemasOrHandler === "function") {
				if (!isSpecNotificationMethod(method)) throw new TypeError(`'${method}' is not a spec notification method; pass schemas as the second argument to setNotificationHandler().`);
				this._notificationHandlers.set(method, (notification, codec) => {
					const outcome = codec.validateNotification(method, notification);
					if (!outcome.ok) {
						if (outcome.reason === "not-in-era") throw new ProtocolError(ProtocolErrorCode.InternalError, `No wire schema for ${method} in the resolved era`);
						throw new Error(outcome.message);
					}
					return Promise.resolve(schemasOrHandler(outcome.value));
				});
				return;
			}
			if (!maybeHandler) throw new TypeError("setNotificationHandler: handler is required");
			this._notificationHandlers.set(method, async (notification) => {
				const parsed = await validateStandardSchema(schemasOrHandler.params, { ...notification.params });
				if (!parsed.success) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid params for notification ${method}: ${parsed.error}`);
				await maybeHandler(parsed.data, notification);
			});
		}
		/**
		* Removes the notification handler for the given method.
		*/
		removeNotificationHandler(method) {
			this._notificationHandlers.delete(method);
		}
	};
	function isPlainObject$1(value) {
		return value !== null && typeof value === "object" && !Array.isArray(value);
	}
	function mergeCapabilities(base, additional) {
		const result = { ...base };
		for (const key in additional) {
			const k = key;
			const addValue = additional[k];
			if (addValue === void 0) continue;
			const baseValue = result[k];
			result[k] = isPlainObject$1(baseValue) && isPlainObject$1(addValue) ? {
				...baseValue,
				...addValue
			} : addValue;
		}
		return result;
	}
	/**
	* The multi-round-trip auto-fulfilment ENGINE (protocol revision 2026-07-28):
	* the wiring between the protocol layer's response funnel, the
	* already-registered input handlers, and the pure {@link runInputRequiredDriver}
	* loop. The engine is what the `Client` plugs into the funnel's
	* `_resolveNonCompleteResult` extension point — `Protocol` itself only knows
	* the input-required branch exists.
	*
	* Relocated here so the shared `Protocol` base stays generic: the only
	* MRTR-specific code that remains in `protocol.ts` is the irreducible
	* input-required branch in the response path, the type surface (the
	* `allowInputRequired` request option and the `inputResponses`/`requestState`/
	* `droppedInputResponseKeys` context fields), and the named extension point.
	*/
	function isPlainObject(value) {
		return typeof value === "object" && value !== null && !Array.isArray(value);
	}
	/**
	* Splits a retried request's `inputResponses` map into the BARE response
	* entries the spec defines and everything else. The spec's embedded responses
	* are the bare result objects (an `ElicitResult`, `CreateMessageResult`, or
	* `ListRootsResult`); a wrapped `{method, result}` envelope (a shape some
	* peers emit) is never accepted as a response — its key is recorded so the
	* handler can re-issue the corresponding input request.
	*/
	function partitionInputResponses(inputResponses) {
		const accepted = {};
		const droppedKeys = [];
		if (!isPlainObject(inputResponses)) return {
			accepted,
			droppedKeys
		};
		for (const [key, entry] of Object.entries(inputResponses)) {
			if (!isPlainObject(entry) || "method" in entry || "result" in entry) {
				droppedKeys.push(key);
				continue;
			}
			accepted[key] = entry;
		}
		return {
			accepted,
			droppedKeys
		};
	}
	/**
	* Related send/notify are unavailable inside an embedded input-request
	* handler: the request is fulfilled locally by the multi-round-trip driver,
	* so there is no live peer request to relate messages to.
	*/
	function relatedMessagingUnavailable(member) {
		throw new SdkError(SdkErrorCode.SendFailed, `ctx.mcpReq.${member} is not available while fulfilling an embedded input request: the request is fulfilled locally and has no related peer request`);
	}
	/**
	* The synthesized {@linkcode BaseContext} for an embedded input request: the
	* id is the `inputRequests` key (correlation only — it is not a JSON-RPC
	* message id), the supplied abort signal chains the originating call's signal
	* through, and related `send`/`notify` are unavailable because there is no
	* live peer request to relate them to.
	*/
	function synthesizeInputRequestContext(key, method, params, signal, sessionId) {
		return {
			sessionId,
			mcpReq: {
				id: key,
				method,
				_meta: params?.["_meta"],
				requestState: requestStateAccessor(void 0),
				signal,
				send: (() => relatedMessagingUnavailable("send")),
				notify: () => relatedMessagingUnavailable("notify")
			}
		};
	}
	/**
	* Dispatches one embedded (de-JSON-RPC'd) input request to the locally
	* registered handler for its method and resolves with the bare response.
	*
	* The handler runs through the same stored handler chain as a wire request
	* (including role-specific validation installed by `_wrapHandler`), with a
	* synthesized context (see {@link synthesizeInputRequestContext}).
	*/
	async function dispatchInputRequest(host, codec, key, entry, signal) {
		if (!isPlainObject(entry) || typeof entry["method"] !== "string") throw new SdkError(SdkErrorCode.InvalidResult, `Invalid input request '${key}': each inputRequests entry must be an embedded request object with a method`, { key });
		const method = entry["method"];
		if (!codec.hasInputRequestMethod(method)) throw new SdkError(SdkErrorCode.InvalidResult, `Invalid input request '${key}': '${method}' is not an embedded request the ${codec.era} revision defines (expected elicitation/create, sampling/createMessage, or roots/list)`, {
			key,
			method
		});
		const handler = host.getRequestHandler(method);
		if (handler === void 0) throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Cannot fulfil input request '${key}': no handler is registered for '${method}' on this client. Declare the corresponding capability and register a handler, or handle input_required results manually.`, {
			key,
			method
		});
		const params = isPlainObject(entry["params"]) ? entry["params"] : void 0;
		return await handler({
			jsonrpc: "2.0",
			id: key,
			method,
			...params !== void 0 && { params }
		}, host.buildContext(synthesizeInputRequestContext(key, method, params, signal, host.sessionId)));
	}
	/**
	* Builds the per-retry-leg {@linkcode RequestOptions} from the originating
	* call's options.
	*
	* Only the fields that are correct to apply to every leg carry over (a
	* deliberate whitelist): the per-leg `timeout`, the (shrinking) total budget
	* `maxTotalTimeout`, the caller's `onprogress`/`resetTimeoutOnProgress`, and
	* the caller's abort `signal`. Everything else — in particular
	* `relatedRequestId`, `resumptionToken`, and `onresumptiontoken` — is scoped
	* to the originating wire leg and is NOT inherited by retries.
	*/
	function buildRetryLegRequestOptions(options, legOptions) {
		return {
			...options?.signal !== void 0 && { signal: options.signal },
			...options?.onprogress !== void 0 && { onprogress: options.onprogress },
			...options?.resetTimeoutOnProgress !== void 0 && { resetTimeoutOnProgress: options.resetTimeoutOnProgress },
			...options?.headers !== void 0 && { headers: options.headers },
			...legOptions.timeout !== void 0 && { timeout: legOptions.timeout },
			...legOptions.maxTotalTimeout !== void 0 && { maxTotalTimeout: legOptions.maxTotalTimeout },
			allowInputRequired: true
		};
	}
	/**
	* Runs the auto-fulfilment flow for one originating request whose response
	* came back as `input_required`: builds the driver hooks (embedded-request
	* dispatch + retry through the funnel) and hands them to
	* {@link runInputRequiredDriver}. Resolves with the final complete result
	* (already validated by the retry leg) or rejects with a typed error.
	*/
	function runInputRequiredFlow(host, config, decoded, flow) {
		const { codec, request, options, flowStartedAt } = flow;
		const firstPayload = {
			inputRequests: decoded.inputRequests,
			...decoded.requestState !== void 0 && { requestState: decoded.requestState }
		};
		const hooks = {
			dispatchInputRequest: (key, entry, signal) => dispatchInputRequest(host, codec, key, entry, signal),
			retry: (params, legOptions) => flow.retry(params, buildRetryLegRequestOptions(options, legOptions))
		};
		return runInputRequiredDriver({
			config,
			method: request.method,
			originalParams: request.params,
			firstPayload,
			flowStartedAt,
			signal: options?.signal,
			requestOptions: {
				...options?.timeout !== void 0 && { timeout: options.timeout },
				...options?.maxTotalTimeout !== void 0 && { maxTotalTimeout: options.maxTotalTimeout },
				...options?.onprogress !== void 0 && { onprogress: options.onprogress }
			},
			hooks
		});
	}
	/**
	* Builds the manual-mode {@linkcode InputRequiredResult} value from the
	* codec's decoded payload — what an `allowInputRequired: true` caller
	* receives instead of the auto-fulfilled complete result.
	*/
	function manualInputRequiredValue(decoded) {
		return {
			resultType: "input_required",
			inputRequests: decoded.inputRequests,
			...decoded.requestState !== void 0 && { requestState: decoded.requestState }
		};
	}
	/*!
	* content-type
	* Copyright(c) 2015 Douglas Christopher Wilson
	* MIT Licensed
	*/
	var import_content_type = /* @__PURE__ */ __toESM((/* @__PURE__ */ __commonJSMin(((exports) => {
		/**
		* RegExp to match *( ";" parameter ) in RFC 7231 sec 3.1.1.1
		*
		* parameter     = token "=" ( token / quoted-string )
		* token         = 1*tchar
		* tchar         = "!" / "#" / "$" / "%" / "&" / "'" / "*"
		*               / "+" / "-" / "." / "^" / "_" / "`" / "|" / "~"
		*               / DIGIT / ALPHA
		*               ; any VCHAR, except delimiters
		* quoted-string = DQUOTE *( qdtext / quoted-pair ) DQUOTE
		* qdtext        = HTAB / SP / %x21 / %x23-5B / %x5D-7E / obs-text
		* obs-text      = %x80-FF
		* quoted-pair   = "\" ( HTAB / SP / VCHAR / obs-text )
		*/
		var PARAM_REGEXP = /; *([!#$%&'*+.^_`|~0-9A-Za-z-]+) *= *("(?:[\u000b\u0020\u0021\u0023-\u005b\u005d-\u007e\u0080-\u00ff]|\\[\u000b\u0020-\u00ff])*"|[!#$%&'*+.^_`|~0-9A-Za-z-]+) */g;
		/**
		* RegExp to match quoted-pair in RFC 7230 sec 3.2.6
		*
		* quoted-pair = "\" ( HTAB / SP / VCHAR / obs-text )
		* obs-text    = %x80-FF
		*/
		var QESC_REGEXP = /\\([\u000b\u0020-\u00ff])/g;
		/**
		* RegExp to match type in RFC 7231 sec 3.1.1.1
		*
		* media-type = type "/" subtype
		* type       = token
		* subtype    = token
		*/
		var TYPE_REGEXP = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
		exports.parse = parse;
		/**
		* Parse media type to object.
		*
		* @param {string|object} string
		* @return {Object}
		* @public
		*/
		function parse(string) {
			if (!string) throw new TypeError("argument string is required");
			var header = typeof string === "object" ? getcontenttype(string) : string;
			if (typeof header !== "string") throw new TypeError("argument string is required to be a string");
			var index = header.indexOf(";");
			var type = index !== -1 ? header.slice(0, index).trim() : header.trim();
			if (!TYPE_REGEXP.test(type)) throw new TypeError("invalid media type");
			var obj = new ContentType(type.toLowerCase());
			if (index !== -1) {
				var key;
				var match;
				var value;
				PARAM_REGEXP.lastIndex = index;
				while (match = PARAM_REGEXP.exec(header)) {
					if (match.index !== index) throw new TypeError("invalid parameter format");
					index += match[0].length;
					key = match[1].toLowerCase();
					value = match[2];
					if (value.charCodeAt(0) === 34) {
						value = value.slice(1, -1);
						if (value.indexOf("\\") !== -1) value = value.replace(QESC_REGEXP, "$1");
					}
					obj.parameters[key] = value;
				}
				if (index !== header.length) throw new TypeError("invalid parameter format");
			}
			return obj;
		}
		/**
		* Get content-type from req/res objects.
		*
		* @param {object}
		* @return {Object}
		* @private
		*/
		function getcontenttype(obj) {
			var header;
			if (typeof obj.getHeader === "function") header = obj.getHeader("content-type");
			else if (typeof obj.headers === "object") header = obj.headers && obj.headers["content-type"];
			if (typeof header !== "string") throw new TypeError("content-type header is missing from object");
			return header;
		}
		/**
		* Class to represent a content type.
		* @private
		*/
		function ContentType(type) {
			this.parameters = Object.create(null);
			this.type = type;
		}
	})))(), 1);
	/**
	* Extracts the media type (the lowercased `type/subtype` pair, without
	* parameters) from a raw `Content-Type` header value, or `undefined` when the
	* header is missing or empty.
	*
	* Content-Type comparisons must use the parsed media type, never a substring
	* search of the raw header: a value like `text/plain; a=application/json`
	* contains the substring `application/json` but its media type is
	* `text/plain`, and case variants or parameters make naive string comparison
	* wrong in both directions.
	*
	* "Essence" is the WHATWG MIME Sniffing standard's term for the bare
	* `type/subtype` pair (https://mimesniff.spec.whatwg.org/#mime-type-essence);
	* the Fetch standard's request classification is defined against it
	* (https://fetch.spec.whatwg.org/#cors-safelisted-request-header).
	*
	* Parsing is RFC 9110 (`content-type` package) first. When the parameter
	* section is malformed (`application/json;`, `application/json; charset=`),
	* browsers and most HTTP stacks still derive the media type from the segment
	* before the first `;` — the fallback matches that widely-implemented
	* behavior, so a header whose media type is unambiguous is not rejected for
	* a sloppy parameter section.
	*/
	function mediaTypeEssence(header) {
		if (!header) return;
		try {
			return import_content_type.parse(header).type;
		} catch {
			const essence = (header.split(";", 1)[0] ?? "").trim().toLowerCase();
			if (essence === "" || header.slice(essence.length).includes(",")) return;
			return essence;
		}
	}
	/**
	* Normalizes `HeadersInit` to a plain `Record<string, string>` for manipulation.
	* Handles `Headers` objects, arrays of tuples, and plain objects.
	*/
	function normalizeHeaders(headers) {
		if (!headers) return {};
		if (headers instanceof Headers) return Object.fromEntries(headers.entries());
		if (Array.isArray(headers)) return Object.fromEntries(headers);
		return { ...headers };
	}
	/**
	* Creates a fetch function that includes base `RequestInit` options.
	* This ensures requests inherit settings like credentials, mode, headers, etc. from the base init.
	*
	* @param baseFetch - The base fetch function to wrap (defaults to global `fetch`)
	* @param baseInit - The base `RequestInit` to merge with each request
	* @returns A wrapped fetch function that merges base options with call-specific options
	*/
	function createFetchWithInit(baseFetch = fetch, baseInit) {
		if (!baseInit) return baseFetch;
		return async (url, init) => {
			return baseFetch(url, {
				...baseInit,
				...init,
				headers: init?.headers ? {
					...normalizeHeaders(baseInit.headers),
					...normalizeHeaders(init.headers)
				} : baseInit.headers
			});
		};
	}
	//#endregion
	//#region ../../node_modules/.pnpm/@modelcontextprotocol+client@2.0.0/node_modules/@modelcontextprotocol/client/dist/cfWorkerProvider-BylNJ1R5.mjs
	function deepCompareStrict(a, b) {
		const typeofa = typeof a;
		if (typeofa !== typeof b) return false;
		if (Array.isArray(a)) {
			if (!Array.isArray(b)) return false;
			const length = a.length;
			if (length !== b.length) return false;
			for (let i = 0; i < length; i++) if (!deepCompareStrict(a[i], b[i])) return false;
			return true;
		}
		if (typeofa === "object") {
			if (!a || !b) return a === b;
			const aKeys = Object.keys(a);
			const bKeys = Object.keys(b);
			if (aKeys.length !== bKeys.length) return false;
			for (const k of aKeys) if (!deepCompareStrict(a[k], b[k])) return false;
			return true;
		}
		return a === b;
	}
	function encodePointer(p) {
		return encodeURI(escapePointer(p));
	}
	function escapePointer(p) {
		return p.replace(/~/g, "~0").replace(/\//g, "~1");
	}
	const schemaArrayKeyword = {
		prefixItems: true,
		items: true,
		allOf: true,
		anyOf: true,
		oneOf: true
	};
	const schemaMapKeyword = {
		$defs: true,
		definitions: true,
		properties: true,
		patternProperties: true,
		dependentSchemas: true
	};
	const ignoredKeyword = {
		id: true,
		$id: true,
		$ref: true,
		$schema: true,
		$anchor: true,
		$vocabulary: true,
		$comment: true,
		default: true,
		enum: true,
		const: true,
		required: true,
		type: true,
		maximum: true,
		minimum: true,
		exclusiveMaximum: true,
		exclusiveMinimum: true,
		multipleOf: true,
		maxLength: true,
		minLength: true,
		pattern: true,
		format: true,
		maxItems: true,
		minItems: true,
		uniqueItems: true,
		maxProperties: true,
		minProperties: true
	};
	let initialBaseURI = typeof self !== "undefined" && self.location && self.location.origin !== "null" ? new URL(self.location.origin + self.location.pathname + location.search) : new URL("https://github.com/cfworker");
	function dereference(schema, lookup = Object.create(null), baseURI = initialBaseURI, basePointer = "") {
		if (schema && typeof schema === "object" && !Array.isArray(schema)) {
			const id = schema.$id || schema.id;
			if (id) {
				const url = new URL(id, baseURI.href);
				if (url.hash.length > 1) lookup[url.href] = schema;
				else {
					url.hash = "";
					if (basePointer === "") baseURI = url;
					else dereference(schema, lookup, baseURI);
				}
			}
		} else if (schema !== true && schema !== false) return lookup;
		const schemaURI = baseURI.href + (basePointer ? "#" + basePointer : "");
		if (lookup[schemaURI] !== void 0) throw new Error(`Duplicate schema URI "${schemaURI}".`);
		lookup[schemaURI] = schema;
		if (schema === true || schema === false) return lookup;
		if (schema.__absolute_uri__ === void 0) Object.defineProperty(schema, "__absolute_uri__", {
			enumerable: false,
			value: schemaURI
		});
		if (schema.$ref && schema.__absolute_ref__ === void 0) {
			const url = new URL(schema.$ref, baseURI.href);
			url.hash = url.hash;
			Object.defineProperty(schema, "__absolute_ref__", {
				enumerable: false,
				value: url.href
			});
		}
		if (schema.$recursiveRef && schema.__absolute_recursive_ref__ === void 0) {
			const url = new URL(schema.$recursiveRef, baseURI.href);
			url.hash = url.hash;
			Object.defineProperty(schema, "__absolute_recursive_ref__", {
				enumerable: false,
				value: url.href
			});
		}
		if (schema.$anchor) {
			const url = new URL("#" + schema.$anchor, baseURI.href);
			lookup[url.href] = schema;
		}
		for (let key in schema) {
			if (ignoredKeyword[key]) continue;
			const keyBase = `${basePointer}/${encodePointer(key)}`;
			const subSchema = schema[key];
			if (Array.isArray(subSchema)) {
				if (schemaArrayKeyword[key]) {
					const length = subSchema.length;
					for (let i = 0; i < length; i++) dereference(subSchema[i], lookup, baseURI, `${keyBase}/${i}`);
				}
			} else if (schemaMapKeyword[key]) for (let subKey in subSchema) dereference(subSchema[subKey], lookup, baseURI, `${keyBase}/${encodePointer(subKey)}`);
			else dereference(subSchema, lookup, baseURI, keyBase);
		}
		return lookup;
	}
	const DATE = /^(\d\d\d\d)-(\d\d)-(\d\d)$/;
	const DAYS = [
		0,
		31,
		28,
		31,
		30,
		31,
		30,
		31,
		31,
		30,
		31,
		30,
		31
	];
	const TIME = /^(\d\d):(\d\d):(\d\d)(\.\d+)?(z|[+-]\d\d(?::?\d\d)?)?$/i;
	const HOSTNAME = /^(?=.{1,253}\.?$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[-0-9a-z]{0,61}[0-9a-z])?)*\.?$/i;
	const URIREF = /^(?:[a-z][a-z0-9+\-.]*:)?(?:\/?\/(?:(?:[a-z0-9\-._~!$&'()*+,;=:]|%[0-9a-f]{2})*@)?(?:\[(?:(?:(?:(?:[0-9a-f]{1,4}:){6}|::(?:[0-9a-f]{1,4}:){5}|(?:[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){4}|(?:(?:[0-9a-f]{1,4}:){0,1}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){3}|(?:(?:[0-9a-f]{1,4}:){0,2}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){2}|(?:(?:[0-9a-f]{1,4}:){0,3}[0-9a-f]{1,4})?::[0-9a-f]{1,4}:|(?:(?:[0-9a-f]{1,4}:){0,4}[0-9a-f]{1,4})?::)(?:[0-9a-f]{1,4}:[0-9a-f]{1,4}|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?))|(?:(?:[0-9a-f]{1,4}:){0,5}[0-9a-f]{1,4})?::[0-9a-f]{1,4}|(?:(?:[0-9a-f]{1,4}:){0,6}[0-9a-f]{1,4})?::)|[Vv][0-9a-f]+\.[a-z0-9\-._~!$&'()*+,;=:]+)\]|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)|(?:[a-z0-9\-._~!$&'"()*+,;=]|%[0-9a-f]{2})*)(?::\d*)?(?:\/(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})*)*|\/(?:(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})*)*)?|(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})*)*)?(?:\?(?:[a-z0-9\-._~!$&'"()*+,;=:@/?]|%[0-9a-f]{2})*)?(?:#(?:[a-z0-9\-._~!$&'"()*+,;=:@/?]|%[0-9a-f]{2})*)?$/i;
	const URITEMPLATE = /^(?:(?:[^\x00-\x20"'<>%\\^`{|}]|%[0-9a-f]{2})|\{[+#./;?&=,!@|]?(?:[a-z0-9_]|%[0-9a-f]{2})+(?::[1-9][0-9]{0,3}|\*)?(?:,(?:[a-z0-9_]|%[0-9a-f]{2})+(?::[1-9][0-9]{0,3}|\*)?)*\})*$/i;
	const URL_ = /^(?:(?:https?|ftp):\/\/)(?:\S+(?::\S*)?@)?(?:(?!10(?:\.\d{1,3}){3})(?!127(?:\.\d{1,3}){3})(?!169\.254(?:\.\d{1,3}){2})(?!192\.168(?:\.\d{1,3}){2})(?!172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2})(?:[1-9]\d?|1\d\d|2[01]\d|22[0-3])(?:\.(?:1?\d{1,2}|2[0-4]\d|25[0-5])){2}(?:\.(?:[1-9]\d?|1\d\d|2[0-4]\d|25[0-4]))|(?:(?:[a-z\u{00a1}-\u{ffff}0-9]+-?)*[a-z\u{00a1}-\u{ffff}0-9]+)(?:\.(?:[a-z\u{00a1}-\u{ffff}0-9]+-?)*[a-z\u{00a1}-\u{ffff}0-9]+)*(?:\.(?:[a-z\u{00a1}-\u{ffff}]{2,})))(?::\d{2,5})?(?:\/[^\s]*)?$/iu;
	const UUID = /^(?:urn:uuid:)?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
	const JSON_POINTER = /^(?:\/(?:[^~/]|~0|~1)*)*$/;
	const JSON_POINTER_URI_FRAGMENT = /^#(?:\/(?:[a-z0-9_\-.!$&'()*+,;:=@]|%[0-9a-f]{2}|~0|~1)*)*$/i;
	const RELATIVE_JSON_POINTER = /^(?:0|[1-9][0-9]*)(?:#|(?:\/(?:[^~/]|~0|~1)*)*)$/;
	const EMAIL = (input) => {
		if (input[0] === "\"") return false;
		const [name, host, ...rest] = input.split("@");
		if (!name || !host || rest.length !== 0 || name.length > 64 || host.length > 253) return false;
		if (name[0] === "." || name.endsWith(".") || name.includes("..")) return false;
		if (!/^[a-z0-9.-]+$/i.test(host) || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(name)) return false;
		return host.split(".").every((part) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i.test(part));
	};
	const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)$/;
	const IPV6 = /^((([0-9a-f]{1,4}:){7}([0-9a-f]{1,4}|:))|(([0-9a-f]{1,4}:){6}(:[0-9a-f]{1,4}|((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9a-f]{1,4}:){5}(((:[0-9a-f]{1,4}){1,2})|:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9a-f]{1,4}:){4}(((:[0-9a-f]{1,4}){1,3})|((:[0-9a-f]{1,4})?:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9a-f]{1,4}:){3}(((:[0-9a-f]{1,4}){1,4})|((:[0-9a-f]{1,4}){0,2}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9a-f]{1,4}:){2}(((:[0-9a-f]{1,4}){1,5})|((:[0-9a-f]{1,4}){0,3}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9a-f]{1,4}:){1}(((:[0-9a-f]{1,4}){1,6})|((:[0-9a-f]{1,4}){0,4}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(:(((:[0-9a-f]{1,4}){1,7})|((:[0-9a-f]{1,4}){0,5}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:)))$/i;
	const DURATION = (input) => input.length > 1 && input.length < 80 && (/^P\d+([.,]\d+)?W$/.test(input) || /^P[\dYMDTHS]*(\d[.,]\d+)?[YMDHS]$/.test(input) && /^P([.,\d]+Y)?([.,\d]+M)?([.,\d]+D)?(T([.,\d]+H)?([.,\d]+M)?([.,\d]+S)?)?$/.test(input));
	function bind(r) {
		return r.test.bind(r);
	}
	const format = {
		date,
		time: time.bind(void 0, false),
		"date-time": date_time,
		duration: DURATION,
		uri,
		"uri-reference": bind(URIREF),
		"uri-template": bind(URITEMPLATE),
		url: bind(URL_),
		email: EMAIL,
		hostname: bind(HOSTNAME),
		ipv4: bind(IPV4),
		ipv6: bind(IPV6),
		regex,
		uuid: bind(UUID),
		"json-pointer": bind(JSON_POINTER),
		"json-pointer-uri-fragment": bind(JSON_POINTER_URI_FRAGMENT),
		"relative-json-pointer": bind(RELATIVE_JSON_POINTER)
	};
	function isLeapYear(year) {
		return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	}
	function date(str) {
		const matches = str.match(DATE);
		if (!matches) return false;
		const year = +matches[1];
		const month = +matches[2];
		const day = +matches[3];
		return month >= 1 && month <= 12 && day >= 1 && day <= (month == 2 && isLeapYear(year) ? 29 : DAYS[month]);
	}
	function time(full, str) {
		const matches = str.match(TIME);
		if (!matches) return false;
		const hour = +matches[1];
		const minute = +matches[2];
		const second = +matches[3];
		const timeZone = !!matches[5];
		return (hour <= 23 && minute <= 59 && second <= 59 || hour == 23 && minute == 59 && second == 60) && (!full || timeZone);
	}
	const DATE_TIME_SEPARATOR = /t|\s/i;
	function date_time(str) {
		const dateTime = str.split(DATE_TIME_SEPARATOR);
		return dateTime.length == 2 && date(dateTime[0]) && time(true, dateTime[1]);
	}
	const NOT_URI_FRAGMENT = /\/|:/;
	const URI_PATTERN = /^(?:[a-z][a-z0-9+\-.]*:)(?:\/?\/(?:(?:[a-z0-9\-._~!$&'()*+,;=:]|%[0-9a-f]{2})*@)?(?:\[(?:(?:(?:(?:[0-9a-f]{1,4}:){6}|::(?:[0-9a-f]{1,4}:){5}|(?:[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){4}|(?:(?:[0-9a-f]{1,4}:){0,1}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){3}|(?:(?:[0-9a-f]{1,4}:){0,2}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){2}|(?:(?:[0-9a-f]{1,4}:){0,3}[0-9a-f]{1,4})?::[0-9a-f]{1,4}:|(?:(?:[0-9a-f]{1,4}:){0,4}[0-9a-f]{1,4})?::)(?:[0-9a-f]{1,4}:[0-9a-f]{1,4}|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?))|(?:(?:[0-9a-f]{1,4}:){0,5}[0-9a-f]{1,4})?::[0-9a-f]{1,4}|(?:(?:[0-9a-f]{1,4}:){0,6}[0-9a-f]{1,4})?::)|[Vv][0-9a-f]+\.[a-z0-9\-._~!$&'()*+,;=:]+)\]|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)|(?:[a-z0-9\-._~!$&'()*+,;=]|%[0-9a-f]{2})*)(?::\d*)?(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*|\/(?:(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*)?|(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*)(?:\?(?:[a-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9a-f]{2})*)?(?:#(?:[a-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9a-f]{2})*)?$/i;
	function uri(str) {
		return NOT_URI_FRAGMENT.test(str) && URI_PATTERN.test(str);
	}
	const Z_ANCHOR = /[^\\]\\Z/;
	function regex(str) {
		if (Z_ANCHOR.test(str)) return false;
		try {
			new RegExp(str, "u");
			return true;
		} catch (e) {
			return false;
		}
	}
	function ucs2length(s) {
		let result = 0;
		let length = s.length;
		let index = 0;
		let charCode;
		while (index < length) {
			result++;
			charCode = s.charCodeAt(index++);
			if (charCode >= 55296 && charCode <= 56319 && index < length) {
				charCode = s.charCodeAt(index);
				if ((charCode & 64512) == 56320) index++;
			}
		}
		return result;
	}
	function validate(instance, schema, draft = "2019-09", lookup = dereference(schema), shortCircuit = true, recursiveAnchor = null, instanceLocation = "#", schemaLocation = "#", evaluated = Object.create(null)) {
		if (schema === true) return {
			valid: true,
			errors: []
		};
		if (schema === false) return {
			valid: false,
			errors: [{
				instanceLocation,
				keyword: "false",
				keywordLocation: instanceLocation,
				error: "False boolean schema."
			}]
		};
		const rawInstanceType = typeof instance;
		let instanceType;
		switch (rawInstanceType) {
			case "boolean":
			case "number":
			case "string":
				instanceType = rawInstanceType;
				break;
			case "object":
				if (instance === null) instanceType = "null";
				else if (Array.isArray(instance)) instanceType = "array";
				else instanceType = "object";
				break;
			default: throw new Error(`Instances of "${rawInstanceType}" type are not supported.`);
		}
		const { $ref, $recursiveRef, $recursiveAnchor, type: $type, const: $const, enum: $enum, required: $required, not: $not, anyOf: $anyOf, allOf: $allOf, oneOf: $oneOf, if: $if, then: $then, else: $else, format: $format, properties: $properties, patternProperties: $patternProperties, additionalProperties: $additionalProperties, unevaluatedProperties: $unevaluatedProperties, minProperties: $minProperties, maxProperties: $maxProperties, propertyNames: $propertyNames, dependentRequired: $dependentRequired, dependentSchemas: $dependentSchemas, dependencies: $dependencies, prefixItems: $prefixItems, items: $items, additionalItems: $additionalItems, unevaluatedItems: $unevaluatedItems, contains: $contains, minContains: $minContains, maxContains: $maxContains, minItems: $minItems, maxItems: $maxItems, uniqueItems: $uniqueItems, minimum: $minimum, maximum: $maximum, exclusiveMinimum: $exclusiveMinimum, exclusiveMaximum: $exclusiveMaximum, multipleOf: $multipleOf, minLength: $minLength, maxLength: $maxLength, pattern: $pattern, __absolute_ref__, __absolute_recursive_ref__ } = schema;
		const errors = [];
		if ($recursiveAnchor === true && recursiveAnchor === null) recursiveAnchor = schema;
		if ($recursiveRef === "#") {
			const refSchema = recursiveAnchor === null ? lookup[__absolute_recursive_ref__] : recursiveAnchor;
			const keywordLocation = `${schemaLocation}/$recursiveRef`;
			const result = validate(instance, recursiveAnchor === null ? schema : recursiveAnchor, draft, lookup, shortCircuit, refSchema, instanceLocation, keywordLocation, evaluated);
			if (!result.valid) errors.push({
				instanceLocation,
				keyword: "$recursiveRef",
				keywordLocation,
				error: "A subschema had errors."
			}, ...result.errors);
		}
		if ($ref !== void 0) {
			const refSchema = lookup[__absolute_ref__ || $ref];
			if (refSchema === void 0) {
				let message = `Unresolved $ref "${$ref}".`;
				if (__absolute_ref__ && __absolute_ref__ !== $ref) message += `  Absolute URI "${__absolute_ref__}".`;
				message += `\nKnown schemas:\n- ${Object.keys(lookup).join("\n- ")}`;
				throw new Error(message);
			}
			const keywordLocation = `${schemaLocation}/$ref`;
			const result = validate(instance, refSchema, draft, lookup, shortCircuit, recursiveAnchor, instanceLocation, keywordLocation, evaluated);
			if (!result.valid) errors.push({
				instanceLocation,
				keyword: "$ref",
				keywordLocation,
				error: "A subschema had errors."
			}, ...result.errors);
			if (draft === "4" || draft === "7") return {
				valid: errors.length === 0,
				errors
			};
		}
		if (Array.isArray($type)) {
			let length = $type.length;
			let valid = false;
			for (let i = 0; i < length; i++) if (instanceType === $type[i] || $type[i] === "integer" && instanceType === "number" && instance % 1 === 0 && instance === instance) {
				valid = true;
				break;
			}
			if (!valid) errors.push({
				instanceLocation,
				keyword: "type",
				keywordLocation: `${schemaLocation}/type`,
				error: `Instance type "${instanceType}" is invalid. Expected "${$type.join("\", \"")}".`
			});
		} else if ($type === "integer") {
			if (instanceType !== "number" || instance % 1 || instance !== instance) errors.push({
				instanceLocation,
				keyword: "type",
				keywordLocation: `${schemaLocation}/type`,
				error: `Instance type "${instanceType}" is invalid. Expected "${$type}".`
			});
		} else if ($type !== void 0 && instanceType !== $type) errors.push({
			instanceLocation,
			keyword: "type",
			keywordLocation: `${schemaLocation}/type`,
			error: `Instance type "${instanceType}" is invalid. Expected "${$type}".`
		});
		if ($const !== void 0) {
			if (instanceType === "object" || instanceType === "array") {
				if (!deepCompareStrict(instance, $const)) errors.push({
					instanceLocation,
					keyword: "const",
					keywordLocation: `${schemaLocation}/const`,
					error: `Instance does not match ${JSON.stringify($const)}.`
				});
			} else if (instance !== $const) errors.push({
				instanceLocation,
				keyword: "const",
				keywordLocation: `${schemaLocation}/const`,
				error: `Instance does not match ${JSON.stringify($const)}.`
			});
		}
		if ($enum !== void 0) {
			if (instanceType === "object" || instanceType === "array") {
				if (!$enum.some((value) => deepCompareStrict(instance, value))) errors.push({
					instanceLocation,
					keyword: "enum",
					keywordLocation: `${schemaLocation}/enum`,
					error: `Instance does not match any of ${JSON.stringify($enum)}.`
				});
			} else if (!$enum.some((value) => instance === value)) errors.push({
				instanceLocation,
				keyword: "enum",
				keywordLocation: `${schemaLocation}/enum`,
				error: `Instance does not match any of ${JSON.stringify($enum)}.`
			});
		}
		if ($not !== void 0) {
			const keywordLocation = `${schemaLocation}/not`;
			if (validate(instance, $not, draft, lookup, shortCircuit, recursiveAnchor, instanceLocation, keywordLocation).valid) errors.push({
				instanceLocation,
				keyword: "not",
				keywordLocation,
				error: "Instance matched \"not\" schema."
			});
		}
		let subEvaluateds = [];
		if ($anyOf !== void 0) {
			const keywordLocation = `${schemaLocation}/anyOf`;
			const errorsLength = errors.length;
			let anyValid = false;
			for (let i = 0; i < $anyOf.length; i++) {
				const subSchema = $anyOf[i];
				const subEvaluated = Object.create(evaluated);
				const result = validate(instance, subSchema, draft, lookup, shortCircuit, $recursiveAnchor === true ? recursiveAnchor : null, instanceLocation, `${keywordLocation}/${i}`, subEvaluated);
				errors.push(...result.errors);
				anyValid = anyValid || result.valid;
				if (result.valid) subEvaluateds.push(subEvaluated);
			}
			if (anyValid) errors.length = errorsLength;
			else errors.splice(errorsLength, 0, {
				instanceLocation,
				keyword: "anyOf",
				keywordLocation,
				error: "Instance does not match any subschemas."
			});
		}
		if ($allOf !== void 0) {
			const keywordLocation = `${schemaLocation}/allOf`;
			const errorsLength = errors.length;
			let allValid = true;
			for (let i = 0; i < $allOf.length; i++) {
				const subSchema = $allOf[i];
				const subEvaluated = Object.create(evaluated);
				const result = validate(instance, subSchema, draft, lookup, shortCircuit, $recursiveAnchor === true ? recursiveAnchor : null, instanceLocation, `${keywordLocation}/${i}`, subEvaluated);
				errors.push(...result.errors);
				allValid = allValid && result.valid;
				if (result.valid) subEvaluateds.push(subEvaluated);
			}
			if (allValid) errors.length = errorsLength;
			else errors.splice(errorsLength, 0, {
				instanceLocation,
				keyword: "allOf",
				keywordLocation,
				error: `Instance does not match every subschema.`
			});
		}
		if ($oneOf !== void 0) {
			const keywordLocation = `${schemaLocation}/oneOf`;
			const errorsLength = errors.length;
			const matches = $oneOf.filter((subSchema, i) => {
				const subEvaluated = Object.create(evaluated);
				const result = validate(instance, subSchema, draft, lookup, shortCircuit, $recursiveAnchor === true ? recursiveAnchor : null, instanceLocation, `${keywordLocation}/${i}`, subEvaluated);
				errors.push(...result.errors);
				if (result.valid) subEvaluateds.push(subEvaluated);
				return result.valid;
			}).length;
			if (matches === 1) errors.length = errorsLength;
			else errors.splice(errorsLength, 0, {
				instanceLocation,
				keyword: "oneOf",
				keywordLocation,
				error: `Instance does not match exactly one subschema (${matches} matches).`
			});
		}
		if (instanceType === "object" || instanceType === "array") Object.assign(evaluated, ...subEvaluateds);
		if ($if !== void 0) {
			const keywordLocation = `${schemaLocation}/if`;
			if (validate(instance, $if, draft, lookup, shortCircuit, recursiveAnchor, instanceLocation, keywordLocation, evaluated).valid) {
				if ($then !== void 0) {
					const thenResult = validate(instance, $then, draft, lookup, shortCircuit, recursiveAnchor, instanceLocation, `${schemaLocation}/then`, evaluated);
					if (!thenResult.valid) errors.push({
						instanceLocation,
						keyword: "if",
						keywordLocation,
						error: `Instance does not match "then" schema.`
					}, ...thenResult.errors);
				}
			} else if ($else !== void 0) {
				const elseResult = validate(instance, $else, draft, lookup, shortCircuit, recursiveAnchor, instanceLocation, `${schemaLocation}/else`, evaluated);
				if (!elseResult.valid) errors.push({
					instanceLocation,
					keyword: "if",
					keywordLocation,
					error: `Instance does not match "else" schema.`
				}, ...elseResult.errors);
			}
		}
		if (instanceType === "object") {
			if ($required !== void 0) {
				for (const key of $required) if (!(key in instance)) errors.push({
					instanceLocation,
					keyword: "required",
					keywordLocation: `${schemaLocation}/required`,
					error: `Instance does not have required property "${key}".`
				});
			}
			const keys = Object.keys(instance);
			if ($minProperties !== void 0 && keys.length < $minProperties) errors.push({
				instanceLocation,
				keyword: "minProperties",
				keywordLocation: `${schemaLocation}/minProperties`,
				error: `Instance does not have at least ${$minProperties} properties.`
			});
			if ($maxProperties !== void 0 && keys.length > $maxProperties) errors.push({
				instanceLocation,
				keyword: "maxProperties",
				keywordLocation: `${schemaLocation}/maxProperties`,
				error: `Instance does not have at least ${$maxProperties} properties.`
			});
			if ($propertyNames !== void 0) {
				const keywordLocation = `${schemaLocation}/propertyNames`;
				for (const key in instance) {
					const subInstancePointer = `${instanceLocation}/${encodePointer(key)}`;
					const result = validate(key, $propertyNames, draft, lookup, shortCircuit, recursiveAnchor, subInstancePointer, keywordLocation);
					if (!result.valid) errors.push({
						instanceLocation,
						keyword: "propertyNames",
						keywordLocation,
						error: `Property name "${key}" does not match schema.`
					}, ...result.errors);
				}
			}
			if ($dependentRequired !== void 0) {
				const keywordLocation = `${schemaLocation}/dependantRequired`;
				for (const key in $dependentRequired) if (key in instance) {
					const required = $dependentRequired[key];
					for (const dependantKey of required) if (!(dependantKey in instance)) errors.push({
						instanceLocation,
						keyword: "dependentRequired",
						keywordLocation,
						error: `Instance has "${key}" but does not have "${dependantKey}".`
					});
				}
			}
			if ($dependentSchemas !== void 0) for (const key in $dependentSchemas) {
				const keywordLocation = `${schemaLocation}/dependentSchemas`;
				if (key in instance) {
					const result = validate(instance, $dependentSchemas[key], draft, lookup, shortCircuit, recursiveAnchor, instanceLocation, `${keywordLocation}/${encodePointer(key)}`, evaluated);
					if (!result.valid) errors.push({
						instanceLocation,
						keyword: "dependentSchemas",
						keywordLocation,
						error: `Instance has "${key}" but does not match dependant schema.`
					}, ...result.errors);
				}
			}
			if ($dependencies !== void 0) {
				const keywordLocation = `${schemaLocation}/dependencies`;
				for (const key in $dependencies) if (key in instance) {
					const propsOrSchema = $dependencies[key];
					if (Array.isArray(propsOrSchema)) {
						for (const dependantKey of propsOrSchema) if (!(dependantKey in instance)) errors.push({
							instanceLocation,
							keyword: "dependencies",
							keywordLocation,
							error: `Instance has "${key}" but does not have "${dependantKey}".`
						});
					} else {
						const result = validate(instance, propsOrSchema, draft, lookup, shortCircuit, recursiveAnchor, instanceLocation, `${keywordLocation}/${encodePointer(key)}`);
						if (!result.valid) errors.push({
							instanceLocation,
							keyword: "dependencies",
							keywordLocation,
							error: `Instance has "${key}" but does not match dependant schema.`
						}, ...result.errors);
					}
				}
			}
			const thisEvaluated = Object.create(null);
			let stop = false;
			if ($properties !== void 0) {
				const keywordLocation = `${schemaLocation}/properties`;
				for (const key in $properties) {
					if (!(key in instance)) continue;
					const subInstancePointer = `${instanceLocation}/${encodePointer(key)}`;
					const result = validate(instance[key], $properties[key], draft, lookup, shortCircuit, recursiveAnchor, subInstancePointer, `${keywordLocation}/${encodePointer(key)}`);
					if (result.valid) evaluated[key] = thisEvaluated[key] = true;
					else {
						stop = shortCircuit;
						errors.push({
							instanceLocation,
							keyword: "properties",
							keywordLocation,
							error: `Property "${key}" does not match schema.`
						}, ...result.errors);
						if (stop) break;
					}
				}
			}
			if (!stop && $patternProperties !== void 0) {
				const keywordLocation = `${schemaLocation}/patternProperties`;
				for (const pattern in $patternProperties) {
					const regex$1 = new RegExp(pattern, "u");
					const subSchema = $patternProperties[pattern];
					for (const key in instance) {
						if (!regex$1.test(key)) continue;
						const subInstancePointer = `${instanceLocation}/${encodePointer(key)}`;
						const result = validate(instance[key], subSchema, draft, lookup, shortCircuit, recursiveAnchor, subInstancePointer, `${keywordLocation}/${encodePointer(pattern)}`);
						if (result.valid) evaluated[key] = thisEvaluated[key] = true;
						else {
							stop = shortCircuit;
							errors.push({
								instanceLocation,
								keyword: "patternProperties",
								keywordLocation,
								error: `Property "${key}" matches pattern "${pattern}" but does not match associated schema.`
							}, ...result.errors);
						}
					}
				}
			}
			if (!stop && $additionalProperties !== void 0) {
				const keywordLocation = `${schemaLocation}/additionalProperties`;
				for (const key in instance) {
					if (thisEvaluated[key]) continue;
					const subInstancePointer = `${instanceLocation}/${encodePointer(key)}`;
					const result = validate(instance[key], $additionalProperties, draft, lookup, shortCircuit, recursiveAnchor, subInstancePointer, keywordLocation);
					if (result.valid) evaluated[key] = true;
					else {
						stop = shortCircuit;
						errors.push({
							instanceLocation,
							keyword: "additionalProperties",
							keywordLocation,
							error: `Property "${key}" does not match additional properties schema.`
						}, ...result.errors);
					}
				}
			} else if (!stop && $unevaluatedProperties !== void 0) {
				const keywordLocation = `${schemaLocation}/unevaluatedProperties`;
				for (const key in instance) if (!evaluated[key]) {
					const subInstancePointer = `${instanceLocation}/${encodePointer(key)}`;
					const result = validate(instance[key], $unevaluatedProperties, draft, lookup, shortCircuit, recursiveAnchor, subInstancePointer, keywordLocation);
					if (result.valid) evaluated[key] = true;
					else errors.push({
						instanceLocation,
						keyword: "unevaluatedProperties",
						keywordLocation,
						error: `Property "${key}" does not match unevaluated properties schema.`
					}, ...result.errors);
				}
			}
		} else if (instanceType === "array") {
			if ($maxItems !== void 0 && instance.length > $maxItems) errors.push({
				instanceLocation,
				keyword: "maxItems",
				keywordLocation: `${schemaLocation}/maxItems`,
				error: `Array has too many items (${instance.length} > ${$maxItems}).`
			});
			if ($minItems !== void 0 && instance.length < $minItems) errors.push({
				instanceLocation,
				keyword: "minItems",
				keywordLocation: `${schemaLocation}/minItems`,
				error: `Array has too few items (${instance.length} < ${$minItems}).`
			});
			const length = instance.length;
			let i = 0;
			let stop = false;
			if ($prefixItems !== void 0) {
				const keywordLocation = `${schemaLocation}/prefixItems`;
				const length2 = Math.min($prefixItems.length, length);
				for (; i < length2; i++) {
					const result = validate(instance[i], $prefixItems[i], draft, lookup, shortCircuit, recursiveAnchor, `${instanceLocation}/${i}`, `${keywordLocation}/${i}`);
					evaluated[i] = true;
					if (!result.valid) {
						stop = shortCircuit;
						errors.push({
							instanceLocation,
							keyword: "prefixItems",
							keywordLocation,
							error: `Items did not match schema.`
						}, ...result.errors);
						if (stop) break;
					}
				}
			}
			if ($items !== void 0) {
				const keywordLocation = `${schemaLocation}/items`;
				if (Array.isArray($items)) {
					const length2 = Math.min($items.length, length);
					for (; i < length2; i++) {
						const result = validate(instance[i], $items[i], draft, lookup, shortCircuit, recursiveAnchor, `${instanceLocation}/${i}`, `${keywordLocation}/${i}`);
						evaluated[i] = true;
						if (!result.valid) {
							stop = shortCircuit;
							errors.push({
								instanceLocation,
								keyword: "items",
								keywordLocation,
								error: `Items did not match schema.`
							}, ...result.errors);
							if (stop) break;
						}
					}
				} else for (; i < length; i++) {
					const result = validate(instance[i], $items, draft, lookup, shortCircuit, recursiveAnchor, `${instanceLocation}/${i}`, keywordLocation);
					evaluated[i] = true;
					if (!result.valid) {
						stop = shortCircuit;
						errors.push({
							instanceLocation,
							keyword: "items",
							keywordLocation,
							error: `Items did not match schema.`
						}, ...result.errors);
						if (stop) break;
					}
				}
				if (!stop && $additionalItems !== void 0) {
					const keywordLocation$1 = `${schemaLocation}/additionalItems`;
					for (; i < length; i++) {
						const result = validate(instance[i], $additionalItems, draft, lookup, shortCircuit, recursiveAnchor, `${instanceLocation}/${i}`, keywordLocation$1);
						evaluated[i] = true;
						if (!result.valid) {
							stop = shortCircuit;
							errors.push({
								instanceLocation,
								keyword: "additionalItems",
								keywordLocation: keywordLocation$1,
								error: `Items did not match additional items schema.`
							}, ...result.errors);
						}
					}
				}
			}
			if ($contains !== void 0) if (length === 0 && $minContains === void 0) errors.push({
				instanceLocation,
				keyword: "contains",
				keywordLocation: `${schemaLocation}/contains`,
				error: `Array is empty. It must contain at least one item matching the schema.`
			});
			else if ($minContains !== void 0 && length < $minContains) errors.push({
				instanceLocation,
				keyword: "minContains",
				keywordLocation: `${schemaLocation}/minContains`,
				error: `Array has less items (${length}) than minContains (${$minContains}).`
			});
			else {
				const keywordLocation = `${schemaLocation}/contains`;
				const errorsLength = errors.length;
				let contained = 0;
				for (let j = 0; j < length; j++) {
					const result = validate(instance[j], $contains, draft, lookup, shortCircuit, recursiveAnchor, `${instanceLocation}/${j}`, keywordLocation);
					if (result.valid) {
						evaluated[j] = true;
						contained++;
					} else errors.push(...result.errors);
				}
				if (contained >= ($minContains || 0)) errors.length = errorsLength;
				if ($minContains === void 0 && $maxContains === void 0 && contained === 0) errors.splice(errorsLength, 0, {
					instanceLocation,
					keyword: "contains",
					keywordLocation,
					error: `Array does not contain item matching schema.`
				});
				else if ($minContains !== void 0 && contained < $minContains) errors.push({
					instanceLocation,
					keyword: "minContains",
					keywordLocation: `${schemaLocation}/minContains`,
					error: `Array must contain at least ${$minContains} items matching schema. Only ${contained} items were found.`
				});
				else if ($maxContains !== void 0 && contained > $maxContains) errors.push({
					instanceLocation,
					keyword: "maxContains",
					keywordLocation: `${schemaLocation}/maxContains`,
					error: `Array may contain at most ${$maxContains} items matching schema. ${contained} items were found.`
				});
			}
			if (!stop && $unevaluatedItems !== void 0) {
				const keywordLocation = `${schemaLocation}/unevaluatedItems`;
				for (; i < length; i++) {
					if (evaluated[i]) continue;
					const result = validate(instance[i], $unevaluatedItems, draft, lookup, shortCircuit, recursiveAnchor, `${instanceLocation}/${i}`, keywordLocation);
					evaluated[i] = true;
					if (!result.valid) errors.push({
						instanceLocation,
						keyword: "unevaluatedItems",
						keywordLocation,
						error: `Items did not match unevaluated items schema.`
					}, ...result.errors);
				}
			}
			if ($uniqueItems) for (let j = 0; j < length; j++) {
				const a = instance[j];
				const ao = typeof a === "object" && a !== null;
				for (let k = 0; k < length; k++) {
					if (j === k) continue;
					const b = instance[k];
					if (a === b || ao && typeof b === "object" && b !== null && deepCompareStrict(a, b)) {
						errors.push({
							instanceLocation,
							keyword: "uniqueItems",
							keywordLocation: `${schemaLocation}/uniqueItems`,
							error: `Duplicate items at indexes ${j} and ${k}.`
						});
						j = Number.MAX_SAFE_INTEGER;
						k = Number.MAX_SAFE_INTEGER;
					}
				}
			}
		} else if (instanceType === "number") {
			if (draft === "4") {
				if ($minimum !== void 0 && ($exclusiveMinimum === true && instance <= $minimum || instance < $minimum)) errors.push({
					instanceLocation,
					keyword: "minimum",
					keywordLocation: `${schemaLocation}/minimum`,
					error: `${instance} is less than ${$exclusiveMinimum ? "or equal to " : ""} ${$minimum}.`
				});
				if ($maximum !== void 0 && ($exclusiveMaximum === true && instance >= $maximum || instance > $maximum)) errors.push({
					instanceLocation,
					keyword: "maximum",
					keywordLocation: `${schemaLocation}/maximum`,
					error: `${instance} is greater than ${$exclusiveMaximum ? "or equal to " : ""} ${$maximum}.`
				});
			} else {
				if ($minimum !== void 0 && instance < $minimum) errors.push({
					instanceLocation,
					keyword: "minimum",
					keywordLocation: `${schemaLocation}/minimum`,
					error: `${instance} is less than ${$minimum}.`
				});
				if ($maximum !== void 0 && instance > $maximum) errors.push({
					instanceLocation,
					keyword: "maximum",
					keywordLocation: `${schemaLocation}/maximum`,
					error: `${instance} is greater than ${$maximum}.`
				});
				if ($exclusiveMinimum !== void 0 && instance <= $exclusiveMinimum) errors.push({
					instanceLocation,
					keyword: "exclusiveMinimum",
					keywordLocation: `${schemaLocation}/exclusiveMinimum`,
					error: `${instance} is less than ${$exclusiveMinimum}.`
				});
				if ($exclusiveMaximum !== void 0 && instance >= $exclusiveMaximum) errors.push({
					instanceLocation,
					keyword: "exclusiveMaximum",
					keywordLocation: `${schemaLocation}/exclusiveMaximum`,
					error: `${instance} is greater than or equal to ${$exclusiveMaximum}.`
				});
			}
			if ($multipleOf !== void 0) {
				const remainder = instance % $multipleOf;
				if (Math.abs(0 - remainder) >= 1.1920929e-7 && Math.abs($multipleOf - remainder) >= 1.1920929e-7) errors.push({
					instanceLocation,
					keyword: "multipleOf",
					keywordLocation: `${schemaLocation}/multipleOf`,
					error: `${instance} is not a multiple of ${$multipleOf}.`
				});
			}
		} else if (instanceType === "string") {
			const length = $minLength === void 0 && $maxLength === void 0 ? 0 : ucs2length(instance);
			if ($minLength !== void 0 && length < $minLength) errors.push({
				instanceLocation,
				keyword: "minLength",
				keywordLocation: `${schemaLocation}/minLength`,
				error: `String is too short (${length} < ${$minLength}).`
			});
			if ($maxLength !== void 0 && length > $maxLength) errors.push({
				instanceLocation,
				keyword: "maxLength",
				keywordLocation: `${schemaLocation}/maxLength`,
				error: `String is too long (${length} > ${$maxLength}).`
			});
			if ($pattern !== void 0 && !new RegExp($pattern, "u").test(instance)) errors.push({
				instanceLocation,
				keyword: "pattern",
				keywordLocation: `${schemaLocation}/pattern`,
				error: `String does not match pattern.`
			});
			if ($format !== void 0 && format[$format] && !format[$format](instance)) errors.push({
				instanceLocation,
				keyword: "format",
				keywordLocation: `${schemaLocation}/format`,
				error: `String does not match format "${$format}".`
			});
		}
		return {
			valid: errors.length === 0,
			errors
		};
	}
	var Validator = class {
		schema;
		draft;
		shortCircuit;
		lookup;
		constructor(schema, draft = "2019-09", shortCircuit = true) {
			this.schema = schema;
			this.draft = draft;
			this.shortCircuit = shortCircuit;
			this.lookup = dereference(schema);
		}
		validate(instance) {
			return validate(instance, this.schema, this.draft, this.lookup, this.shortCircuit);
		}
		addSchema(schema, id) {
			if (id) schema = {
				...schema,
				$id: id
			};
			dereference(schema, this.lookup);
		}
	};
	/**
	* Cloudflare Worker-compatible JSON Schema validator provider
	*
	* This provider uses @cfworker/json-schema for validation without code generation,
	* making it compatible with edge runtimes like Cloudflare Workers that restrict
	* eval and new Function.
	*
	* @see {@linkcode AjvJsonSchemaValidator} for the Node.js alternative
	*/
	/**
	* `@cfworker/json-schema`-backed JSON Schema validator. See
	* `@modelcontextprotocol/{client,server}/validators/cf-worker` for the customisation entry point.
	*
	* Default dispatches on the schema's declared dialect: no `$schema` or 2020-12 → `'2020-12'`
	* (SEP-1613); 2019-09 → `'2019-09'`; draft-07 or draft-06 → `'7'`. Schemas declaring any other `$schema` are rejected
	* with a plain `Error`. Passing an explicit `draft` to the constructor
	* overrides this — that draft is used for every schema regardless of `$schema`.
	*
	* Known draft-07 engine gap: `@cfworker/json-schema` does not treat draft-07 `dependencies` as
	* a name→subschema map during `$ref` collection, so a dependency entry whose KEY collides with
	* a JSON Schema keyword (`type`, `default`, `format`, `required`, `pattern`, …) and whose
	* subschema contains a `$ref` throws `Unresolved $ref` at validation time when the dependency
	* triggers — data-dependently, not at compile. The Node (classic Ajv) engine handles the same
	* schema correctly. Callers that hit this receive the SDK's typed validation error (the throw
	* is captured by the validation paths), and the deviation is pinned by a recorded-contract test.
	*
	* @example Use with default configuration (2020-12, shortcircuit on)
	* ```ts source="./cfWorkerProvider.examples.ts#CfWorkerJsonSchemaValidator_default"
	* const validator = new CfWorkerJsonSchemaValidator();
	* ```
	*
	* @example Use with custom configuration
	* ```ts source="./cfWorkerProvider.examples.ts#CfWorkerJsonSchemaValidator_customConfig"
	* const validator = new CfWorkerJsonSchemaValidator({
	*     draft: '2020-12',
	*     shortcircuit: false // Report all errors
	* });
	* ```
	*/
	var CfWorkerJsonSchemaValidator = class {
		shortcircuit;
		/** Caller-supplied draft; when set, the `$schema` check is skipped (caller owns dialect). */
		draft;
		/**
		* Create a validator
		*
		* @param options - Configuration options
		* @param options.shortcircuit - If `true`, stop validation after first error (default: `true`)
		* @param options.draft - JSON Schema draft version to force for every schema. When set, the
		* `$schema` dispatch is skipped. When omitted, the provider dispatches on each schema's
		* declared `$schema` (2020-12, 2019-09, draft-07, draft-06; absent means 2020-12) and rejects others.
		*/
		constructor(options) {
			this.shortcircuit = options?.shortcircuit ?? true;
			this.draft = options?.draft;
		}
		/**
		* Pick the engine draft for a schema's declared dialect (a caller-forced `{draft}` bypasses
		* this — do not second-guess by `$schema`). No `$schema` or 2020-12 → `'2020-12'`; 2019-09 →
		* `'2019-09'`; draft-07 or draft-06 → `'7'`; anything else → `Error`.
		*/
		_draftFor(schema) {
			const dialect = declaredDialect(schema, "pass an explicit { draft } to CfWorkerJsonSchemaValidator to validate other dialects.");
			return dialect === "draft-7" ? "7" : dialect;
		}
		/**
		* Create a validator for the given JSON Schema
		*
		* Unlike AJV, this validator is not cached internally
		*
		* @param schema - Standard JSON Schema object
		* @returns A validator function that validates input data
		*/
		getValidator(schema) {
			const validator = new Validator(schema, this.draft ?? this._draftFor(schema), this.shortcircuit);
			return (input) => {
				const result = validator.validate(input);
				return result.valid ? {
					valid: true,
					data: input,
					errorMessage: void 0
				} : {
					valid: false,
					data: void 0,
					errorMessage: result.errors.map((err) => `${err.instanceLocation}: ${err.error}`).join("; ")
				};
			};
		}
	};
	//#endregion
	//#region ../../node_modules/.pnpm/pkce-challenge@5.0.1/node_modules/pkce-challenge/dist/index.browser.js
	let crypto;
	crypto = globalThis.crypto;
	/**
	* Creates an array of length `size` of random bytes
	* @param size
	* @returns Array of random ints (0 to 255)
	*/
	async function getRandomValues(size) {
		return (await crypto).getRandomValues(new Uint8Array(size));
	}
	/** Generate cryptographically strong random string
	* @param size The desired length of the string
	* @returns The random string
	*/
	async function random(size) {
		const mask = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
		const evenDistCutoff = Math.pow(2, 8) - Math.pow(2, 8) % 66;
		let result = "";
		while (result.length < size) {
			const randomBytes = await getRandomValues(size - result.length);
			for (const randomByte of randomBytes) if (randomByte < evenDistCutoff) result += mask[randomByte % 66];
		}
		return result;
	}
	/** Generate a PKCE challenge verifier
	* @param length Length of the verifier
	* @returns A random verifier `length` characters long
	*/
	async function generateVerifier(length) {
		return await random(length);
	}
	/** Generate a PKCE code challenge from a code verifier
	* @param code_verifier
	* @returns The base64 url encoded code challenge
	*/
	async function generateChallenge(code_verifier) {
		const buffer = await (await crypto).subtle.digest("SHA-256", new TextEncoder().encode(code_verifier));
		return btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\//g, "_").replace(/\+/g, "-").replace(/=/g, "");
	}
	/** Generate a PKCE challenge pair
	* @param length Length of the verifer (between 43-128). Defaults to 43.
	* @returns PKCE challenge pair
	*/
	async function pkceChallenge(length) {
		if (!length) length = 43;
		if (length < 43 || length > 128) throw `Expected a length between 43 and 128. Received ${length}.`;
		const verifier = await generateVerifier(length);
		return {
			code_verifier: verifier,
			code_challenge: await generateChallenge(verifier)
		};
	}
	//#endregion
	//#region ../../node_modules/.pnpm/eventsource-parser@3.1.0/node_modules/eventsource-parser/dist/index.js
	var ParseError = class extends Error {
		constructor(message, options) {
			super(message), this.name = "ParseError", this.type = options.type, this.field = options.field, this.value = options.value, this.line = options.line;
		}
	};
	const LF = 10;
	const CR = 13;
	const SPACE = 32;
	function noop(_arg) {}
	function createParser(config) {
		if (typeof config == "function") throw new TypeError("`config` must be an object, got a function instead. Did you mean `createParser({onEvent: fn})`?");
		const { onEvent = noop, onError = noop, onRetry = noop, onComment, maxBufferSize } = config, pendingFragments = [];
		let pendingFragmentsLength = 0, isFirstChunk = !0, id, data = "", dataLines = 0, eventType, terminated = !1;
		function feed(chunk) {
			if (terminated) throw new Error("Cannot feed parser: it was terminated after exceeding the configured max buffer size. Call `reset()` to resume parsing.");
			if (isFirstChunk && (isFirstChunk = !1, chunk.charCodeAt(0) === 239 && chunk.charCodeAt(1) === 187 && chunk.charCodeAt(2) === 191 && (chunk = chunk.slice(3))), pendingFragments.length === 0) {
				const trailing2 = processLines(chunk);
				trailing2 !== "" && (pendingFragments.push(trailing2), pendingFragmentsLength = trailing2.length), checkBufferSize();
				return;
			}
			if (chunk.indexOf(`
`) === -1 && chunk.indexOf("\r") === -1) {
				pendingFragments.push(chunk), pendingFragmentsLength += chunk.length, checkBufferSize();
				return;
			}
			pendingFragments.push(chunk);
			const input = pendingFragments.join("");
			pendingFragments.length = 0, pendingFragmentsLength = 0;
			const trailing = processLines(input);
			trailing !== "" && (pendingFragments.push(trailing), pendingFragmentsLength = trailing.length), checkBufferSize();
		}
		function checkBufferSize() {
			maxBufferSize !== void 0 && (pendingFragmentsLength + data.length <= maxBufferSize || (terminated = !0, pendingFragments.length = 0, pendingFragmentsLength = 0, id = void 0, data = "", dataLines = 0, eventType = void 0, onError(new ParseError(`Buffered data exceeded max buffer size of ${maxBufferSize} characters`, { type: "max-buffer-size-exceeded" }))));
		}
		function processLines(chunk) {
			let searchIndex = 0;
			if (chunk.indexOf("\r") === -1) {
				let lfIndex = chunk.indexOf(`
`, searchIndex);
				for (; lfIndex !== -1;) {
					if (searchIndex === lfIndex) {
						dataLines > 0 && onEvent({
							id,
							event: eventType,
							data
						}), id = void 0, data = "", dataLines = 0, eventType = void 0, searchIndex = lfIndex + 1, lfIndex = chunk.indexOf(`
`, searchIndex);
						continue;
					}
					const firstCharCode = chunk.charCodeAt(searchIndex);
					if (isDataPrefix(chunk, searchIndex, firstCharCode)) {
						const valueStart = chunk.charCodeAt(searchIndex + 5) === SPACE ? searchIndex + 6 : searchIndex + 5, value = chunk.slice(valueStart, lfIndex);
						if (dataLines === 0 && chunk.charCodeAt(lfIndex + 1) === LF) {
							onEvent({
								id,
								event: eventType,
								data: value
							}), id = void 0, data = "", eventType = void 0, searchIndex = lfIndex + 2, lfIndex = chunk.indexOf(`
`, searchIndex);
							continue;
						}
						data = dataLines === 0 ? value : `${data}
${value}`, dataLines++;
					} else isEventPrefix(chunk, searchIndex, firstCharCode) ? eventType = chunk.slice(chunk.charCodeAt(searchIndex + 6) === SPACE ? searchIndex + 7 : searchIndex + 6, lfIndex) || void 0 : parseLine(chunk, searchIndex, lfIndex);
					searchIndex = lfIndex + 1, lfIndex = chunk.indexOf(`
`, searchIndex);
				}
				return chunk.slice(searchIndex);
			}
			for (; searchIndex < chunk.length;) {
				const crIndex = chunk.indexOf("\r", searchIndex), lfIndex = chunk.indexOf(`
`, searchIndex);
				let lineEnd = -1;
				if (crIndex !== -1 && lfIndex !== -1 ? lineEnd = crIndex < lfIndex ? crIndex : lfIndex : crIndex !== -1 ? crIndex === chunk.length - 1 ? lineEnd = -1 : lineEnd = crIndex : lfIndex !== -1 && (lineEnd = lfIndex), lineEnd === -1) break;
				parseLine(chunk, searchIndex, lineEnd), searchIndex = lineEnd + 1, chunk.charCodeAt(searchIndex - 1) === CR && chunk.charCodeAt(searchIndex) === LF && searchIndex++;
			}
			return chunk.slice(searchIndex);
		}
		function parseLine(chunk, start, end) {
			if (start === end) {
				dispatchEvent();
				return;
			}
			const firstCharCode = chunk.charCodeAt(start);
			if (isDataPrefix(chunk, start, firstCharCode)) {
				const valueStart = chunk.charCodeAt(start + 5) === SPACE ? start + 6 : start + 5, value2 = chunk.slice(valueStart, end);
				data = dataLines === 0 ? value2 : `${data}
${value2}`, dataLines++;
				return;
			}
			if (isEventPrefix(chunk, start, firstCharCode)) {
				eventType = chunk.slice(chunk.charCodeAt(start + 6) === SPACE ? start + 7 : start + 6, end) || void 0;
				return;
			}
			if (firstCharCode === 105 && chunk.charCodeAt(start + 1) === 100 && chunk.charCodeAt(start + 2) === 58) {
				const value2 = chunk.slice(chunk.charCodeAt(start + 3) === SPACE ? start + 4 : start + 3, end);
				id = value2.includes("\0") ? void 0 : value2;
				return;
			}
			if (firstCharCode === 58) {
				if (onComment) {
					const line2 = chunk.slice(start, end);
					onComment(line2.slice(chunk.charCodeAt(start + 1) === SPACE ? 2 : 1));
				}
				return;
			}
			const line = chunk.slice(start, end), fieldSeparatorIndex = line.indexOf(":");
			if (fieldSeparatorIndex === -1) {
				processField(line, "", line);
				return;
			}
			const field = line.slice(0, fieldSeparatorIndex), offset = line.charCodeAt(fieldSeparatorIndex + 1) === SPACE ? 2 : 1;
			processField(field, line.slice(fieldSeparatorIndex + offset), line);
		}
		function processField(field, value, line) {
			switch (field) {
				case "event":
					eventType = value || void 0;
					break;
				case "data":
					data = dataLines === 0 ? value : `${data}
${value}`, dataLines++;
					break;
				case "id":
					id = value.includes("\0") ? void 0 : value;
					break;
				case "retry":
					/^\d+$/.test(value) ? onRetry(parseInt(value, 10)) : onError(new ParseError(`Invalid \`retry\` value: "${value}"`, {
						type: "invalid-retry",
						value,
						line
					}));
					break;
				default: onError(new ParseError(`Unknown field "${field.length > 20 ? `${field.slice(0, 20)}\u2026` : field}"`, {
					type: "unknown-field",
					field,
					value,
					line
				}));
			}
		}
		function dispatchEvent() {
			dataLines > 0 && onEvent({
				id,
				event: eventType,
				data
			}), id = void 0, data = "", dataLines = 0, eventType = void 0;
		}
		function reset(options = {}) {
			if (options.consume && pendingFragments.length > 0) {
				const incompleteLine = pendingFragments.join("");
				parseLine(incompleteLine, 0, incompleteLine.length);
			}
			isFirstChunk = !0, id = void 0, data = "", dataLines = 0, eventType = void 0, pendingFragments.length = 0, pendingFragmentsLength = 0, terminated = !1;
		}
		return {
			feed,
			reset
		};
	}
	function isDataPrefix(chunk, i, firstCharCode) {
		return firstCharCode === 100 && chunk.charCodeAt(i + 1) === 97 && chunk.charCodeAt(i + 2) === 116 && chunk.charCodeAt(i + 3) === 97 && chunk.charCodeAt(i + 4) === 58;
	}
	function isEventPrefix(chunk, i, firstCharCode) {
		return firstCharCode === 101 && chunk.charCodeAt(i + 1) === 118 && chunk.charCodeAt(i + 2) === 101 && chunk.charCodeAt(i + 3) === 110 && chunk.charCodeAt(i + 4) === 116 && chunk.charCodeAt(i + 5) === 58;
	}
	//#endregion
	//#region ../../node_modules/.pnpm/eventsource-parser@3.1.0/node_modules/eventsource-parser/dist/stream.js
	var EventSourceParserStream = class extends TransformStream {
		constructor({ onError, onRetry, onComment, maxBufferSize } = {}) {
			let parser;
			super({
				start(controller) {
					parser = createParser({
						onEvent: (event) => {
							controller.enqueue(event);
						},
						onError(error) {
							typeof onError == "function" && onError(error), (onError === "terminate" || error.type === "max-buffer-size-exceeded") && controller.error(error);
						},
						onRetry,
						onComment,
						maxBufferSize
					});
				},
				transform(chunk) {
					parser.feed(chunk);
				}
			});
		}
	};
	//#endregion
	//#region ../../node_modules/.pnpm/@modelcontextprotocol+client@2.0.0/node_modules/@modelcontextprotocol/client/dist/index.mjs
	/**
	* Base class for the OAuth-client-flow error family. Concrete subclasses are
	* added to this module alongside the SEP-2468/837/2207/2350/2352 behavior
	* changes that throw them, so callers can catch the whole family with a single
	* `instanceof OAuthClientFlowError` guard once those land.
	*
	* @remarks Nothing in the SDK throws this base class directly. In the release
	* that introduces it no subclass exists yet — the guard is a forward-compat
	* hook and will not match anything until the first behavior change ships.
	*/
	var OAuthClientFlowError = class extends Error {
		static {
			Object.defineProperty(this, "mcpBrand", { value: "mcp.OAuthClientFlowError" });
		}
		static [Symbol.hasInstance](value) {
			return brandedHasInstance(this, value);
		}
		/**
		* Brand-based type guard: equivalent to `value instanceof this`, as an
		* explicit static predicate (the axios/AWS-SDK `isInstance` style). Reads
		* the caller's own brand via `this`, so every branded subclass gets a
		* correctly-scoped guard by inheritance. Must be invoked on the class —
		* in callback position write `v => SdkError.isInstance(v)`, not
		* `.filter(SdkError.isInstance)` (detached calls throw rather than
		* silently matching nothing).
		*/
		static isInstance(value) {
			if (typeof this !== "function") throw new TypeError("isInstance must be called on the class (e.g. `SdkError.isInstance(value)`); for callbacks use `v => SdkError.isInstance(v)`");
			return brandedHasInstance(this, value);
		}
		constructor(message) {
			super(message);
			this.name = new.target.name;
			stampErrorBrands(this, new.target);
		}
	};
	/**
	* Thrown when an authorization-server issuer identifier fails validation.
	*
	* Two checks raise this error, distinguished by {@linkcode IssuerMismatchError.kind | kind}:
	* - `'metadata'` — the `issuer` in fetched authorization-server metadata does
	*   not match the issuer identifier the well-known URL was constructed from
	*   (RFC 8414 §3.3 / OpenID Connect Discovery §4.3).
	* - `'authorization_response'` — the `iss` parameter on the authorization
	*   callback failed RFC 9207 §2.4 validation against the recorded issuer.
	*
	* Intentionally does **not** extend `OAuthError`: the `auth()`
	* orchestrator's `OAuthError` retry block must not swallow this — a mix-up
	* indication is fatal for the flow, not a retryable credential problem.
	*
	* On the `'authorization_response'` path the {@linkcode IssuerMismatchError.received | received}
	* value is attacker-controllable in a mix-up attack; callers **MUST NOT** display
	* it (or any `error`/`error_description`/`error_uri` from the same callback) to
	* end users. The values are JSON-encoded in the message to neutralize log-injection.
	*/
	var IssuerMismatchError = class extends OAuthClientFlowError {
		static {
			Object.defineProperty(this, "mcpBrand", { value: "mcp.IssuerMismatchError" });
		}
		/** Which check failed — metadata echo (RFC 8414 §3.3) or authorization-response `iss` (RFC 9207). */
		kind;
		/** The issuer the client expected (from validated metadata / discovery input). */
		expected;
		/** The issuer value that was received. Attacker-controllable on the `'authorization_response'` path. */
		received;
		constructor(kind, expected, received) {
			super(`Issuer mismatch in ${kind === "metadata" ? "authorization server metadata (RFC 8414 §3.3)" : "authorization response (RFC 9207)"}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(received)}`);
			this.kind = kind;
			this.expected = expected;
			this.received = received;
		}
	};
	/**
	* Thrown by `registerClient()` when the authorization server rejects a
	* Dynamic Client Registration request. Carries the HTTP status, the raw
	* response body, and the metadata that was submitted, so callers can inspect
	* the AS's `error` / `error_description` and retry with adjusted metadata
	* (for example a different `application_type`) per SEP-837.
	*
	* The `body` is the raw RFC 7591 error JSON; compare `JSON.parse(body).error`
	* against `OAuthErrorCode` (e.g. `OAuthErrorCode.InvalidRedirectUri`,
	* `OAuthErrorCode.InvalidClientMetadata`).
	*
	* Intentionally does **not** extend `OAuthError`: registration rejection is
	* not a recoverable-by-credential-invalidation condition, and staying outside
	* that hierarchy keeps it from being caught by `auth()`'s `OAuthError` retry
	* path.
	*/
	var RegistrationRejectedError = class extends OAuthClientFlowError {
		static {
			Object.defineProperty(this, "mcpBrand", { value: "mcp.RegistrationRejectedError" });
		}
		/** HTTP status code returned by the registration endpoint. */
		status;
		/** Raw response body text (typically an RFC 7591 error JSON document). */
		body;
		/** The exact client metadata that was POSTed (after SDK defaults were applied). */
		submittedMetadata;
		constructor(args) {
			super(`Dynamic Client Registration rejected (HTTP ${args.status}): ${args.body}`);
			this.status = args.status;
			this.body = args.body;
			this.submittedMetadata = args.submittedMetadata;
		}
	};
	/**
	* Thrown by the token-exchange and refresh paths when the resolved token
	* endpoint is not `https:` and is not a loopback host (SEP-2207). This is a
	* configuration error — re-authorizing cannot fix it — so it intentionally does
	* **not** extend `OAuthError` and `auth()`'s refresh branch rethrows it instead
	* of falling through to a fresh `/authorize` redirect.
	*/
	var InsecureTokenEndpointError = class extends OAuthClientFlowError {
		static {
			Object.defineProperty(this, "mcpBrand", { value: "mcp.InsecureTokenEndpointError" });
		}
		/** The token endpoint URL that was rejected. */
		tokenEndpoint;
		constructor(tokenEndpoint) {
			super(`Refusing to send credentials to non-https token endpoint '${tokenEndpoint}'. OAuth token requests MUST use TLS (localhost / 127.0.0.1 / ::1 are exempt).`);
			this.tokenEndpoint = tokenEndpoint;
		}
	};
	/**
	* Thrown by the HTTP client transport when the server responds with
	* `403 Forbidden` and `WWW-Authenticate: Bearer error="insufficient_scope"`,
	* and either (a) the transport's `onInsufficientScope` option is `'throw'`, or
	* (b) `onInsufficientScope` is the default `'reauthorize'` but the transport
	* has no {@linkcode index.OAuthClientProvider | OAuthClientProvider} to drive
	* step-up (e.g. a minimal `AuthProvider`, `requestInit`-only headers, or no
	* `authProvider`).
	*
	* Carries the challenge parameters so the host can decide whether to initiate
	* step-up authorization itself (e.g., behind a UX gate) or surface the error.
	*
	* Does **not** extend `OAuthError`: that class represents OAuth protocol errors
	* from the authorization server; this is a resource-server challenge surfaced
	* at the transport layer.
	*
	* All fields originate from the resource server's `WWW-Authenticate` header;
	* treat them as untrusted input when displaying or logging (this includes
	* `requiredScope`, which appears in the error message).
	*/
	/**
	* Thrown by `auth()` on the authorization-code callback leg when the
	* authorization server resolved by discovery differs from the one recorded in
	* `discoveryState()` at redirect time. The `authorization_code` and PKCE
	* `code_verifier` are bound to the AS that minted the code (RFC 7636); sending
	* them to a different AS's token endpoint is a credential-exfiltration vector.
	*
	* This is the only runtime check left in the SEP-2352 model — stored tokens and
	* client credentials are protected structurally by the `issuer` stamp instead.
	*/
	var AuthorizationServerMismatchError = class extends OAuthClientFlowError {
		static {
			Object.defineProperty(this, "mcpBrand", { value: "mcp.AuthorizationServerMismatchError" });
		}
		constructor(recordedIssuer, currentIssuer) {
			super(`Authorization server changed between redirect and callback (redirected to ${JSON.stringify(recordedIssuer)}, callback resolved ${JSON.stringify(currentIssuer)}); refusing to send authorization_code/code_verifier to a different token endpoint`);
			this.recordedIssuer = recordedIssuer;
			this.currentIssuer = currentIssuer;
		}
	};
	var InsufficientScopeError = class extends OAuthClientFlowError {
		static {
			Object.defineProperty(this, "mcpBrand", { value: "mcp.InsufficientScopeError" });
		}
		/** The `scope` value from the `WWW-Authenticate` challenge — the scopes the resource server says are required. */
		requiredScope;
		/** The `resource_metadata` URL from the `WWW-Authenticate` challenge, if present. */
		resourceMetadataUrl;
		/** The `error_description` from the `WWW-Authenticate` challenge, if present. */
		errorDescription;
		constructor(init) {
			super(`Insufficient scope${init.requiredScope ? `: required "${init.requiredScope}"` : ""}`);
			this.requiredScope = init.requiredScope;
			this.resourceMetadataUrl = init.resourceMetadataUrl;
			this.errorDescription = init.errorDescription;
		}
	};
	/**
	* SEP-2352 stamp check: returns `stored` only when its `issuer` stamp matches the
	* resolved authorization server. A stamp that names a *different* issuer reads back
	* as `undefined`, so a credential issued by one authorization server is never reused
	* at another — the flow falls through to re-registration / re-authorization exactly
	* as if nothing were stored. An unstamped value (legacy provider or pre-SEP-2352
	* storage) is returned as-is with a `console.warn`; {@linkcode auth} writes the
	* stamp back on first use so the window closes after one call.
	*
	* {@linkcode auth} stamps every value it writes via `saveTokens` / `saveClientInformation`,
	* so a provider that round-trips the stored object verbatim is protected with no extra
	* code. Providers that hold credentials for multiple authorization servers key their
	* storage on `ctx.issuer` instead.
	*
	* @param opts.canPersistStamp - When `false`, suppresses the unstamped-credential
	*   warning: the caller cannot back-stamp (no `saveClientInformation`), so the
	*   "binding on first use" claim would be false and would fire on every call.
	*/
	function discardIfIssuerMismatch(stored, issuer, opts) {
		if (stored === void 0) return void 0;
		if (stored.issuer === void 0) {
			if (opts?.canPersistStamp !== false) console.warn("[mcp-sdk] SEP-2352: stored OAuth credential has no 'issuer' stamp (pre-upgrade storage or provider not round-tripping the value). SEP-2352 isolation is inactive for this read; ensure your provider round-trips the issuer field.");
			return stored;
		}
		return issuersMatch(stored.issuer, issuer) ? stored : void 0;
	}
	/**
	* SEP-2352 issuer-identity comparison. Tolerates a single trailing `/` difference,
	* mirroring the RFC 8414 §3.3 "one narrow tolerance" applied at metadata-echo
	* validation in {@linkcode discoverAuthorizationServerMetadata}: when the SDK
	* derives an issuer from `String(new URL(...))` (always slash-suffixed) and the AS
	* publishes a slash-free `metadata.issuer`, the two name the same authorization
	* server.
	*/
	function issuersMatch(a, b) {
		return a === b || a.endsWith("/") && a.slice(0, -1) === b || b.endsWith("/") && b.slice(0, -1) === a;
	}
	/**
	* Type guard distinguishing `OAuthClientProvider` from a minimal `AuthProvider`.
	* Transports use this at construction time to classify the `authProvider` option.
	*
	* Checks for `tokens()` + `clientInformation()` — two required `OAuthClientProvider`
	* methods that a minimal `AuthProvider` `{ token: ... }` would never have.
	*/
	function isOAuthClientProvider(provider) {
		if (provider == null) return false;
		const p = provider;
		return typeof p.tokens === "function" && typeof p.clientInformation === "function";
	}
	/**
	* Standard `onUnauthorized` behavior for OAuth providers: extracts
	* `WWW-Authenticate` parameters from the 401 response and runs {@linkcode auth}.
	* Used by {@linkcode adaptOAuthProvider} to bridge `OAuthClientProvider` to `AuthProvider`.
	*/
	async function handleOAuthUnauthorized(provider, ctx, extraAuthOptions) {
		const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(ctx.response);
		if (await auth(provider, {
			serverUrl: ctx.serverUrl,
			resourceMetadataUrl,
			scope,
			fetchFn: ctx.fetchFn,
			...extraAuthOptions
		}) !== "AUTHORIZED") throw new UnauthorizedError();
	}
	/**
	* Adapts an `OAuthClientProvider` to the minimal `AuthProvider` interface that
	* transports consume. Called once at transport construction — the transport stores
	* the adapted provider for `_commonHeaders()` and 401 handling, while keeping the
	* original `OAuthClientProvider` for OAuth-specific paths (`finishAuth()`, 403 `insufficient_scope` step-up).
	*
	* SEP-2352 note: `token()` here is the per-request `Authorization: Bearer …` read for
	* the *resource server* (the MCP transport URL), not an authorization server. No OAuth
	* discovery has run at this layer, so there is no `issuer` to pass as `ctx` and no
	* {@linkcode discardIfIssuerMismatch} check to apply — the access token is sent only to
	* the resource server, never to an AS, so the SEP-2352 cross-AS isolation invariant is
	* not in scope. Providers that key storage on `ctx.issuer` MUST treat `ctx === undefined`
	* as "return the most-recently-saved token set" (the only consumer is the resource server
	* the token was minted for); providers that round-trip a single blob need no change.
	*/
	function adaptOAuthProvider(provider, extraAuthOptions) {
		return {
			token: async () => {
				return (await provider.tokens())?.access_token;
			},
			onUnauthorized: async (ctx) => handleOAuthUnauthorized(provider, ctx, extraAuthOptions)
		};
	}
	var UnauthorizedError = class extends Error {
		static {
			Object.defineProperty(this, "mcpBrand", { value: "mcp.UnauthorizedError" });
		}
		static [Symbol.hasInstance](value) {
			return brandedHasInstance(this, value);
		}
		/**
		* Brand-based type guard: equivalent to `value instanceof this`, as an
		* explicit static predicate (the axios/AWS-SDK `isInstance` style). Reads
		* the caller's own brand via `this`, so every branded subclass gets a
		* correctly-scoped guard by inheritance. Must be invoked on the class —
		* in callback position write `v => SdkError.isInstance(v)`, not
		* `.filter(SdkError.isInstance)` (detached calls throw rather than
		* silently matching nothing).
		*/
		static isInstance(value) {
			if (typeof this !== "function") throw new TypeError("isInstance must be called on the class (e.g. `SdkError.isInstance(value)`); for callbacks use `v => SdkError.isInstance(v)`");
			return brandedHasInstance(this, value);
		}
		constructor(message) {
			super(message ?? "Unauthorized");
			this.name = "UnauthorizedError";
			stampErrorBrands(this, new.target);
		}
	};
	/**
	* Validates the `iss` parameter from an authorization response against the
	* issuer recorded from the authorization server's validated metadata, per
	* RFC 9207 §2.4 and the MCP specification's four-row decision table.
	*
	* | `issParameterSupported` | `iss`   | Action                                           |
	* | ----------------------- | ------- | ------------------------------------------------ |
	* | `true`                  | present | compare; throw {@linkcode IssuerMismatchError} on mismatch |
	* | `true`                  | absent  | throw {@linkcode IssuerMismatchError}            |
	* | `false`                 | present | compare; throw {@linkcode IssuerMismatchError} on mismatch |
	* | `false`                 | absent  | proceed (no-op)                                  |
	*
	* Comparison is **simple string equality** (RFC 3986 §6.2.1). Scheme/host case
	* folding, default-port elision, trailing-slash, and percent-encoding
	* normalization are explicitly **not** applied — any difference is a mismatch.
	*
	* When `expectedIssuer` is `undefined` (no validated metadata document exists),
	* the check has no authentic baseline and degenerates to a no-op.
	*
	* @throws {IssuerMismatchError} with `kind: 'authorization_response'`
	*/
	/**
	* Reads RFC 9207's `authorization_response_iss_parameter_supported` from
	* authorization-server metadata. Only a literal `true` counts as advertised;
	* absent, `false`, or a non-boolean wire value (coerced to `undefined` by the
	* schema) means not advertised.
	*/
	function isIssParameterSupported(metadata) {
		return metadata?.authorization_response_iss_parameter_supported === true;
	}
	function validateAuthorizationResponseIssuer({ iss, expectedIssuer, issParameterSupported }) {
		if (expectedIssuer === void 0) return;
		if (iss === void 0) {
			if (issParameterSupported) throw new IssuerMismatchError("authorization_response", expectedIssuer, void 0);
			return;
		}
		if (iss !== expectedIssuer) throw new IssuerMismatchError("authorization_response", expectedIssuer, iss);
	}
	/**
	* Computes the union of one or more OAuth `scope` strings.
	*
	* Each argument is a space-delimited scope string per RFC 6749 §3.3, or
	* `undefined`. The result is a single space-delimited string containing each
	* distinct scope token exactly once, in first-seen order, or `undefined` if
	* every input is empty/undefined.
	*
	* No hierarchical deduplication is performed: a union may contain semantically
	* redundant entries (e.g., a broad scope alongside a narrower one it implies).
	* Authorization servers normalize such redundancy during token issuance; the
	* spec's step-up flow does not require clients to.
	*
	* Used by the transport's `403 insufficient_scope` step-up path to accumulate
	* previously-requested scopes with newly-challenged scopes so re-authorization
	* does not lose previously-granted permissions.
	*/
	function computeScopeUnion(...scopes) {
		const seen = /* @__PURE__ */ new Set();
		for (const scope of scopes) {
			if (!scope) continue;
			for (const token of scope.split(/\s+/)) if (token) seen.add(token);
		}
		return seen.size > 0 ? [...seen].join(" ") : void 0;
	}
	/**
	* Whether `union` contains at least one scope token not present in `current`.
	* Both arguments are space-delimited scope strings per RFC 6749 §3.3.
	*
	* Used to gate the step-up refresh bypass: when the union of previously-requested
	* and newly-challenged scopes is a strict superset of the current token's
	* granted scope, refreshing cannot widen the grant (RFC 6749 §6), so the
	* transport must force a fresh authorization request instead. When the current
	* token already covers the union, refresh remains valid.
	*
	* An undefined or empty `current` is treated as the empty set, so any non-empty
	* `union` is a strict superset. Note that per RFC 6749 §3.3 an authorization
	* server MAY omit the token's `scope` field when it equals the requested scope;
	* this helper is conservative and treats an absent token `scope` as empty, so
	* step-up always forces a fresh authorization request in that case rather than
	* risking a refresh that silently drops the widened scope.
	*/
	function isStrictScopeSuperset(union, current) {
		if (!union) return false;
		const currentSet = new Set((current ?? "").split(/\s+/).filter(Boolean));
		for (const token of union.split(/\s+/)) if (token && !currentSet.has(token)) return true;
		return false;
	}
	/**
	* Shared `finishAuth` resolver for the `(code, iss?)` and `(URLSearchParams)` overloads.
	*
	* For the `URLSearchParams` form, only `iss` and `code` are read up front. When a `code` is
	* present the returned values flow into {@linkcode auth}, which runs
	* {@linkcode validateAuthorizationResponseIssuer} against freshly-discovered metadata before
	* the code is redeemed — so on mismatch the thrown {@linkcode IssuerMismatchError} carries no
	* `error`/`error_description`/`error_uri` text from the callback (those are attacker-controlled
	* in a mix-up). When no `code` is present (an error-shaped callback), `iss` is validated here
	* against the provider's recorded discovery state — or, when the provider does not implement
	* `discoveryState`, against freshly-discovered metadata mirroring what {@linkcode auth} does on
	* the code-present path — **before** the callback's error parameters are read; only after that
	* passes are they surfaced as an {@linkcode OAuthError}. When no issuer baseline can be
	* obtained either way, a generic {@linkcode UnauthorizedError} is thrown without surfacing the
	* callback's `error`/`error_description`/`error_uri`.
	*
	* @internal Exported for the transport `finishAuth` overloads; not part of the public barrel.
	*/
	async function resolveAuthorizationCallbackParams(codeOrParams, iss, provider, serverUrl, opts) {
		if (typeof codeOrParams === "string") return {
			authorizationCode: codeOrParams,
			iss
		};
		const issParam = codeOrParams.get("iss") ?? void 0;
		const code = codeOrParams.get("code");
		if (code) return {
			authorizationCode: code,
			iss: issParam
		};
		let metadata = (await provider.discoveryState?.())?.authorizationServerMetadata;
		if (!metadata) try {
			metadata = (await discoverOAuthServerInfo(serverUrl, opts)).authorizationServerMetadata;
		} catch {
			metadata = void 0;
		}
		if (!metadata) throw new UnauthorizedError("Authorization callback failed and the issuer could not be verified");
		validateAuthorizationResponseIssuer({
			iss: issParam,
			expectedIssuer: metadata.issuer,
			issParameterSupported: isIssParameterSupported(metadata)
		});
		const error = codeOrParams.get("error");
		if (error) throw new OAuthError(error, codeOrParams.get("error_description") ?? error, codeOrParams.get("error_uri") ?? void 0);
		throw new UnauthorizedError("Authorization callback contained neither `code` nor `error`");
	}
	function isClientAuthMethod(method) {
		return [
			"client_secret_basic",
			"client_secret_post",
			"none"
		].includes(method);
	}
	const AUTHORIZATION_CODE_RESPONSE_TYPE = "code";
	const AUTHORIZATION_CODE_CHALLENGE_METHOD = "S256";
	/**
	* Determines the best client authentication method to use based on server support and client configuration.
	*
	* Priority order (highest to lowest):
	* 1. `client_secret_basic` (if client secret is available)
	* 2. `client_secret_post` (if client secret is available)
	* 3. `none` (for public clients)
	*
	* @param clientInformation - OAuth client information containing credentials
	* @param supportedMethods - Authentication methods supported by the authorization server
	* @returns The selected authentication method
	*/
	function selectClientAuthMethod(clientInformation, supportedMethods) {
		const hasClientSecret = clientInformation.client_secret !== void 0;
		if ("token_endpoint_auth_method" in clientInformation && clientInformation.token_endpoint_auth_method && isClientAuthMethod(clientInformation.token_endpoint_auth_method) && (supportedMethods.length === 0 || supportedMethods.includes(clientInformation.token_endpoint_auth_method))) return clientInformation.token_endpoint_auth_method;
		if (supportedMethods.length === 0) return hasClientSecret ? "client_secret_basic" : "none";
		if (hasClientSecret && supportedMethods.includes("client_secret_basic")) return "client_secret_basic";
		if (hasClientSecret && supportedMethods.includes("client_secret_post")) return "client_secret_post";
		if (supportedMethods.includes("none")) return "none";
		return hasClientSecret ? "client_secret_post" : "none";
	}
	/**
	* Applies client authentication to the request based on the specified method.
	*
	* Implements OAuth 2.1 client authentication methods:
	* - `client_secret_basic`: HTTP Basic authentication (RFC 6749 Section 2.3.1)
	* - `client_secret_post`: Credentials in request body (RFC 6749 Section 2.3.1)
	* - `none`: Public client authentication (RFC 6749 Section 2.1)
	*
	* @param method - The authentication method to use
	* @param clientInformation - OAuth client information containing credentials
	* @param headers - HTTP headers object to modify
	* @param params - URL search parameters to modify
	* @throws {Error} When required credentials are missing
	*/
	function applyClientAuthentication(method, clientInformation, headers, params) {
		const { client_id, client_secret } = clientInformation;
		switch (method) {
			case "client_secret_basic":
				applyBasicAuth(client_id, client_secret, headers);
				return;
			case "client_secret_post":
				applyPostAuth(client_id, client_secret, params);
				return;
			case "none":
				applyPublicAuth(client_id, params);
				return;
			default: throw new Error(`Unsupported client authentication method: ${method}`);
		}
	}
	/**
	* Applies HTTP Basic authentication (RFC 6749 Section 2.3.1)
	*/
	function applyBasicAuth(clientId, clientSecret, headers) {
		if (!clientSecret) throw new Error("client_secret_basic authentication requires a client_secret");
		const credentials = btoa(`${clientId}:${clientSecret}`);
		headers.set("Authorization", `Basic ${credentials}`);
	}
	/**
	* Applies POST body authentication (RFC 6749 Section 2.3.1)
	*/
	function applyPostAuth(clientId, clientSecret, params) {
		params.set("client_id", clientId);
		if (clientSecret) params.set("client_secret", clientSecret);
	}
	/**
	* Applies public client authentication (RFC 6749 Section 2.1)
	*/
	function applyPublicAuth(clientId, params) {
		params.set("client_id", clientId);
	}
	/** Loopback hosts exempt from the in-transit `https:` requirement (RFC 8252 §7.3). */
	function isLoopbackHost(hostname) {
		return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
	}
	/**
	* SEP-2207: refuse to send credentials to a non-TLS, non-loopback token endpoint.
	* Throws {@linkcode InsecureTokenEndpointError}. Loopback hosts are exempt.
	*/
	function assertSecureTokenEndpoint(tokenEndpoint) {
		const url = new URL(String(tokenEndpoint));
		if (url.protocol !== "https:" && !isLoopbackHost(url.hostname)) throw new InsecureTokenEndpointError(url.href);
		return url;
	}
	/**
	* Derives an OIDC `application_type` from a client's registered redirect URIs
	* when the consumer has not set one explicitly (SEP-837). Loopback hosts and
	* non-`http(s)` custom URI schemes indicate a native application (RFC 8252);
	* everything else is treated as a web application. The result is a heuristic
	* default — callers that know better should set `clientMetadata.application_type`
	* themselves, which {@linkcode resolveClientMetadata} never overwrites.
	*
	* A mixed redirect set (for example a public `https:` URI alongside a loopback
	* URI) is inherently ambiguous under OIDC DCR §2 — neither value satisfies the
	* AS for both URIs — so consumers with mixed sets should set `application_type`
	* explicitly rather than relying on this heuristic.
	*/
	function deriveApplicationType(redirectUris) {
		for (const raw of redirectUris ?? []) {
			let url;
			try {
				url = new URL(raw);
			} catch {
				continue;
			}
			if (url.protocol !== "http:" && url.protocol !== "https:") return "native";
			if (isLoopbackHost(url.hostname)) return "native";
		}
		return "web";
	}
	/**
	* Reads {@linkcode OAuthClientProvider.clientMetadata | clientMetadata} from the
	* provider and fills the SEP-837 / SEP-2207 defaults the SDK relies on, so
	* {@linkcode registerClient} sees a consistent, fully-populated document.
	*
	* - `grant_types` defaults to `['authorization_code', 'refresh_token']` for
	*   interactive providers (those with a {@linkcode OAuthClientProvider.redirectUrl | redirectUrl})
	*   so authorization servers that gate refresh-token issuance on the registered
	*   grant types issue one (SEP-2207). Non-interactive providers (no
	*   `redirectUrl`) get no `grant_types` default. This default applies to the
	*   Dynamic Client Registration body only — it does **not** drive
	*   {@linkcode determineScope}'s `offline_access` augmentation.
	* - `application_type` defaults from `redirect_uris`: loopback redirect hosts
	*   and custom URI schemes → `'native'`, otherwise `'web'` (SEP-837 / RFC 8252).
	*
	* A field the consumer set explicitly is **never** overwritten. {@linkcode auth}
	* calls this once at the top of the flow; direct callers of
	* {@linkcode registerClient} that want the same defaults should pass the result
	* of this function as `clientMetadata`.
	*/
	function resolveClientMetadata(provider) {
		const clientMetadata = provider.clientMetadata;
		return {
			...clientMetadata,
			grant_types: clientMetadata.grant_types ?? (provider.redirectUrl === void 0 ? void 0 : ["authorization_code", "refresh_token"]),
			application_type: clientMetadata.application_type ?? deriveApplicationType(clientMetadata.redirect_uris)
		};
	}
	/**
	* Parses an OAuth error response from a string or Response object.
	*
	* If the input is a standard OAuth2.0 error response, it will be parsed according to the spec
	* and an {@linkcode OAuthError} will be returned with the appropriate error code.
	* If parsing fails, it falls back to a generic {@linkcode OAuthErrorCode.ServerError | ServerError} that includes
	* the response status (if available) and original content.
	*
	* @param input - A Response object or string containing the error response
	* @returns A Promise that resolves to an {@linkcode OAuthError} instance
	*/
	async function parseErrorResponse(input) {
		const statusCode = input instanceof Response ? input.status : void 0;
		const body = input instanceof Response ? await input.text() : input;
		try {
			const result = OAuthErrorResponseSchema.parse(JSON.parse(body));
			return OAuthError.fromResponse(result);
		} catch (error) {
			const errorMessage = `${statusCode ? `HTTP ${statusCode}: ` : ""}Invalid OAuth error response: ${error}. Raw body: ${body}`;
			return new OAuthError(OAuthErrorCode.ServerError, errorMessage);
		}
	}
	/**
	* Orchestrates the full auth flow with a server.
	*
	* This can be used as a single entry point for all authorization functionality,
	* instead of linking together the other lower-level functions in this module.
	*/
	async function auth(provider, options) {
		try {
			return await authInternal(provider, options);
		} catch (error) {
			if (error instanceof OAuthError) {
				if (error.code === OAuthErrorCode.InvalidClient || error.code === OAuthErrorCode.UnauthorizedClient) {
					await provider.invalidateCredentials?.("client");
					await provider.invalidateCredentials?.("tokens");
					return await authInternal(provider, options);
				} else if (error.code === OAuthErrorCode.InvalidGrant) {
					await provider.invalidateCredentials?.("tokens");
					return await authInternal(provider, options);
				}
			}
			throw error;
		}
	}
	/**
	* Selects scopes per the MCP spec and augment for refresh token support.
	*/
	function determineScope(options) {
		const { requestedScope, resourceMetadata, authServerMetadata, clientMetadata } = options;
		let effectiveScope = requestedScope || resourceMetadata?.scopes_supported?.join(" ") || clientMetadata.scope;
		if (effectiveScope && authServerMetadata?.scopes_supported?.includes("offline_access") && !effectiveScope.split(" ").includes("offline_access") && clientMetadata.grant_types?.includes("refresh_token")) effectiveScope = `${effectiveScope} offline_access`;
		return effectiveScope;
	}
	async function authInternal(provider, { serverUrl, authorizationCode, iss, scope, resourceMetadataUrl, fetchFn, skipIssuerMetadataValidation, forceReauthorization }) {
		const clientMetadata = resolveClientMetadata(provider);
		const cachedState = await provider.discoveryState?.();
		let resourceMetadata;
		let authorizationServerUrl;
		let metadata;
		let freshDiscoveryState;
		let effectiveResourceMetadataUrl = resourceMetadataUrl;
		if (!effectiveResourceMetadataUrl && cachedState?.resourceMetadataUrl) effectiveResourceMetadataUrl = new URL(cachedState.resourceMetadataUrl);
		if (cachedState?.authorizationServerUrl) {
			authorizationServerUrl = cachedState.authorizationServerUrl;
			resourceMetadata = cachedState.resourceMetadata;
			metadata = cachedState.authorizationServerMetadata ?? await discoverAuthorizationServerMetadata(authorizationServerUrl, {
				fetchFn,
				skipIssuerValidation: skipIssuerMetadataValidation
			});
			if (!resourceMetadata) try {
				resourceMetadata = await discoverOAuthProtectedResourceMetadata(serverUrl, { resourceMetadataUrl: effectiveResourceMetadataUrl }, fetchFn);
			} catch (error) {
				if (error instanceof TypeError) throw error;
			}
			if (metadata !== cachedState.authorizationServerMetadata || resourceMetadata !== cachedState.resourceMetadata) await provider.saveDiscoveryState?.({
				authorizationServerUrl: String(authorizationServerUrl),
				resourceMetadataUrl: effectiveResourceMetadataUrl?.toString(),
				resourceMetadata,
				authorizationServerMetadata: metadata
			});
		} else {
			const serverInfo = await discoverOAuthServerInfo(serverUrl, {
				resourceMetadataUrl: effectiveResourceMetadataUrl,
				fetchFn,
				skipIssuerMetadataValidation
			});
			authorizationServerUrl = serverInfo.authorizationServerUrl;
			metadata = serverInfo.authorizationServerMetadata;
			resourceMetadata = serverInfo.resourceMetadata;
			freshDiscoveryState = {
				authorizationServerUrl: String(authorizationServerUrl),
				resourceMetadataUrl: effectiveResourceMetadataUrl?.toString(),
				resourceMetadata,
				authorizationServerMetadata: metadata
			};
		}
		const issuer = metadata?.issuer ?? String(authorizationServerUrl);
		const infoCtx = { issuer };
		await provider.saveAuthorizationServerUrl?.(issuer);
		if (authorizationCode !== void 0) {
			const recordedIssuer = cachedState?.authorizationServerMetadata?.issuer ?? cachedState?.authorizationServerUrl;
			if (recordedIssuer === void 0) {
				if (provider.saveDiscoveryState !== void 0) throw new AuthorizationServerMismatchError("discoveryState was not available on the callback leg; ensure your provider persists discoveryState alongside codeVerifier", issuer);
				console.warn("[mcp-sdk] OAuthClientProvider does not implement saveDiscoveryState()/discoveryState(); the SEP-2352 callback-leg authorization-server binding cannot be checked. Implement discoveryState (persist alongside codeVerifier) — see docs/migration/upgrade-to-v2.md §SEP-2352.");
			} else if (!issuersMatch(recordedIssuer, issuer)) throw new AuthorizationServerMismatchError(recordedIssuer, issuer);
		}
		if (freshDiscoveryState) await provider.saveDiscoveryState?.(freshDiscoveryState);
		const resource = await selectResourceURL(serverUrl, provider, resourceMetadata);
		if (resource) await provider.saveResourceUrl?.(String(resource));
		const resolvedScope = determineScope({
			requestedScope: scope,
			resourceMetadata,
			authServerMetadata: metadata,
			clientMetadata: provider.clientMetadata
		});
		const rawClientInfo = await Promise.resolve(provider.clientInformation(infoCtx));
		let clientInformation = discardIfIssuerMismatch(rawClientInfo, issuer, { canPersistStamp: provider.saveClientInformation !== void 0 });
		if (clientInformation === void 0 && rawClientInfo?.issuer && provider.saveClientInformation === void 0) throw new AuthorizationServerMismatchError(rawClientInfo.issuer, issuer);
		if (clientInformation && clientInformation.issuer === void 0) {
			clientInformation = {
				...clientInformation,
				issuer
			};
			await provider.saveClientInformation?.(clientInformation, infoCtx);
		}
		if (!clientInformation) {
			if (authorizationCode !== void 0) throw new Error("Existing OAuth client information is required when exchanging an authorization code");
			const supportsUrlBasedClientId = metadata?.client_id_metadata_document_supported === true;
			const clientMetadataUrl = provider.clientMetadataUrl;
			if (clientMetadataUrl && !isHttpsUrl(clientMetadataUrl)) throw new OAuthError(OAuthErrorCode.InvalidClientMetadata, `clientMetadataUrl must be a valid HTTPS URL with a non-root pathname, got: ${clientMetadataUrl}`);
			if (supportsUrlBasedClientId && clientMetadataUrl) {
				clientInformation = {
					client_id: clientMetadataUrl,
					issuer
				};
				await provider.saveClientInformation?.(clientInformation, infoCtx);
			} else {
				if (!provider.saveClientInformation) throw new Error("OAuth client information must be saveable for dynamic registration");
				clientInformation = {
					...await registerClient(authorizationServerUrl, {
						metadata,
						clientMetadata,
						scope: resolvedScope,
						fetchFn
					}),
					issuer
				};
				await provider.saveClientInformation(clientInformation, infoCtx);
			}
		}
		const nonInteractiveFlow = !provider.redirectUrl;
		if (authorizationCode !== void 0 || nonInteractiveFlow) {
			if (authorizationCode !== void 0) validateAuthorizationResponseIssuer({
				iss,
				expectedIssuer: metadata?.issuer,
				issParameterSupported: isIssParameterSupported(metadata)
			});
			const tokens$1 = await fetchToken(provider, authorizationServerUrl, {
				metadata,
				resource,
				authorizationCode,
				iss,
				scope: resolvedScope,
				fetchFn
			});
			await provider.saveTokens({
				...tokens$1,
				issuer
			}, infoCtx);
			return "AUTHORIZED";
		}
		let tokens = discardIfIssuerMismatch(await provider.tokens(infoCtx), issuer);
		if (tokens && tokens.issuer === void 0) {
			tokens = {
				...tokens,
				issuer
			};
			await provider.saveTokens(tokens, infoCtx);
		}
		if (tokens?.refresh_token && !forceReauthorization) try {
			const newTokens = await refreshAuthorization(authorizationServerUrl, {
				metadata,
				clientInformation,
				refreshToken: tokens.refresh_token,
				resource,
				addClientAuthentication: provider.addClientAuthentication,
				fetchFn
			});
			await provider.saveTokens({
				...newTokens,
				issuer
			}, infoCtx);
			return "AUTHORIZED";
		} catch (error) {
			if (error instanceof InsecureTokenEndpointError) throw error;
			if (!(error instanceof OAuthError) || error.code === OAuthErrorCode.ServerError) {} else throw error;
		}
		const state = provider.state ? await provider.state() : void 0;
		const { authorizationUrl, codeVerifier } = await startAuthorization(authorizationServerUrl, {
			metadata,
			clientInformation,
			state,
			redirectUrl: provider.redirectUrl,
			scope: resolvedScope,
			resource
		});
		await provider.saveCodeVerifier(codeVerifier);
		await provider.redirectToAuthorization(authorizationUrl);
		return "REDIRECT";
	}
	/**
	* SEP-991: URL-based Client IDs
	* Validate that the `client_id` is a valid URL with `https` scheme
	*/
	function isHttpsUrl(value) {
		if (!value) return false;
		try {
			const url = new URL(value);
			return url.protocol === "https:" && url.pathname !== "/";
		} catch {
			return false;
		}
	}
	async function selectResourceURL(serverUrl, provider, resourceMetadata) {
		const defaultResource = resourceUrlFromServerUrl(serverUrl);
		if (provider.validateResourceURL) return await provider.validateResourceURL(defaultResource, resourceMetadata?.resource);
		if (!resourceMetadata) return;
		if (!checkResourceAllowed({
			requestedResource: defaultResource,
			configuredResource: resourceMetadata.resource
		})) throw new Error(`Protected resource ${resourceMetadata.resource} does not match expected ${defaultResource} (or origin)`);
		return new URL(resourceMetadata.resource);
	}
	/**
	* Extract `resource_metadata`, `scope`, `error`, and `error_description` from a
	* `WWW-Authenticate` header.
	*/
	function extractWWWAuthenticateParams(res) {
		const authenticateHeader = res.headers.get("WWW-Authenticate");
		if (!authenticateHeader) return {};
		const [type, scheme] = authenticateHeader.split(" ");
		if (type?.toLowerCase() !== "bearer" || !scheme) return {};
		const resourceMetadataMatch = extractFieldFromWwwAuth(res, "resource_metadata") || void 0;
		let resourceMetadataUrl;
		if (resourceMetadataMatch) try {
			resourceMetadataUrl = new URL(resourceMetadataMatch);
		} catch {}
		const scope = extractFieldFromWwwAuth(res, "scope") || void 0;
		const error = extractFieldFromWwwAuth(res, "error") || void 0;
		const errorDescription = extractFieldFromWwwAuth(res, "error_description") || void 0;
		return {
			resourceMetadataUrl,
			scope,
			error,
			errorDescription
		};
	}
	/**
	* Extracts a specific field's value from the `WWW-Authenticate` header string.
	*
	* @param response The HTTP response object containing the headers.
	* @param fieldName The name of the field to extract (e.g., `"realm"`, `"nonce"`).
	* @returns The field value
	*/
	function extractFieldFromWwwAuth(response, fieldName) {
		const wwwAuthHeader = response.headers.get("WWW-Authenticate");
		if (!wwwAuthHeader) return null;
		const pattern = new RegExp(String.raw`${fieldName}=(?:"([^"]+)"|([^\s,]+))`);
		const match = wwwAuthHeader.match(pattern);
		if (match) {
			const result = match[1] || match[2];
			if (result) return result;
		}
		return null;
	}
	/**
	* Looks up {@link https://datatracker.ietf.org/doc/html/rfc9728 | RFC 9728}
	* OAuth 2.0 Protected Resource Metadata.
	*
	* If the server returns a 404 for the well-known endpoint, this function will
	* return `undefined`. Any other errors will be thrown as exceptions.
	*/
	async function discoverOAuthProtectedResourceMetadata(serverUrl, opts, fetchFn = fetch) {
		const response = await discoverMetadataWithFallback(serverUrl, "oauth-protected-resource", fetchFn, {
			protocolVersion: opts?.protocolVersion,
			metadataUrl: opts?.resourceMetadataUrl
		});
		if (!response || response.status === 404) {
			await response?.text?.().catch(() => {});
			throw new Error(`Resource server does not implement OAuth 2.0 Protected Resource Metadata.`);
		}
		if (!response.ok) {
			await response.text?.().catch(() => {});
			throw new Error(`HTTP ${response.status} trying to load well-known OAuth protected resource metadata.`);
		}
		return OAuthProtectedResourceMetadataSchema.parse(await response.json());
	}
	/**
	* Fetch with a retry heuristic for CORS errors caused by custom headers.
	*
	* In browsers, adding a custom header (e.g. `MCP-Protocol-Version`) triggers a CORS preflight.
	* If the server doesn't allow that header, the browser throws a `TypeError` before any response
	* is received. Retrying without custom headers often succeeds because the request becomes
	* "simple" (no preflight). If the server sends no CORS headers at all, the retry also fails
	* with `TypeError` and we return `undefined` so callers can fall through to an alternate URL.
	*
	* However, `fetch()` also throws `TypeError` for non-CORS failures (DNS resolution, connection
	* refused, invalid URL). Swallowing those and returning `undefined` masks real errors and can
	* cause callers to silently fall through to a different discovery URL. CORS is a browser-only
	* concept, so in non-browser runtimes (Node.js, Workers) a `TypeError` from `fetch` is never a
	* CORS error — there we propagate the error instead of swallowing it.
	*
	* In browsers, we cannot reliably distinguish CORS `TypeError` from network `TypeError` from the
	* error object alone, so the swallow-and-fallthrough heuristic is preserved there.
	*/
	async function fetchWithCorsRetry(url, headers, fetchFn = fetch) {
		try {
			return await fetchFn(url, { headers });
		} catch (error) {
			if (!(error instanceof TypeError) || false) throw error;
			if (headers) try {
				return await fetchFn(url, {});
			} catch (retryError) {
				if (!(retryError instanceof TypeError)) throw retryError;
				return;
			}
			return;
		}
	}
	/**
	* Constructs the well-known path for auth-related metadata discovery
	*/
	function buildWellKnownPath(wellKnownPrefix, pathname = "", options = {}) {
		if (pathname.endsWith("/")) pathname = pathname.slice(0, -1);
		return options.prependPathname ? `${pathname}/.well-known/${wellKnownPrefix}` : `/.well-known/${wellKnownPrefix}${pathname}`;
	}
	/**
	* Tries to discover OAuth metadata at a specific URL
	*/
	async function tryMetadataDiscovery(url, protocolVersion, fetchFn = fetch) {
		return await fetchWithCorsRetry(url, { "MCP-Protocol-Version": protocolVersion }, fetchFn);
	}
	/**
	* Determines if fallback to root discovery should be attempted
	*/
	function shouldAttemptFallback(response, pathname) {
		if (!response) return true;
		if (pathname === "/") return false;
		return response.status >= 400 && response.status < 500 || response.status === 502;
	}
	/**
	* Generic function for discovering OAuth metadata with fallback support
	*/
	async function discoverMetadataWithFallback(serverUrl, wellKnownType, fetchFn, opts) {
		const issuer = new URL(serverUrl);
		const protocolVersion = opts?.protocolVersion ?? "2025-11-25";
		let url;
		if (opts?.metadataUrl) url = new URL(opts.metadataUrl);
		else {
			const wellKnownPath = buildWellKnownPath(wellKnownType, issuer.pathname);
			url = new URL(wellKnownPath, opts?.metadataServerUrl ?? issuer);
			url.search = issuer.search;
		}
		let response = await tryMetadataDiscovery(url, protocolVersion, fetchFn);
		if (!opts?.metadataUrl && shouldAttemptFallback(response, issuer.pathname)) response = await tryMetadataDiscovery(new URL(`/.well-known/${wellKnownType}`, issuer), protocolVersion, fetchFn);
		return response;
	}
	/**
	* Builds a list of discovery URLs to try for authorization server metadata.
	* URLs are returned in priority order:
	* 1. OAuth metadata at the given URL
	* 2. OIDC metadata endpoints at the given URL
	*/
	function buildDiscoveryUrls(authorizationServerUrl) {
		const url = typeof authorizationServerUrl === "string" ? new URL(authorizationServerUrl) : authorizationServerUrl;
		const hasPath = url.pathname !== "/";
		const urlsToTry = [];
		if (!hasPath) {
			urlsToTry.push({
				url: new URL("/.well-known/oauth-authorization-server", url.origin),
				type: "oauth"
			}, {
				url: new URL(`/.well-known/openid-configuration`, url.origin),
				type: "oidc"
			});
			return urlsToTry;
		}
		let pathname = url.pathname;
		if (pathname.endsWith("/")) pathname = pathname.slice(0, -1);
		urlsToTry.push({
			url: new URL(`/.well-known/oauth-authorization-server${pathname}`, url.origin),
			type: "oauth"
		}, {
			url: new URL(`/.well-known/openid-configuration${pathname}`, url.origin),
			type: "oidc"
		}, {
			url: new URL(`${pathname}/.well-known/openid-configuration`, url.origin),
			type: "oidc"
		});
		return urlsToTry;
	}
	/**
	* Discovers authorization server metadata with support for
	* {@link https://datatracker.ietf.org/doc/html/rfc8414 | RFC 8414} OAuth 2.0
	* Authorization Server Metadata and
	* {@link https://openid.net/specs/openid-connect-discovery-1_0.html | OpenID Connect Discovery 1.0}
	* specifications.
	*
	* This function implements a fallback strategy for authorization server discovery:
	* 1. Attempts RFC 8414 OAuth metadata discovery first
	* 2. If OAuth discovery fails, falls back to OpenID Connect Discovery
	*
	* @param authorizationServerUrl - The authorization server URL obtained from the MCP Server's
	*                                 protected resource metadata, or the MCP server's URL if the
	*                                 metadata was not found.
	* The returned metadata's `issuer` is validated against `authorizationServerUrl`
	* per RFC 8414 §3.3 (and OIDC Discovery §4.3): if they differ the metadata is
	* **rejected** with {@linkcode IssuerMismatchError} and not returned. Set
	* `skipIssuerValidation: true` to suppress this check — **security-weakening**,
	* intended only for known-misconfigured authorization servers.
	*
	* @param options - Configuration options
	* @param options.fetchFn - Optional fetch function for making HTTP requests, defaults to global fetch
	* @param options.protocolVersion - MCP protocol version to use, defaults to {@linkcode LATEST_PROTOCOL_VERSION}
	* @param options.skipIssuerValidation - Skip the RFC 8414 §3.3 `issuer` echo check. **Security-weakening.**
	* @returns Promise resolving to authorization server metadata, or undefined if discovery fails
	* @throws {IssuerMismatchError} when the metadata's `issuer` does not match `authorizationServerUrl`
	*/
	async function discoverAuthorizationServerMetadata(authorizationServerUrl, { fetchFn = fetch, protocolVersion = LATEST_PROTOCOL_VERSION, skipIssuerValidation = false } = {}) {
		const headers = {
			"MCP-Protocol-Version": protocolVersion,
			Accept: "application/json"
		};
		const urlsToTry = buildDiscoveryUrls(authorizationServerUrl);
		for (const { url: endpointUrl, type } of urlsToTry) {
			const response = await fetchWithCorsRetry(endpointUrl, headers, fetchFn);
			if (!response)
 /**
			* CORS error occurred - don't throw as the endpoint may not allow CORS,
			* continue trying other possible endpoints
			*/
			continue;
			if (!response.ok) {
				await response.text?.().catch(() => {});
				if (response.status >= 400 && response.status < 500 || response.status === 502) continue;
				throw new Error(`HTTP ${response.status} trying to load ${type === "oauth" ? "OAuth" : "OpenID provider"} metadata from ${endpointUrl}`);
			}
			const parsed = type === "oauth" ? OAuthMetadataSchema.parse(await response.json()) : OpenIdProviderDiscoveryMetadataSchema.parse(await response.json());
			if (!skipIssuerValidation) {
				const expectedIssuer = typeof authorizationServerUrl === "string" ? authorizationServerUrl : authorizationServerUrl.href;
				if (!(parsed.issuer === expectedIssuer || expectedIssuer.endsWith("/") && parsed.issuer === expectedIssuer.slice(0, -1))) throw new IssuerMismatchError("metadata", expectedIssuer, parsed.issuer);
			}
			return parsed;
		}
	}
	/**
	* Discovers the authorization server for an MCP server following
	* {@link https://datatracker.ietf.org/doc/html/rfc9728 | RFC 9728} (OAuth 2.0 Protected
	* Resource Metadata), with fallback to treating the server URL as the
	* authorization server.
	*
	* This function combines two discovery steps into one call:
	* 1. Probes `/.well-known/oauth-protected-resource` on the MCP server to find the
	*    authorization server URL (RFC 9728).
	* 2. Fetches authorization server metadata from that URL (RFC 8414 / OpenID Connect Discovery).
	*
	* Use this when you need the authorization server metadata for operations outside the
	* {@linkcode auth} orchestrator, such as token refresh or token revocation.
	*
	* @param serverUrl - The MCP resource server URL
	* @param opts - Optional configuration
	* @param opts.resourceMetadataUrl - Override URL for the protected resource metadata endpoint
	* @param opts.fetchFn - Custom fetch function for HTTP requests
	* @returns Authorization server URL, metadata, and resource metadata (if available)
	*/
	async function discoverOAuthServerInfo(serverUrl, opts) {
		let resourceMetadata;
		let authorizationServerUrl;
		try {
			resourceMetadata = await discoverOAuthProtectedResourceMetadata(serverUrl, { resourceMetadataUrl: opts?.resourceMetadataUrl }, opts?.fetchFn);
			if (resourceMetadata.authorization_servers && resourceMetadata.authorization_servers.length > 0) authorizationServerUrl = resourceMetadata.authorization_servers[0];
		} catch (error) {
			if (error instanceof TypeError) throw error;
		}
		if (!authorizationServerUrl) authorizationServerUrl = String(new URL("/", serverUrl));
		const authorizationServerMetadata = await discoverAuthorizationServerMetadata(authorizationServerUrl, {
			fetchFn: opts?.fetchFn,
			skipIssuerValidation: opts?.skipIssuerMetadataValidation
		});
		return {
			authorizationServerUrl,
			authorizationServerMetadata,
			resourceMetadata
		};
	}
	/**
	* Begins the authorization flow with the given server, by generating a PKCE challenge and constructing the authorization URL.
	*/
	async function startAuthorization(authorizationServerUrl, { metadata, clientInformation, redirectUrl, scope, state, resource }) {
		let authorizationUrl;
		if (metadata) {
			authorizationUrl = new URL(metadata.authorization_endpoint);
			if (!metadata.response_types_supported.includes(AUTHORIZATION_CODE_RESPONSE_TYPE)) throw new Error(`Incompatible auth server: does not support response type ${AUTHORIZATION_CODE_RESPONSE_TYPE}`);
			if (metadata.code_challenge_methods_supported && !metadata.code_challenge_methods_supported.includes(AUTHORIZATION_CODE_CHALLENGE_METHOD)) throw new Error(`Incompatible auth server: does not support code challenge method ${AUTHORIZATION_CODE_CHALLENGE_METHOD}`);
		} else authorizationUrl = new URL("/authorize", authorizationServerUrl);
		const challenge = await pkceChallenge();
		const codeVerifier = challenge.code_verifier;
		const codeChallenge = challenge.code_challenge;
		authorizationUrl.searchParams.set("response_type", AUTHORIZATION_CODE_RESPONSE_TYPE);
		authorizationUrl.searchParams.set("client_id", clientInformation.client_id);
		authorizationUrl.searchParams.set("code_challenge", codeChallenge);
		authorizationUrl.searchParams.set("code_challenge_method", AUTHORIZATION_CODE_CHALLENGE_METHOD);
		authorizationUrl.searchParams.set("redirect_uri", String(redirectUrl));
		if (state) authorizationUrl.searchParams.set("state", state);
		if (scope) authorizationUrl.searchParams.set("scope", scope);
		if (scope?.split(" ").includes("offline_access")) authorizationUrl.searchParams.append("prompt", "consent");
		if (resource) authorizationUrl.searchParams.set("resource", resource.href);
		return {
			authorizationUrl,
			codeVerifier
		};
	}
	/**
	* Prepares token request parameters for an authorization code exchange.
	*
	* This is the default implementation used by {@linkcode fetchToken} when the provider
	* doesn't implement {@linkcode OAuthClientProvider.prepareTokenRequest | prepareTokenRequest}.
	*
	* @param authorizationCode - The authorization code received from the authorization endpoint
	* @param codeVerifier - The PKCE code verifier
	* @param redirectUri - The redirect URI used in the authorization request
	* @returns URLSearchParams for the `authorization_code` grant
	*/
	function prepareAuthorizationCodeRequest(authorizationCode, codeVerifier, redirectUri) {
		return new URLSearchParams({
			grant_type: "authorization_code",
			code: authorizationCode,
			code_verifier: codeVerifier,
			redirect_uri: String(redirectUri)
		});
	}
	/**
	* Internal helper to execute a token request with the given parameters.
	* Used by {@linkcode exchangeAuthorization}, {@linkcode refreshAuthorization}, and {@linkcode fetchToken}.
	*/
	async function executeTokenRequest(authorizationServerUrl, { metadata, tokenRequestParams, clientInformation, addClientAuthentication, resource, fetchFn }) {
		const tokenUrl = assertSecureTokenEndpoint(metadata?.token_endpoint ?? new URL("/token", authorizationServerUrl));
		const headers = new Headers({
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json"
		});
		if (resource) tokenRequestParams.set("resource", resource.href);
		if (addClientAuthentication) await addClientAuthentication(headers, tokenRequestParams, tokenUrl, metadata);
		else if (clientInformation) applyClientAuthentication(selectClientAuthMethod(clientInformation, metadata?.token_endpoint_auth_methods_supported ?? []), clientInformation, headers, tokenRequestParams);
		const response = await (fetchFn ?? fetch)(tokenUrl, {
			method: "POST",
			headers,
			body: tokenRequestParams
		});
		if (!response.ok) throw await parseErrorResponse(response);
		const json = await response.json();
		try {
			return OAuthTokensSchema.parse(json);
		} catch (parseError) {
			if (typeof json === "object" && json !== null && "error" in json) throw await parseErrorResponse(JSON.stringify(json));
			throw parseError;
		}
	}
	/**
	* Exchange a refresh token for an updated access token.
	*
	* Supports multiple client authentication methods as specified in OAuth 2.1:
	* - Automatically selects the best authentication method based on server support
	* - Preserves the original refresh token if a new one is not returned
	*
	* @param authorizationServerUrl - The authorization server's base URL
	* @param options - Configuration object containing client info, refresh token, etc.
	* @returns Promise resolving to OAuth tokens (preserves original `refresh_token` if not replaced)
	* @throws {Error} When token refresh fails or authentication is invalid
	*/
	async function refreshAuthorization(authorizationServerUrl, { metadata, clientInformation, refreshToken, resource, addClientAuthentication, fetchFn }) {
		return {
			refresh_token: refreshToken,
			...await executeTokenRequest(authorizationServerUrl, {
				metadata,
				tokenRequestParams: new URLSearchParams({
					grant_type: "refresh_token",
					refresh_token: refreshToken
				}),
				clientInformation,
				addClientAuthentication,
				resource,
				fetchFn
			})
		};
	}
	/**
	* Unified token fetching that works with any grant type via {@linkcode OAuthClientProvider.prepareTokenRequest | prepareTokenRequest()}.
	*
	* This function provides a single entry point for obtaining tokens regardless of the
	* OAuth grant type. The provider's `prepareTokenRequest()` method determines which grant
	* to use and supplies the grant-specific parameters.
	*
	* @param provider - OAuth client provider that implements `prepareTokenRequest()`
	* @param authorizationServerUrl - The authorization server's base URL
	* @param options - Configuration for the token request
	* @returns Promise resolving to OAuth tokens
	* @throws {Error} When provider doesn't implement `prepareTokenRequest` or token fetch fails
	*
	* @example
	* ```ts source="./auth.examples.ts#fetchToken_clientCredentials"
	* // Provider for client_credentials:
	* class MyProvider extends MyProviderBase implements OAuthClientProvider {
	*     prepareTokenRequest(scope?: string) {
	*         const params = new URLSearchParams({ grant_type: 'client_credentials' });
	*         if (scope) params.set('scope', scope);
	*         return params;
	*     }
	* }
	*
	* const tokens = await fetchToken(new MyProvider(), authServerUrl, { metadata });
	* ```
	*/
	async function fetchToken(provider, authorizationServerUrl, { metadata, resource, authorizationCode, iss, scope, fetchFn } = {}) {
		if (authorizationCode !== void 0) validateAuthorizationResponseIssuer({
			iss,
			expectedIssuer: metadata?.issuer,
			issParameterSupported: isIssParameterSupported(metadata)
		});
		const effectiveScope = scope ?? provider.clientMetadata.scope;
		let tokenRequestParams;
		if (provider.prepareTokenRequest) tokenRequestParams = await provider.prepareTokenRequest(effectiveScope);
		if (!tokenRequestParams) {
			if (!authorizationCode) throw new Error("Either provider.prepareTokenRequest() or authorizationCode is required");
			if (!provider.redirectUrl) throw new Error("redirectUrl is required for authorization_code flow");
			tokenRequestParams = prepareAuthorizationCodeRequest(authorizationCode, await provider.codeVerifier(), provider.redirectUrl);
		}
		const clientInformation = await provider.clientInformation({ issuer: metadata?.issuer ?? String(authorizationServerUrl) });
		return executeTokenRequest(authorizationServerUrl, {
			metadata,
			tokenRequestParams,
			clientInformation: clientInformation ?? void 0,
			addClientAuthentication: provider.addClientAuthentication,
			resource,
			fetchFn
		});
	}
	/**
	* Performs OAuth 2.0 Dynamic Client Registration according to
	* {@link https://datatracker.ietf.org/doc/html/rfc7591 | RFC 7591}.
	*
	* If `scope` is provided, it overrides `clientMetadata.scope` in the registration
	* request body. This allows callers to apply the Scope Selection Strategy (SEP-835)
	* consistently across both DCR and the subsequent authorization request.
	*
	* @deprecated Dynamic Client Registration is deprecated as of protocol version
	* 2026-07-28 (SEP-2577) in favor of Client ID Metadata Documents (SEP-991).
	* Remains functional during the deprecation window (at least twelve months).
	* Prefer a CIMD URL `client_id` when the authorization server advertises
	* `client_id_metadata_document_supported`; the SDK already gates on this for you.
	*/
	async function registerClient(authorizationServerUrl, { metadata, clientMetadata, scope, fetchFn }) {
		let registrationUrl;
		if (metadata) {
			if (!metadata.registration_endpoint) throw new Error("Incompatible auth server: does not support dynamic client registration");
			registrationUrl = new URL(metadata.registration_endpoint);
		} else registrationUrl = new URL("/register", authorizationServerUrl);
		const submittedMetadata = {
			...clientMetadata,
			...scope === void 0 ? {} : { scope }
		};
		const response = await (fetchFn ?? fetch)(registrationUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(submittedMetadata)
		});
		if (!response.ok) throw new RegistrationRejectedError({
			status: response.status,
			body: await response.text(),
			submittedMetadata
		});
		return OAuthClientInformationFullSchema.parse(await response.json());
	}
	/**
	* Methods whose entries are exempt from the
	* {@linkcode InMemoryResponseCacheStoreOptions.maxEntries} cap. Each holds at
	* most one entry per partition (a small bounded set) and the
	* `tools/list`-derived index depends on its entry surviving regardless of the
	* `resources/read` working-set size. Only `resources/read` keys count toward
	* the cap and are eligible for FIFO eviction.
	*/
	const CAP_EXEMPT_METHODS = /* @__PURE__ */ new Set([
		"tools/list",
		"prompts/list",
		"resources/list",
		"resources/templates/list",
		"server/discover"
	]);
	/**
	* In-memory default. Bounded by an insertion-ordered size cap (default `512`;
	* see {@linkcode InMemoryResponseCacheStoreOptions.maxEntries}) on the
	* `resources/read` keyspace so an unbounded stream of distinct URIs cannot
	* grow it without limit; the list-singleton methods are exempt and never
	* evicted by the cap. `Map` preserves insertion order, so the oldest live
	* capped key is the first matching iteration entry.
	*/
	var InMemoryResponseCacheStore = class {
		_entries = /* @__PURE__ */ new Map();
		_maxEntries;
		_stamp = 0;
		/** Count of held entries that are subject to the cap (i.e. not in {@linkcode CAP_EXEMPT_METHODS}). */
		_cappedSize = 0;
		constructor(options) {
			this._maxEntries = options?.maxEntries ?? 512;
		}
		/** Number of held entries (for diagnostics / bounding tests). */
		get size() {
			return this._entries.size;
		}
		get(key) {
			return this._entries.get(keyOf(key));
		}
		set(key, entry) {
			const k = keyOf(key);
			const exempt = CAP_EXEMPT_METHODS.has(key.method);
			const isNew = !this._entries.has(k);
			if (!exempt && isNew && this._maxEntries > 0 && this._cappedSize >= this._maxEntries) {
				for (const oldKey of this._entries.keys()) if (!CAP_EXEMPT_METHODS.has(oldKey.slice(0, oldKey.indexOf("\0")))) {
					this._entries.delete(oldKey);
					this._cappedSize--;
					break;
				}
			}
			const stamp = ++this._stamp;
			this._entries.set(k, {
				...entry,
				stamp
			});
			if (isNew && !exempt) this._cappedSize++;
			return stamp;
		}
		delete(key) {
			if (this._entries.delete(keyOf(key)) && !CAP_EXEMPT_METHODS.has(key.method)) this._cappedSize--;
		}
		evict(method) {
			const prefix = `${method}\0`;
			const exempt = CAP_EXEMPT_METHODS.has(method);
			for (const k of this._entries.keys()) if (k.startsWith(prefix)) {
				this._entries.delete(k);
				if (!exempt) this._cappedSize--;
			}
		}
		clear() {
			this._entries.clear();
			this._cappedSize = 0;
		}
	};
	/**
	* Serialize a {@linkcode CacheKey} for the in-memory map. `method` is always
	* an SDK-set MCP method string (never contains a NUL), so the `\0` prefix
	* delimiter is safe and lets {@linkcode InMemoryResponseCacheStore.evict} do a
	* cheap prefix scan. `partition` (already a JSON-encoded
	* `[serverIdentity, principal]` pair) and `params` (a resource URI on the
	* `resources/read` path — caller-controlled) are JSON-array-encoded together,
	* which is collision-free regardless of any NUL or delimiter characters they
	* carry.
	*/
	function keyOf(key) {
		return `${key.method}\0${JSON.stringify([key.partition ?? "", key.params ?? ""])}`;
	}
	/**
	* Serialize a `{method, params}` pair for the eviction-generation map. The
	* list singletons key on `method` alone (their {@linkcode ClientResponseCache.evict}
	* is whole-method); `resources/read` keys on `` `${method}\0${uri}` `` so
	* {@linkcode ClientResponseCache.evictKey} bumps a per-URI counter.
	*/
	function genKey(method, params) {
		return params === void 0 ? method : `${method}\0${params}`;
	}
	/**
	* Upper bound on the server-supplied `ttlMs` honoured by
	* {@linkcode ClientResponseCache} (24h). A server cannot pin an entry
	* indefinitely.
	*/
	const MAX_CACHE_TTL_MS = 864e5;
	/**
	* The `Client`'s cache-coordination collaborator.
	*
	* Owns the per-connection cache state that used to live as five private
	* fields on `Client` — the backing {@linkcode ResponseCacheStore}, the
	* per-method eviction-generation counter, the user-supplied/default flag, and
	* the stamp-memoized derived indices over the `tools/list` entry. `Client`
	* holds exactly one instance and never reaches past it to the store.
	*
	* Not exported from the package index — internal to the client package.
	*
	* @internal
	*/
	var ClientResponseCache = class {
		/**
		* Per-logical-key eviction-generation counter. {@linkcode evict} (whole
		* method) and {@linkcode evictKey} (single `{method, params}`) bump it
		* before touching the store; {@linkcode captureGeneration} reads it before
		* the request; {@linkcode write} skips when it moved — so a `list_changed`
		* arriving mid-walk, or a `resources/updated` arriving while a
		* `readResource()` for the same URI is in flight, is not overwritten by
		* the in-flight request's stale write. The map key is `method` for the
		* list singletons and `` `${method}\0${params}` `` for per-URI keys.
		*
		* Growth is bounded by keys the CLIENT has issued a `captureGeneration`
		* for: {@linkcode captureGeneration} records the key (so an interleaved
		* {@linkcode evictKey} sees there is an in-flight write to suppress);
		* {@linkcode evictKey} only bumps a key that is already recorded — a
		* server streaming `notifications/resources/updated` for URIs the client
		* has never read therefore cannot grow this map.
		*/
		_evictionGeneration = /* @__PURE__ */ new Map();
		/**
		* `name → Tool` index derived from the cached `tools/list` entry, memoized
		* against the entry's `stamp` so it re-derives only when the backing entry
		* changes (mcp.d's `cachedTool` pattern).
		*/
		_toolIndex;
		/**
		* `name → compiled output-schema validator` derived from the cached
		* `tools/list` entry; same stamp-keyed memoization as `_toolIndex`. Typed
		* `unknown` so this class stays free of any validator-provider dependency
		* — the compile callback supplied to {@linkcode outputValidator} owns the
		* concrete type.
		*/
		_toolOutputValidatorIndex;
		/**
		* The connected server's identity (`serverInfo.name@version`, the
		* transport's `sessionId`, or a client-generated per-connection
		* surrogate). Set by the `Client` immediately after a successful connect;
		* `''` is the pre-connect sentinel. Every storage partition is derived
		* from this (see `_partitionFor`), so two clients sharing one store but
		* connected to different servers never collide on `tools/list` and a
		* server cannot read another server's `'public'` entries.
		*/
		_serverIdentity = "";
		constructor(_store, _isUserSupplied, _reportError = () => {}, _cachePartition = "", _now = Date.now) {
			this._store = _store;
			this._isUserSupplied = _isUserSupplied;
			this._reportError = _reportError;
			this._cachePartition = _cachePartition;
			this._now = _now;
		}
		/** The clock used for every freshness computation and check. */
		now() {
			return this._now();
		}
		/**
		* Record the connected server's identity. Called by `Client` immediately
		* after a successful connect: `serverInfo.name@version` when the server
		* identified itself, else the transport's `sessionId`, else a
		* client-generated per-connection surrogate (`serverInfo` is a spec
		* SHOULD on 2026-07-28, so anonymous servers exist). Surrogate-keyed
		* partitions are NOT stable across reconnects — no identity means no
		* cross-connection cache reuse, and a shared long-lived store should
		* bound its own size accordingly. Every partition derived after this
		* call is scoped to this identity; entries written under the pre-connect
		* `''` sentinel are no longer reachable.
		*/
		setServerIdentity(identity) {
			this._serverIdentity = identity;
		}
		/**
		* Derive the storage partition for `scope`. The encoding is
		* `JSON.stringify([serverIdentity, principal])` — JSON escaping makes it
		* collision-free by construction: a malicious server cannot craft a
		* `serverInfo.name`/`version` whose concatenated form bleeds into another
		* server's namespace or another principal's slot, regardless of `@` / `|`
		* / `"` / NUL in the server-controlled strings. `'public'` →
		* `[serverIdentity, '']` (shared within this server); `'private'` →
		* `[serverIdentity, cachePartition]`. When `cachePartition` is `''` the
		* two coincide.
		*/
		_partitionFor(scope) {
			return JSON.stringify([this._serverIdentity, scope === "public" ? "" : this._cachePartition]);
		}
		/**
		* Two-probe lookup: this client's own (private) partition first, then the
		* connected server's shared (public) partition. The shared probe is gated
		* on `entry.scope === 'public'` — a co-tenant client that omits
		* `cachePartition` writes its `'private'`-scoped entries at the public
		* partition, and serving those to a correctly-partitioned client would
		* leak private bodies (mcp.d's `cachedEntry` two-probe order; the scope
		* gate is defence-in-depth on top of the partition split). When
		* `cachePartition` is `''` the two partitions are identical and only one
		* probe is issued.
		*/
		async _probe(method, params) {
			const key = {
				method,
				params: params ?? ""
			};
			const ownPartition = this._partitionFor("private");
			const own = await this._store.get({
				...key,
				partition: ownPartition
			});
			if (own !== void 0) return own;
			const sharedPartition = this._partitionFor("public");
			if (sharedPartition === ownPartition) return void 0;
			const shared = await this._store.get({
				...key,
				partition: sharedPartition
			});
			return shared?.scope === "public" ? shared : void 0;
		}
		/**
		* Bump the per-method generation (so an in-flight {@linkcode write} for the
		* same method becomes a no-op) and drop the connected server's two list
		* singletons (own + shared partition; `params: ''`). The generation bump
		* is unconditional and FIRST — the {@linkcode write} race guard relies on
		* the bump, not on the store's deletes completing.
		*
		* Eviction is scoped to this client's `[serverIdentity, principal]`
		* partitions (mirroring {@linkcode evictKey}) — the method-wide
		* `store.evict()` is NOT called, so on a shared store one server's
		* `list_changed` cannot wipe a co-tenant's entry. A custom store's
		* `delete()` may throw or reject; each partition is guarded
		* independently so a failure on one does not skip the other, the failure
		* is reported via the constructor's sink, and the call resolves so
		* dispatch proceeds.
		*/
		async evict(method) {
			this._evictionGeneration.set(method, (this._evictionGeneration.get(method) ?? 0) + 1);
			await this._deleteBoth(method, "");
		}
		/**
		* Guarded two-partition delete of `{method, params}`: each partition's
		* `delete` is independently wrapped so a custom store's failure on one is
		* reported and does not skip the other, and the call always resolves.
		*/
		async _deleteBoth(method, params) {
			const ownPartition = this._partitionFor("private");
			const sharedPartition = this._partitionFor("public");
			try {
				await this._store.delete({
					method,
					params,
					partition: ownPartition
				});
			} catch (error) {
				this._reportError(error);
			}
			if (sharedPartition !== ownPartition) try {
				await this._store.delete({
					method,
					params,
					partition: sharedPartition
				});
			} catch (error) {
				this._reportError(error);
			}
		}
		/**
		* Drop the single logical entry `{method, params}` from BOTH the private
		* and public partitions for this client's connected server (mcp.d's
		* `invalidateLogical`). Used for `notifications/resources/updated`'s
		* per-URI eviction. The per-key generation is bumped FIRST (so an
		* in-flight {@linkcode write} for the same `{method, params}` becomes a
		* no-op and cannot re-cache the now-stale body) but only when the key was
		* already recorded by {@linkcode captureGeneration} — bounding the map to
		* keys the client has actually read. A custom store's `delete()` may
		* throw or reject; each partition's delete is guarded independently so a
		* failure on one does not skip the other, and the call resolves so
		* dispatch proceeds.
		*/
		async evictKey(method, params) {
			const gk = genKey(method, params);
			const current = this._evictionGeneration.get(gk);
			if (current !== void 0) this._evictionGeneration.set(gk, current + 1);
			await this._deleteBoth(method, params);
		}
		/**
		* Snapshot the eviction generation for `{method, params}` before issuing
		* the request (a list walk's page 1, or a `resources/read` for `params`).
		* Records the key so an interleaved {@linkcode evictKey} for the same
		* `{method, params}` knows there is an in-flight write to suppress and
		* bumps; without the record, `evictKey`'s recorded-only bump would skip
		* and the stale body would be cached.
		*/
		captureGeneration(method, params) {
			const gk = genKey(method, params);
			const current = this._evictionGeneration.get(gk) ?? 0;
			this._evictionGeneration.set(gk, current);
			return current;
		}
		/**
		* Write `value` under `{method}` unless the per-method generation moved
		* since `capturedGen` was taken — a `list_changed` that landed mid-walk has
		* already invalidated the result the caller is about to write, and
		* overwriting the eviction with the stale aggregate would lose the
		* invalidation.
		*
		* The value is stored as its JSON-serialized document; serialization
		* doubles as the mutation barrier, so a caller mutating the returned
		* aggregate cannot reach the cache or its derived indices. A value that
		* is not JSON-serializable (reachable only via in-process transports)
		* fails the write loudly into the `reportError` sink. A custom store
		* whose `set()` throws or rejects is routed to the same sink and the
		* write resolves — cache bookkeeping never costs the caller a result it
		* already fetched.
		*
		* `freshness` carries the client-computed `expiresAt` (absolute ms epoch,
		* `now + ttlMs`) and the server-reported `cacheScope`. The storage
		* `partition` is derived from the scope via `_partitionFor`:
		* `'public'` → `[serverIdentity, '']` (shared within this server);
		* `'private'` → `[serverIdentity, cachePartition]` (so a shared store
		* never serves a private entry to another identity). Absent `freshness`
		* preserves the substrate write (no `expiresAt`, private partition) — the
		* `tools/list` retain-for-schema posture: never served by
		* {@linkcode read}'s freshness gate, always readable by
		* {@linkcode toolDefinition}.
		*
		* After storing under the derived partition, the same `{method, params}`
		* is deleted from the OPPOSITE partition (mirroring {@linkcode evictKey}'s
		* two-partition posture). A server that flips a result's `cacheScope` for
		* the same key would otherwise leave the previous entry in the other slot
		* — and since `_probe` checks own-partition first, a stale private entry
		* would shadow the fresh public one (or a stale public entry would keep
		* serving co-tenants). Both store calls are independently guarded so a
		* custom store's failure on one does not skip the other.
		*/
		async write(method, value, capturedGen, freshness) {
			if ((this._evictionGeneration.get(genKey(method, freshness?.params)) ?? 0) !== capturedGen) return;
			const params = freshness?.params ?? "";
			const ownPartition = this._partitionFor("private");
			const sharedPartition = this._partitionFor("public");
			const partition = (freshness?.scope ?? "private") === "public" ? sharedPartition : ownPartition;
			try {
				await this._store.set({
					method,
					params,
					partition
				}, {
					value: encodeCacheValue(value),
					expiresAt: freshness?.expiresAt,
					scope: freshness?.scope
				});
			} catch (error) {
				this._reportError(error);
			}
			if (sharedPartition !== ownPartition) try {
				await this._store.delete({
					method,
					params,
					partition: partition === ownPartition ? sharedPartition : ownPartition
				});
			} catch (error) {
				this._reportError(error);
			}
		}
		/**
		* Serve the fresh cached result for `{method, params}`, or `undefined`.
		* Lookup is the two-probe order (own-partition then this server's shared
		* partition, gated on `scope === 'public'`); freshness is
		* `entry.expiresAt > now()` (a missing `expiresAt` is never fresh),
		* checked BEFORE decoding so stale entries cost no parse. Every hit is
		* freshly parsed, so the caller owns the value outright. An entry whose
		* document does not parse or is not an object (corrupted external
		* store) is reported,
		* deleted, and treated as a miss — deleted because a fresh-but-corrupt
		* entry would otherwise re-parse and re-report on every read until its
		* `expiresAt` passes.
		*/
		async read(method, params) {
			const entry = await this._probe(method, params);
			if (entry?.expiresAt === void 0 || !(entry.expiresAt > this.now())) return void 0;
			try {
				const parsed = JSON.parse(entry.value);
				if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new TypeError("cached document is not an object");
				return { value: parsed };
			} catch (error) {
				this._reportError(error);
				await this._deleteBoth(method, params ?? "");
				return;
			}
		}
		/**
		* Connection reset. The per-instance default store IS cleared
		* (connection-scoped); a user-supplied store is NOT — that would defeat
		* the only reason to supply one. The generation map and every derived
		* index are dropped regardless: they are connection-scoped even when the
		* backing store survives, so the next read re-derives from whatever the
		* store still holds. The server identity returns to the pre-connect
		* sentinel. The default impl is synchronous, so the `MaybePromise<void>`
		* return is a plain void here and the caller need not await.
		*/
		resetForReconnect() {
			if (!this._isUserSupplied) this._store.clear();
			this._evictionGeneration.clear();
			this._toolIndex = void 0;
			this._toolOutputValidatorIndex = void 0;
			this._serverIdentity = "";
		}
		/**
		* The descriptor for tool `name` taken from the cached `tools/list` entry.
		* The `name → Tool` index is memoized against the entry's `stamp` and
		* re-derived only when the backing entry changes (mcp.d's `cachedTool`).
		* Returns `undefined` only when no `tools/list` response is held at all,
		* or the held list does not contain `name`.
		*
		* Consumed by `callTool()`'s SEP-2243 `_resolveXMcpHeaderScan` (mirroring)
		* and, via {@linkcode outputValidator}, its output-schema validation.
		*/
		async toolDefinition(name) {
			const entry = await this._probe("tools/list");
			if (entry === void 0) {
				this._toolIndex = void 0;
				return;
			}
			if (this._toolIndex?.stamp !== entry.stamp) {
				const list = this._decodeListTools(entry);
				const byName = /* @__PURE__ */ new Map();
				if (list !== void 0) for (const tool of list.tools) byName.set(tool.name, tool);
				this._toolIndex = {
					stamp: entry.stamp,
					byName
				};
			}
			return this._toolIndex.byName.get(name);
		}
		/**
		* The compiled output-schema validator for tool `name`, derived from the
		* cached `tools/list` entry — same source and same stamp-keyed
		* memoization as {@linkcode toolDefinition}. The `name → validator` index
		* re-derives only when the backing entry's stamp changes (a refetched
		* `tools/list` recompiles; a `list_changed` eviction drops it). Returns
		* `undefined` when no `tools/list` is held, the tool is absent, or it has
		* no `outputSchema`.
		*
		* `compile` is the caller-supplied validator-compile callback (the
		* `Client` passes its `_jsonSchemaValidator` wrapper) so this
		* class carries no validator-provider dependency. One tool's uncompilable
		* `outputSchema` (e.g. an invalid `pattern` regex or unresolvable `$ref`)
		* must not poison every other tool's `callTool` — the callback isolates
		* that compile error per tool by returning a per-tool error variant which
		* the index stores alongside the good ones, and `callTool` surfaces it as
		* a typed `InvalidParams` only for that name. Because the error is held on
		* this stamp-keyed substrate (not a parallel map), it inherits the
		* substrate's invalidation lifecycle: a `list_changed` eviction drops it,
		* a refetched `tools/list` re-derives it, and `resetForReconnect` clears
		* the lot.
		*/
		async outputValidator(name, compile) {
			const entry = await this._probe("tools/list");
			if (entry === void 0) {
				this._toolOutputValidatorIndex = void 0;
				return;
			}
			if (this._toolOutputValidatorIndex?.stamp !== entry.stamp) {
				const list = this._decodeListTools(entry) ?? { tools: [] };
				const byName = /* @__PURE__ */ new Map();
				for (const tool of list.tools) {
					const compiled = compile(tool);
					if (compiled !== void 0) byName.set(tool.name, compiled);
				}
				this._toolOutputValidatorIndex = {
					stamp: entry.stamp,
					byName
				};
			}
			return this._toolOutputValidatorIndex.byName.get(name);
		}
		/** Parse a held `tools/list` document for the index builders; a document
		* that does not parse OR whose `tools` is not an array of objects
		* (both mean a corrupted external store) is reported and treated as if
		* nothing were held. Callers memoize the outcome against the entry's
		* stamp, so a corrupt document costs one parse + report per stamp, not
		* per lookup. */
		_decodeListTools(entry) {
			try {
				const parsed = JSON.parse(entry.value);
				if (!Array.isArray(parsed?.tools) || !parsed.tools.every((t) => t !== null && typeof t === "object")) throw new TypeError("cached tools/list document has a malformed tools array");
				return parsed;
			} catch (error) {
				this._reportError(error);
				return;
			}
		}
	};
	/**
	* Serialize a result for storage; throws TypeError for anything without a
	* JSON representation (legal wire results always have one). Two failure
	* modes need folding into that one throw: `JSON.stringify` throws on cycles
	* and BigInt, but silently returns `undefined` (not a string) for a
	* top-level function, symbol, or `undefined`.
	*/
	function encodeCacheValue(value) {
		let json;
		try {
			json = JSON.stringify(value);
		} catch (error) {
			throw new TypeError(`cache value is not JSON-serializable: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (typeof json !== "string") throw new TypeError("cache value is not JSON-serializable: it has no JSON representation");
		return json;
	}
	/**
	* Auth-seam provenance stamp (internal — not part of the public API).
	*
	* Errors escaping a transport auth seam — the `authProvider.token()` read,
	* an `onUnauthorized` invocation (SDK adapter or custom user callback), the
	* 403 step-up flow, the transport's own auth-failure constructions — are
	* stamped at the throw boundary. The version-negotiation probe routes stamped
	* errors as auth outcomes; provenance is recorded where it is known, never
	* reconstructed from error types downstream.
	*
	* `Symbol.for` uses the global symbol registry, so the stamp survives a
	* duplicated SDK copy in one process (bundler double-install, version skew)
	* by design: both copies resolve the same symbol.
	*/
	const AUTH_SEAM = Symbol.for("mcp.authSeamEscape");
	/**
	* Stamp `error` as an auth-seam escape and return it — identity-preserving
	* (the same object flows on, `instanceof` and `.cause` chains intact). A
	* frozen/sealed object is returned unstamped rather than replaced: identity
	* outranks provenance. Primitive throws cannot carry the stamp.
	*/
	function markAuthSeamEscape(error) {
		if (typeof error === "object" && error !== null || typeof error === "function") try {
			Object.defineProperty(error, AUTH_SEAM, {
				value: true,
				configurable: true
			});
		} catch {}
		return error;
	}
	/** Whether `error` escaped through a transport auth seam. */
	function isAuthSeamEscape(error) {
		return (typeof error === "object" && error !== null || typeof error === "function") && error[AUTH_SEAM] === true;
	}
	/** The `-32022` UnsupportedProtocolVersion protocol error code (negotiation-phase recognition). */
	const UNSUPPORTED_PROTOCOL_VERSION = -32022;
	/**
	* Deliberately not probe-recognized in either direction: deployed servers
	* overload `-32001` (the SDK-conventional `Session not found` body on a 2025
	* stateful server), and the spec-assigned `-32020` (`HeaderMismatch`) /
	* `-32021` (`MissingRequiredClientCapability`) are not era evidence — all
	* fall into the conservative legacy default.
	*/
	const NOT_PROBE_RECOGNIZED = /* @__PURE__ */ new Set([
		-32001,
		-32020,
		-32021
	]);
	/**
	* Classify a single probe outcome. Pure: no I/O, no state — loop-guard and
	* retry state live in the caller.
	*/
	function classifyProbeOutcome(outcome, context) {
		switch (outcome.kind) {
			case "result": return classifyResult(outcome.result, context);
			case "rpc-error": return classifyRpcError(outcome, context);
			case "http-error": return classifyHttpError(outcome, context);
			case "network-error": return classifyNetworkError(outcome.error, context);
			case "auth-required": return {
				kind: "error",
				error: outcome.error
			};
			case "closed":
				if (context.transportKind === "stdio") return { kind: "legacy" };
				return classifyNetworkError(/* @__PURE__ */ new Error("Connection closed during the version negotiation probe"), context);
			case "timeout":
				if (context.transportKind === "stdio") return { kind: "legacy" };
				return {
					kind: "error",
					error: new SdkError(SdkErrorCode.RequestTimeout, `Version negotiation probe timed out after ${outcome.timeoutMs}ms`, { timeout: outcome.timeoutMs })
				};
		}
	}
	function classifyResult(result, context) {
		const parsed = codecForVersion(MODERN_WIRE_REVISION).validateResult("server/discover", result);
		if (!parsed.ok) return { kind: "legacy" };
		const supportedVersions = parsed.value.supportedVersions;
		const overlap = context.clientModernVersions.find((version) => supportedVersions.includes(version));
		if (overlap !== void 0) return {
			kind: "modern",
			version: overlap,
			discover: parsed.value
		};
		if (context.fallbackAvailable) return { kind: "legacy" };
		return {
			kind: "error",
			error: new UnsupportedProtocolVersionError({
				supported: [...supportedVersions],
				requested: context.requestedVersion
			})
		};
	}
	function classifyRpcError(outcome, context) {
		const { code, message, data } = outcome;
		if (code === UNSUPPORTED_PROTOCOL_VERSION) {
			const supported = parseSupportedList(data);
			if (supported === void 0) return { kind: "legacy" };
			const error = new UnsupportedProtocolVersionError({
				supported,
				requested: parseRequested(data) ?? context.requestedVersion
			}, message);
			const supportedModern = modernProtocolVersions(supported);
			const mutual = context.clientModernVersions.find((version) => supportedModern.includes(version));
			if (mutual !== void 0) return {
				kind: "corrective",
				version: mutual,
				error
			};
			if (supportedModern.length > 0) return {
				kind: "error",
				error
			};
			return context.fallbackAvailable ? { kind: "legacy" } : {
				kind: "error",
				error
			};
		}
		if (NOT_PROBE_RECOGNIZED.has(code)) return { kind: "legacy" };
		return { kind: "legacy" };
	}
	function classifyHttpError(outcome, context) {
		if (outcome.status === 401 || outcome.status === 403) {
			const isDenial = outcome.status === 403;
			return {
				kind: "error",
				error: new SdkHttpError(isDenial ? SdkErrorCode.ClientHttpForbidden : SdkErrorCode.ClientHttpAuthentication, `Version negotiation failed: ${isDenial ? "the server denied access (HTTP 403)" : "the server requires authorization (HTTP 401)"}`, {
					status: outcome.status,
					statusText: outcome.statusText,
					text: outcome.body
				})
			};
		}
		if (outcome.status >= 500) return {
			kind: "error",
			error: new SdkHttpError(SdkErrorCode.EraNegotiationFailed, `Version negotiation failed: the server answered the probe with HTTP ${outcome.status}`, {
				status: outcome.status,
				statusText: outcome.statusText,
				text: outcome.body
			})
		};
		const rpcError = parseJsonRpcErrorBody(outcome.body);
		if (rpcError !== void 0) return classifyRpcError(rpcError, context);
		return { kind: "legacy" };
	}
	function classifyNetworkError(error, context) {
		if (context.environment === "browser" && isOpaqueFetchTypeError(error)) return { kind: "legacy" };
		return {
			kind: "error",
			error: new SdkError(SdkErrorCode.EraNegotiationFailed, `Version negotiation probe failed: ${describeError(error)}`, { cause: error })
		};
	}
	function isOpaqueFetchTypeError(error) {
		return error instanceof TypeError || error instanceof Error && error.name === "TypeError";
	}
	function describeError(error) {
		return error instanceof Error ? error.message : String(error);
	}
	function parseSupportedList(data) {
		if (typeof data !== "object" || data === null) return void 0;
		const supported = data.supported;
		if (!Array.isArray(supported) || supported.length === 0 || !supported.every((v) => typeof v === "string")) return;
		return supported;
	}
	function parseRequested(data) {
		if (typeof data !== "object" || data === null) return void 0;
		const requested = data.requested;
		return typeof requested === "string" ? requested : void 0;
	}
	function parseJsonRpcErrorBody(body) {
		if (body === void 0 || body === "") return void 0;
		let parsed;
		try {
			parsed = JSON.parse(body);
		} catch {
			return;
		}
		if (typeof parsed !== "object" || parsed === null) return void 0;
		const error = parsed.error;
		if (typeof error !== "object" || error === null) return void 0;
		const { code, message, data } = error;
		if (typeof code !== "number") return void 0;
		return {
			code,
			message: typeof message === "string" ? message : "",
			data
		};
	}
	/**
	* The default mode when `versionNegotiation` (or its `mode`) is absent;
	* changing the default later is a flip of this single line.
	*/
	const DEFAULT_VERSION_NEGOTIATION_MODE = "legacy";
	/**
	* Resolve the negotiation options into a per-connect plan. The raw (not
	* defaulted) `supportedProtocolVersions` option supplies the modern offer list;
	* a list without any legacy version makes this a modern-only client (no fallback).
	*/
	function resolveVersionNegotiation(options, supportedProtocolVersionsOption) {
		const mode = options?.mode ?? DEFAULT_VERSION_NEGOTIATION_MODE;
		if (mode === "legacy") return { kind: "legacy" };
		const probe = options?.probe ?? {};
		if (typeof mode === "object") {
			if (!isModernProtocolVersion(mode.pin)) throw new TypeError(`versionNegotiation: { pin: '${mode.pin}' } is not a modern protocol revision — pinning is for 2026-07-28 and later; omit versionNegotiation (or use mode: 'legacy') for 2025-era servers.`);
			return {
				kind: "pin",
				version: mode.pin,
				probe
			};
		}
		const explicitModern = supportedProtocolVersionsOption ? modernProtocolVersions(supportedProtocolVersionsOption) : [];
		return {
			kind: "auto",
			modernVersions: explicitModern.length > 0 ? explicitModern : [...SUPPORTED_MODERN_PROTOCOL_VERSIONS],
			fallbackAvailable: supportedProtocolVersionsOption ? legacyProtocolVersions(supportedProtocolVersionsOption).length > 0 : true,
			probe
		};
	}
	/** Detect the probe environment for the network-failure row — see {@linkcode ProbeEnvironment}. */
	function detectProbeEnvironment() {
		const g = globalThis;
		return g.window !== void 0 && g.document !== void 0 ? "browser" : "node";
	}
	/**
	* Detect the transport class for the transport-aware timeout and closed verdicts (see
	* {@linkcode ProbeTransportKind}). The stdio child-process transport is
	* recognized structurally (`stderr`/`pid` accessors, no `instanceof` — safe
	* across bundles); everything else is treated like HTTP.
	*/
	function detectProbeTransportKind(transport) {
		return "stderr" in transport && "pid" in transport ? "stdio" : "http";
	}
	/**
	* Temporary ownership of a raw transport for the negotiation exchange, before
	* the Protocol machinery attaches. `open()` installs the window's handlers and
	* starts the transport; `release()` detaches them and arms a one-shot `start()`
	* pass-through so the subsequent Protocol connect (which always starts its
	* transport) takes over the already-started channel without a double-start error.
	*
	* Handlers a caller pre-set on the transport before `connect()` are saved on
	* open and restored on detach, so `Protocol.connect()` finds and chains them
	* exactly as it would on a plain (non-negotiating) connect. Error and close
	* events are forwarded to the saved handlers during the window, so negotiation
	* does not change what a pre-attached observer sees of the transport
	* lifecycle. (Inbound messages are deliberately NOT forwarded — the window's
	* drop-guard is a module invariant, and the probe reply has no plain-connect
	* counterpart; a pre-set `onmessage` is restored at detach and chained by
	* `Protocol.connect()` like the others.)
	*/
	var ProbeWindow = class ProbeWindow {
		_pending;
		_probeCounter = 0;
		_savedOnMessage;
		_savedOnError;
		_savedOnClose;
		_closeDelivered = false;
		constructor(_transport) {
			this._transport = _transport;
			this._savedOnMessage = _transport.onmessage;
			this._savedOnError = _transport.onerror;
			this._savedOnClose = _transport.onclose;
		}
		static async open(transport) {
			const window = new ProbeWindow(transport);
			transport.onmessage = (message) => {
				const pending = window._pending;
				if (pending !== void 0 && (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) && message.id === pending.id) {
					window._pending = void 0;
					if (isJSONRPCResultResponse(message)) pending.resolve({
						kind: "response",
						result: message.result
					});
					else pending.resolve({
						kind: "response",
						error: message.error
					});
					return;
				}
			};
			transport.onerror = (error) => {
				window._savedOnError?.(error);
			};
			transport.onclose = () => {
				const pending = window._pending;
				if (pending !== void 0) {
					window._pending = void 0;
					pending.resolve({ kind: "closed" });
				}
				window._closeDelivered = true;
				window._savedOnClose?.();
			};
			try {
				await transport.start();
			} catch (error) {
				window.detach();
				throw error;
			}
			return window;
		}
		/**
		* Send one probe request and await its reply. Probe ids are strings, so they
		* never collide with Protocol's numeric ids (e.g. on a shared stdio pipe).
		*/
		async exchange(buildRequest, timeoutMs) {
			const id = `server-discover-probe-${++this._probeCounter}`;
			return new Promise((resolve) => {
				let settled = false;
				const settle = (reply) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					if (this._pending?.id === id) this._pending = void 0;
					resolve(reply);
				};
				const timer = setTimeout(() => settle({ kind: "timeout" }), timeoutMs);
				this._pending = {
					id,
					resolve: settle
				};
				this._transport.send(buildRequest(id)).catch((error) => settle({
					kind: "send-error",
					error
				}));
			});
		}
		/** Detach the window's handlers, restoring any the caller pre-set, leaving the transport's own `start` untouched. */
		detach() {
			this._pending = void 0;
			this._transport.onmessage = this._savedOnMessage;
			this._transport.onerror = this._savedOnError;
			if (this._closeDelivered && this._savedOnClose !== void 0) {
				const saved = this._savedOnClose;
				const transport = this._transport;
				let spent = false;
				const wrapper = () => {
					if (!spent) {
						spent = true;
						return;
					}
					saved();
				};
				transport.onclose = wrapper;
				pendingSpentCloseGuards.set(transport, () => {
					if (transport.onclose === wrapper) transport.onclose = saved;
				});
			} else this._transport.onclose = this._savedOnClose;
		}
		/** Detach the handlers and arm the one-shot `start()` pass-through for the `Protocol.connect()` handover. */
		release() {
			this.detach();
			const transport = this._transport;
			const originalStart = transport.start;
			let armed = true;
			transport.start = async function() {
				if (armed) {
					armed = false;
					transport.start = originalStart;
					return;
				}
				return originalStart.call(transport);
			};
		}
	};
	/**
	* Spent-close guards from failed negotiations, pending disarm by the cleanup
	* site (keyed weakly — an abandoned transport carries its guard to GC).
	*/
	const pendingSpentCloseGuards = /* @__PURE__ */ new WeakMap();
	/**
	* Disarm a failed negotiation's spent-close guard once the cleanup `close()`
	* has settled. Any re-delivery of the spent mid-window close happens DURING
	* that close (HTTP transports re-fire `onclose` there; stdio transports never
	* do — their close event already fired), so after it every close is genuine
	* and must reach the caller's pre-set observer.
	*/
	function disarmSpentCloseGuard(transport) {
		const disarm = pendingSpentCloseGuards.get(transport);
		pendingSpentCloseGuards.delete(transport);
		disarm?.();
	}
	/** Build the probe request: `server/discover` carrying the full per-request `_meta` envelope. */
	function buildProbeRequest(id, protocolVersion, clientInfo, capabilities) {
		return {
			jsonrpc: "2.0",
			id,
			method: "server/discover",
			params: { _meta: codecForVersion(protocolVersion).outboundEnvelope({
				protocolVersion,
				clientInfo,
				clientCapabilities: capabilities
			}) }
		};
	}
	function normalizeReply(reply, timeoutMs) {
		switch (reply.kind) {
			case "response": return reply.error === void 0 ? {
				kind: "result",
				result: reply.result
			} : {
				kind: "rpc-error",
				...reply.error
			};
			case "send-error": {
				const error = reply.error;
				if (isAuthSeamEscape(error) || error instanceof UnauthorizedError || error instanceof Error && error.name === "UnauthorizedError") return {
					kind: "auth-required",
					error
				};
				if (error instanceof SdkHttpError) {
					const text = error.data?.text;
					return {
						kind: "http-error",
						status: error.data.status,
						body: typeof text === "string" ? text : void 0,
						statusText: error.data.statusText
					};
				}
				return {
					kind: "network-error",
					error
				};
			}
			case "closed": return { kind: "closed" };
			case "timeout": return {
				kind: "timeout",
				timeoutMs
			};
		}
	}
	/**
	* Run the negotiation probe state machine on a raw (not yet Protocol-connected)
	* transport. Resolves with the negotiated era; throws typed connect errors. On
	* return the probe window has been released: the transport is started,
	* handler-free, and ready for `Protocol.connect()` handover. On throw the
	* window is detached and the transport's `start` is left untouched.
	*/
	async function negotiateEra(negotiation, deps) {
		const timeoutMs = negotiation.probe.timeoutMs ?? deps.defaultTimeoutMs;
		const maxRetries = Math.max(0, negotiation.probe.maxRetries ?? 0);
		const clientModernVersions = negotiation.kind === "pin" ? [negotiation.version] : negotiation.modernVersions;
		const fallbackAvailable = negotiation.kind === "auto" && negotiation.fallbackAvailable;
		const window = await ProbeWindow.open(deps.transport);
		const probe = async () => {
			let requestedVersion = clientModernVersions[0];
			let correctiveUsed = false;
			let timeoutRetriesRemaining = maxRetries;
			for (;;) {
				const reply = await window.exchange((id) => buildProbeRequest(id, requestedVersion, deps.clientInfo, deps.capabilities), timeoutMs);
				if (reply.kind === "timeout" && timeoutRetriesRemaining > 0) {
					timeoutRetriesRemaining--;
					continue;
				}
				const outcome = normalizeReply(reply, timeoutMs);
				const verdict = classifyProbeOutcome(outcome, {
					clientModernVersions,
					requestedVersion,
					fallbackAvailable,
					environment: deps.environment,
					transportKind: deps.transportKind
				});
				switch (verdict.kind) {
					case "modern": return {
						era: "modern",
						version: verdict.version,
						discover: verdict.discover
					};
					case "corrective":
						if (correctiveUsed) throw verdict.error;
						correctiveUsed = true;
						requestedVersion = verdict.version;
						continue;
					case "legacy": {
						const closedCause = outcome.kind === "closed" ? "the connection closed during the server/discover probe" : void 0;
						if (negotiation.kind === "pin") throw new SdkError(SdkErrorCode.EraNegotiationFailed, closedCause === void 0 ? `Version negotiation failed: the server did not offer pinned protocol version ${negotiation.version} via server/discover (no fallback in pin mode)` : `Version negotiation failed: ${closedCause} before the server offered pinned protocol version ${negotiation.version} (no fallback in pin mode)`);
						if (!negotiation.fallbackAvailable) throw new SdkError(SdkErrorCode.EraNegotiationFailed, closedCause === void 0 ? "Version negotiation failed: the server gave no modern evidence and this client supports no pre-2026-07-28 protocol version to fall back to" : `Version negotiation failed: ${closedCause} and this client supports no pre-2026-07-28 protocol version to fall back to`);
						if (closedCause !== void 0 && deps.disposableProbe !== true) throw new SdkError(SdkErrorCode.EraNegotiationFailed, `Version negotiation failed: ${closedCause} (this transport probed in place — the disposable sibling probe requires the SDK's base StdioClientTransport)`);
						return { era: "legacy" };
					}
					case "error": throw verdict.error;
				}
			}
		};
		let result;
		try {
			result = await probe();
		} catch (error) {
			window.detach();
			throw error;
		}
		window.release();
		return result;
	}
	/**
	* Structural read of the SDK stdio transport's retained spawn parameters —
	* `undefined` for stdio-shaped transports that do not expose them, and for
	* SUBCLASSES of the SDK transport (those probe in place, where a mid-probe
	* close stays a typed connect error). The sibling path requires the transport
	* to be exactly the base class: a subclass cannot be faithfully cloned by
	* re-invoking its constructor with the retained params alone (extra ctor
	* arguments, transformed state, side effects). Exactness is checked without
	* importing the class (the negotiation graph must stay runtime-neutral): only
	* the base class's own prototype carries the internal `_dispose` reaper the
	* sibling flow depends on — a subclass's prototype does not own it.
	*/
	function readStdioServerParams(transport) {
		const proto = Object.getPrototypeOf(transport);
		if (proto === null || !Object.prototype.hasOwnProperty.call(proto, "_dispose")) return;
		const params = transport._serverParams;
		return typeof params === "object" && params !== null && typeof params.command === "string" ? params : void 0;
	}
	/**
	* stdio era negotiation on a DISPOSABLE SIBLING: stdio servers built on SDKs
	* that terminate on any pre-`initialize` request exit when the probe arrives,
	* so the probe must not spend the caller's one process life. `server/discover`
	* runs on a short-lived sibling spawned from the same parameters; the caller's
	* transport starts exactly once, after the era is known. The sibling is
	* invisible infrastructure: its stderr is discarded, and it is reaped before
	* this resolves (signal escalation awaiting process exit — a helper holding
	* its pipes never blocks disposal). A caller `close()` on the session
	* transport during the probe aborts the connect with the typed negotiation
	* error, and the session transport is never started.
	*/
	async function negotiateStdioViaSibling(negotiation, sessionTransport, params, deps) {
		const SiblingTransport = sessionTransport.constructor;
		const sibling = new SiblingTransport({
			...params,
			stderr: "ignore"
		});
		const originalClose = sessionTransport.close;
		let callerClosed = false;
		let signalClosed;
		const closedSignal = new Promise((_, reject) => {
			signalClosed = () => reject(callerCloseAbortError());
		});
		sessionTransport.close = async function() {
			callerClosed = true;
			signalClosed?.();
			return originalClose.call(sessionTransport);
		};
		let result;
		try {
			const negotiated = negotiateEra(negotiation, {
				...deps,
				transport: sibling,
				transportKind: "stdio",
				disposableProbe: true
			});
			negotiated.catch(() => {});
			result = await Promise.race([negotiated, closedSignal]);
		} finally {
			await disposeSibling(sibling);
			sessionTransport.close = originalClose;
		}
		if (callerClosed) throw callerCloseAbortError();
		return result;
	}
	/** The typed abort for a caller `close()` landing while the sibling probes. */
	function callerCloseAbortError() {
		return new SdkError(SdkErrorCode.EraNegotiationFailed, "Version negotiation failed: the transport was closed during the server/discover probe");
	}
	/** Reap a probe sibling — best-effort; a sibling that cannot be reaped must not turn a settled verdict into an error. */
	async function disposeSibling(sibling) {
		try {
			const dispose = sibling._dispose;
			await (typeof dispose === "function" ? dispose.call(sibling) : sibling.close());
		} catch {}
	}
	/**
	* The server identity a `DiscoverResult` carries in
	* `_meta['io.modelcontextprotocol/serverInfo']` (a spec SHOULD — absent means
	* the server offered no identity). Runtime-validated with the spec-type
	* guard because `connect({ prior })` accepts caller-supplied values that
	* never saw a wire parse.
	*/
	function serverInfoFromDiscover(discover) {
		const fromMeta = discover._meta?.[SERVER_INFO_META_KEY];
		return isSpecType.Implementation(fromMeta) ? fromMeta : void 0;
	}
	/**
	* Elicitation default application helper. Applies defaults to the `data` based on the `schema`.
	*
	* @param schema - The schema to apply defaults to.
	* @param data - The data to apply defaults to.
	*/
	function applyElicitationDefaults(schema, data) {
		if (!schema || data === null || typeof data !== "object") return;
		if (schema.type === "object" && schema.properties && typeof schema.properties === "object") {
			const obj = data;
			const props = schema.properties;
			for (const key of Object.keys(props)) {
				const propSchema = props[key];
				if (obj[key] === void 0 && Object.prototype.hasOwnProperty.call(propSchema, "default")) obj[key] = propSchema.default;
				if (obj[key] !== void 0) applyElicitationDefaults(propSchema, obj[key]);
			}
		}
		if (Array.isArray(schema.anyOf)) {
			for (const sub of schema.anyOf) if (typeof sub !== "boolean") applyElicitationDefaults(sub, data);
		}
		if (Array.isArray(schema.oneOf)) {
			for (const sub of schema.oneOf) if (typeof sub !== "boolean") applyElicitationDefaults(sub, data);
		}
	}
	/**
	* Determines which elicitation modes are supported based on declared client capabilities.
	*
	* According to the spec:
	* - An empty elicitation capability object defaults to form mode support (backwards compatibility)
	* - URL mode is only supported if explicitly declared
	*
	* @param capabilities - The client's elicitation capabilities
	* @returns An object indicating which modes are supported
	*/
	function getSupportedElicitationModes(capabilities) {
		if (!capabilities) return {
			supportsFormMode: false,
			supportsUrlMode: false
		};
		const hasFormCapability = capabilities.form !== void 0;
		const hasUrlCapability = capabilities.url !== void 0;
		return {
			supportsFormMode: hasFormCapability || !hasFormCapability && !hasUrlCapability,
			supportsUrlMode: hasUrlCapability
		};
	}
	/**
	* Rejects malformed persisted blobs with a typed `SdkError` before any state
	* change: unrecognized `kind`, a legacy verdict also carrying
	* DiscoverResult-shaped members (a corrupt blob must never era-choose), or a
	* modern `discover` payload failing the wire path's schema.
	*/
	function validatePrior(prior) {
		if (typeof prior === "object" && prior !== null) {
			if (prior.kind === "legacy" && !("supportedVersions" in prior) && !("discover" in prior)) return prior;
			if (prior.kind === "modern" && DiscoverResultSchema.safeParse(prior.discover).success) return prior;
		}
		throw new SdkError(SdkErrorCode.EraNegotiationFailed, "connect({ prior }): unrecognized prior — expected { kind: 'modern', discover } or { kind: 'legacy' }");
	}
	/**
	* `list_changed` notification → response-cache method(s) to evict. `resources`
	* covers both list verbs (the spec's "relevant notification ⇒ immediately
	* stale").
	*/
	const LIST_CHANGED_EVICTIONS = {
		"notifications/tools/list_changed": ["tools/list"],
		"notifications/prompts/list_changed": ["prompts/list"],
		"notifications/resources/list_changed": ["resources/list", "resources/templates/list"]
	};
	const DEFAULT_LIST_MAX_PAGES = 64;
	/**
	* An MCP client on top of a pluggable transport.
	*
	* The client will automatically begin the initialization flow with the server when {@linkcode connect} is called.
	*
	* To handle server-initiated requests (sampling, elicitation, roots), call {@linkcode setRequestHandler}.
	* The client must declare the corresponding capability for the handler to be accepted. For
	* `sampling/createMessage` and `elicitation/create`, the handler is automatically wrapped with
	* schema validation for both the incoming request and the returned result.
	*
	* Note: the `roots/list` and `sampling/createMessage` handler surfaces (and the corresponding
	* `roots` and `sampling` capabilities) are deprecated as of protocol version 2026-07-28
	* (SEP-2577). They remain functional during the deprecation window (at least twelve months).
	* Migrate sampling to calling LLM provider APIs directly, and roots to passing paths via tool
	* parameters, resource URIs, or configuration.
	*
	* @example Handling a sampling request
	* ```ts source="./client.examples.ts#Client_setRequestHandler_sampling"
	* client.setRequestHandler('sampling/createMessage', async request => {
	*     const lastMessage = request.params.messages.at(-1);
	*     console.log('Sampling request:', lastMessage);
	*
	*     // In production, send messages to your LLM here
	*     return {
	*         model: 'my-model',
	*         role: 'assistant' as const,
	*         content: {
	*             type: 'text' as const,
	*             text: 'Response from the model'
	*         }
	*     };
	* });
	* ```
	*/
	var Client = class extends Protocol {
		_serverCapabilities;
		_serverVersion;
		_capabilities;
		_instructions;
		_jsonSchemaValidator;
		/**
		* The response-cache substrate. Owns the backing store, the per-method
		* eviction-generation counter, the user-supplied/default flag, and the
		* stamp-memoized derived `name → Tool` / `name → output-validator`
		* indices — the cache-coordination state that used to live as separate
		* private fields here. The internal aggregating walk writes one entry per
		* list verb; `list_changed` evicts the matching method;
		* `_resetConnectionState` resets the lot. {@linkcode callTool}'s
		* output-schema validation reads the derived `outputValidator` index (the
		* substrate's first production caller); the stacked SEP-2243 PR wires
		* `Mcp-Param-*` mirroring through `toolDefinition` on top.
		*/
		_cache;
		_defaultCacheTtlMs;
		_listMaxPages;
		_listChangedDebounceTimers = /* @__PURE__ */ new Map();
		/**
		* The constructor `listChanged` configuration. Durable across reconnects:
		* read fresh on every connect (legacy or modern), never consumed.
		*/
		_listChangedConfig;
		_enforceStrictCapabilities;
		_versionNegotiation;
		_supportedProtocolVersionsOption;
		_inputRequiredDriverConfig;
		/**
		* Active subscriptions/listen state, keyed by subscription id (= the
		* listen request's JSON-RPC id verbatim). The id is a STRING from a
		* Client-owned counter (`'listen:' + N`) — JSON-RPC permits string ids,
		* and Protocol's numeric `_requestMessageId` counter only ever issues
		* numbers, so listen ids cannot collide with ordinary request ids.
		*/
		_listenState = /* @__PURE__ */ new Map();
		_nextListenId = 0;
		/** The auto-opened subscription backing ClientOptions.listChanged on a modern connection. */
		_autoOpenedSubscription;
		/** Backing store for {@linkcode getDiscoverResult}. Per-connection. */
		_discoverResult;
		/**
		* Clears every per-connection field in one place. Called at the start of
		* each fresh (non-resuming) connect and from `close()`, so a stale
		* negotiated era / server identity / auto-opened subscription cannot
		* survive a reconnect.
		*/
		_resetConnectionState() {
			this._negotiatedProtocolVersion = void 0;
			this._serverCapabilities = void 0;
			this._serverVersion = void 0;
			this._instructions = void 0;
			this._discoverResult = void 0;
			this._autoOpenedSubscription = void 0;
			if (this._listenState.size > 0) {
				const reason = new SdkError(SdkErrorCode.ConnectionClosed, "subscriptions/listen: client reconnected or closed; subscription state from the previous connection was reset");
				for (const entry of this._listenState.values()) entry.settle({
					cause: "remote",
					error: reason
				});
			}
			this._listenState.clear();
			for (const timer of this._listChangedDebounceTimers.values()) clearTimeout(timer);
			this._listChangedDebounceTimers.clear();
			this._cache.resetForReconnect();
		}
		async close() {
			try {
				await super.close();
			} finally {
				this._resetConnectionState();
			}
		}
		/**
		* Initializes this client with the given name and version information.
		*/
		constructor(_clientInfo, options) {
			super(options);
			this._clientInfo = _clientInfo;
			this._capabilities = options?.capabilities ? { ...options.capabilities } : {};
			this._jsonSchemaValidator = options?.jsonSchemaValidator ?? new CfWorkerJsonSchemaValidator();
			this._enforceStrictCapabilities = options?.enforceStrictCapabilities ?? false;
			this._versionNegotiation = options?.versionNegotiation;
			this._supportedProtocolVersionsOption = options?.supportedProtocolVersions;
			this._inputRequiredDriverConfig = resolveInputRequiredDriverConfig(options?.inputRequired);
			this._cache = new ClientResponseCache(options?.responseCacheStore ?? new InMemoryResponseCacheStore(), options?.responseCacheStore !== void 0, (error) => this._reportStoreError(error), options?.cachePartition ?? "");
			this._defaultCacheTtlMs = options?.defaultCacheTtlMs ?? 0;
			this._listMaxPages = options?.listMaxPages ?? DEFAULT_LIST_MAX_PAGES;
			if (options?.listChanged) this._listChangedConfig = options.listChanged;
		}
		buildContext(ctx, _transportInfo) {
			return ctx;
		}
		/**
		* Era-keyed direction enforcement for inbound traffic on channels whose
		* transport does not classify (e.g. stdio): the 2026-07-28 era has no
		* server→client JSON-RPC request channel — server-to-client interactions
		* are carried in-band in `input_required` results — and on stdio the
		* client must never write JSON-RPC responses. An inbound request arriving
		* on a connection that negotiated a modern era is therefore dropped
		* (surfaced via `onerror`) rather than answered. Connections on a legacy
		* era — and all responses and notifications — keep today's dispatch path.
		*/
		_shouldDropInbound(message) {
			if (this._negotiatedProtocolVersion !== void 0 && isModernProtocolVersion(this._negotiatedProtocolVersion) && isJSONRPCRequest(message)) return "drop";
		}
		/**
		* Per-request `_meta` envelope auto-emission (protocol revision 2026-07-28):
		* on a connection that negotiated a modern era — auto-negotiated or pinned —
		* every outgoing request and notification automatically carries the reserved
		* protocol-version / client-info / client-capabilities `_meta` keys (the
		* same envelope the connect-time `server/discover` probe sends).
		* User-supplied `_meta` keys take precedence over the auto-attached ones.
		*
		* Legacy-era connections return `undefined`: the envelope seam is a no-op
		* and outbound traffic is byte-identical to a 2025 client (the legacy
		* `'auto'` fallback included).
		*/
		_outboundMetaEnvelope() {
			const version = this._negotiatedProtocolVersion;
			if (version === void 0) return void 0;
			return this._wireCodec().outboundEnvelope({
				protocolVersion: version,
				clientInfo: this._clientInfo,
				clientCapabilities: this._capabilities
			});
		}
		/**
		* Wires the multi-round-trip auto-fulfilment engine (protocol revision
		* 2026-07-28) into the response funnel: an `input_required` answer is
		* fulfilled through the registered elicitation/sampling/roots handlers
		* and the original request retried via `flow.retry`, up to
		* `inputRequired.maxRounds` rounds. With auto-fulfilment disabled the
		* response surfaces as a typed error steering to manual mode.
		*/
		_resolveNonCompleteResult(decoded, flow) {
			if (!this._inputRequiredDriverConfig.autoFulfill) return Promise.reject(new SdkError(SdkErrorCode.UnsupportedResultType, `Unsupported result type 'input_required' for ${flow.request.method}: multi-round-trip auto-fulfilment is not enabled on this instance — pass allowInputRequired: true to handle it manually, or enable inputRequired.autoFulfill`, {
				resultType: "input_required",
				method: flow.request.method
			}));
			return runInputRequiredFlow({
				getRequestHandler: (method) => this._getRequestHandler(method),
				buildContext: (baseCtx) => this.buildContext(baseCtx, void 0),
				sessionId: this.transport?.sessionId
			}, this._inputRequiredDriverConfig, decoded, flow);
		}
		/**
		* Set up handlers for list changed notifications based on config and server capabilities.
		* This should only be called after initialization when server capabilities are known.
		* Handlers are silently skipped if the server doesn't advertise the corresponding listChanged capability.
		* @internal
		*/
		_setupListChangedHandlers(config) {
			if (config.tools && this._serverCapabilities?.tools?.listChanged) this._setupListChangedHandler("tools", "notifications/tools/list_changed", config.tools, async () => {
				return (await this.listTools(void 0, { cacheMode: "refresh" })).tools;
			});
			if (config.prompts && this._serverCapabilities?.prompts?.listChanged) this._setupListChangedHandler("prompts", "notifications/prompts/list_changed", config.prompts, async () => {
				return (await this.listPrompts(void 0, { cacheMode: "refresh" })).prompts;
			});
			if (config.resources && this._serverCapabilities?.resources?.listChanged) this._setupListChangedHandler("resources", "notifications/resources/list_changed", config.resources, async () => {
				return (await this.listResources(void 0, { cacheMode: "refresh" })).resources;
			});
		}
		/**
		* Registers new capabilities. This can only be called before connecting to a transport.
		*
		* The new capabilities will be merged with any existing capabilities previously given (e.g., at initialization).
		*/
		registerCapabilities(capabilities) {
			if (this.transport) throw new Error("Cannot register capabilities after connecting to transport");
			this._capabilities = mergeCapabilities(this._capabilities, capabilities);
		}
		/**
		* Configure protocol version negotiation before connecting (equivalent to
		* passing `versionNegotiation` at construction time). Can only be called
		* before connecting to a transport. Passing `undefined` clears a previously
		* configured negotiation, restoring the default `'legacy'` posture.
		*
		* See {@linkcode ClientOptions | ClientOptions.versionNegotiation} for the mode semantics.
		*/
		setVersionNegotiation(options) {
			if (this.transport) throw new Error("Cannot configure version negotiation after connecting to transport");
			this._versionNegotiation = options;
		}
		/**
		* Enforces client-side validation for `elicitation/create` and `sampling/createMessage`
		* regardless of how the handler was registered.
		*/
		_wrapHandler(method, handler) {
			if (method === "elicitation/create") return async (request, ctx) => {
				const codec = codecForVersion(this._negotiatedProtocolVersion);
				let validatedRequest = codec.validateRequest("elicitation/create", request);
				if (!validatedRequest.ok && validatedRequest.reason === "not-in-era") validatedRequest = codec.validateInputRequest("elicitation/create", request);
				if (!validatedRequest.ok) throw new ProtocolError(validatedRequest.reason === "not-in-era" ? ProtocolErrorCode.InternalError : ProtocolErrorCode.InvalidParams, validatedRequest.reason === "not-in-era" ? "No wire schema for elicitation/create in the resolved era" : `Invalid elicitation request: ${validatedRequest.message}`);
				const { params } = validatedRequest.value;
				params.mode = params.mode ?? "form";
				const { supportsFormMode, supportsUrlMode } = getSupportedElicitationModes(this._capabilities.elicitation);
				if (params.mode === "form" && !supportsFormMode) throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Client does not support form-mode elicitation requests");
				if (params.mode === "url" && !supportsUrlMode) throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Client does not support URL-mode elicitation requests");
				const result = await handler(request, ctx);
				let validationResult = codec.validateResult("elicitation/create", result);
				if (!validationResult.ok && validationResult.reason === "not-in-era") validationResult = codec.validateInputResponse("elicitation/create", result);
				if (!validationResult.ok) throw new ProtocolError(validationResult.reason === "not-in-era" ? ProtocolErrorCode.InternalError : ProtocolErrorCode.InvalidParams, validationResult.reason === "not-in-era" ? "No wire schema for elicitation/create in the resolved era" : `Invalid elicitation result: ${validationResult.message}`);
				const validatedResult = validationResult.value;
				const requestedSchema = params.mode === "form" ? params.requestedSchema : void 0;
				if (params.mode === "form" && validatedResult.action === "accept" && validatedResult.content && requestedSchema && this._capabilities.elicitation?.form?.applyDefaults) try {
					applyElicitationDefaults(requestedSchema, validatedResult.content);
				} catch {}
				return validatedResult;
			};
			if (method === "sampling/createMessage") return async (request, ctx) => {
				const codec = codecForVersion(this._negotiatedProtocolVersion);
				let validatedRequest = codec.validateRequest("sampling/createMessage", request);
				if (!validatedRequest.ok && validatedRequest.reason === "not-in-era") validatedRequest = codec.validateInputRequest("sampling/createMessage", request);
				if (!validatedRequest.ok) throw new ProtocolError(validatedRequest.reason === "not-in-era" ? ProtocolErrorCode.InternalError : ProtocolErrorCode.InvalidParams, validatedRequest.reason === "not-in-era" ? "No wire schema for sampling/createMessage in the resolved era" : `Invalid sampling request: ${validatedRequest.message}`);
				const { params } = validatedRequest.value;
				const result = await handler(request, ctx);
				const hasTools = Boolean(params.tools || params.toolChoice);
				let validatedResult = codec.samplingResultVariant(hasTools, result);
				if (!validatedResult.ok && validatedResult.reason === "not-in-era") validatedResult = codec.validateInputResponse("sampling/createMessage", result);
				if (!validatedResult.ok) throw new ProtocolError(validatedResult.reason === "not-in-era" ? ProtocolErrorCode.InternalError : ProtocolErrorCode.InvalidParams, validatedResult.reason === "not-in-era" ? "No result schema for sampling/createMessage in the resolved era" : `Invalid sampling result: ${validatedResult.message}`);
				return validatedResult.value;
			};
			return handler;
		}
		assertCapability(capability, method) {
			if (!this._serverCapabilities?.[capability]) throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support ${capability} (required for ${method})`);
		}
		/**
		* Connects to a server via the given transport and performs the MCP initialization handshake.
		*
		* @example Basic usage (stdio)
		* ```ts source="./client.examples.ts#Client_connect_stdio"
		* const client = new Client({ name: 'my-client', version: '1.0.0' });
		* const transport = new StdioClientTransport({ command: 'my-mcp-server' });
		* await client.connect(transport);
		* ```
		*
		* @example Streamable HTTP with SSE fallback
		* ```ts source="./client.examples.ts#Client_connect_sseFallback"
		* const baseUrl = new URL(url);
		*
		* try {
		*     // Try modern Streamable HTTP transport first
		*     const client = new Client({ name: 'my-client', version: '1.0.0' });
		*     const transport = new StreamableHTTPClientTransport(baseUrl);
		*     await client.connect(transport);
		*     return { client, transport };
		* } catch {
		*     // Fall back to legacy SSE transport
		*     const client = new Client({ name: 'my-client', version: '1.0.0' });
		*     const transport = new SSEClientTransport(baseUrl);
		*     await client.connect(transport);
		*     return { client, transport };
		* }
		* ```
		*/
		async connect(transport, options) {
			if (options?.prior != null) return this._connectFromPrior(transport, validatePrior(options.prior), options);
			const negotiation = resolveVersionNegotiation(this._versionNegotiation, this._supportedProtocolVersionsOption);
			if (negotiation.kind !== "legacy") return this._connectNegotiated(transport, negotiation, options);
			return this._connectPlainLegacy(transport, options);
		}
		/**
		* Plain legacy connect — the pinned 2025 sequence, byte-untouched. The
		* `mode: 'legacy'` connect body, shared with the `prior` legacy verdict.
		*/
		async _connectPlainLegacy(transport, options) {
			await super.connect(transport);
			if (transport.sessionId !== void 0) {
				const negotiatedProtocolVersion = this._negotiatedProtocolVersion;
				if (negotiatedProtocolVersion !== void 0) transport.setProtocolVersion?.(negotiatedProtocolVersion);
				return;
			}
			this._resetConnectionState();
			await this._legacyHandshake(transport, options);
		}
		/**
		* The 2025 `initialize` handshake — the body of the plain legacy connect and
		* the `'auto'`-mode fallback path (same `initialize` body, zero 2026 headers;
		* on the stdio sibling path it opens the session child's fresh pipe, in the
		* in-place modes it rides the probed connection). Callers clear the negotiated protocol version before
		* the handshake; its completion sets the negotiated (legacy) version.
		*/
		async _legacyHandshake(transport, options) {
			const legacyVersions = legacyProtocolVersions(this._supportedProtocolVersions);
			try {
				const offeredVersion = legacyVersions[0];
				if (offeredVersion === void 0) throw new SdkError(SdkErrorCode.EraNegotiationFailed, "Cannot run the initialize handshake: supportedProtocolVersions contains no pre-2026-07-28 protocol version");
				const result = await this.request({
					method: "initialize",
					params: {
						protocolVersion: offeredVersion,
						capabilities: this._capabilities,
						clientInfo: this._clientInfo
					}
				}, options);
				if (result === void 0) throw new Error(`Server sent invalid initialize result: ${result}`);
				if (!legacyVersions.includes(result.protocolVersion)) throw new Error(`Server's protocol version is not supported: ${result.protocolVersion}`);
				this._serverCapabilities = result.capabilities;
				this._serverVersion = result.serverInfo;
				this._cache.setServerIdentity(this._deriveServerIdentity(transport));
				if (transport.setProtocolVersion) transport.setProtocolVersion(result.protocolVersion);
				this._instructions = result.instructions;
				await this.notification({ method: "notifications/initialized" });
				this._negotiatedProtocolVersion = result.protocolVersion;
				if (this._listChangedConfig) this._setupListChangedHandlers(this._listChangedConfig);
			} catch (error) {
				this.close();
				throw error;
			}
		}
		/**
		* Negotiated connect (mode `'auto'` or `{ pin }`): probe with `server/discover`
		* before the Protocol machinery attaches — on a disposable sibling process for
		* the SDK's stdio transport, in place otherwise — then either establish the
		* modern era or perform the plain legacy handshake.
		*/
		async _connectNegotiated(transport, negotiation, options) {
			if (transport.sessionId !== void 0) {
				await super.connect(transport);
				const negotiatedProtocolVersion = this._negotiatedProtocolVersion;
				if (negotiatedProtocolVersion !== void 0 && transport.setProtocolVersion) transport.setProtocolVersion(negotiatedProtocolVersion);
				return;
			}
			this._resetConnectionState();
			let result;
			try {
				const transportKind = detectProbeTransportKind(transport);
				const baseDeps = {
					clientInfo: this._clientInfo,
					capabilities: this._capabilities,
					environment: detectProbeEnvironment(),
					defaultTimeoutMs: options?.timeout ?? 6e4
				};
				const stdioParams = transportKind === "stdio" ? readStdioServerParams(transport) : void 0;
				result = stdioParams === void 0 ? await negotiateEra(negotiation, {
					...baseDeps,
					transport,
					transportKind
				}) : await negotiateStdioViaSibling(negotiation, transport, stdioParams, baseDeps);
			} catch (error) {
				await transport.close().catch(() => {});
				disarmSpentCloseGuard(transport);
				throw error;
			}
			disarmSpentCloseGuard(transport);
			await super.connect(transport);
			if (result.era === "legacy") {
				await this._legacyHandshake(transport, options);
				return;
			}
			this._serverCapabilities = result.discover.capabilities;
			this._serverVersion = serverInfoFromDiscover(result.discover);
			this._cache.setServerIdentity(this._deriveServerIdentity(transport));
			this._instructions = result.discover.instructions;
			this._discoverResult = result.discover;
			this._negotiatedProtocolVersion = result.version;
			if (transport.setProtocolVersion) transport.setProtocolVersion(result.version);
			if (this._listChangedConfig) {
				const config = this._listChangedConfig;
				const advertised = this._serverCapabilities;
				const effective = {
					...config.tools && advertised?.tools?.listChanged && { tools: config.tools },
					...config.prompts && advertised?.prompts?.listChanged && { prompts: config.prompts },
					...config.resources && advertised?.resources?.listChanged && { resources: config.resources }
				};
				let handlersRegistered = true;
				try {
					this._setupListChangedHandlers(effective);
				} catch (error) {
					handlersRegistered = false;
					this.onerror?.(error instanceof Error ? error : new Error(String(error)));
				}
				const filter = handlersRegistered ? {
					...effective.tools && { toolsListChanged: true },
					...effective.prompts && { promptsListChanged: true },
					...effective.resources && { resourcesListChanged: true }
				} : {};
				if (Object.keys(filter).length > 0) {
					const ackAbort = new AbortController();
					const onConnectAbort = () => ackAbort.abort(options?.signal?.reason);
					if (options?.signal?.aborted) onConnectAbort();
					options?.signal?.addEventListener("abort", onConnectAbort);
					try {
						this._autoOpenedSubscription = await this.listen(filter, {
							timeout: options?.timeout,
							signal: ackAbort.signal
						});
					} catch (error) {
						if (options?.signal?.aborted) {
							await this.close().catch(() => {});
							throw error;
						}
						this.onerror?.(error instanceof Error ? error : new Error(String(error)));
					} finally {
						options?.signal?.removeEventListener("abort", onConnectAbort);
					}
				}
			}
		}
		/**
		* Connect from a validated {@linkcode PriorDiscovery}: the modern arm
		* adopts the `DiscoverResult` (zero round trips; `EraNegotiationFailed`
		* on no 2026-07-28+ overlap), the legacy arm runs the plain legacy connect.
		*/
		async _connectFromPrior(transport, prior, options) {
			if (prior.kind === "legacy") return this._connectPlainLegacy(transport, options);
			const discover = prior.discover;
			this._resetConnectionState();
			const explicit = this._supportedProtocolVersionsOption;
			const version = (explicit && modernProtocolVersions(explicit).length > 0 ? modernProtocolVersions(explicit) : SUPPORTED_MODERN_PROTOCOL_VERSIONS).find((v) => discover.supportedVersions.includes(v));
			if (version === void 0) throw new SdkError(SdkErrorCode.EraNegotiationFailed, "connect({ prior }) with a modern verdict requires a 2026-07-28+ mutual protocol version; the supplied DiscoverResult and this client's supportedProtocolVersions have no modern overlap. For a server known to be legacy, pass prior: { kind: 'legacy' } to skip the probe and initialize directly, or use versionNegotiation: { mode: 'auto' } to re-probe with legacy fallback.");
			await super.connect(transport);
			this._discoverResult = discover;
			this._serverCapabilities = discover.capabilities;
			this._serverVersion = serverInfoFromDiscover(discover);
			this._cache.setServerIdentity(this._deriveServerIdentity(transport));
			this._instructions = discover.instructions;
			this._negotiatedProtocolVersion = version;
			transport.setProtocolVersion?.(version);
			if (this._listChangedConfig) try {
				this._setupListChangedHandlers(this._listChangedConfig);
			} catch (error) {
				this.onerror?.(error instanceof Error ? error : new Error(String(error)));
			}
		}
		/**
		* After initialization has completed, this will be populated with the server's reported capabilities.
		*/
		getServerCapabilities() {
			return this._serverCapabilities;
		}
		/**
		* The connected server's self-reported name and version, when it
		* identified itself: required on the legacy `initialize` result; a spec
		* SHOULD in the discover result's `_meta` on 2026-07-28, so a successful
		* modern connect against an anonymous server leaves this `undefined`.
		*/
		getServerVersion() {
			return this._serverVersion;
		}
		/**
		* The connected server's identity for response-cache partitioning. The
		* `serverInfo` `name@version` pair when available (required on
		* `initialize`; a SHOULD in the discover result's `_meta` since spec PR
		* #3002); falls back to the transport's `sessionId`, then to a
		* per-connection surrogate. The surrogate matters since #3002 made
		* identity optional: without it, two identity-less servers reached over
		* sessionId-less transports would share the cache's pre-connect `''`
		* partition and read each other's entries — no stable identity means no
		* cross-connection cache reuse. The value itself is server-controlled —
		* the collision-safety of the storage partition comes from
		* {@linkcode ClientResponseCache}'s JSON-array encoding around it, not
		* from any character it does or does not contain.
		*/
		_deriveServerIdentity(transport) {
			const v = this._serverVersion;
			if (v !== void 0) return `${v.name}@${v.version}`;
			return transport.sessionId ?? `anonymous:${Date.now()}-${Math.random().toString(36).slice(2)}`;
		}
		/**
		* After initialization has completed, this will be populated with the protocol version negotiated
		* during the initialize handshake. When manually reconstructing a transport for reconnection, pass this
		* value to the new transport so it continues sending the required `mcp-protocol-version` header.
		*/
		getNegotiatedProtocolVersion() {
			return this._negotiatedProtocolVersion;
		}
		/**
		* After initialization has completed, this returns the protocol era of the
		* connection: `'modern'` when the connection negotiated a 2026-07-28+
		* revision (via `server/discover`), `'legacy'` for the 2025-era
		* `initialize` handshake, or `undefined` before the connection is
		* established.
		*/
		getProtocolEra() {
			const version = this._negotiatedProtocolVersion;
			if (version === void 0) return void 0;
			return isModernProtocolVersion(version) ? "modern" : "legacy";
		}
		/**
		* After initialization has completed, this may be populated with information about the server's instructions.
		*/
		getInstructions() {
			return this._instructions;
		}
		/**
		* The {@linkcode DiscoverResult} from the last `'auto'`/pinned probe,
		* {@linkcode discover} call, or `connect({ prior })` that adopted a
		* modern verdict (a legacy verdict leaves this `undefined` — there is no
		* `DiscoverResult` on that path). Persistable via `JSON.stringify`; wrap
		* as `{ kind: 'modern', discover }` and feed to {@linkcode ConnectOptions}
		* `prior`.
		*/
		getDiscoverResult() {
			return this._discoverResult;
		}
		assertCapabilityForMethod(method) {
			switch (method) {
				case "logging/setLevel":
					if (!this._serverCapabilities?.logging) throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support logging (required for ${method})`);
					break;
				case "prompts/get":
				case "prompts/list":
					if (!this._serverCapabilities?.prompts) throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support prompts (required for ${method})`);
					break;
				case "resources/list":
				case "resources/templates/list":
				case "resources/read":
				case "resources/subscribe":
				case "resources/unsubscribe":
					if (!this._serverCapabilities?.resources) throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support resources (required for ${method})`);
					if (method === "resources/subscribe" && !this._serverCapabilities.resources.subscribe) throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support resource subscriptions (required for ${method})`);
					break;
				case "tools/call":
				case "tools/list":
					if (!this._serverCapabilities?.tools) throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support tools (required for ${method})`);
					break;
				case "completion/complete": if (!this._serverCapabilities?.completions) throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support completions (required for ${method})`);
			}
		}
		assertNotificationCapability(method) {
			switch (method) {
				case "notifications/roots/list_changed": if (!this._capabilities.roots?.listChanged) throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Client does not support roots list changed notifications (required for ${method})`);
			}
		}
		assertRequestHandlerCapability(method) {
			switch (method) {
				case "sampling/createMessage":
					if (!this._capabilities.sampling) throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Client does not support sampling capability (required for ${method})`);
					break;
				case "elicitation/create":
					if (!this._capabilities.elicitation) throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Client does not support elicitation capability (required for ${method})`);
					break;
				case "roots/list": if (!this._capabilities.roots) throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Client does not support roots capability (required for ${method})`);
			}
		}
		async ping(options) {
			return this.request({ method: "ping" }, options);
		}
		/**
		* Send `server/discover` (2026-07-28+) and record the result for
		* {@linkcode getDiscoverResult}.
		*/
		async discover(options) {
			const result = await this._requestWithSchema({ method: "server/discover" }, DiscoverResultSchema, options);
			this._discoverResult = result;
			return result;
		}
		/** Requests argument autocompletion suggestions from the server for a prompt or resource. */
		async complete(params, options) {
			return this.request({
				method: "completion/complete",
				params
			}, options);
		}
		/**
		* Sets the minimum severity level for log messages sent by the server.
		*
		* @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577).
		* Remains functional during the deprecation window (at least twelve months).
		* Migrate to stderr logging (STDIO servers) or OpenTelemetry.
		*/
		async setLoggingLevel(level, options) {
			return this.request({
				method: "logging/setLevel",
				params: { level }
			}, options);
		}
		/** Retrieves a prompt by name from the server, passing the given arguments for template substitution. */
		async getPrompt(params, options) {
			return this.request({
				method: "prompts/get",
				params
			}, options);
		}
		/**
		* Lists available prompts.
		*
		* Called without a `cursor` (the common case), this walks every page and
		* returns the complete aggregated list with no `nextCursor`; the
		* aggregate is also written to the {@linkcode ResponseCacheStore}. Pass an
		* explicit `{ cursor }` to fetch a single page and walk pagination
		* yourself — the per-page path returns the server's raw page (with
		* `nextCursor` for the next call) and does not write the response cache.
		* The auto-aggregate path is capped by
		* {@linkcode ClientOptions | ClientOptions.listMaxPages} (default 64); the per-page path
		* is not.
		*
		* Returns an empty list if the server does not advertise prompts capability
		* (or throws if {@linkcode ClientOptions.enforceStrictCapabilities} is enabled).
		*
		* @example
		* ```ts source="./client.examples.ts#Client_listPrompts_pagination"
		* // No cursor → all pages aggregated for you.
		* const { prompts } = await client.listPrompts();
		* console.log(
		*     'Available prompts:',
		*     prompts.map(p => p.name)
		* );
		* ```
		*/
		async listPrompts(params, options) {
			if (!this._serverCapabilities?.prompts && !this._enforceStrictCapabilities) {
				console.debug("Client.listPrompts() called but server does not advertise prompts capability - returning empty list");
				return { prompts: [] };
			}
			if (params?.cursor !== void 0) return this.request({
				method: "prompts/list",
				params
			}, options);
			const hit = await this._serveFromCache("prompts/list", void 0, options);
			if (hit !== void 0) return hit;
			return this._listAllPages("prompts/list", params, options, (acc, page) => acc.prompts.push(...page.prompts));
		}
		/**
		* Lists available resources.
		*
		* Called without a `cursor` (the common case), this walks every page and
		* returns the complete aggregated list with no `nextCursor`; the
		* aggregate is also written to the {@linkcode ResponseCacheStore}. Pass an
		* explicit `{ cursor }` to fetch a single page and walk pagination
		* yourself — the per-page path returns the server's raw page (with
		* `nextCursor` for the next call) and does not write the response cache.
		* The auto-aggregate path is capped by
		* {@linkcode ClientOptions | ClientOptions.listMaxPages} (default 64); the per-page path
		* is not.
		*
		* Returns an empty list if the server does not advertise resources capability
		* (or throws if {@linkcode ClientOptions.enforceStrictCapabilities} is enabled).
		*
		* @example
		* ```ts source="./client.examples.ts#Client_listResources_pagination"
		* // No cursor → all pages aggregated for you.
		* const { resources } = await client.listResources();
		* console.log(
		*     'Available resources:',
		*     resources.map(r => r.name)
		* );
		* ```
		*/
		async listResources(params, options) {
			if (!this._serverCapabilities?.resources && !this._enforceStrictCapabilities) {
				console.debug("Client.listResources() called but server does not advertise resources capability - returning empty list");
				return { resources: [] };
			}
			if (params?.cursor !== void 0) return this.request({
				method: "resources/list",
				params
			}, options);
			const hit = await this._serveFromCache("resources/list", void 0, options);
			if (hit !== void 0) return hit;
			return this._listAllPages("resources/list", params, options, (acc, page) => acc.resources.push(...page.resources));
		}
		/**
		* Lists available resource URI templates for dynamic resources.
		*
		* Called without a `cursor`, this walks every page and returns the
		* complete aggregated list with no `nextCursor`; the aggregate is
		* also written to the {@linkcode ResponseCacheStore}. Pass an explicit
		* `{ cursor }` to fetch a single page — see
		* {@linkcode listResources | listResources()} for the per-page contract.
		*
		* Returns an empty list if the server does not advertise resources capability
		* (or throws if {@linkcode ClientOptions.enforceStrictCapabilities} is enabled).
		*/
		async listResourceTemplates(params, options) {
			if (!this._serverCapabilities?.resources && !this._enforceStrictCapabilities) {
				console.debug("Client.listResourceTemplates() called but server does not advertise resources capability - returning empty list");
				return { resourceTemplates: [] };
			}
			if (params?.cursor !== void 0) return this.request({
				method: "resources/templates/list",
				params
			}, options);
			const hit = await this._serveFromCache("resources/templates/list", void 0, options);
			if (hit !== void 0) return hit;
			return this._listAllPages("resources/templates/list", params, options, (acc, page) => acc.resourceTemplates.push(...page.resourceTemplates));
		}
		/**
		* Walk every page of a paginated list verb, aggregate, and write ONE
		* entry to the response cache. Internal — backs the public `list*`
		* methods' no-`cursor` auto-aggregate path. Page 1's result object is
		* mutated in place (its items array is extended; `nextCursor` is
		* cleared); page-1 metadata (`ttlMs`, `cacheScope`, `_meta`) is preserved.
		* A `nextCursor` that repeats stops the walk (defence against a
		* non-converging server, mcp.d's `drainList` guard);
		* {@linkcode ClientOptions.listMaxPages} is a hard cap — hitting it
		* throws, so a partial aggregate is never cached. The
		* captured-generation guard skips the write when a `list_changed` landed
		* mid-walk, so the eviction is never overwritten by a stale aggregate.
		* `finalize` runs on the complete aggregate before the cache write — the
		* SEP-2243 invalid-`x-mcp-header` exclusion hooks here so the cached
		* `tools/list` entry is already filtered.
		*
		* The caller's `baseParams` (everything except `cursor`) is threaded into
		* every page request — page 1 sends `{...baseParams}`, later pages
		* `{...baseParams, cursor}` — so a typed, documented `_meta` (e.g. W3C
		* trace context) supplied to the public `list*()` reaches every wire
		* request the walk issues.
		*/
		async _listAllPages(method, baseParams, options, append, finalize) {
			const bypass = options?.cacheMode === "bypass";
			const generation = this._cache.captureGeneration(method);
			const acc = await this.request({
				method,
				...baseParams && { params: { ...baseParams } }
			}, options);
			let cursor = acc.nextCursor;
			const seen = /* @__PURE__ */ new Set();
			let pages = 1;
			while (cursor !== void 0 && !seen.has(cursor)) {
				if (this._listMaxPages !== 0 && pages >= this._listMaxPages) throw new SdkError(SdkErrorCode.ListPaginationExceeded, `${method}: exceeded listMaxPages (${this._listMaxPages}); server pagination did not terminate`, {
					method,
					listMaxPages: this._listMaxPages
				});
				seen.add(cursor);
				const page = await this.request({
					method,
					params: {
						...baseParams,
						cursor
					}
				}, options);
				append(acc, page);
				cursor = page.nextCursor;
				pages++;
			}
			delete acc.nextCursor;
			finalize?.(acc);
			if (bypass) return acc;
			await this._cache.write(method, acc, generation, this._freshness(acc));
			return acc;
		}
		/**
		* Compute the {@linkcode ClientResponseCache.write} freshness payload from
		* a cacheable result body. The single seam through which the client reads
		* `ttlMs`/`cacheScope` (mcp.d's `cachedFetch` engine). The fields pass
		* through the loose result schema, so they are read off the runtime body;
		* a missing `ttlMs` falls back to
		* {@linkcode ClientOptions | ClientOptions.defaultCacheTtlMs}; an explicit server-sent
		* `ttlMs` (including `0` — the spec's "immediately stale") is honoured
		* as-is. The default of `0` means `expiresAt === now()` ⇒ never served,
		* only stored. A missing `cacheScope` is treated as `'private'` — the
		* spec's `'public'` grant ("any client … MAY serve to any user") is too
		* strong to infer by default, and matches this SDK's server-side stamp
		* default.
		*/
		_freshness(result, params) {
			const body = result;
			const ttlMs = typeof body.ttlMs === "number" ? body.ttlMs : this._defaultCacheTtlMs;
			const scope = body.cacheScope === "public" ? "public" : "private";
			return {
				expiresAt: this._cache.now() + Math.min(Math.max(0, ttlMs), MAX_CACHE_TTL_MS),
				scope,
				params
			};
		}
		/**
		* The cache-serving front of every cacheable verb (mcp.d's `cachedFetch`
		* read half): under `cacheMode: 'use'` (the default), a fresh held entry
		* is served and the round trip is skipped. `'refresh'` and `'bypass'`
		* always fetch (the caller decides whether to write). Freshness and
		* decoding live in {@linkcode ClientResponseCache.read}; every hit is
		* freshly parsed, so the caller owns it outright. A custom store
		* whose `get()` rejects is routed to `onerror` and treated as a miss —
		* cache bookkeeping never blocks a request from reaching the wire.
		*/
		async _serveFromCache(method, params, options) {
			if (options?.cacheMode === "bypass" || options?.cacheMode === "refresh") return void 0;
			const hit = await this._cache.read(method, params).catch((error) => void this._reportStoreError(error));
			if (hit !== void 0) {
				if (options?.signal?.aborted) {
					const reason = options.signal.reason;
					throw reason instanceof SdkError ? reason : new SdkError(SdkErrorCode.RequestTimeout, String(reason));
				}
				return hit.value;
			}
		}
		/** Route a custom-store failure to `onerror` without aborting the surrounding dispatch. */
		_reportStoreError(e) {
			this.onerror?.(e instanceof Error ? e : new Error(String(e)));
		}
		/**
		* Compile a single tool's `outputSchema`. Passed as the compile callback to
		* {@linkcode ClientResponseCache.outputValidator} so the cache class stays
		* free of any validator-provider dependency, and called directly for the
		* `options.toolDefinition` path of {@linkcode callTool} (a one-off
		* caller-supplied definition is compiled in isolation and never enters the
		* cache, so it cannot poison the listed tool of the same name).
		*
		* Returns `undefined` when the tool has no `outputSchema`, or a
		* discriminated `{ok}` result otherwise. SEP-2106: ANY throw from the
		* validator engine — unsupported `$schema` dialect, invalid `pattern`
		* regex, unresolvable `$ref`, or any other engine error — is captured as
		* `{ok: false, compileError}` so one bad schema does not poison the rest
		* of the listing; `callTool()` surfaces it as an `InvalidParams` error
		* before the request. The `{ok}` discriminator (not
		* `compileError !== undefined`) means a custom provider that does
		* `throw undefined` is still treated as a captured failure.
		*/
		_compileOutputValidator(tool) {
			if (!tool.outputSchema) return void 0;
			try {
				return {
					ok: true,
					validator: this._jsonSchemaValidator.getValidator(tool.outputSchema)
				};
			} catch (error) {
				return {
					ok: false,
					compileError: error
				};
			}
		}
		/**
		* Resolve the SEP-2243 `x-mcp-header` declaration scan for a tool name.
		*
		* The caller-supplied `toolDefinition` escape hatch wins; otherwise the
		* cached `tools/list` entry (via the cache's `toolDefinition`) is the
		* source. Freshness is the response cache's lifecycle: `list_changed`
		* evicts, otherwise the held schema is the best information available
		* regardless of age, and a stale schema is recovered through the
		* `HEADER_MISMATCH` → evict-refetch-retry path in {@linkcode callTool}.
		* On a miss the call proceeds without `Mcp-Param-*` headers (the spec's
		* "client SHOULD send without custom headers" guidance) and relies on the
		* same recovery.
		*/
		async _resolveXMcpHeaderScan(name, override) {
			const tool = override ?? await this._cache.toolDefinition(name);
			return tool === void 0 ? void 0 : scanXMcpHeaderDeclarations(tool.inputSchema);
		}
		/**
		* Reads the contents of a resource by URI.
		*
		* Honours the result's `ttlMs`/`cacheScope` (SEP-2549): a still-fresh
		* cached body for the same `uri` is returned without a round trip
		* (`cacheMode: 'use'`, the default). The cache key is `{method, uri}`
		* partitioned by the resolved scope — `'private'` (the default when the
		* server omits the field) is stored under this client's
		* {@linkcode ClientOptions | ClientOptions.cachePartition}, so a shared
		* store cannot serve one principal's resource body to another. Unlike the
		* list verbs, a result whose resolved TTL is ≤0 is **not** stored
		* (`resources/read` has no derived index and the URI keyspace is
		* unbounded).
		*/
		async readResource(params, options) {
			const hit = await this._serveFromCache("resources/read", params.uri, options);
			if (hit !== void 0) return hit;
			const generation = this._cache.captureGeneration("resources/read", params.uri);
			const result = await this.request({
				method: "resources/read",
				params
			}, options);
			if (options?.cacheMode !== "bypass") {
				const freshness = this._freshness(result, params.uri);
				if (freshness.expiresAt > this._cache.now()) await this._cache.write("resources/read", result, generation, freshness);
				else if (options?.cacheMode === "refresh") await this._cache.evictKey("resources/read", params.uri);
			}
			return result;
		}
		/** Subscribes to change notifications for a resource. The server must support resource subscriptions. */
		async subscribeResource(params, options) {
			return this.request({
				method: "resources/subscribe",
				params
			}, options);
		}
		/** Unsubscribes from change notifications for a resource. */
		async unsubscribeResource(params, options) {
			return this.request({
				method: "resources/unsubscribe",
				params
			}, options);
		}
		/**
		* Opens a `subscriptions/listen` stream (protocol revision 2026-07-28).
		*
		* Resolves once the server's `notifications/subscriptions/acknowledged`
		* arrives (the standard request timeout applies to this ack phase). Change
		* notifications delivered on the stream are dispatched to the existing
		* {@linkcode setNotificationHandler} registrations — the same handlers the
		* 2025-era unsolicited notifications fire on a legacy connection — so
		* `listen()` is era-transparent for consumers that already register those.
		*
		* `close()` tears the subscription down by aborting the listen request's
		* `requestSignal` (closes the SSE stream where the transport honors it)
		* AND sending `notifications/cancelled` referencing the listen request id
		* — both, unconditionally, so any spec-compliant server on any transport
		* sees the cancel. No automatic re-listen — call `listen()` again to
		* re-establish.
		*
		* On a 2025-era connection this throws a typed
		* {@linkcode SdkErrorCode.MethodNotSupportedByProtocolVersion} steering to
		* `resources/subscribe` and `ClientOptions.listChanged` (the legacy
		* unsolicited delivery model still applies there); no transparent shim.
		*/
		async listen(filter, options) {
			if (this.transport === void 0) throw new SdkError(SdkErrorCode.NotConnected, "Not connected");
			const negotiated = this._negotiatedProtocolVersion;
			if (negotiated === void 0 || !isModernProtocolVersion(negotiated)) throw new SdkError(SdkErrorCode.MethodNotSupportedByProtocolVersion, `subscriptions/listen requires a 2026-07-28-era connection (negotiated: ${negotiated ?? "none"}). On a 2025-era connection, change notifications are delivered unsolicited: use ClientOptions.listChanged and resources/subscribe instead.`, {
				method: "subscriptions/listen",
				protocolVersion: negotiated
			});
			if (options?.signal?.aborted) {
				const reason = options.signal.reason;
				throw reason instanceof SdkError ? reason : new SdkError(SdkErrorCode.RequestTimeout, String(reason));
			}
			const requestAbort = new AbortController();
			const listenId = `listen:${this._nextListenId++}`;
			let state = "opening";
			let ackTimer;
			let onCallerAbort;
			let resolveOpening;
			let rejectOpening;
			const opening = new Promise((resolve, reject) => {
				resolveOpening = resolve;
				rejectOpening = reject;
			});
			let resolveClosed;
			const closed = new Promise((resolve) => {
				resolveClosed = resolve;
			});
			const settle = (outcome) => {
				if (state === "closed") return;
				const wasOpening = state === "opening";
				if (ackTimer !== void 0) {
					clearTimeout(ackTimer);
					ackTimer = void 0;
				}
				if ("ack" in outcome) {
					state = "open";
					resolveOpening(outcome.ack);
					return;
				}
				state = "closed";
				if (onCallerAbort !== void 0) options?.signal?.removeEventListener("abort", onCallerAbort);
				this._listenState.delete(listenId);
				requestAbort.abort();
				resolveClosed(outcome.cause);
				if (wasOpening) rejectOpening(outcome.error ?? new SdkError(SdkErrorCode.ConnectionClosed, "subscriptions/listen closed before the server acknowledged"));
			};
			const wireTeardown = async () => {
				requestAbort.abort();
				await this.notification({
					method: "notifications/cancelled",
					params: { requestId: listenId }
				}).catch(() => {});
			};
			const close = async () => {
				if (state === "closed") return;
				settle({ cause: "local" });
				await wireTeardown();
			};
			this._listenState.set(listenId, { settle });
			const ackTimeout = options?.timeout ?? 6e4;
			ackTimer = setTimeout(() => {
				settle({
					cause: "remote",
					error: new SdkError(SdkErrorCode.RequestTimeout, "subscriptions/listen ack timed out", { timeout: ackTimeout })
				});
				wireTeardown().catch(() => {});
			}, ackTimeout);
			if (options?.signal) {
				const callerSignal = options.signal;
				onCallerAbort = () => {
					if (state === "closed") return;
					const reason = callerSignal.reason;
					settle({
						cause: "local",
						error: reason instanceof Error ? reason : new Error(String(reason ?? "Aborted"))
					});
					wireTeardown().catch(() => {});
				};
				callerSignal.addEventListener("abort", onCallerAbort, { once: true });
			}
			const jsonrpcRequest = {
				jsonrpc: "2.0",
				id: listenId,
				method: "subscriptions/listen",
				params: {
					_meta: { ...this._outboundMetaEnvelope() },
					notifications: filter
				}
			};
			try {
				await this.transport.send(jsonrpcRequest, {
					requestSignal: requestAbort.signal,
					onRequestStreamEnd: () => settle({
						cause: "remote",
						error: /* @__PURE__ */ new Error("subscriptions/listen: stream ended")
					})
				});
			} catch (error) {
				settle({
					cause: "remote",
					error: error instanceof Error ? error : new Error(String(error))
				});
			}
			return {
				honoredFilter: await opening,
				close,
				closed
			};
		}
		/**
		* The subscription auto-opened by `ClientOptions.listChanged` on a modern
		* connection — the listen filter is the intersection of the configured
		* sub-options and the server-advertised `listChanged` capabilities.
		* `undefined` on a legacy connection, before connect, or when that
		* intersection is empty (auto-open skipped). Exposed so the consumer can
		* `close()` it.
		*/
		get autoOpenedSubscription() {
			return this._autoOpenedSubscription;
		}
		/**
		* Transport-level demux for `subscriptions/listen` notifications, before
		* any decoding/era-gating/handler dispatch. Consumes the leading
		* `notifications/subscriptions/acknowledged` referencing a live
		* subscription id (resolves the ack waiter) and an inbound
		* `notifications/cancelled` referencing a live string-typed subscription
		* id (server-side teardown on stdio). Change notifications carrying a
		* subscription id pass through to the existing registered handlers via
		* `super`. An unmatched ack/cancelled is NOT consumed: it reaches
		* `setNotificationHandler` / `fallbackNotificationHandler` instead of
		* being silently swallowed.
		*/
		_onnotification(raw, extra) {
			const evicted = Object.hasOwn(LIST_CHANGED_EVICTIONS, raw.method) ? LIST_CHANGED_EVICTIONS[raw.method] : void 0;
			if (raw.method === "notifications/resources/updated") {
				const uri = raw.params?.uri;
				if (typeof uri === "string") this._cache.evictKey("resources/read", uri);
			} else if (evicted !== void 0) for (const method of evicted) this._cache.evict(method);
			if (raw.method === "notifications/subscriptions/acknowledged") {
				const subscriptionId = raw.params?._meta?.[SUBSCRIPTION_ID_META_KEY];
				const entry = typeof subscriptionId === "string" ? this._listenState.get(subscriptionId) : void 0;
				if (entry !== void 0) {
					const honored = this._wireCodec().validateNotification("notifications/subscriptions/acknowledged", raw);
					entry.settle({ ack: honored.ok ? honored.value.params.notifications : {} });
					return;
				}
			}
			if (raw.method === "notifications/cancelled") {
				const cancelledId = raw.params?.requestId;
				const entry = typeof cancelledId === "string" ? this._listenState.get(cancelledId) : void 0;
				if (entry !== void 0) {
					entry.settle({
						cause: "remote",
						error: /* @__PURE__ */ new Error("subscriptions/listen: server cancelled the subscription")
					});
					return;
				}
			}
			super._onnotification(raw, extra);
		}
		/**
		* Transport-level demux for `subscriptions/listen` responses. A JSON-RPC
		* ERROR for the listen id is the server's pre-ack capacity/params
		* rejection; a JSON-RPC RESULT for the listen id is the spec's
		* `SubscriptionsListenResult` — the server's GRACEFUL-close signal (sent
		* on shutdown). A string-id response that matches a live `_listenState`
		* entry is consumed here (Protocol's `_responseHandlers` map is keyed by
		* NUMBER and never holds a listen id, so passing a string-id response
		* through would surface as "unknown message ID" via `onerror`).
		*/
		_onresponse(response) {
			const id = response.id;
			const entry = typeof id === "string" ? this._listenState.get(id) : void 0;
			if (entry !== void 0) {
				if (isJSONRPCErrorResponse(response)) entry.settle({
					cause: "remote",
					error: ProtocolError.fromError(response.error.code, response.error.message, response.error.data)
				});
				else entry.settle({
					cause: "graceful",
					error: new SdkError(SdkErrorCode.ConnectionClosed, "subscriptions/listen: server closed the subscription gracefully before acknowledging")
				});
				return;
			}
			super._onresponse(response);
		}
		/**
		* Settle every live per-listen state machine on a transport-initiated
		* close (the server dropping the connection on stdio/InMemory) before
		* Protocol's `_onclose` tears the transport down. The base
		* `_responseHandlers` settlement does not reach `_listenState` (listen
		* ids are never registered there), so without this override a remote
		* close would leave an in-flight `listen()` / open `McpSubscription`
		* hanging.
		*/
		_onclose() {
			if (this._listenState.size > 0) {
				const reason = new SdkError(SdkErrorCode.ConnectionClosed, "Connection closed");
				for (const entry of this._listenState.values()) entry.settle({
					cause: "remote",
					error: reason
				});
				this._listenState.clear();
			}
			super._onclose();
		}
		/**
		* Calls a tool on the connected server and returns the result. Automatically validates structured output
		* if the tool has an `outputSchema`.
		*
		* Tool results have two error surfaces: `result.isError` for tool-level failures (the tool ran but reported
		* a problem), and thrown {@linkcode ProtocolError} for protocol-level failures or {@linkcode SdkError} for
		* SDK-level issues (timeouts, missing capabilities).
		*
		* @example Basic usage
		* ```ts source="./client.examples.ts#Client_callTool_basic"
		* const result = await client.callTool({
		*     name: 'calculate-bmi',
		*     arguments: { weightKg: 70, heightM: 1.75 }
		* });
		*
		* // Tool-level errors are returned in the result, not thrown
		* if (result.isError) {
		*     console.error('Tool error:', result.content);
		*     return;
		* }
		*
		* console.log(result.content);
		* ```
		*
		* @example Structured output
		* ```ts source="./client.examples.ts#Client_callTool_structuredOutput"
		* const result = await client.callTool({
		*     name: 'calculate-bmi',
		*     arguments: { weightKg: 70, heightM: 1.75 }
		* });
		*
		* // Machine-readable output for the client application. SEP-2106: structuredContent is
		* // `unknown` (any JSON value). Check for presence with `!== undefined` and narrow before use.
		* if (result.structuredContent !== undefined) {
		*     const sc: unknown = result.structuredContent; // e.g. { bmi: 22.86 }
		*     if (typeof sc === 'object' && sc !== null && 'bmi' in sc) {
		*         console.log(sc.bmi);
		*     }
		* }
		* ```
		*/
		async callTool(params, options) {
			const mirroringActive = this.getProtocolEra() === "modern" && detectProbeEnvironment() !== "browser";
			const buildSendOptions = async () => {
				if (!mirroringActive) return options;
				let scan;
				try {
					scan = await this._resolveXMcpHeaderScan(params.name, options?.toolDefinition);
				} catch (error) {
					this._reportStoreError(error);
				}
				if (!scan?.valid || scan.declarations.length === 0) return options;
				const paramHeaders = buildMcpParamHeaders(scan.declarations, params.arguments);
				return Object.keys(paramHeaders).length === 0 ? options : {
					...options,
					headers: {
						...options?.headers,
						...paramHeaders
					}
				};
			};
			let compiled = options?.toolDefinition === void 0 ? await this._cache.outputValidator(params.name, (tool) => this._compileOutputValidator(tool)).catch((error) => void this._reportStoreError(error)) : this._compileOutputValidator(options.toolDefinition);
			const assertCompiled = () => {
				if (compiled === void 0 || compiled.ok) return;
				const err = compiled.compileError;
				const message = (err instanceof Error ? err.message : String(err)).slice(0, 200);
				throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Tool '${params.name}' has an invalid outputSchema: ${message}`);
			};
			assertCompiled();
			let result;
			try {
				result = await this.request({
					method: "tools/call",
					params
				}, await buildSendOptions());
			} catch (error) {
				const isHeaderMismatch = error instanceof ProtocolError && error.code === -32020;
				if (!mirroringActive || !isHeaderMismatch || options?.toolDefinition !== void 0) throw error;
				const refreshOptions = {
					signal: options?.signal,
					timeout: options?.timeout,
					cacheMode: "refresh"
				};
				await this._cache.evict("tools/list");
				await this.listTools(void 0, refreshOptions).catch((error_) => this._reportStoreError(error_));
				compiled = await this._cache.outputValidator(params.name, (tool) => this._compileOutputValidator(tool)).catch((error_) => void this._reportStoreError(error_));
				assertCompiled();
				result = await this.request({
					method: "tools/call",
					params
				}, await buildSendOptions());
			}
			const validator = compiled !== void 0 && compiled.ok ? compiled.validator : void 0;
			if (validator) {
				if (result.structuredContent === void 0 && !result.isError) throw new ProtocolError(ProtocolErrorCode.InvalidRequest, `Tool ${params.name} has an output schema but did not return structured content`);
				if (result.structuredContent !== void 0 && !result.isError) try {
					const validationResult = validator(result.structuredContent);
					if (!validationResult.valid) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Structured content does not match the tool's output schema: ${validationResult.errorMessage}`);
				} catch (error) {
					if (error instanceof ProtocolError) throw error;
					throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Failed to validate structured content: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			return result;
		}
		/**
		* Lists available tools.
		*
		* Called without a `cursor` (the common case), this walks every page and
		* returns the complete aggregated list with no `nextCursor`; the
		* aggregate is also written to the {@linkcode ResponseCacheStore} (the
		* source for {@linkcode callTool | callTool()}'s output-schema validation
		* and SEP-2243 `Mcp-Param-*` header mirroring). Pass an explicit
		* `{ cursor }` to fetch a single page and walk pagination yourself — the
		* per-page path returns the server's raw page (with `nextCursor` for the
		* next call) and does not write the response cache. The auto-aggregate
		* path is capped by {@linkcode ClientOptions | ClientOptions.listMaxPages} (default 64);
		* the per-page path is not.
		*
		* Returns an empty list if the server does not advertise tools capability
		* (or throws if {@linkcode ClientOptions.enforceStrictCapabilities} is enabled).
		*
		* @example
		* ```ts source="./client.examples.ts#Client_listTools_pagination"
		* // No cursor → all pages aggregated for you.
		* const { tools } = await client.listTools();
		* console.log(
		*     'Available tools:',
		*     tools.map(t => t.name)
		* );
		* ```
		*/
		async listTools(params, options) {
			if (!this._serverCapabilities?.tools && !this._enforceStrictCapabilities) {
				console.debug("Client.listTools() called but server does not advertise tools capability - returning empty list");
				return { tools: [] };
			}
			if (params?.cursor !== void 0) {
				const page = await this.request({
					method: "tools/list",
					params
				}, options);
				this._excludeInvalidXMcpHeaderTools(page);
				return page;
			}
			const hit = await this._serveFromCache("tools/list", void 0, options);
			if (hit !== void 0) return hit;
			return this._listAllPages("tools/list", params, options, (acc, page) => acc.tools.push(...page.tools), (acc) => this._excludeInvalidXMcpHeaderTools(acc));
		}
		/**
		* SEP-2243 (protocol revision 2026-07-28): a Streamable HTTP client MUST
		* exclude tool definitions whose `x-mcp-header` declarations violate the
		* constraints, and SHOULD log a warning naming the tool and the reason.
		* Applied to the CACHED aggregated `tools/list` result (so the entry
		* mirroring reads never holds an unmirrorable tool) AND to every public
		* per-page {@linkcode listTools | listTools()} return (the spec's MUST
		* has no carve-out for paginated reads). The gate is era-only on
		* non-stdio transports — `detectProbeTransportKind` cannot distinguish a
		* real HTTP transport from in-memory/custom transports (it only
		* positively recognizes stdio), and over-excluding on a non-HTTP modern
		* connection is harmless: those transports never carry per-request
		* headers, so an excluded tool would have been uncallable on a Streamable
		* HTTP arm of the same server. Mutates `result.tools` in place.
		*/
		_excludeInvalidXMcpHeaderTools(result) {
			if (this.getProtocolEra() !== "modern" || !this.transport || detectProbeTransportKind(this.transport) === "stdio") return;
			const filtered = result.tools.filter((tool) => {
				const scan = scanXMcpHeaderDeclarations(tool.inputSchema);
				if (!scan.valid) {
					console.warn(`[mcp-sdk] excluding tool '${tool.name}' from tools/list: invalid x-mcp-header declaration — ${scan.reason}`);
					return false;
				}
				return true;
			});
			if (filtered.length !== result.tools.length) result.tools = filtered;
		}
		/**
		* Set up a single list changed handler.
		* @internal
		*/
		_setupListChangedHandler(listType, notificationMethod, options, fetcher) {
			const parseResult = parseSchema(ListChangedOptionsBaseSchema, options);
			if (!parseResult.success) throw new Error(`Invalid ${listType} listChanged options: ${parseResult.error.message}`);
			if (typeof options.onChanged !== "function") throw new TypeError(`Invalid ${listType} listChanged options: onChanged must be a function`);
			const { autoRefresh, debounceMs } = parseResult.data;
			const { onChanged } = options;
			const refresh = async () => {
				if (!autoRefresh) {
					onChanged(null, null);
					return;
				}
				try {
					onChanged(null, await fetcher());
				} catch (error) {
					onChanged(error instanceof Error ? error : new Error(String(error)), null);
				}
			};
			const handler = () => {
				if (debounceMs) {
					const existingTimer = this._listChangedDebounceTimers.get(listType);
					if (existingTimer) clearTimeout(existingTimer);
					const timer = setTimeout(refresh, debounceMs);
					this._listChangedDebounceTimers.set(listType, timer);
				} else refresh();
			};
			this.setNotificationHandler(notificationMethod, handler);
		}
		/**
		* Notifies the server that the client's root list has changed. Requires the `roots.listChanged` capability.
		*
		* @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577).
		* Remains functional during the deprecation window (at least twelve months).
		* Migrate to passing paths via tool parameters, resource URIs, or configuration.
		*/
		async sendRootsListChanged() {
			return this.notification({ method: "notifications/roots/list_changed" });
		}
	};
	(class extends Error {
		static {
			Object.defineProperty(this, "mcpBrand", { value: "mcp.SseError" });
		}
		static [Symbol.hasInstance](value) {
			return brandedHasInstance(this, value);
		}
		/**
		* Brand-based type guard: equivalent to `value instanceof this`, as an
		* explicit static predicate (the axios/AWS-SDK `isInstance` style). Reads
		* the caller's own brand via `this`, so every branded subclass gets a
		* correctly-scoped guard by inheritance. Must be invoked on the class —
		* in callback position write `v => SdkError.isInstance(v)`, not
		* `.filter(SdkError.isInstance)` (detached calls throw rather than
		* silently matching nothing).
		*/
		static isInstance(value) {
			if (typeof this !== "function") throw new TypeError("isInstance must be called on the class (e.g. `SdkError.isInstance(value)`); for callbacks use `v => SdkError.isInstance(v)`");
			return brandedHasInstance(this, value);
		}
		constructor(code, message, event) {
			super(`SSE error: ${message}`);
			this.code = code;
			this.event = event;
			stampErrorBrands(this, new.target);
		}
	});
	/** Default cap on step-up re-authorization retries within a single send/stream-open. */
	const DEFAULT_MAX_STEP_UP_RETRIES = 1;
	const DEFAULT_STREAMABLE_HTTP_RECONNECTION_OPTIONS = {
		initialReconnectionDelay: 1e3,
		maxReconnectionDelay: 3e4,
		reconnectionDelayGrowFactor: 1.5,
		maxRetries: 2
	};
	/**
	* Standard/auth header names the transport owns. The per-request
	* `TransportSendOptions.headers` carrier MUST NOT be able to override these —
	* they are derived from connection state (`authorization`, `mcp-session-id`)
	* or from the message body itself (`mcp-protocol-version`, `mcp-method`,
	* `mcp-name`), and a per-request override would let a caller produce a
	* header/body disagreement the server's SEP-2243 cross-checks reject.
	*/
	const RESERVED_REQUEST_HEADER_NAMES = /* @__PURE__ */ new Set([
		"authorization",
		"content-type",
		"mcp-protocol-version",
		"mcp-method",
		"mcp-name",
		"mcp-session-id"
	]);
	/**
	* `AbortSignal.any` with a manual fallback. `AbortSignal.any` landed in
	* Node 20.3; this package's `engines` floor is `>=20`, so 20.0–20.2 must be
	* served by the fallback combinator (a controller that aborts on the first
	* of `a` or `b`). The native path is preferred because it propagates the
	* originating signal's `reason` and participates in GC the way the spec
	* defines.
	*/
	function anySignal(a, b) {
		if (typeof AbortSignal.any === "function") return AbortSignal.any([a, b]);
		const controller = new AbortController();
		if (a.aborted) return controller.abort(a.reason), controller.signal;
		if (b.aborted) return controller.abort(b.reason), controller.signal;
		const cleanup = () => {
			a.removeEventListener("abort", onA);
			b.removeEventListener("abort", onB);
		};
		function onA() {
			cleanup();
			controller.abort(a.reason);
		}
		function onB() {
			cleanup();
			controller.abort(b.reason);
		}
		a.addEventListener("abort", onA, { once: true });
		b.addEventListener("abort", onB, { once: true });
		return controller.signal;
	}
	/**
	* Client transport for Streamable HTTP: this implements the MCP Streamable HTTP transport specification.
	* It will connect to a server using HTTP `POST` for sending messages and HTTP `GET` with Server-Sent Events
	* for receiving messages.
	*/
	var StreamableHTTPClientTransport = class {
		_abortController;
		_url;
		_resourceMetadataUrl;
		_scope;
		_requestInit;
		_authProvider;
		_oauthProvider;
		_skipIssuerMetadataValidation;
		_fetch;
		_fetchWithInit;
		_sessionId;
		_reconnectionOptions;
		_protocolVersion;
		_onInsufficientScope;
		_maxStepUpRetries;
		_serverRetryMs;
		_reconnectionScheduler;
		_cancelReconnection;
		onclose;
		onerror;
		onmessage;
		/**
		* Streamable HTTP opens one POST (and SSE response stream) per outbound
		* request and honors `TransportSendOptions.requestSignal`. On a 2026-era
		* connection the protocol layer aborts that per-request stream as the
		* spec cancellation signal instead of POSTing `notifications/cancelled`.
		*/
		hasPerRequestStream = true;
		constructor(url, opts) {
			this._url = url;
			this._resourceMetadataUrl = void 0;
			this._scope = void 0;
			this._requestInit = opts?.requestInit;
			this._skipIssuerMetadataValidation = opts?.skipIssuerMetadataValidation;
			if (isOAuthClientProvider(opts?.authProvider)) {
				this._oauthProvider = opts.authProvider;
				this._authProvider = adaptOAuthProvider(opts.authProvider, { skipIssuerMetadataValidation: opts.skipIssuerMetadataValidation });
			} else this._authProvider = opts?.authProvider;
			this._fetch = opts?.fetch;
			this._fetchWithInit = createFetchWithInit(opts?.fetch, opts?.requestInit);
			this._sessionId = opts?.sessionId;
			this._protocolVersion = opts?.protocolVersion;
			this._reconnectionOptions = opts?.reconnectionOptions ?? DEFAULT_STREAMABLE_HTTP_RECONNECTION_OPTIONS;
			this._reconnectionScheduler = opts?.reconnectionScheduler;
			this._onInsufficientScope = opts?.onInsufficientScope ?? "reauthorize";
			this._maxStepUpRetries = Math.max(0, opts?.maxStepUpRetries ?? DEFAULT_MAX_STEP_UP_RETRIES);
		}
		/**
		* SEP-2350 step-up: compute the union scope, decide whether refresh must be
		* bypassed, and run {@linkcode auth}. Returns the auth result so the caller
		* can decide whether to retry. Shared by the POST `_send` path and the GET
		* `_startOrAuthSse` path so both apply the same `'throw'` short-circuit,
		* the same superset-gated refresh bypass, and the same retry cap.
		*/
		async _stepUpAuthorize(challenge, stepUpRetries) {
			try {
				return await this._stepUpAuthorizeInner(challenge, stepUpRetries);
			} catch (error) {
				throw markAuthSeamEscape(error);
			}
		}
		async _stepUpAuthorizeInner(challenge, stepUpRetries) {
			if (this._onInsufficientScope === "throw") throw new InsufficientScopeError({
				requiredScope: challenge.scope,
				resourceMetadataUrl: challenge.resourceMetadataUrl,
				errorDescription: challenge.errorDescription
			});
			if (!this._oauthProvider) throw new InsufficientScopeError({
				requiredScope: challenge.scope,
				resourceMetadataUrl: challenge.resourceMetadataUrl,
				errorDescription: challenge.errorDescription
			});
			if (stepUpRetries >= this._maxStepUpRetries) throw new SdkHttpError(SdkErrorCode.ClientHttpForbidden, `Server returned 403 insufficient_scope after step-up re-authorization (retry limit ${this._maxStepUpRetries} reached)`, {
				status: 403,
				statusText: challenge.statusText ?? "Forbidden",
				text: challenge.text
			});
			if (challenge.resourceMetadataUrl) this._resourceMetadataUrl = challenge.resourceMetadataUrl;
			const tokens = await this._oauthProvider.tokens();
			const unionScope = computeScopeUnion(this._scope, tokens?.scope, challenge.scope);
			this._scope = unionScope;
			const forceReauthorization = isStrictScopeSuperset(unionScope, tokens?.scope);
			return auth(this._oauthProvider, {
				serverUrl: this._url,
				resourceMetadataUrl: this._resourceMetadataUrl,
				scope: unionScope,
				forceReauthorization,
				fetchFn: this._fetchWithInit,
				skipIssuerMetadataValidation: this._skipIssuerMetadataValidation
			});
		}
		async _commonHeaders() {
			const headers = {};
			let token;
			try {
				token = await this._authProvider?.token();
			} catch (error) {
				throw markAuthSeamEscape(error);
			}
			if (token) headers["Authorization"] = `Bearer ${token}`;
			if (this._sessionId) headers["mcp-session-id"] = this._sessionId;
			if (this._protocolVersion) headers["mcp-protocol-version"] = this._protocolVersion;
			const extraHeaders = normalizeHeaders(this._requestInit?.headers);
			return new Headers({
				...headers,
				...extraHeaders
			});
		}
		/**
		* Body-derived per-request headers: when an outgoing request carries a
		* protocol-version claim in its `_meta` envelope (the version negotiation
		* probe is the first such sender), `MCP-Protocol-Version` and `Mcp-Method`
		* derive from the message itself. The connection-level version slot is
		* neither consulted nor mutated; messages without an envelope claim are
		* untouched, so no 2026 header can appear on a legacy exchange.
		*/
		_applyBodyDerivedHeaders(headers, message) {
			if (Array.isArray(message) || !isJSONRPCRequest(message)) return;
			const envelopeVersion = (message.params?._meta)?.[PROTOCOL_VERSION_META_KEY];
			if (typeof envelopeVersion !== "string") return;
			headers.set("mcp-protocol-version", envelopeVersion);
			headers.set("mcp-method", message.method);
			const params = message.params;
			const nameHeader = message.method === "resources/read" ? typeof params?.uri === "string" ? params.uri : void 0 : typeof params?.name === "string" ? params.name : void 0;
			if (nameHeader !== void 0) headers.set("mcp-name", encodeMcpParamValue(nameHeader));
		}
		/**
		* `true` when the outbound message is a single request carrying a
		* modern-era protocol-version envelope claim — the same predicate that
		* gates body-derived `mcp-method`/`mcp-name` emission. Used to confine the
		* 400-body-as-ProtocolError delivery to modern-era exchanges only.
		*/
		_isModernEnvelopedRequest(message) {
			if (Array.isArray(message) || !isJSONRPCRequest(message)) return false;
			const v = (message.params?._meta)?.[PROTOCOL_VERSION_META_KEY];
			return typeof v === "string" && isModernProtocolVersion(v);
		}
		async _startOrAuthSse(options, isAuthRetry = false, stepUpRetries = 0) {
			const { resumptionToken, requestSignal } = options;
			const isIntentionalAbort = () => this._abortController?.signal.aborted === true || requestSignal?.aborted === true;
			try {
				const headers = await this._commonHeaders();
				const types = [...headers.get("accept")?.split(",").map((s) => s.trim().toLowerCase()) ?? [], "text/event-stream"];
				headers.set("accept", [...new Set(types)].join(", "));
				if (resumptionToken) headers.set("last-event-id", resumptionToken);
				const transportSignal = this._abortController?.signal;
				const signal = requestSignal !== void 0 && transportSignal !== void 0 ? anySignal(transportSignal, requestSignal) : requestSignal ?? transportSignal;
				const response = await (this._fetch ?? fetch)(this._url, {
					...this._requestInit,
					method: "GET",
					headers,
					signal
				});
				if (!response.ok) {
					if (response.status === 401 && this._authProvider) {
						if (response.headers.has("www-authenticate")) {
							const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(response);
							this._resourceMetadataUrl = resourceMetadataUrl;
							this._scope = computeScopeUnion(this._scope, scope);
						}
						if (this._authProvider.onUnauthorized && !isAuthRetry) {
							try {
								await this._authProvider.onUnauthorized({
									response,
									serverUrl: this._url,
									fetchFn: this._fetchWithInit
								});
							} catch (error) {
								throw markAuthSeamEscape(error);
							}
							await response.text?.().catch(() => {});
							return this._startOrAuthSse(options, true, stepUpRetries);
						}
						await response.text?.().catch(() => {});
						if (isAuthRetry) throw markAuthSeamEscape(new SdkHttpError(SdkErrorCode.ClientHttpAuthentication, "Server returned 401 after re-authentication", {
							status: 401,
							statusText: response.statusText
						}));
						throw markAuthSeamEscape(new UnauthorizedError());
					}
					if (response.status === 403) {
						const { resourceMetadataUrl, scope, error, errorDescription } = extractWWWAuthenticateParams(response);
						if (error === "insufficient_scope") {
							const text = await response.text?.().catch(() => null);
							if (await this._stepUpAuthorize({
								scope,
								resourceMetadataUrl,
								errorDescription,
								statusText: response.statusText,
								text
							}, stepUpRetries) !== "AUTHORIZED") throw markAuthSeamEscape(new UnauthorizedError());
							return this._startOrAuthSse(options, isAuthRetry, stepUpRetries + 1);
						}
					}
					await response.text?.().catch(() => {});
					if (response.status === 405) {
						options.onRequestStreamEnd?.();
						return;
					}
					throw new SdkHttpError(SdkErrorCode.ClientHttpFailedToOpenStream, `Failed to open SSE stream: ${response.statusText}`, {
						status: response.status,
						statusText: response.statusText
					});
				}
				this._handleSseStream(response.body, options, true);
			} catch (error) {
				if (!isIntentionalAbort()) this.onerror?.(error);
				throw error;
			}
		}
		/**
		* Calculates the next reconnection delay using a backoff algorithm
		*
		* @param attempt Current reconnection attempt count for the specific stream
		* @returns Time to wait in milliseconds before next reconnection attempt
		*/
		_getNextReconnectionDelay(attempt) {
			if (this._serverRetryMs !== void 0) return this._serverRetryMs;
			const initialDelay = this._reconnectionOptions.initialReconnectionDelay;
			const growFactor = this._reconnectionOptions.reconnectionDelayGrowFactor;
			const maxDelay = this._reconnectionOptions.maxReconnectionDelay;
			return Math.min(initialDelay * Math.pow(growFactor, attempt), maxDelay);
		}
		/**
		* Schedule a reconnection attempt using server-provided retry interval or backoff
		*
		* @param lastEventId The ID of the last received event for resumability
		* @param attemptCount Current reconnection attempt count for this specific stream
		*/
		_scheduleReconnection(options, attemptCount = 0) {
			const maxRetries = this._reconnectionOptions.maxRetries;
			if (attemptCount >= maxRetries) {
				this.onerror?.(/* @__PURE__ */ new Error(`Maximum reconnection attempts (${maxRetries}) exceeded.`));
				options.onRequestStreamEnd?.();
				return;
			}
			const delay = this._getNextReconnectionDelay(attemptCount);
			const reconnect = () => {
				this._cancelReconnection = void 0;
				if (this._abortController?.signal.aborted || options.requestSignal?.aborted) return;
				this._startOrAuthSse(options).catch((error) => {
					if (this._abortController?.signal.aborted || options.requestSignal?.aborted) return;
					this.onerror?.(/* @__PURE__ */ new Error(`Failed to reconnect SSE stream: ${error instanceof Error ? error.message : String(error)}`));
					try {
						this._scheduleReconnection(options, attemptCount + 1);
					} catch (scheduleError) {
						this.onerror?.(scheduleError instanceof Error ? scheduleError : new Error(String(scheduleError)));
					}
				});
			};
			if (this._reconnectionScheduler) {
				const cancel = this._reconnectionScheduler(reconnect, delay, attemptCount);
				this._cancelReconnection = typeof cancel === "function" ? cancel : void 0;
			} else {
				const handle = setTimeout(reconnect, delay);
				this._cancelReconnection = () => clearTimeout(handle);
			}
		}
		_handleSseStream(stream, options, isReconnectable) {
			if (!stream) {
				options.onRequestStreamEnd?.();
				return;
			}
			const { onresumptiontoken, replayMessageId, requestSignal, onRequestStreamEnd } = options;
			const isIntentionalAbort = () => this._abortController?.signal.aborted === true || requestSignal?.aborted === true;
			let lastEventId;
			let hasPrimingEvent = false;
			let receivedResponse = false;
			const processStream = async () => {
				try {
					const reader = stream.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream({ onRetry: (retryMs) => {
						this._serverRetryMs = retryMs;
					} })).getReader();
					while (true) {
						const { value: event, done } = await reader.read();
						if (done) break;
						if (event.id) {
							lastEventId = event.id;
							hasPrimingEvent = true;
							onresumptiontoken?.(event.id);
						}
						if (!event.data) continue;
						if (!event.event || event.event === "message") try {
							const message = JSONRPCMessageSchema.parse(JSON.parse(event.data));
							if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {
								receivedResponse = true;
								if (replayMessageId !== void 0) message.id = replayMessageId;
							}
							this.onmessage?.(message);
						} catch (error) {
							this.onerror?.(error);
						}
					}
					if ((isReconnectable || hasPrimingEvent) && !receivedResponse && this._abortController && !isIntentionalAbort()) this._scheduleReconnection({
						resumptionToken: lastEventId,
						onresumptiontoken,
						replayMessageId,
						requestSignal,
						onRequestStreamEnd
					}, 0);
					else if (!isIntentionalAbort()) onRequestStreamEnd?.();
				} catch (error) {
					if (isIntentionalAbort()) return;
					this.onerror?.(/* @__PURE__ */ new Error(`SSE stream disconnected: ${error}`));
					if ((isReconnectable || hasPrimingEvent) && !receivedResponse && this._abortController && !isIntentionalAbort()) try {
						this._scheduleReconnection({
							resumptionToken: lastEventId,
							onresumptiontoken,
							replayMessageId,
							requestSignal,
							onRequestStreamEnd
						}, 0);
					} catch (error$1) {
						this.onerror?.(/* @__PURE__ */ new Error(`Failed to reconnect: ${error$1 instanceof Error ? error$1.message : String(error$1)}`));
						onRequestStreamEnd?.();
					}
					else onRequestStreamEnd?.();
				}
			};
			processStream();
		}
		async start() {
			if (this._abortController) throw new Error("StreamableHTTPClientTransport already started! If using Client class, note that connect() calls start() automatically.");
			this._abortController = new AbortController();
		}
		async finishAuth(codeOrParams, iss) {
			if (!this._oauthProvider) throw new UnauthorizedError("finishAuth requires an OAuthClientProvider");
			const { authorizationCode, iss: issParam } = await resolveAuthorizationCallbackParams(codeOrParams, iss, this._oauthProvider, this._url, {
				fetchFn: this._fetchWithInit,
				resourceMetadataUrl: this._resourceMetadataUrl
			});
			if (await auth(this._oauthProvider, {
				serverUrl: this._url,
				authorizationCode,
				iss: issParam,
				resourceMetadataUrl: this._resourceMetadataUrl,
				scope: this._scope,
				fetchFn: this._fetchWithInit,
				skipIssuerMetadataValidation: this._skipIssuerMetadataValidation
			}) !== "AUTHORIZED") throw new UnauthorizedError("Failed to authorize");
		}
		async close() {
			try {
				this._cancelReconnection?.();
			} finally {
				this._cancelReconnection = void 0;
				this._abortController?.abort();
				this.onclose?.();
			}
		}
		async send(message, options) {
			return this._send(message, options, false);
		}
		async _send(message, options, isAuthRetry, stepUpRetries = 0) {
			try {
				const { resumptionToken, onresumptiontoken } = options || {};
				if (resumptionToken) {
					this._startOrAuthSse({
						resumptionToken,
						replayMessageId: isJSONRPCRequest(message) ? message.id : void 0,
						requestSignal: options?.requestSignal
					}).catch((error) => this.onerror?.(error));
					return;
				}
				const headers = await this._commonHeaders();
				this._applyBodyDerivedHeaders(headers, message);
				const isHandshake = Array.isArray(message) ? message.some((m) => isInitializeRequest(m)) : isInitializeRequest(message);
				if (isHandshake) headers.delete("mcp-session-id");
				if (options?.headers !== void 0) for (const [name, value] of Object.entries(options.headers)) {
					if (RESERVED_REQUEST_HEADER_NAMES.has(name.toLowerCase())) continue;
					headers.set(name, value);
				}
				headers.set("content-type", "application/json");
				const types = [
					...headers.get("accept")?.split(",").map((s) => s.trim().toLowerCase()) ?? [],
					"application/json",
					"text/event-stream"
				];
				headers.set("accept", [...new Set(types)].join(", "));
				const transportSignal = this._abortController?.signal;
				const signal = options?.requestSignal !== void 0 && transportSignal !== void 0 ? anySignal(transportSignal, options.requestSignal) : options?.requestSignal ?? transportSignal;
				const init = {
					...this._requestInit,
					method: "POST",
					headers,
					body: JSON.stringify(message),
					signal
				};
				const response = await (this._fetch ?? fetch)(this._url, init);
				if (isHandshake && response.ok) this._sessionId = response.headers.get("mcp-session-id") || void 0;
				if (!response.ok) {
					if (response.status === 401 && this._authProvider) {
						if (response.headers.has("www-authenticate")) {
							const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(response);
							this._resourceMetadataUrl = resourceMetadataUrl;
							this._scope = computeScopeUnion(this._scope, scope);
						}
						if (this._authProvider.onUnauthorized && !isAuthRetry) {
							try {
								await this._authProvider.onUnauthorized({
									response,
									serverUrl: this._url,
									fetchFn: this._fetchWithInit
								});
							} catch (error) {
								throw markAuthSeamEscape(error);
							}
							await response.text?.().catch(() => {});
							return this._send(message, options, true, stepUpRetries);
						}
						await response.text?.().catch(() => {});
						if (isAuthRetry) throw markAuthSeamEscape(new SdkHttpError(SdkErrorCode.ClientHttpAuthentication, "Server returned 401 after re-authentication", {
							status: 401,
							statusText: response.statusText
						}));
						throw markAuthSeamEscape(new UnauthorizedError());
					}
					const text = await response.text?.().catch(() => null);
					if (response.status === 403) {
						const { resourceMetadataUrl, scope, error, errorDescription } = extractWWWAuthenticateParams(response);
						if (error === "insufficient_scope") {
							if (await this._stepUpAuthorize({
								scope,
								resourceMetadataUrl,
								errorDescription,
								statusText: response.statusText,
								text
							}, stepUpRetries) !== "AUTHORIZED") throw markAuthSeamEscape(new UnauthorizedError());
							return this._send(message, options, isAuthRetry, stepUpRetries + 1);
						}
					}
					if (response.status === 400 && typeof text === "string" && this._isModernEnvelopedRequest(message)) try {
						const parsed = JSONRPCMessageSchema.parse(JSON.parse(text));
						const requests = (Array.isArray(message) ? message : [message]).filter((m) => isJSONRPCRequest(m));
						if (isJSONRPCErrorResponse(parsed) && requests.some((r) => r.id === parsed.id)) {
							this.onmessage?.(parsed);
							return;
						}
					} catch {}
					throw new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, `Error POSTing to endpoint: ${text}`, {
						status: response.status,
						statusText: response.statusText,
						text
					});
				}
				if (response.status === 202) {
					await response.text?.().catch(() => {});
					if (isInitializedNotification(message)) this._startOrAuthSse({ resumptionToken: void 0 }).catch((error) => this.onerror?.(error));
					return;
				}
				const hasRequests = (Array.isArray(message) ? message : [message]).some((msg) => "method" in msg && "id" in msg && msg.id !== void 0);
				const contentType = response.headers.get("content-type");
				const responseMediaType = mediaTypeEssence(contentType);
				if (hasRequests) if (responseMediaType === "text/event-stream") this._handleSseStream(response.body, {
					onresumptiontoken,
					requestSignal: options?.requestSignal,
					onRequestStreamEnd: options?.onRequestStreamEnd
				}, false);
				else if (responseMediaType === "application/json") {
					const data = await response.json();
					const responseMessages = Array.isArray(data) ? data.map((msg) => JSONRPCMessageSchema.parse(msg)) : [JSONRPCMessageSchema.parse(data)];
					for (const msg of responseMessages) this.onmessage?.(msg);
				} else {
					await response.text?.().catch(() => {});
					throw new SdkError(SdkErrorCode.ClientHttpUnexpectedContent, `Unexpected content type: ${contentType}`, { contentType });
				}
				else await response.text?.().catch(() => {});
			} catch (error) {
				if (options?.requestSignal?.aborted !== true) this.onerror?.(error);
				throw error;
			}
		}
		get sessionId() {
			return this._sessionId;
		}
		/**
		* Terminates the current session by sending a `DELETE` request to the server.
		*
		* Clients that no longer need a particular session
		* (e.g., because the user is leaving the client application) SHOULD send an
		* HTTP `DELETE` to the MCP endpoint with the `Mcp-Session-Id` header to explicitly
		* terminate the session.
		*
		* The server MAY respond with HTTP `405 Method Not Allowed`, indicating that
		* the server does not allow clients to terminate sessions.
		*/
		async terminateSession() {
			if (!this._sessionId) return;
			try {
				const headers = await this._commonHeaders();
				const init = {
					...this._requestInit,
					method: "DELETE",
					headers,
					signal: this._abortController?.signal
				};
				const response = await (this._fetch ?? fetch)(this._url, init);
				await response.text?.().catch(() => {});
				if (!response.ok && response.status !== 405) throw new SdkHttpError(SdkErrorCode.ClientHttpFailedToTerminateSession, `Failed to terminate session: ${response.statusText}`, {
					status: response.status,
					statusText: response.statusText
				});
				this._sessionId = void 0;
			} catch (error) {
				this.onerror?.(error);
				throw error;
			}
		}
		setProtocolVersion(version) {
			this._protocolVersion = version;
		}
		get protocolVersion() {
			return this._protocolVersion;
		}
		/**
		* Resume an SSE stream from a previous event ID.
		* Opens a `GET` SSE connection with `Last-Event-ID` header to replay missed events.
		*
		* @param lastEventId The event ID to resume from
		* @param options Optional callback to receive new resumption tokens
		*/
		async resumeStream(lastEventId, options) {
			await this._startOrAuthSse({
				resumptionToken: lastEventId,
				onresumptiontoken: options?.onresumptiontoken
			});
		}
	};
	//#endregion
	//#region src/host.ts
	/**
	* Browser-side MCP Apps host (bundled to public/host.js).
	*
	* A real SDK `Client` over StreamableHTTP to the Projection facade at /mcp,
	* pinned to the 2026-07-28 revision with `autoFulfill: false` so this page
	* drives the MRTR approval round trips itself (approve/deny buttons).
	*
	* The MCP Apps host side (AppBridge-lite): loads the ui:// dashboard
	* resource into a sandboxed iframe (allow-scripts only — the app gets no
	* same-origin access) and speaks the SEP-1865 postMessage dialect: answers
	* `ui/initialize`, waits for `ui/notifications/initialized`, then pushes
	* `ui/notifications/tool-input` and `ui/notifications/tool-result`.
	*/
	const MRTR_REVISION = "2026-07-28";
	const DASHBOARD_URI = "ui://projection/dashboard.html";
	/** The canned workflow: an inline read, then a gated (destructive) write. */
	const MACHINE = `
import { setup, assign } from 'xstate';
import { toolCall } from '@astral-mcp/tools';

export default setup({}).createMachine({
  id: 'readThenWrite',
  context: ({ input }) => ({ dir: input.dir, note: null, status: 'pending' }),
  initial: 'reading',
  states: {
    reading: {
      entry: toolCall('read_text_file', ({ context }) => ({ path: context.dir + '/notes.txt' })),
      on: {
        TOOL_RESULT: { target: 'writing', actions: assign({ note: ({ event }) => event.result }) },
        TOOL_ERROR: { target: 'done', actions: assign({ status: 'read failed' }) },
      },
    },
    writing: {
      entry: toolCall('write_file', ({ context }) => ({
        path: context.dir + '/dashboard-was-here.txt',
        content: 'written by an approved Projection workflow',
      })),
      on: {
        TOOL_RESULT: { target: 'done', actions: assign({ status: 'written' }) },
        TOOL_DENIED: { target: 'done', actions: assign({ status: 'declined by the user' }) },
        TOOL_ERROR: { target: 'done', actions: assign({ status: 'write failed' }) },
      },
    },
    done: { type: 'final' },
  },
  output: ({ context }) => ({ status: context.status, note: context.note }),
});
`;
	function el(id) {
		return document.getElementById(id);
	}
	function log(direction, text) {
		const line = document.createElement("div");
		line.className = "wire-line";
		const tag = document.createElement("span");
		tag.className = "wire-tag";
		tag.textContent = direction;
		line.appendChild(tag);
		line.appendChild(document.createTextNode(text));
		const wire = el("wire");
		wire.appendChild(line);
		wire.scrollTop = wire.scrollHeight;
	}
	function mountApp(html) {
		const iframe = document.createElement("iframe");
		iframe.setAttribute("sandbox", "allow-scripts");
		iframe.id = "app-frame";
		iframe.srcdoc = html;
		el("app-slot").replaceChildren(iframe);
		let markReady;
		const ready = new Promise((resolve) => {
			markReady = resolve;
		});
		window.addEventListener("message", (event) => {
			if (event.source !== iframe.contentWindow) return;
			const message = event.data;
			if (message?.jsonrpc !== "2.0") return;
			if (message.method === "ui/initialize" && message.id !== void 0) {
				log("app→host", "ui/initialize");
				iframe.contentWindow?.postMessage({
					jsonrpc: "2.0",
					id: message.id,
					result: {
						hostInfo: {
							name: "projection-demo-host",
							version: "0.1.0"
						},
						hostCapabilities: {},
						hostContext: {}
					}
				}, "*");
				return;
			}
			if (message.method === "ui/notifications/initialized") {
				log("app→host", "ui/notifications/initialized");
				markReady();
				return;
			}
			if (message.id !== void 0 && message.method !== void 0) iframe.contentWindow?.postMessage({
				jsonrpc: "2.0",
				id: message.id,
				result: {}
			}, "*");
		});
		return {
			ready,
			push(method, params) {
				log("host→app", method);
				iframe.contentWindow?.postMessage({
					jsonrpc: "2.0",
					method,
					params
				}, "*");
			}
		};
	}
	async function run() {
		const runButton = el("run");
		runButton.disabled = true;
		el("approvals").replaceChildren();
		const client = new Client({
			name: "apps-demo-page",
			version: "0.1.0"
		}, {
			capabilities: { elicitation: {} },
			versionNegotiation: { mode: { pin: MRTR_REVISION } },
			inputRequired: { autoFulfill: false }
		});
		await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", location.href)));
		log("host→server", `initialize (pinned ${MRTR_REVISION})`);
		const appHtml = (await client.readResource({ uri: DASHBOARD_URI })).contents[0].text ?? "";
		log("host→server", `resources/read ${DASHBOARD_URI} (${appHtml.length} bytes)`);
		const app = mountApp(appHtml);
		await app.ready;
		const dir = (await (await fetch("/config")).json()).dir;
		el("dir").value = dir;
		app.push("ui/notifications/tool-input", { arguments: {
			code: MACHINE,
			input: { dir }
		} });
		let retry;
		for (;;) {
			log("host→server", "tools/call execute_machine");
			const result = await client.request({
				method: "tools/call",
				params: {
					name: "execute_machine",
					arguments: {
						code: MACHINE,
						input: { dir }
					},
					...retry !== void 0 ? retry : {}
				}
			}, { allowInputRequired: true });
			if (result.resultType !== "input_required") {
				log("server→host", result.isError === true ? "tools/call result (error)" : "tools/call result (completed)");
				app.push("ui/notifications/tool-result", result);
				runButton.disabled = false;
				return;
			}
			log("server→host", "input_required (workflow suspended, sealed blob echoed)");
			const responses = {};
			for (const [key, request] of Object.entries(result.inputRequests ?? {})) {
				const action = await askApproval(request.params?.message ?? "(no message)");
				responses[key] = action ? { action: "accept" } : { action: "decline" };
				log("host→server", `${action ? "approve" : "decline"} ${key}`);
			}
			retry = {
				requestState: result.requestState,
				inputResponses: responses
			};
		}
	}
	/** Render one approval prompt and resolve with the human's verdict. */
	function askApproval(message) {
		return new Promise((resolve) => {
			const card = document.createElement("div");
			card.className = "approval";
			const text = document.createElement("pre");
			text.textContent = message;
			const buttons = document.createElement("div");
			buttons.className = "buttons";
			const approve = document.createElement("button");
			approve.textContent = "Approve";
			approve.className = "approve";
			const decline = document.createElement("button");
			decline.textContent = "Decline";
			decline.className = "decline";
			const finish = (verdict) => {
				card.classList.add("decided");
				approve.disabled = decline.disabled = true;
				card.dataset["verdict"] = verdict ? "approved" : "declined";
				resolve(verdict);
			};
			approve.addEventListener("click", () => finish(true));
			decline.addEventListener("click", () => finish(false));
			buttons.appendChild(approve);
			buttons.appendChild(decline);
			card.appendChild(text);
			card.appendChild(buttons);
			el("approvals").appendChild(card);
			card.scrollIntoView({ behavior: "smooth" });
		});
	}
	el("run").addEventListener("click", () => {
		run().catch((err) => {
			log("error", String(err));
			el("run").disabled = false;
		});
	});
	//#endregion
})();
