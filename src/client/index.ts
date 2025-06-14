import { IHMRType } from "./hmr";
import { HotCallBack, HotModule, ModuleNamespace } from "./hot";
import { logger } from "./logger";
import { clearErrorOverlay, createErrorOverlay, ErrorOverlay, hasErrorOverlay } from "./overlay";

//变量注入
declare const __BASE__: string;
declare const __HMR_HOSTNAME__: string | null;
declare const __HMR_PORT__: string | null;
declare const __HMR_HEARTTIMER__: number;
declare const __HMR_CLIENT_ID__: string;
//取值设值
let importMetaUrl = new URL(import.meta.url);
/**Socket协议 */
let socketProtocol: "ws" | "wss" = location.protocol === "https" ? "wss" : "ws";
/**基础目录 */
let base = __BASE__;
/**热更新端口 */
let hmrPort = __HMR_PORT__;
/**热更新端口 */
let hmrClientId = __HMR_CLIENT_ID__;
/**Socket HOST */
let socketHost = `${__HMR_HOSTNAME__ || importMetaUrl.hostname}:${hmrPort || importMetaUrl.port}${base}`;

class SocketService {
    public socket?: WebSocket;

    /**
     * 连接是否已打开
     */
    public isOpened: boolean = false;

    /**
     * 消息列队
     */
    public messageQueue: Set<string> = new Set();

    /**
     * 监听列队
     */
    private listeners: Map<string, ((data: any) => void)[]> = new Map();

    /**
     * 是否已经执行过更新
     */
    private isUpdated = false;

    /**
     * 排除文件字典
     */
    public pruneMap = new Map<string, (data: any) => void | Promise<void>>();

    /**
     * url于数据字典
     */
    public urlDataMap = new Map<string, any>();

    /**
     * 热更模块字典
     */
    public hotModuleMap = new Map<string, HotModule>();

    /**
     * Dep和处理事件字典
     */
    public depExecMap = new Map<string, (data: any) => void | Promise<void>>();

    constructor() {
        //如果开启HMR时才做处理
        if (hmrPort) {
            try {
                this.socket = new WebSocket(`${socketProtocol}://${socketHost}`, "joker-hmr");
            } catch (e: any) {
                logger.error("WebSocket connection failed");
            }

            this.initEventListener();
        } else {
            logger.warn("HMR is disabled. Applying fallback mode with feature degradation compensation only");
        }
    }

    private initEventListener() {
        this.socket?.addEventListener(
            "open",
            () => {
                this.isOpened = true;
            },
            { once: true }
        );

        this.socket?.addEventListener("message", async ({ data }) => {
            this.receiveMessage(JSON.parse(data));
        });

        this.socket?.addEventListener("close", async ({ wasClean }) => {
            if (wasClean) return;

            logger.info("Connection to server lost. Attempting to reconnect...");
            await this.waitingToConnect();

            location.reload();
        });
    }

    private receiveMessage(hmr: IHMRType.All) {
        if (hmr.clientId !== hmrClientId) return;

        switch (hmr.type) {
            case "connected":
                logger.info("Server connection established");
                this.sendMessages();

                setInterval(() => {
                    this.socket?.send(`{'type':'ping'}`);
                }, __HMR_HEARTTIMER__);

                break;
            case "update":
                this.notify("before:update", hmr);
                //如果已更新 && 有阻塞遮罩提示，需要进行reload
                if (this.isUpdated === false && hasErrorOverlay()) {
                    window.location.reload();
                    return;
                }

                clearErrorOverlay();
                this.isUpdated = true;

                hmr.updates.forEach((update) => {
                    if (update.type === "css-update") {
                        this.updateCss(update);
                    } else {
                        this.updateScript(update);
                    }
                });
                break;
            case "custom":
                this.notify(hmr.event, hmr.data);
                break;
            case "reload":
                this.notify("before:reload", hmr);

                if (hmr.path?.endsWith(".html")) {
                    let pagePath = decodeURI(location.pathname);
                    let loadPath = base + hmr.path.slice(1);

                    if (
                        pagePath === loadPath ||
                        hmr.path === "/index.html" ||
                        (pagePath.endsWith("/") && pagePath + "index.html" === loadPath)
                    ) {
                        location.reload();
                    }
                } else {
                    location.reload();
                }
                break;
            case "prune":
                this.notify("before:prune", hmr);

                hmr.paths.forEach((p) => {
                    this.pruneMap.get(p)?.(this.urlDataMap.get(p));
                });
                break;
            case "error":
                this.notify("error", hmr);

                logger.error(`Error detected:\n${hmr.err.message}\n${hmr.err.stack}`);

                createErrorOverlay(hmr.err);
                break;
            default:
                logger.warn(
                    `Unknown HMR type detected. This might be caused by version mismatch between CLI and client`
                );
                break;
        }
    }

