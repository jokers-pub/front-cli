import path from "node:path";
import fs from "node:fs";
import { VERSION } from "rollup";
import type {
    CustomPluginOptions,
    EmittedFile,
    InputOptions,
    LoadResult,
    MinimalPluginContext,
    ModuleInfo,
    NormalizedInputOptions,
    PartialResolvedId,
    PluginContext,
    PluginContextMeta,
    ResolvedId,
    RollupError,
    RollupLog,
    SourceDescription,
    SourceMap,
    TransformResult
} from "rollup";
import { Server } from ".";
import { Plugin } from "../plugin";
import {
    addUrlQuery,
    combineSourceMaps,
    createErrorMsgFromRollupError,
    generateCodeFrame,
    normalizePath,
    offsetToPosition,
    parseRequest,
    prettifyUrl
} from "../utils";
import { logger } from "../logger";
import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";
import { cleanUrl, isExternalUrl, isObject } from "@joker.front/shared";
import type * as postcss from "postcss";
import type { RawSourceMap } from "@ampproject/remapping";
import MagicString from "magic-string";
import { ResolvedConfig } from "../config";
import { ModuleMap } from "./moduleMap";
import { browserExternalId } from "../plugins/resolve";

const LOGTAG = "插件容器";

export class PluginContainer {
    private readonly plugins: Plugin[];

    /**
     * rollup插件上下文
     */
    public minimalPluginContext: MinimalPluginContext;

    public isClonsed: boolean = false;

    private inputOptions?: InputOptions;

    /**
     * resolveId缓存，避免重复多次的解析
     */
    public resolveIdCache: Map<string, PartialResolvedId> = new Map();

    constructor(
        public config: ResolvedConfig,
        public moduleMap?: ModuleMap,
        public addWatcher?: Server["addWatchFile"]
    ) {
        this.plugins = this.config.plugins || [];

        this.minimalPluginContext = {
            meta: {
                //采用dep引用，向下兼容模式，无法固定版本
                rollupVersion: VERSION,
                watchMode: true
            }
        } as any;
    }

    public async initOptions() {
        let rollupOptions = this.config.build?.rollupOptions || {};

        for (let plugin of this.config.plugins || []) {
            if (plugin.options) {
                rollupOptions =
                    (await (typeof plugin.options === "object" ? plugin.options.handler : plugin.options).call(
                        this.minimalPluginContext,
                        rollupOptions
                    )) || rollupOptions;
            }
        }

        this.inputOptions = {
            ...rollupOptions
        };
    }

    public async start() {
        await Promise.all(
            this.plugins.map((plugin) => {
                if (plugin.buildStart) {
                    /**
                     * 这里需要重写RollupContainer，因为我们对地址
                     * 进行了重写，有自己的时间戳和参数，需要实现对应的moduleId
                     */
                    return (typeof plugin.buildStart === "object" ? plugin.buildStart.handler : plugin.buildStart).call(
                        new RollupPluginContext(this, plugin) as any,
                        /**
                         * inputOptions 比 NormalizedInputOptions 多一个watcher，
                         * 并在acornInjectPlugins 有类型差异，已在初始化时置为空数组
                         */
                        this.inputOptions as NormalizedInputOptions
                    );
                }
            })
        );
    }

    public getModuleInfo(id: string) {
        let module = this.moduleMap?.getModuleById(id);

        if (module) {
            module.info ??= new Proxy(
                { id, meta: module.meta || {} },
                {
                    get(obj: any, key: string) {
                        if (key in obj) {
                            return obj[key];
                        }

                        logger.error(
                            LOGTAG,
                            `获取ModuleInfo中${key}失败，在server模式下，moduleInfo不具备此属性相关能力`
                        );
                    }
                }
            );

            return module.info!;
        }

        return null;
    }

