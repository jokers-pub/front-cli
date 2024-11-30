import { Server } from "..";
import type { IncomingMessage, ServerResponse } from "http";
import { NextFunction } from "connect";
import { stripBase } from "@joker.front/shared";

/**
 * Server 模式下的 base地址处理
 */
export class BasePathMiddleware {
    constructor(protected server: Server) {
        if (server.config.base && server.config.base !== "/") {
            this.server.httpServer.app.use(this.exec.bind(this));
        }
    }

    exec(req: IncomingMessage, res: ServerResponse, next: NextFunction) {
        let url = req.url!;
        let base = this.server.config.base;
        if (url.startsWith(base)) {
            req.url = stripBase(url, base);
        }

        if (req.url!.startsWith("/") === false) {
            req.url = "/" + req.url;
        }

        return next();
    }
}
