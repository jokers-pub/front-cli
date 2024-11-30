import { Server } from "..";
import fs from "node:fs";
import type { NextFunction } from "connect";
import history, { Context } from "connect-history-api-fallback";
import path from "node:path";
import { logger } from "../../logger";

const LOGTAG = "Spa-Middleware";
/**
 * 单页面处理中间件
 * 主要处理路由空重定向html
 */
export class SpaMiddleware {
    constructor(protected server: Server) {
        //URL重写
        this.server.httpServer.app.use(this.urlRewrite.bind(this));

        logger.debug(LOGTAG, "spa单页面处理中间件初始化完成");
    }

    urlRewrite(req: any, res: any, next: NextFunction) {
        let self = this;
        return history({
            rewrites: [
                {
                    from: /\/$/,
                    to({ parsedUrl }: Context) {
                        let rePath = decodeURIComponent(parsedUrl.pathname || "") + "index.html";

                        let fileRelPath = path.join(self.server.config.root || "", rePath);
                        if (fs.existsSync(fileRelPath) === false) {
                            logger.debug(LOGTAG, `未找到对应的${fileRelPath}将按照默认地址重定向：${rePath}`);
                            rePath = "/index.html";
                        }

                        logger.debug(LOGTAG, `地址重定向：${rePath}`);
                        return rePath;
                    }
                }
            ]
        })(req, res, next);
    }
}
