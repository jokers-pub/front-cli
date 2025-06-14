import { RollupError } from "rollup";
import { Server } from ".";
import { logger } from "../logger";
import { clearnStack, isCssRequest, normalizePath, prettifyUrl, strip, warpId } from "../utils";
import { ModuleNode } from "./moduleMap";
import type { IHMRType } from "../../client/hmr";
import path from "node:path";
import { CLIENT_DIR } from "../config";
import fs from "node:fs";

const LOGTAG = "HMR";

export namespace HMRType {
    export type All = IHMRType.All;

    export class Connected implements IHMRType.Connected {
        type: "connected" = "connected";
    }

    export class Custom implements IHMRType.Custom {
        type: "custom" = "custom";

        constructor(public event: string, public data?: any) {}
    }

    export class Error implements IHMRType.Error {
        type: "error" = "error";

        constructor(public err: IHMRType.Error["err"]) {}
    }

    export class Reload implements IHMRType.Reload {
        type: "reload" = "reload";

        constructor(public path: string) {}
    }

    export class Prune implements IHMRType.Prune {
        type: "prune" = "prune";

        constructor(public paths: string[]) {}
    }

    export class Update implements IHMRType.Update {
        type: "update" = "update";
        constructor(public updates: IHMRType.UpdateItem[]) {}
    }
}

export function parserHMRError(err: Error | RollupError): HMRType.Error["err"] {
    return {
        message: strip(err.message || ""),
        stack: strip(clearnStack(err.stack || "")),
        id: (err as RollupError).id,
        frame: strip((err as RollupError).frame || ""),
        plugin: (err as RollupError).plugin,
        pluginCode: (err as RollupError).pluginCode as any,
        loc: (err as RollupError).loc
    };
}

//引号类型
enum QuoteType {
    inCall,
    inSingleQuoteString,
    inDoubleQuoteString,
    inTemplateString,
    inArray
}

/**
 * 收集HMR自定义监听的Dep依赖
 * @param code
 * @param start
 * @param urls
 * @returns selfAccepts
 */
export function acceptedHMRDeps(
    code: string,
    start: number,
    urls: Set<{ url: string; start: number; end: number }>
): boolean {
    let quoteType: QuoteType = QuoteType.inCall;
    let preQuoteType: QuoteType = QuoteType.inCall;
    let currentDep: string = "";

    let addDep = (index: number) => {
        urls.add({
            url: currentDep,
            start: index - currentDep.length - 1,
            end: index + 1
        });

        currentDep = "";
    };

    for (let i = start; i < code.length; i++) {
        let char = code.charAt(i);

        switch (quoteType) {
            case QuoteType.inCall:
            case QuoteType.inArray:
                if (char === `'`) {
                    preQuoteType = quoteType;
                    quoteType = QuoteType.inSingleQuoteString;
                } else if (char === '"') {
                    preQuoteType = quoteType;
                    quoteType = QuoteType.inDoubleQuoteString;
                } else if (char === "`") {
                    preQuoteType = quoteType;
                    quoteType = QuoteType.inTemplateString;
                } else if (/\s/.test(char)) {
                    continue;
                } else {
                    if (quoteType === QuoteType.inCall) {
                        if (char === "[") {
                            quoteType = QuoteType.inArray;
                        } else {
                            //import.meta.hot.accept(...) 监听自身文件
                            return true;
                        }
                    } else if (quoteType === QuoteType.inArray) {
                        if (char === "]") {
                            return false;
                        } else if (char === ",") {
                            continue;
                        } else {
                            acceptError(i);
                        }
                    }
                }
                break;
            case QuoteType.inSingleQuoteString:
                if (char === `'`) {
                    addDep(i);

                    if (preQuoteType === QuoteType.inCall) {
                        //import.meta.hot.acceopt('xx',...)
                        return false;
                    } else {
                        quoteType = preQuoteType;
                    }
                } else {
                    currentDep += char;
                }
                break;
            case QuoteType.inDoubleQuoteString:
                if (char === `"`) {
                    addDep(i);

                    if (preQuoteType === QuoteType.inCall) {
                        //import.meta.hot.acceopt("xx",...)
                        return false;
                    } else {
                        quoteType = preQuoteType;
                    }
                } else {
                    currentDep += char;
                }
                break;
            case QuoteType.inTemplateString:
                if (char === "`") {
                    addDep(i);

                    if (preQuoteType === QuoteType.inCall) {
                        //import.meta.hot.acceopt(`xx`,...)
                        return false;
                    } else {
                        quoteType = preQuoteType;
                    }
                } else if (char === "$" && code.charAt(i + 1) === "{") {
                    acceptError(i);
                } else {
                    currentDep += char;
                }
                break;
            default:
                acceptError(i);
        }
    }

    return false;
}

