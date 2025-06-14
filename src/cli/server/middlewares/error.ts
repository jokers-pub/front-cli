import type { NextFunction } from "connect";
import type * as http from "node:http";
import { Server } from "..";
import { logger } from "../../logger";
import { clearnStack } from "../../utils";
import { HMRType, parserHMRError } from "../hmr";

const LOGTAG = "Error Middleware";
//引用https://github.com/chalk/strip-ansi
function strip(str: string) {
    const pattern = [
        "[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)",
        "(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))"
    ].join("|");
    let reg = new RegExp(pattern, "g");
    return str.replace(reg, "");
}

function transformError(err: Error) {
    return {
        message: strip(err.message),
        stack: strip(clearnStack(err.stack || ""))
    };
}

/**
 * 错误处理中间件
 */
export class ErrorMiddleware {
    constructor(protected server: Server) {
        this.server.httpServer.app.use(this.error404.bind(this));

        this.server.httpServer.app.use(this.errorMain.bind(this));
        logger.debug(LOGTAG, "404 and exception handling initialization completed");
    }

    errorMain(err: any, req: http.IncomingMessage, res: http.ServerResponse, next: NextFunction): void {
        res.statusCode = 500;

        //spa下的错误广播
        this.server.socketServer.send(new HMRType.Error(parserHMRError(err)));
        //渲染单条网络数据错误
        res.end(`
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Error</title>
<script type="module">
import { createErrorOverlay } from '/@joker.front/client';
createErrorOverlay(${JSON.stringify(transformError(err)).replace(/</g, "\\u003c")})
</script>
</head>
</html>
`);
    }

    error404(req: http.IncomingMessage, res: http.ServerResponse) {
        if (req.url?.startsWith("/.well-known/appspecific/com.chrome.devtools.json")) {
            res.statusCode = 204;
            res.end();
            return;
        }

        res.statusCode = 404;
        res.end();

        if (req.url?.endsWith("/favicon.ico") === false) {
            logger.error(LOGTAG, req.url + " resource not found, returning 404 status");
        }
    }
}