    public async resolveId(
        id: string,
        importer?: string,
        options?: {
            //跳过列表
            skips?: Set<Plugin>;
            //是否开启扫描
            scan?: boolean;
            isEntry?: boolean;
            custom?: CustomPluginOptions;
        }
    ): Promise<PartialResolvedId | null> {
        //默认导入方为index.html
        importer ??= path.join(this.config.root || "", "index.html");

        let partialResolvedId: Partial<PartialResolvedId> = {};

        let cacheId = `__${importer}__~__${id}__`;
        let cacheResult = this.resolveIdCache.get(cacheId);

        if (cacheResult) {
            return cacheResult;
        }

        let resultId = "";

        //伪造context
        let ctx = new RollupPluginContext(this);
        for (let plugin of this.plugins) {
            if (plugin.resolveId === undefined) continue;

            //需要跳过当前组件时
            if (options?.skips?.has(plugin)) continue;

            ctx.plugin = plugin;
            ctx._scan = options?.scan;
            ctx._skipsPlugins = options?.skips;

            let resolveResult = await plugin.resolveId.call(ctx as any, id, importer, {
                custom: options?.custom,
                isEntry: !!options?.isEntry,
                scan: options?.scan
            });

            if (!resolveResult) continue;

            if (typeof resolveResult === "string") {
                resultId = resolveResult;
            } else {
                resultId = resolveResult.id;
                Object.assign(partialResolvedId, resolveResult);
            }

            //由于id可能会存在不同程度变种，只允许第一个存在转换id的hook去执行
            //执行成功返回即不在向其他组件做传递

            logger.debug(
                LOGTAG,
                "resolveID被" + plugin.name + "触发：" + id + " => " + prettifyUrl(resultId, this.config.root)
            );
            break;
        }

        if (resultId) {
            //返还参数
            let oldParams = parseRequest(id) || {};
            let newParams = Object.assign(oldParams, parseRequest(resultId));
            resultId = cleanUrl(resultId);
            let queryArr: string[] = [];
            for (let name in newParams) {
                if (newParams[name]) {
                    queryArr.push(`${name}=${newParams[name]}`);
                } else {
                    queryArr.push(`${name}`);
                }
            }

            if (queryArr.length) {
                resultId = addUrlQuery(resultId, `${queryArr.join("&")}`);
            }

            //如果id是外部协议地址，则直接返回，否则转换为标准本地绝对路径
            partialResolvedId.id = isExternalUrl(resultId) ? resultId : normalizePath(resultId);

            let result = partialResolvedId as PartialResolvedId;

            cacheId && this.resolveIdCache.set(cacheId, result);

            return result;
        }

        logger.warn(LOGTAG, `resolveID未能返回转换的resolveId:${id}，引用来源：${importer}`);
        return null;
    }

    public async load(id: string): Promise<LoadResult | null> {
        let ctx = new RollupPluginContext(this);
        for (let plugin of this.plugins) {
            if (plugin.load === undefined) continue;

            ctx.plugin = plugin;

            let result: LoadResult;
            if (typeof plugin.load === "object") {
                result = await plugin.load.handler.call(ctx as any, id);
            } else {
                result = await plugin.load.call(ctx as any, id);
            }

            if (result !== null && result !== undefined) {
                if (isObject(result)) {
                    this.updateModuleInfo(id, result as any);
                }

                logger.debug(LOGTAG, `${prettifyUrl(id, this.config.root)}文件被${plugin.name}执行了load`);

                return result;
            }
        }

        return null;
    }

    public async close() {
        if (this.isClonsed) return;

        let ctx = new RollupPluginContext(this);

        await Promise.all(
            this.plugins.map(
                (m) => m.buildEnd && (typeof m.buildEnd === "object" ? m.buildEnd.handler : m.buildEnd).call(ctx as any)
            )
        );

        await Promise.all(
            this.plugins.map(
                (m) =>
                    m.closeBundle &&
                    (typeof m.closeBundle === "object" ? m.closeBundle.handler : m.closeBundle).call(ctx as any)
            )
        );

        this.isClonsed = true;
    }

