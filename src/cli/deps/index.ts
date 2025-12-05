import path from "node:path";
import { getConfigHash, ResolvedConfig } from "../config";
import { logger } from "../logger";
import {
    ControlPromise,
    createControlPromise,
    flattenId,
    getHash,
    getPartObject,
    normalizePath,
    SCRIPT_TYPES_RE
} from "../utils";
import { DepCache } from "./cache";
import { scanProject } from "./scan";

import { getDepRewriteImport, getExportDatas, ResolveDepMetadataResult, runResolvedDeps } from "./resolved";
import { DepMetadata, DepInfo } from "./metadata";
import { Server } from "../server";
import { HMRType } from "../server/hmr";
import { removeFilter } from "@joker.front/shared";
import { throwOutdatedRequest } from "../plugins/resolveDep";
const LOGTAG = "DEP";

/**
 * 扫描项目内所有引用关系
 * @param config
 */
export async function scanProjectDependencies(config: ResolvedConfig): Promise<Record<string, string>> {
    let { deps, missing } = await scanProject(config);

    let missingIds = Object.keys(missing);

    if (missingIds.length) {
        logger.error(
            LOGTAG,
            `During dependency scanning of the project entry point, missing references were detected. Please ensure these dependencies are correctly installed and loaded:
${missingIds.join("\n ")}`
        );
    }

    return deps;
}

export class DepHandler {
    public configHash: string;

    /**
     * Dep缓存
     */
    public depCache: DepCache;

    public isInitByCache: boolean = false;

    /**
     * 配置devServer，用于reload等时机时的websocket通讯
     */
    public server?: Server;

    /**
     * Dep 描述
     */
    public depMetadata: DepMetadata;

    /**
     * 扫描处理程序，控制项目扫描进程状态
     */
    public scanProcessing?: Promise<void>;

    /**
     * 第一次是否已经完成（标记），区分第一次初始化和changed
     */
    private firstEnded: boolean = false;

    /**
     * 是否被执行过首次
     */
    private firstRunEnsured: boolean = false;

    /**
     * dep 数据源扫描程序
     */
    private scanDepMetadataProcessing?: Promise<ResolveDepMetadataResult>;

    /**
     * 是否发现新的dep
     */
    private findNewDep: boolean = false;

    /**
     * 本轮dep扫描进度处理程序
     */
    private depResolveProcessing: ControlPromise = createControlPromise();

    /**
     * 队列记录（内容参考上述）
     */
    private depResolveProcessingQueue: ControlPromise[] = [];

    /**
     * 当前是否在运行中
     */
    private currentProcessing: boolean = false;

    /**
     * 注册id的列队
     */
    private registedIdsQueue: { id: string; exec: () => Promise<any> }[] = [];

    /**
     * 已经接收到要注册的id列表
     */
    private ids: Set<string> = new Set();

    /**
     * worker 注册id
     */
    private workersSources: Set<string> = new Set();

    /**
     * 当前执行的列队ID
     */
    private currentQueueId?: string;

    constructor(public config: ResolvedConfig) {
        //重写configHash中的 mode，保证不区分环境
        this.configHash = getConfigHash({ ...this.config, command: "build" });

        this.depCache = new DepCache(this.config);

        let cachedMetadata = this.depCache.loadCache(this.configHash);

        if (cachedMetadata) {
            this.isInitByCache = true;
            this.depMetadata = cachedMetadata;

            logger.debug(LOGTAG, `Dependency cache detected. Using cached version.`);
        } else {
            this.depMetadata = new DepMetadata(this.configHash);
        }

        this.firstEnded = !!this.isInitByCache;
    }

