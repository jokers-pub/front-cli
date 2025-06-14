import { ResolvedConfig } from "../config";
import { HttpServer, HttpServerOptions } from "./http";

import chokidar, { FSWatcher } from "chokidar";
import { ProxyMiddleware } from "./middlewares/proxy";
import { PublicMiddleware, RawFsMiddleware, StaticMiddleware } from "./middlewares/static";
import { ErrorMiddleware } from "./middlewares/error";
import { SocketServer } from "./websocket";
import { logger } from "../logger";
import { SpaMiddleware } from "./middlewares/spa";
import { OpenEditorMiddleware } from "./middlewares/openEditor";
import { ModuleMap } from "./moduleMap";
import { IndexHtmlMiddleware } from "./middlewares/indexHtml";
import fs from "node:fs";
import path from "node:path";
import { PluginContainer } from "./pluginContainer";
import { TransformMiddleware } from "./middlewares/transform";
import { TransformRequester } from "./transformRequest";
import { normalizePath } from "../utils";
import { removePackageData } from "../package";
import { hmrFileAddUnlink, HMRType, hmrUpdate, parserHMRError } from "./hmr";
import { searchForWorkspaceRoot } from "../root";
import { BasePathMiddleware } from "./middlewares/basePath";
import { guid } from "@joker.front/shared";

const LOGTAG = "Server";

export interface ServerOptions extends HttpServerOptions {
    /** 热更新 */
    hmr?: boolean | { port?: number; host?: string };

    /**
     * 配置文件允许范围
     */
    fs?: FileSystemServeOptions;
}

export function resolveServerOpt(config: Partial<ResolvedConfig>) {
    let resolved: ServerOptions = {
        hmr: config.server?.hmr ?? true,
        fs: {
            strict: config.server?.fs?.strict ?? true,
            allow: config.server?.fs?.allow ?? []
        },
        ...config.server
    };

    resolved.fs?.allow?.unshift(normalizePath(searchForWorkspaceRoot(config.root!)));

    config.server = resolved;
}

export interface FileSystemServeOptions {
    /**
     * 严格限制文件访问超出允许的路径
     * 设置为'false'，则不做警告限制
     * @default true
     */
    strict?: boolean;

    /**
     * 允许访问的目录集合
     *
     * @default [workspace/root]
     */
    allow?: string[];
}

export class Server {
    public httpServer: HttpServer;

    public watcher: FSWatcher;

    public socketServer: SocketServer;

    public moduleMap: ModuleMap;

    public pluginContainer: PluginContainer;

    public transformRequester: TransformRequester;

    clientId = guid();
    constructor(public config: ResolvedConfig) {
        this.httpServer = new HttpServer(this.config.server, this.config.base);
        logger.debug(LOGTAG, "HTTP server initialized successfully");

        this.socketServer = new SocketServer(this, this.config.server);
        logger.debug(LOGTAG, "WebSocket server established successfully");

        this.watcher = chokidar.watch(this.config.root, {
            ignored: ["**/.vscode/**", "**/.git/**", "**/node_modules/**"],
            ignoreInitial: true,
            ignorePermissionErrors: true,
            disableGlobbing: true
        });
        logger.debug(LOGTAG, "File watcher initialized");

        this.pluginContainer = new PluginContainer(this.config);
        logger.debug(LOGTAG, "Plugin runtime container initialized");

        this.transformRequester = new TransformRequester(this);
        logger.debug(LOGTAG, "Request transformation handler initialized successfully");

        this.moduleMap = new ModuleMap(this, (id: string) => this.pluginContainer.resolveId(id, undefined, {}));
        logger.debug(LOGTAG, "Module dependency collection system initialized");

        //初始化事件
        this.initHandler();
        logger.debug(LOGTAG, "Public event registration completed");

        //初始化中间件
        this.initMiddleware();
        logger.debug(LOGTAG, "Middleware initialized successfully");

        this.config.depHandler.server = this;
    }

    private initHandler() {
        process.once("SIGTERM", async () => {
            try {
                await this.dispose();
            } finally {
                process.exit();
            }
        });

        //文件变更
        this.watcher.on("change", async (file) => {
            file = normalizePath(file);

            if (file.endsWith("/package.json")) {
                return removePackageData(this.config.packageCache, file);
            }

            this.moduleMap.disposeModuleByFile(file);

            if (this.config.server.hmr) {
                try {
                    await hmrUpdate(file, this);
                } catch (e: any) {
                    this.socketServer.send(new HMRType.Error(parserHMRError(e)));
                }
            }
        });

        //新增文件
        this.watcher.on("add", (file) => {
            hmrFileAddUnlink(normalizePath(file), this);
        });

        //删除文件
        this.watcher.on("unlink", (file) => {
            hmrFileAddUnlink(normalizePath(file), this);
        });

        //同步更新端口
        this.httpServer.app.once("listening", () => {
            let address = this.httpServer.server.address();

            if (typeof address !== "string") {
                this.config.server.port = address?.port;
            }
        });
    }

    private initMiddleware() {
        //代理中间件
        new ProxyMiddleware(this);

        //base地址转换
        new BasePathMiddleware(this);

        //打开编辑器处理中间件
        new OpenEditorMiddleware(this);

        //公共资源中间件
        new PublicMiddleware(this);

        //文件转换服务中间件，负责处理所有请求文件的编译、依赖采集
        new TransformMiddleware(this);

        //@fs处理中间件
        new RawFsMiddleware(this);

        //静态文件中间件
        new StaticMiddleware(this);

        //单页面处理中间件
        new SpaMiddleware(this);

        //html转换中间件
        new IndexHtmlMiddleware(this);

        //错误处理中间件
        new ErrorMiddleware(this);
    }

    public async start() {
        for (let plugin of this.config.plugins) {
            if (plugin.configureServer) {
                await plugin.configureServer(this);
            }
        }

        await this.pluginContainer.initOptions();

        await this.pluginContainer.start();

        await this.config.depHandler.init();

        await this.httpServer.start();
    }

    public addWatchFile(filePath: string | undefined) {
        /**
         * file地址存在 && 是指定root外的文件 && 不是\0-Map文件地址 && 文件存在
         * root外文件才参与监听，root内的文件在server启动时已经启动
         */
        if (
            filePath &&
            filePath.startsWith(this.config.root + "/") === false &&
            filePath.includes("\0") === false &&
            fs.existsSync(filePath)
        ) {
            this.watcher.add(path.resolve(filePath));
        }
    }

    private async dispose() {
        await Promise.all([
            this.watcher.close(),
            this.socketServer.dispose(),
            this.pluginContainer.close(),
            this.httpServer.close()
        ]);
    }
}
