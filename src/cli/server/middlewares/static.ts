import { Server } from "..";
import sirv, { RequestHandler } from "sirv";
import {
    fsPathFromId,
    fsPathFromUrl,
    getFileStat,
    isImportRequest,
    isInternalRequest,
    isParentDirectory,
    isWindows,
    normalizePath
} from "../../utils";
import type { NextFunction } from "connect";
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "http";

import { cleanUrl } from "@joker.front/shared";
import path from "node:path";
import { FS_PREFIX } from "../../config";
import { logger } from "../../logger";
const LOGTAG = "Static Server Middleware";
function sirvOptions(headers?: OutgoingHttpHeaders) {
    return {
        dev: true,
        etag: true,
        extensions: [],
        onNoMatch: (req: IncomingMessage, res: ServerResponse) => {
            logger.warn(LOGTAG, `${req.url} resource not matched`);
        },
        setHeaders: (res: ServerResponse, pathname: string) => {
            //如果是ts/js时
            if (/\.[tj]s$/.test(pathname)) {
                res.setHeader("Content-Type", "application/javascript");
            }

            if (headers) {
                for (let name in headers) {
                    res.setHeader(name, headers[name]!);
                }
            }
        }
    };
}

/**
 * 公共文件处理中间件
 */
export class PublicMiddleware {
    private sirvServer?: RequestHandler;
    constructor(protected server: Server) {
        if (this.server.config.publicDir) {
            this.sirvServer = sirv(this.server.config.publicDir, sirvOptions(this.server.config.server.headers));

            this.server.httpServer.app.use(this.exec.bind(this));

            logger.debug(LOGTAG, "Public Resource Service Middleware initialized successfully");
        }
    }
    exec(req: IncomingMessage, res: ServerResponse, next: NextFunction): void {
        //如果是import语法请求 || 内部链接，不使用静态文件处理，向下传递，使用transform
        if (isImportRequest(req.url!) || isInternalRequest(req.url!)) {
            return next();
        }

        this.sirvServer?.(req, res, next);
    }
}

export class StaticMiddleware {
    private sirvServer: RequestHandler;

    constructor(protected server: Server) {
        this.sirvServer = sirv(this.server.config.root, sirvOptions(this.server.config.server?.headers));

        this.server.httpServer.app.use(this.exec.bind(this));

        logger.debug(LOGTAG, "Static Resource Service initialized successfully");
    }
    exec(req: IncomingMessage, res: ServerResponse, next: NextFunction): void {
        let cleanedUrl = cleanUrl(req.url!);

        //无固定指向 ｜｜ html文件｜｜内部链接
        if (cleanedUrl.endsWith("/") || path.extname(cleanedUrl) === ".html" || isInternalRequest(req.url!)) {
            return next();
        }

        //这里不再考虑alias地址域简写/重写的概念
        //原因：1. 不方便转到定义  2.后续有可视化工具

        let url = decodeURIComponent(req.url!);
        let fileUrl = path.resolve(this.server.config.root, url.replace(/^\//, ""));
        if (url.endsWith("/") && fileUrl.endsWith("/") === false) {
            fileUrl += "/";
        }

        if (ensureServingAccess(fileUrl, this.server, res, next) === false) {
            return;
        }

        this.sirvServer?.(req, res, next);
    }
}

export class RawFsMiddleware {
    private sirvServer: RequestHandler;

    constructor(protected server: Server) {
        this.sirvServer = sirv("/", sirvOptions(this.server.config.server?.headers));

        this.server.httpServer.app.use(this.exec.bind(this));

        logger.debug(LOGTAG, "FS Middleware processing initialized successfully");
    }

    exec(req: IncomingMessage, res: ServerResponse, next: NextFunction): void {
        let url = decodeURIComponent(req.url!);

        if (url.startsWith(FS_PREFIX)) {
            let fsPath = path.resolve(fsPathFromId(url));

            if (ensureServingAccess(fsPath, this.server, res, next) === false) {
                return;
            }

            url = url.slice(FS_PREFIX.length);

            if (isWindows) {
                url = url.replace(/^[A-Z]:/i, "");
            }

            req.url = url;

            this.sirvServer(req, res, next);
        } else {
            next();
        }
    }
}

/**
 * 是否允许资源范围
 * @param url
 * @param server
 * @returns
 */
export function isFileServingAllowed(url: string, server: Server): boolean {
    if (!server.config.server.fs?.strict) return true;

    let file = fsPathFromUrl(url);

    if (server.config.server.fs.allow?.some((dir) => isParentDirectory(dir, file))) {
        return true;
    }

    return false;
}

function ensureServingAccess(url: string, server: Server, res: ServerResponse, next: NextFunction): boolean {
    if (isFileServingAllowed(url, server)) {
        return true;
    }

    if (getFileStat(cleanUrl(url))) {
        let warnMessage = [
            `The request: ${url} exceeds the allowed scope, please check!`,
            `Currently configured allowed request scopes include: ${server.config.server.fs?.allow
                ?.map((i) => i)
                .join(",")}`,
            `If you want to allow this resource request, you can configure the fs.strict or fs.allow properties for fine-grained control`
        ].join("\n");

        logger.warn(LOGTAG, warnMessage);

        res.statusCode = 403;
        res.write(renderRestrictedErrorHtml(warnMessage), "utf-8");
        res.end();
    } else {
        //文件不存在 交由error 中间件处理
        next();
    }

    return false;
}

function renderRestrictedErrorHtml(msg: string): string {
    return `<body><h1>403 Forbidden</h1><p>${msg.replace(
        /\n/g,
        "<br/>"
    )}</p><style>body{padding:1em 2em;}</style></body>`;
}