    public async transform(
        code: string,
        id: string,
        inMap?: SourceDescription["map"]
    ): Promise<SourceDescription | null> {
        let ctx = new TransformRollupPluginContext(this, id, code, inMap as SourceMap);

        for (let plugin of this.plugins) {
            if (plugin.transform === undefined) continue;

            ctx.plugin = plugin;
            ctx._activeId = id;
            ctx._activeCode = code;

            let result: TransformResult | string | undefined;

            try {
                result = await (typeof plugin.transform === "object"
                    ? plugin.transform.handler
                    : plugin.transform
                ).call(ctx as any, code, id);
            } catch (e: any) {
                ctx.error(e);
            }

            if (!result) continue;

            if (isObject(result)) {
                if (result.code !== undefined) {
                    code = result.code;

                    if (result.map) {
                        ctx.sourceMapChain.push(result.map);
                    }
                }

                this.updateModuleInfo(id, result as any);
            } else {
                code = result;
            }
        }

        return {
            code,
            map: ctx.getCombinedSourcemap(false)
        };
    }

    private updateModuleInfo(id: string, { meta }: { meta?: object }) {
        if (meta) {
            let moduleInfo = this.getModuleInfo(id);

            if (moduleInfo) {
                moduleInfo.meta = {
                    ...moduleInfo.meta,
                    ...meta
                };
            }
        }
    }
}

export class RollupPluginContext
    implements
        Omit<
            PluginContext,
            | "cache"
            | "emitAsset"
            | "emitChunk"
            | "getAssetFileName"
            | "getChunkFileName"
            | "isExternal"
            | "moduleIds"
            | "resolveId"
            | "load"
            | "debug"
            | "info"
            | "parse"
        >
{
    watchFiles = new Set<string>();
    meta: PluginContextMeta;

    //以下值 在container中的周期内，初始化上下文时会主动配置
    public _activeId?: string;
    public _activeCode?: string;
    public _scan?: boolean;
    public _skipsPlugins?: Set<Plugin>;
    public _addedImports?: Set<string>;
    constructor(private container: PluginContainer, public plugin?: Plugin) {
        this.meta = container.minimalPluginContext.meta;
    }

    async resolve(
        source: string,
        importer?: string | undefined,
        options?:
            | {
                  custom?: CustomPluginOptions | undefined;
                  isEntry?: boolean | undefined;
                  skipSelf?: boolean | undefined;
              }
            | undefined
    ) {
        let skip: Set<Plugin> | undefined;

        if (options?.skipSelf && this.plugin) {
            skip = new Set<Plugin>();
            skip.add(this.plugin);
        }

        let result = await this.container.resolveId(source, importer, {
            custom: options?.custom,
            isEntry: options?.isEntry,
            skips: skip,
            scan: this._scan
        });

        if (typeof result === "string") {
            result = {
                id: result
            };
        }

        return result as ResolvedId | null;
    }

    getModuleIds(): IterableIterator<string> {
        return this.container.moduleMap?.idModuleMap.keys() || Array.prototype[Symbol.iterator]();
    }

    getModuleInfo(moduleId: string): ModuleInfo | null {
        return this.container.getModuleInfo(moduleId);
    }

    addWatchFile(id: string) {
        this.watchFiles.add(id);

        this._addedImports ??= new Set();

        this._addedImports.add(id);

        this.container.addWatcher?.(id);
    }

    getWatchFiles(): string[] {
        return Array.from(this.watchFiles);
    }

    //#region 警告错误
    transformError(e: string | RollupLog, position?: number | { column: number; line: number }) {
        let err = (typeof e === "string" ? new Error(e) : e) as RollupError & postcss.CssSyntaxError;

        if (err.pluginCode) {
            return err;
        }
        if (err.file && err.name === "CssSyntaxError") {
            err.id = normalizePath(err.file);
        }

        err.plugin = this.plugin?.name;
        if (err.id === undefined) {
            err.id = this._activeId;
        }

        if (this._activeCode) {
            err.pluginCode = this._activeCode;

            // eslint-disable-next-line eqeqeq
            let pos = position != null ? position : err.pos != null ? err.pos : (err as any).position;

            // eslint-disable-next-line eqeqeq
            if (pos != null) {
                let errLocation = offsetToPosition(this._activeCode, pos);

                err.loc = err.loc || {
                    file: err.id,
                    ...errLocation!
                };

                err.frame ??= generateCodeFrame(this._activeCode, pos);
            } else if (err.loc) {
                if (!err.frame) {
                    let code = this._activeCode;
                    if (err.loc.file) {
                        err.id = normalizePath(err.loc.file);

                        try {
                            code = fs.readFileSync(err.loc.file, "utf-8");
                        } catch (e) {}
                    }

                    err.frame = generateCodeFrame(code, err.loc);
                }
            } else if (err.line !== undefined && err.column !== undefined) {
                err.loc = {
                    file: err.id,
                    line: err.line,
                    column: err.column
                };

                //err.id -》source
                err.frame ??= generateCodeFrame(err.id || "", err.loc);
            }

            if (err.loc && this instanceof TransformRollupPluginContext) {
                let sourceMap = this.getCombinedSourcemap(false);

                if (sourceMap) {
                    //rollup.sourceMap -> TraceMap
                    let traced = new TraceMap(sourceMap as any);

                    let { source, line, column } = originalPositionFor(traced, {
                        line: err.loc.line,
                        column: err.loc.column
                    });

                    if (source && line !== null && column !== null) {
                        err.loc = { file: source, line, column };
                    }
                }
            }
        }

        return err;
    }

    error(err: string | RollupError, pos?: number | { column: number; line: number } | undefined): never {
        throw this.transformError(err, pos);
    }
    warn(log: RollupLog | string | (() => RollupLog | string)) {
        if (typeof log === "function") {
            log();
        } else {
            let err = this.transformError(log);

            let msg = createErrorMsgFromRollupError(err);

            logger.warn(LOGTAG, msg);
        }
    }

    //#endregion

    //#region  无实现警告
    emitFile(emittedFile: EmittedFile): string {
        this.warnTip("emitFile");
        return "";
    }

    getFileName(fileReferenceId: string) {
        this.warnTip("getFileName");
        return "";
    }

    setAssetSource(assetReferenceId: string, source: string | Uint8Array) {
        this.warnTip("setAssetSource");
    }
    private warnTip(funName: string) {
        logger.warn(
            `[plugin:${this.plugin?.name || ""}]`,
            `context上下文实例中不支持在server模式下调用${funName},已按空处理`
        );
    }
    //#endregion
}