    public async init() {
        //项目依赖采集要在server开始前完成，不采用后置方案
        if (!this.isInitByCache && this.config.command === "server") {
            logger.debug(LOGTAG, `DEV mode detected. No cache found. Initializing full project scan...`);

            this.currentProcessing = true;

            //创建一个promise，来管理扫描的进度状态
            let scanDepResolveProcessing = createControlPromise();
            this.scanProcessing = scanDepResolveProcessing.promise;

            //非阻塞线程，优先保证server端优先初始化完毕，采用静默扫描
            //并通过process promise模式进行状态管理
            //确保整个项目扫描放在server的启动后执行
            setTimeout(async () => {
                logger.debug(LOGTAG, "Starting project dependency collection and scanning...");

                let deps = await scanProjectDependencies(this.config);
                let depsKeys = Object.keys(deps);
                logger.debug(
                    LOGTAG,
                    depsKeys.length
                        ? `Project scan complete: Found ${depsKeys.length} dependencies: ${depsKeys.join(", ")}`
                        : `Project scan complete: No dependencies found in the entry point.`
                );

                //由于数据可能来自cache，所以要去查找差异，并添新的引用
                for (let id in deps) {
                    if (this.depMetadata.discovered[id] === undefined) {
                        this.addMissingDep(id, deps[id]);
                    }
                }

                let knownDeps = this.getKnownDeps();

                //静默处理：对已有的依赖进行构建、并移入缓存
                //由于每个dep，都会有process，在load时，会awaite，此处只做触发，不做阻塞
                this.scanDepMetadataProcessing = runResolvedDeps(this, knownDeps);

                //标记完成
                scanDepResolveProcessing.resolve();
                this.scanProcessing = undefined;
            }, 0);
        }
    }

    /**
     * 通过id获取缓存文件路径
     * @param id
     * @returns
     */
    public getDepPath(id: string) {
        return normalizePath(path.resolve(this.depCache.cacheDir, flattenId(id) + ".js"));
    }

    public getDepList(): DepInfo[] {
        return [
            ...Object.values(this.depMetadata.resolved),
            ...Object.values(this.depMetadata.discovered),
            ...Object.values(this.depMetadata.chunks)
        ];
    }

    public isOptimizable(id: string) {
        return SCRIPT_TYPES_RE.test(id);
    }

    public getDepInfoFromFile(fsPath: string): DepInfo | undefined {
        return (
            Object.values(this.depMetadata.resolved).find((m) => m.file === fsPath) ||
            Object.values(this.depMetadata.discovered).find((m) => m.file === fsPath) ||
            Object.values(this.depMetadata.chunks).find((m) => m.file === fsPath)
        );
    }

    public getDepInfoFromId(id: string): DepInfo | undefined {
        return this.depMetadata.resolved[id] || this.depMetadata.discovered[id] || this.depMetadata.chunks[id];
    }
    /**
     * 判断文件id是否是已解析文件
     * @param id
     * @returns
     */
    public isResolvedDepFile(id: string): boolean {
        return this.depCache.isCacheFile(id);
    }

    /**
     * 通过url判断当前文件是否已解析
     * @param url
     * @returns
     */
    public isResolvedDepUrl(url: string): boolean {
        return this.depCache.isCacheUrl(url);
    }

    /**
     * 开始一个周期扫描
     */
    public run() {
        this.debouncedRestart(0);
    }

    /**
     * 获取一个引用的文件id
     * @param depInfo
     * @returns
     */
    public getResolvedDepId(depInfo: DepInfo) {
        return this.config.command === "server" ? `${depInfo.file}?v=${depInfo.browserHash}` : depInfo.file;
    }

    /**
     * 添加dep load队列，不接管内容，只做队列控制(用于记录非dep请求)
     * @param id moduleId
     * @param exec load方法
     */
    public delayDepResolveUntil(id: string, exec: () => Promise<any>): void {
        //没有被缓存过 && 没有加入过队列
        if (this.depCache.isCacheFile(id) === false && this.ids.has(id) === false) {
            this.ids.add(id);
            this.registedIdsQueue.push({
                id,
                exec
            });

            this.runNextDepLoad();
        }
    }

    /**
     * 重置数据
     */
    public reset() {
        this.ids = new Set<string>();

        this.registedIdsQueue = [];
        this.currentQueueId = undefined;
        this.firstEnded = false;
    }

    /**
     * 首次执行，由plugin插件执行
     */
    public firstRun() {
        if (this.firstRunEnsured === false && this.registedIdsQueue.length === 0 && this.firstEnded === false) {
            setTimeout(() => {
                if (this.registedIdsQueue.length === 0) {
                    this.onQueueEnd();
                }
            }, 100);
        }

        this.firstRunEnsured = true;
    }