export function acceptedHMRExports(code: string, start: number, exportNames: Set<string>): boolean {
    let urls = new Set<{ url: string; start: number; end: number }>();

    acceptedHMRDeps(code, start, urls);

    urls.forEach((m) => {
        exportNames.add(m.url);
    });

    return urls.size > 0;
}

export function normalizeHMRUrl(url: string): string {
    if (url.startsWith(".") === false && url.startsWith("/") === false) {
        url = warpId(url);
    }

    return url;
}

/**
 * 通知并去除不再使用的import modules
 * @param modules
 * @param server
 */
export function hmrPruned(modules: Set<ModuleNode>, server: Server): void {
    let newTime = Date.now();

    modules.forEach((m) => {
        m.lastHMRTimer = newTime;
    });

    server.socketServer.send(new HMRType.Prune(Array.from(modules).map((m) => m.url)));
}

export async function hmrUpdate(file: string, server: Server): Promise<void> {
    let isConfigFile = file === server.config.configPath;

    if (isConfigFile) {
        logger.warn(LOGTAG, `CLI configuration file has changed, please restart manually`);
        return;
    }

    logger.debug(
        LOGTAG,
        `${prettifyUrl(file, server.config.root)} has changed, preparing to notify update via WebSocket`
    );

    //如果clinet发生变更时处理，正常不会存在该场景，本判断为了CLI开发存在
    if (file.startsWith(normalizePath(CLIENT_DIR))) {
        server.socketServer.send(new HMRType.Reload("*"));
        return;
    }

    if (file.endsWith(".html")) {
        let htmlPath = "/" + getHMRRelativePath(file, server.config.root);
        logger.debug(LOGTAG, `html:${htmlPath} changed, triggering reload`);

        server.socketServer.send(new HMRType.Reload(htmlPath));
        return;
    }

    let modules = server.moduleMap.getModulesByFile(file);

    let hmrContext = new HMRContext(file, server, modules);

    //plugin hook
    for (let plugin of server.config.plugins) {
        if (plugin.hmrUpdate) {
            let transformModules = await plugin.hmrUpdate(hmrContext, server);

            if (transformModules) {
                hmrContext.modules = transformModules;
            }
        }
    }

    if (hmrContext.modules.length) {
        updateModules(hmrContext);
    }
}

export async function hmrFileAddUnlink(file: string, server: Server): Promise<void> {
    let modules = server.moduleMap.getModulesByFile(file);

    if (modules?.size) {
        updateModules(new HMRContext(file, server, modules));
    }
}

export function updateModules(ctx: HMRContext) {
    let disposeModules = new Set<ModuleNode>();
    let fullReload = false;
    let updates: IHMRType.UpdateItem[] = [];

    for (let module of ctx.modules) {
        disposeModule(module, ctx.timestamp, ctx.server, true, disposeModules);

        if (fullReload) {
            /**
             * 如果在循环时发现需要重新加载，不做break，还要继续循环
             * 以完成模块的dispose
             */
            continue;
        }

        let collectionNodes = new Set<{ node: ModuleNode; acceptedVia: ModuleNode }>();

        let hasDepEnd = recursionUpdate(module, collectionNodes);

        //引用终点则需要reload才可以被刷新
        if (hasDepEnd) {
            fullReload = true;
            continue;
        }

        //当前模块还没有被浏览器加载解析过，或加载失败，则需要reload进行重置资源
        if (collectionNodes.size === 0 && module.id && module.isSelfAccepting === undefined) {
            fullReload = true;
            continue;
        }

        collectionNodes.forEach((item) => {
            updates.push({
                type: item.node.type === "js" ? "js-update" : "css-update",
                timestamp: ctx.timestamp,
                path: item.node.url,
                acceptedPath: item.acceptedVia.url
            });
        });
    }

    if (fullReload) {
        logger.info(
            LOGTAG,
            `Dependency endpoint or interruption exception detected during module update. Full page reload required for hot update.`
        );

        ctx.server.socketServer.send(new HMRType.Reload("*"));
        return;
    }

    if (updates.length) {
        updates.forEach((u) => {
            logger.info(LOGTAG, `Hot updating file: ${u.path}`);
        });

        ctx.server.socketServer.send(new HMRType.Update(updates));
    }
}