    private async waitingToConnect() {
        let hostProtocol = socketProtocol === "wss" ? "https" : "http";

        while (true) {
            try {
                await fetch(`${hostProtocol}://${socketHost}`, { mode: "no-cors" });
                break;
            } catch (e) {
                await sleep(1500);
            }
        }
    }

    public sendMessages() {
        if (this.socket?.readyState === 1) {
            this.messageQueue.forEach((msg) => {
                this.socket?.send(msg);
            });

            this.messageQueue.clear();
        }
    }

    private notify(event: string, data: any): void {
        let callBacks = this.listeners.get(event);

        if (callBacks) {
            callBacks.forEach((cb) => cb(data));
        }
    }

    private updateCss(update: IHMRType.UpdateItem): void {
        let searchUrl = this.clearnUrl(update.path);

        let el = Array.from(document.querySelectorAll("link")).find((el) => {
            return this.clearnUrl(el.href).includes(searchUrl);
        });

        if (el) {
            let newPath = `${base}${searchUrl.slice(1)}${searchUrl.includes("?") ? "&" : "?"}t=${update.timestamp}`;

            let newLinkTag = el.cloneNode() as HTMLLinkElement;
            newLinkTag.href = new URL(newPath, el.href).href;
            newLinkTag.addEventListener("load", () => el?.remove());
            newLinkTag.addEventListener("error", () => el?.remove());

            //先挂新的link，等待加载完毕或者失败时，删除原始link
            el.after(newLinkTag);

            logger.info(`CSS file ${searchUrl} has been updated`);
        } else {
            logger.warn(
                `Server requested update for ${searchUrl}, but corresponding link not found in DOM. Update skipped.`
            );
        }
    }

    /**脚本更新执行列队 */
    private scriptUpdateQueue: Array<Promise<() => void>> = [];
    /**脚本更新执行等待pending */
    private scriptUpdatePending = false;
    private async updateScript(update: IHMRType.UpdateItem): Promise<void> {
        let module = this.hotModuleMap.get(update.path);

        if (module === undefined) return;

        //创建更新执行程序
        let createUpdateFn = async () => {
            let moduleMap = new Map<string, ModuleNamespace>();
            let isSelfUpdate = update.path === update.acceptedPath;
            let moduleToUpdate = new Set<string>();

            //如果是自身更新
            if (isSelfUpdate) {
                moduleToUpdate.add(update.path);
            } else {
                //判断当前页面的依赖Dep如果有也存在依赖该module时，做记录并同步更新dep
                for (let cb of module!.callbacks) {
                    cb.deps.forEach((dep) => {
                        if (update.acceptedPath === dep) {
                            moduleToUpdate.add(dep);
                        }
                    });
                }
            }

            //筛选出符合dep变更范围的回调
            let callBacks = module!.callbacks.filter((cb) => {
                return cb.deps.some((dep) => moduleToUpdate.has(dep));
            });

            await Promise.all(
                Array.from(moduleToUpdate).map(async (dep) => {
                    let beforeExec = this.depExecMap.get(dep);

                    //处理dep之前的自定义处理函数
                    if (beforeExec) {
                        await beforeExec(this.urlDataMap.get(dep));
                    }

                    let [path, query] = dep.split("?");

                    try {
                        let newModule: ModuleNamespace = await import(
                            `${base}${path.slice(1)}?import&t=${update.timestamp}${query ? `&${query}` : ""}`
                        );

                        moduleMap.set(dep, newModule);
                    } catch (err: any) {
                        logger.error(
                            `Request to ${path} failed. This could be due to syntax errors or importing non-existent modules. (See console for details). Attempting to reload to fix HMR failure in 2 seconds.`,
                            err
                        );

                        setTimeout(() => {
                            location.reload();
                        }, 2000);
                    }
                })
            );

            return () => {
                for (let cb of callBacks) {
                    cb.fn(cb.deps.map((dep) => moduleMap.get(dep)));
                }

                let prettyUrl = isSelfUpdate ? update.path : `${update.acceptedPath} updated via ${update.path}`;

                logger.info(`Hot update completed: ${prettyUrl}`);
            };
        };

        this.scriptUpdateQueue.push(createUpdateFn());

        if (this.scriptUpdatePending === false) {
            this.scriptUpdatePending = true;

            //等待微任务周期
            await Promise.resolve();

            this.scriptUpdatePending = false;

            //clone
            let loading = [...this.scriptUpdateQueue];

            //清空
            this.scriptUpdateQueue = [];

            (await Promise.all(loading)).forEach((fn) => fn?.());
        }
    }