    /**
     * 注册丢失的import引用
     * @param id
     * @param resolvedId
     * @returns
     */
    public registerMissingImport(id: string, resolvedId: string) {
        let resolved = this.depMetadata.resolved[id];

        if (resolved) {
            return resolved;
        }

        let chunk = this.depMetadata.chunks[id];
        if (chunk) {
            return chunk;
        }

        let missing = this.depMetadata.discovered[id];
        if (missing) {
            return missing;
        }

        missing = this.addMissingDep(id, resolvedId);

        //如果扫描已经完成，则重置下扫描程序
        if (this.firstEnded) {
            this.debouncedRestart(0);
        }

        return missing;
    }

    public registerWorkersSource(id: string) {
        this.workersSources.add(id);

        removeFilter(this.registedIdsQueue, (m) => m.id === id);

        if (this.currentQueueId === id) {
            this.currentQueueId = undefined;
            this.runNextDepLoad();
        }
    }

    /**
     * 根据描述以及file确定是否需要重写import
     * @param metadata
     * @param file
     */
    public async resolvedDepNeedRewriteImport(file: string): Promise<boolean | undefined> {
        let depInfo = this.getDepInfoFromFile(file);

        if (depInfo?.src && depInfo.needRewriteImport === undefined) {
            depInfo.exportDatas ??= getExportDatas(depInfo.src);
            depInfo.needRewriteImport = getDepRewriteImport(await depInfo.exportDatas);
        }

        return depInfo?.needRewriteImport;
    }

    /**
     * 该循环是为了做请求优先级分类
     * 1. 优先处理非dep注册的处理
     * 2. 直到所有非dep处理完毕后，再去处理dep的缓存优化
     *
     * 以上操作可以实现放阻塞机制
     */
    private runNextDepLoad() {
        if (this.currentQueueId === undefined) {
            let next = this.registedIdsQueue.pop();

            if (next) {
                this.currentQueueId = next.id;

                let nextCallBack = () => {
                    this.currentQueueId = undefined;

                    if (this.workersSources.has(next!.id) === false) {
                        if (this.registedIdsQueue.length > 0) {
                            this.runNextDepLoad();
                        } else {
                            this.onQueueEnd();
                        }
                    }
                };

                next.exec()
                    .then(() => {
                        setTimeout(nextCallBack, this.registedIdsQueue.length > 0 ? 0 : 100);
                    })
                    .catch(nextCallBack);
            }
        }
    }

    private async onQueueEnd() {
        logger.debug(LOGTAG, "Dependency async loading queue execution completed.");

        if (this.firstEnded) return;

        this.currentProcessing = false;

        let deps = Object.keys(this.depMetadata.discovered);

        /**
         * 等待后台运行扫描程序
         * 通常在用户代码扫描结束时，它应该结束
         */
        await this.scanProcessing;

        if (this.config.command === "server" && this.scanDepMetadataProcessing) {
            let result = await this.scanDepMetadataProcessing;

            this.scanDepMetadataProcessing = undefined;

            let scanDeps = Object.keys(result.metadata.resolved);

            if (scanDeps.length === 0 && deps.length === 0) {
                logger.debug(LOGTAG, "No references found that require parsing.");

                result.cancel();
                this.firstEnded = true;
                return;
            }

            /**
             * 判断结果是否有效
             * deps 是在异步之前取值，为了判断异步处理后是否有新的发现
             *
             * 1. 有重写标记差异
             * 2. deps集有差异
             */
            let depDiff = deps.some((dep) => scanDeps.includes(dep) === false);
            let outdatedResult =
                this.findRewriteDiffs(this.depMetadata.discovered, result.metadata.resolved) || depDiff;

            //超出了结果范围，当前结果已失效
            if (outdatedResult) {
                result.cancel();

                //补充
                for (let dep of scanDeps) {
                    if (deps.includes(dep) === false) {
                        this.addMissingDep(dep, result.metadata.resolved[dep].src!);
                    }
                }

                if (depDiff) {
                    logger.debug(LOGTAG, "New references discovered at the end of the loop.");
                }

                logger.debug(LOGTAG, "Initiating a new reference scan...");

                this.debouncedRestart(0);
            } else {
                //当前扫描结果可以被解析使用
                logger.debug(LOGTAG, `The current scan results are valid. No invalid or missing indices found.`);

                this.startNextDiscoveredBatch();
                this.runResolve(result);
            }
        } else {
            if (deps.length === 0) {
                logger.debug(LOGTAG, `Scan complete. No dependency indices found.`);
                this.firstEnded = true;
            } else {
                this.debouncedRestart(0);
            }
        }
    }