class TransformRollupPluginContext extends RollupPluginContext {
    public sourceMapChain: NonNullable<SourceDescription["map"]>[] = [];
    public combinedMap: SourceMap | null = null;
    constructor(
        container: PluginContainer,

        public fileName: string,
        public code: string,
        inMap?: SourceMap | string
    ) {
        super(container);

        if (inMap) {
            this.sourceMapChain.push(inMap);
        }
    }

    getCombinedSourcemap(createIfNull: boolean = true): SourceMap | null {
        //暂存
        let combinedMap = this.combinedMap;

        for (let m of this.sourceMapChain) {
            let item = (typeof m === "string" ? JSON.stringify(m) : m) as SourceMap;
            if ("version" in item === false) {
                this.sourceMapChain.length = 0;
                this.combinedMap = null;
                combinedMap = null;
                break;
            }

            if (combinedMap === null) {
                combinedMap = item;
            } else {
                combinedMap = {
                    ...combineSourceMaps(cleanUrl(this.fileName), [
                        {
                            ...(item as RawSourceMap),
                            sourcesContent: combinedMap.sourcesContent
                        },
                        combinedMap as RawSourceMap
                    ])
                };
            }

            if (combinedMap === null) {
                return createIfNull
                    ? new MagicString(this.code).generateMap({
                          includeContent: true,
                          hires: true,
                          source: cleanUrl(this.fileName)
                      })
                    : null;
            }

            if (combinedMap !== this.combinedMap) {
                this.combinedMap = combinedMap;

                this.sourceMapChain.length = 0;
            }
        }
        return this.combinedMap;
    }
}
