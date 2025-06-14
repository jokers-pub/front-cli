import { Server } from "..";
import type { IncomingMessage, ServerResponse } from "http";
import type { NextFunction } from "connect";
import {
    addUrlQuery,
    fsPathFromId,
    isCssRequest,
    isDepRequest,
    isDirectRequest,
    isImportRequest,
    isJSRequest,
    normalizePath,
    unwarpId,
    removeImportQuery,
    removeTimestampQuery
} from "../../utils";
import { FS_PREFIX, NULL_BYTE_PLACHOLDER } from "../../config";
import { cleanUrl } from "@joker.front/shared";
import path from "node:path";
import fs from "node:fs";
import { logger } from "../../logger";
import colors from "picocolors";
import { isHtmlProxy } from "../../plugins/html";
import { ERR_OUTDATED_RESOLVED_DEP, ERR_RESOLVE_DEP_PROCESSING_ERROR } from "../../plugins/resolveDep";
import { HMRType, parserHMRError } from "../hmr";
//空指向 ｜｜ 图标（转static中间件处理）
const IG_FILE_LIST = new Set(["/", "/favicon.ico"]);
const LOGTAG = "Request Transformation";

/**
 * 文件转换服务中间件，负责处理所有请求文件的编译、依赖采集
 */
export class TransformMiddleware {
    constructor(protected server: Server) {
        this.server.httpServer.app.use(this.exec.bind(this));
        logger.debug(LOGTAG, `Transformer initialized. This is the entry point for all file transformers`);
    }

    async exec(req: IncomingMessage, res: ServerResponse, next: NextFunction): Promise<void> {
        //这里只处理get请求，所有资源加载都是get请求
        if (req.url === undefined || (req.method || "").toUpperCase() !== "GET" || IG_FILE_LIST.has(req.url)) {
            return next();
        }

        let url = decodeURI(removeTimestampQuery(req.url)).replace(NULL_BYTE_PLACHOLDER, "\0");

        let cleanedUrl = cleanUrl(url);

        logger.debug(LOGTAG, `Request received: ${cleanedUrl} => ${req.url}`);

        if (cleanedUrl.endsWith(".map")) {
            await this.execMapFile(url, req, res, next);
            return;
        }

        let rootDir = normalizePath(this.server.config.root);

        //如果有public目录，则做合法性验证
        if (this.server.config.publicDir) {
            let publicDir = normalizePath(this.server.config.publicDir);

            let publicPath = publicDir.slice(rootDir.length) + "/";

            //如果是public资源
            //解析后的publicPath 不等于'/' 若等于/ 则代表 public 和root 跨目录了
            if (publicPath !== "/" && url.startsWith(publicPath)) {
                /**
                 * public的文件全部是静态资源，不做编译，会做拷贝使用
                 * 所以目录下不应该存在publicDir，不应该去直接使用
                 */
                if (isImportRequest(url)) {
                    let realPath = removeImportQuery(url);

                    logger.warn(
                        LOGTAG,
                        `${realPath}: This resource is located within the public directory and should not be referenced using imports. Please move this file to the src development directory.`
                    );
                } else {
                    logger.warn(
                        LOGTAG,
                        `A file request was detected containing the publicDir path in the request URL. Please use ${colors.cyan(
                            url.replace(publicPath, "/")
                        )} instead of the current ${colors.cyan(url)}`
                    );
                }
            }
        }

        if (isJSRequest(url) || isImportRequest(url) || isCssRequest(url) || isHtmlProxy(url)) {
            url = removeImportQuery(url);

            //去除id标记，通过import分析插件添加的标记
            url = unwarpId(url);

            //为css类型文件请求 && 没有具备direct的链接添加 direct特性
            if (isCssRequest(url) && isDirectRequest(url) === false && req.headers.accept?.includes("text/css")) {
                url = addUrlQuery(url, "direct");
            }

            //检查下 我们是否可以按304状态提前返回
            let ifNoneMatch = req.headers["if-none-match"];

            //如果有并且和moduleMap中缓存的etag一致，则不做转换，直接返回304走缓存
            if (
                ifNoneMatch &&
                (await this.server.moduleMap.getModuleByUrl(url))?.transformResult?.etag === ifNoneMatch
            ) {
                logger.debug(LOGTAG, `${url} unchanged, using cached 304 response`);
                res.statusCode = 304;
                res.end();
                return;
            }

            try {
                let result = await this.server.transformRequester.request(
                    url,
                    req.headers.accept?.includes("text/html")
                );

                if (result && "code" in result) {
                    let type = isCssRequest(url) && isDirectRequest(url) ? "css" : "js";
                    let isDep = isDepRequest(url) || this.server.config.depHandler?.isResolvedDepUrl(url);

                    return this.server.httpServer.send(req, res, result.code, type, {
                        etag: result.etag,
                        cacheControl: isDep ? "max-age=31536000,immutable" : "no-cache",
                        headers: this.server.config.server.headers,
                        map: result.map
                    });
                } else {
                    if (!res.writableEnded) {
                        res.statusCode = 404;
                        res.end();
                    }
                    return;
                }
            } catch (e: any) {
                //未知名错误，尝试容错处理
                if (e === undefined) return;

                if (e.code === ERR_RESOLVE_DEP_PROCESSING_ERROR) {
                    if (!res.writableEnded) {
                        res.statusCode = 504;
                        res.end();
                    }

                    logger.error(LOGTAG, e.message);
                    return;
                }

                if (e.code === ERR_OUTDATED_RESOLVED_DEP) {
                    if (!res.writableEnded) {
                        res.statusCode = 504;
                        res.end();
                    }

                    return;
                }

                logger.error(LOGTAG, "Transformation failed", e);

                this.server.socketServer.send(new HMRType.Error(parserHMRError(e)));

                next(e);
                return;
            }
        }
        next();
    }

    private async execMapFile(url: string, req: IncomingMessage, res: ServerResponse, next: NextFunction) {
        //在cacheDep内的map文件，走systemFile模式
        if (this.server.config.depHandler?.isResolvedDepUrl(url)) {
            let mapPath = url.startsWith(FS_PREFIX)
                ? fsPathFromId(url)
                : normalizePath(path.resolve(this.server.config.root, url.slice(1)));
            let mapContent: string;
            try {
                mapContent = fs.readFileSync(mapPath, "utf-8");
            } catch (e) {
                //返回空map，避免异常处理
                mapContent = JSON.stringify({
                    version: 3,
                    file: mapPath.replace(/\.map$/, ""),
                    sources: [],
                    sourcesContent: [],
                    names: [],
                    mappings: ";;;;;;;;;"
                });
            }

            return this.server.httpServer.send(req, res, mapContent, "json", {
                headers: this.server.config.server.headers
            });
        } else {
            //不在cacheDep文件内，走moduleMap模式

            //结尾是map或？，截取到扩展前面内容
            let originalUrl = url.replace(/\.map($|\?)/, "$1");

            let mapContent = (await this.server.moduleMap.getModuleByUrl(originalUrl))?.transformResult?.map;

            if (mapContent) {
                return this.server.httpServer.send(req, res, JSON.stringify(mapContent), "json", {
                    headers: this.server.config.server.headers
                });
            } else {
                return next();
            }
        }
    }
}