    private findRewriteDiffs(discovered: Record<string, DepInfo>, resolved: Record<string, DepInfo>) {
        let result: string[] = [];

        for (let dep in discovered) {
            let discoveredDepInfo = discovered[dep];
            let depInfo = resolved[dep];

            //重写标记不一致（ESM/CJS）
            if (
                depInfo &&
                discoveredDepInfo.needRewriteImport !== undefined &&
                depInfo.needRewriteImport !== discoveredDepInfo.needRewriteImport
            ) {
                /**
                 * 只有当发现的依赖项混合了ESM和CJS语法，
                 * 并且没有手动添加到optimizeDeps.needsInterop时，
                 * 才会发生这种情况
                 */
                result.push(dep);

                logger.debug(LOGTAG, "Found a dependency with inconsistent override markers: " + dep);
            }
        }

        return result;
    }

    private addMissingDep(id: string, resolved: string): DepInfo {
        this.findNewDep = true;

        let depInfo: DepInfo = {
            id: id,
            file: this.getDepPath(id),
            src: resolved,
            browserHash: getHash(
                this.depMetadata.hash +
                    JSON.stringify(getPartObject(this.depMetadata.resolved, "src")) +
                    JSON.stringify(getPartObject(this.depMetadata.discovered, "src"))
            ),
            exportDatas: getExportDatas(resolved),
            processing: this.depResolveProcessing.promise
        };

        this.depMetadata.discovered[depInfo.id] = depInfo;

        return depInfo;
    }

    private getKnownDeps() {
        //合并已识别+新发现的dep，并切新发现有冲突时，要做替换处理
        //做clone机制，不要对其进行污染，方便下一次获取
        let result: Record<string, DepInfo> = {};

        for (let dep in this.depMetadata.resolved) {
            result[dep] = {
                ...this.depMetadata.resolved[dep]
            };
        }

        for (let dep in this.depMetadata.discovered) {
            result[dep] = {
                ...this.depMetadata.discovered[dep]
            };
        }

        return result;
    }

    private resolveEnqueuedProcessingPromises() {
        for (let processing of this.depResolveProcessingQueue) {
            processing.resolve();
        }

        this.depResolveProcessingQueue = [];
    }

    /**
     * 重新排队的方法
     */
    private enqueueRerun?: () => void;

    private handle?: NodeJS.Timeout;

    private debouncedRestart(timeout = 100) {
        //没有发现新的索引，不需要重启
        if (this.findNewDep === false) return;

        this.enqueueRerun = undefined;

        if (this.handle) clearTimeout(this.handle);

        this.handle = setTimeout(() => {
            this.handle = undefined;

            this.enqueueRerun = () => {
                let deps = Object.keys(this.depMetadata.discovered);

                logger.debug(LOGTAG, `Preparing for restart. Detected ${deps.length} new references.`);

                this.runResolve();
            };

            if (this.currentProcessing === false) {
                this.enqueueRerun();
            }
        }, timeout);
    }

    /**
     * 开启下一次扫描分支
     */
    private startNextDiscoveredBatch() {
        //清空发现新索引标记
        this.findNewDep = false;

        //异步加入队列
        this.depResolveProcessingQueue.push(this.depResolveProcessing);

        //创建新的异步处理程序，它会挂在到接下来发现的dep中
        this.depResolveProcessing = createControlPromise();
    }