/**
 * 递归检查并moduleNode，并检测是否存在dep引用终点
 * @param module
 * @param collectionNodes 采集到的节点，里面包含依赖方
 * @param nodesChain 节点链路
 *
 * @return 是否存在dep引用终点，无依赖（引用终点则需要reload才可以被刷新）
 */
function recursionUpdate(
    module: ModuleNode,
    collectionNodes: Set<{ node: ModuleNode; acceptedVia: ModuleNode }>,
    nodesChain: ModuleNode[] = [module]
): boolean {
    //如果存在id，但isSelfAccepting没有值，代表该模块只是静态扫描出来的数据
    //当前模块还没有被浏览器加载解析过，这种跳过递归扫描
    if (module.id && module.isSelfAccepting === undefined) {
        return false;
    }

    if (module.isSelfAccepting) {
        collectionNodes.add({
            node: module,
            acceptedVia: module
        });

        //css附加扫描
        for (let importer of module.importers) {
            if (isCssRequest(importer.url) && nodesChain.includes(importer) === false) {
                recursionUpdate(importer, collectionNodes, nodesChain.concat(importer));
            }
        }

        return false;
    }

    /**
     * 如果存在对外输出，则自己是无法自我接收的
     * 需要更新该模块，必须先更新依赖方（依赖模块），从源头更新，以便完成该模块的reload
     */
    if (module.acceptedHMRExports) {
        collectionNodes.add({
            node: module,
            acceptedVia: module
        });
    } else {
        //没有依赖方，代表遇到依赖终点
        if (module.importers.size === 0) {
            return true;
        }

        //如果一个非css文件，内部引用全都是css文件，则也代表遇到了依赖终点
        if (
            isCssRequest(module.url) === false &&
            Array.from(module.importers).every((item) => isCssRequest(item.url))
        ) {
            return true;
        }
    }

    for (let importer of module.importers) {
        if (importer.acceptedHMRDeps.has(module)) {
            collectionNodes.add({
                node: importer,
                acceptedVia: module
            });

            continue;
        }

        //深度循环引用，将被认定为引用终点
        if (nodesChain.includes(importer)) {
            return true;
        }

        if (recursionUpdate(importer, collectionNodes, nodesChain.concat(importer))) {
            return true;
        }
    }

    return false;
}

export class HMRContext {
    public modules: ModuleNode[];

    public timestamp = Date.now();

    public relativePath: string;

    constructor(
        public file: string,

        public readonly server: Server,
        _modules?: Set<ModuleNode>
    ) {
        //去引用 && 未编译的module不做热更新
        this.modules = [...(_modules || [])];

        this.relativePath = getHMRRelativePath(file, server.config.root);
    }

    public async read(): Promise<string> {
        let content = fs.readFileSync(this.file, "utf-8");

        if (content) {
            return content;
        }

        /**
         * 当获取内容为空时，在一秒内做10次更新时间检测
         * 原因是，可能存在IO阻塞
         */
        let mtime = fs.statSync(this.file).mtimeMs;

        await new Promise((resolve) => {
            let time = 0;
            let checkLoop = async () => {
                time++;

                let newMtime = fs.statSync(this.file).mtimeMs;
                if (newMtime !== mtime || time > 10) {
                    resolve(null);
                } else {
                    setTimeout(() => checkLoop, 10);
                }
            };

            setTimeout(() => checkLoop, 10);
        });

        return fs.readFileSync(this.file, "utf-8");
    }
}

/**
 * 销毁模块属性值，该方法是moduleMap的补充
 * 区别于moduleMap内方法，该方法还做了import接收方的同步递归销毁
 * @param module
 * @param timestamp
 * @param server
 */
function disposeModule(
    module: ModuleNode,
    timestamp: number,
    server: Server,
    isHmr: boolean = false,
    _list: Set<ModuleNode>
) {
    //防重复处理
    if (_list.has(module)) {
        return;
    }

    _list.add(module);

    server.moduleMap.disposeModule(module, isHmr, timestamp);

    module.importers.forEach((importer) => {
        //除热更外全部重置
        if (importer.acceptedHMRDeps.has(module) === false) {
            disposeModule(importer, timestamp, server, isHmr, _list);
        }
    });
}
/**
 * 获取相对路径，如果非root，则返回原值
 * @param file
 * @param root
 * @returns
 */
function getHMRRelativePath(file: string, root: string): string {
    return file.startsWith(root + "/") ? path.posix.relative(root, file) : file;
}

function acceptError(pos: number): never {
    let err = new Error(
        logger.error(
            LOGTAG,
            `import.meta.hot.accept() only accepts strings or arrays. Dynamic variables are not supported.`
        )
    ) as RollupError;

    err.pos = pos;

    throw err;
}