    /**
     * 去除地址中非有效参数
     * @param path
     * @returns
     */
    private clearnUrl(path: string): string {
        let url = new URL(path, location.toString());

        url.searchParams.delete("direct");

        return url.pathname + url.search;
    }
}

async function sleep(timer: number) {
    await new Promise((resolve) => setTimeout(resolve, timer));
}

//初始化服务
let socket = new SocketService();

let styleMap = new Map<string, HTMLStyleElement | undefined>();

type ListenersMap = Map<string, ((data: any) => void)[]>;

let listenersMap: ListenersMap = new Map();

let ctxListenersMap = new Map<string, ListenersMap>();

export function updateStyle(id: string, content: string): void {
    let style = styleMap.get(id);

    if (style) {
        style.innerHTML = content;
    } else {
        style = document.createElement("style");

        style.setAttribute("type", "text/css");
        style.innerHTML = content;
        document.head.appendChild(style);
    }

    styleMap.set(id, style);
}

export function removeStyle(id: string): void {
    let style = styleMap.get(id);

    if (style) {
        document.head.removeChild(style);

        styleMap.delete(id);
    }
}

export class JokerHotContext {
    private listeners: ListenersMap = new Map();

    constructor(private path: string) {
        if (socket.urlDataMap.has(path) === false) {
            socket.urlDataMap.set(path, {});
        }

        let module = socket.hotModuleMap.get(path);

        //新的Hot上下文创建，需要清空历史回调
        if (module) {
            module.callbacks = [];
        }

        let ownerListeners = ctxListenersMap.get(path);
        if (ownerListeners) {
            for (let [event, fns] of ownerListeners) {
                let customListener = listenersMap.get(event);

                //如果存在，则进行同步处理
                if (customListener) {
                    listenersMap.set(
                        event,
                        customListener.filter((l) => fns.includes(l) === false)
                    );
                }
            }
        }

        //注册整体监听者
        ctxListenersMap.set(path, this.listeners);
    }

    public get data() {
        return socket.urlDataMap.get(this.path);
    }

    /**接收引用 */
    public accept(deps: string | string[] | HotCallBack["fn"], callBacks?: HotCallBack["fn"]) {
        if (typeof deps === "function") {
            //接收自己
            this.acceptDeps([this.path], deps);
        } else {
            deps = [deps].flat();
            if (deps.length) {
                this.acceptDeps(deps, callBacks);
            }
        }
    }

    public dispose(cb: (data: any) => void | Promise<void>) {
        socket.depExecMap.set(this.path, cb);
    }

    public prune(cb: (data: any) => void | Promise<void>) {
        socket.pruneMap.set(this.path, cb);
    }

    public on(event: string, cb: Function) {
        this.addToListionMap(event, listenersMap, cb);
        this.addToListionMap(event, this.listeners, cb);
    }

    public send(event: string, data: any) {
        socket.messageQueue.add(JSON.stringify({ type: "custom", event, data }));

        socket.sendMessages();
    }

    private acceptDeps(deps: string[], callBacks: HotCallBack["fn"] = () => {}) {
        let module: HotModule = socket.hotModuleMap.get(this.path) || {
            id: this.path,
            callbacks: []
        };

        module.callbacks.push({
            deps,
            fn: callBacks
        });

        socket.hotModuleMap.set(this.path, module);
    }

    private addToListionMap(event: string, souceMap: Map<string, any[]>, cb: Function) {
        let map = souceMap.get(event) || [];

        map.push(cb);

        listenersMap.set(event, map);
    }
}

export function injectQuery(url: string, query: string): string {
    //针对非内部地址，直接做返回，不处理
    //这里只处理本地地址
    if (url.startsWith(".") === false || url.startsWith("/") === false) {
        return url;
    }

    //clean
    let pathname = url.replace(/#.*$/, "").replace(/\?.*$/, "");

    let { search, hash } = new URL(url, "http://jokers.pub");

    return `${pathname}?${query}${search ? `&${search.slice(1)}` : ""}${hash || ""}`;
}

export { createErrorOverlay, clearErrorOverlay };

export * from "./hot";

export * from "./hmr";