    private async runResolve(preResult?: ResolveDepMetadataResult) {
        this.firstEnded = true;

        //确保顺序执行， 由debouncedRestart-》runResolve
        this.enqueueRerun = undefined;
        if (this.handle) clearTimeout(this.handle);

        //没有已发现的dep-结束当前扫描
        if (Object.keys(this.depMetadata.discovered).length === 0) {
            this.currentProcessing = false;
            return;
        }

        //标记开始
        this.currentProcessing = true;

        try {
            let processingResult = preResult ?? (await this.resolveNewDeps());

            let newMetadata = processingResult.metadata;

            let needInteropMismatch = this.findRewriteDiffs(this.depMetadata.discovered, newMetadata.resolved);

            /**
             * 是否需要重载：
             * 1. 发现引用方式需要重写
             * 2. hash不一致
             * 3. 发现文件hash发生变更 老-》新，不考虑新增
             */
            let needReload =
                needInteropMismatch.length > 0 ||
                this.depMetadata.hash !== newMetadata.hash ||
                Object.keys(this.depMetadata.resolved).some((dep) => {
                    return this.depMetadata.resolved[dep].fileHash !== newMetadata.resolved[dep].fileHash;
                });

            if (needReload) {
                if (this.findNewDep) {
                    processingResult.cancel();

                    logger.debug(LOGTAG, `Reload delayed due to new references detected during asynchronous parsing.`);
                } else {
                    await this.commitProcessing(processingResult, needReload);

                    logger.debug(LOGTAG, "Reloading in progress due to changes in references.");

                    if (needInteropMismatch.length) {
                        logger.debug(
                            LOGTAG,
                            `Detected mixed ESM/CJS usage in references: \n${needInteropMismatch.join(", ")}\n` +
                                `These will be injected during reload to ensure fast cold starts`
                        );
                    }

                    this.fullReload();
                }
            } else {
                await this.commitProcessing(processingResult, needReload);

                logger.debug(LOGTAG, `Dependencies have been parsed and optimized with no changes detected.`);
            }
        } catch (e: any) {
            logger.error(LOGTAG, `Failed to parse dependencies: ${e.message}\n${e.stack}`);

            this.resolveEnqueuedProcessingPromises();

            //清空新发现，交由下一次对比重置
            this.depMetadata.discovered = {};
        }

        this.currentProcessing = false;

        //@ts-ignore
        this.enqueueRerun?.();
    }

    private async resolveNewDeps() {
        let knownDeps = this.getKnownDeps();

        this.startNextDiscoveredBatch();

        return await runResolvedDeps(this, knownDeps);
    }

    private async commitProcessing(processingResult: ResolveDepMetadataResult, needReload: boolean) {
        await processingResult.commit();

        let newMetadata = processingResult.metadata;
        //由于异步进程，可能再次环节仍然发现丢失引用的场景,我们直接追加到新的数据源中即可
        //新的扫描可能会丢失一些引用（不同入口等原因），这里做追加补充
        for (let id in this.depMetadata.discovered) {
            if (newMetadata.resolved[id] === undefined) {
                newMetadata.resolved[id] = {
                    ...this.depMetadata.discovered[id]
                };
            }
        }

        //即使不需重载，我们也要更新下浏览时的hash,保证启动时的browser的稳定
        //老的brwoser要做保留，避免client做出错误的判断
        if (needReload === false) {
            newMetadata.browserHash = this.depMetadata.browserHash;

            for (let dep in newMetadata.chunks) {
                newMetadata.chunks[dep].browserHash = this.depMetadata.browserHash;
            }

            for (let dep in newMetadata.resolved) {
                newMetadata.resolved[dep].browserHash = (
                    this.depMetadata.resolved[dep] || this.depMetadata.discovered[dep]
                ).browserHash;
            }
        }

        this.depMetadata = newMetadata;

        this.resolveEnqueuedProcessingPromises();
    }

    private fullReload() {
        if (this.config.command === "server" && this.server) {
            this.server.moduleMap.disposeAllModule();
            //重置resolved索引，用于下次重置版本v=?
            this.config.depHandler.server?.pluginContainer.resolveIdCache.clear();
            logger.warn(
                LOGTAG,
                `New DEP cache reference detected; preparing to reload the page to update dependencies.`
            );
            this.server.socketServer.send(new HMRType.Reload("*"));
        }
    }
}
