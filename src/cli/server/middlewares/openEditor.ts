import { Server } from "..";
import { logger } from "../../logger";
import url from "node:url";
import launch from "launch-editor";

const LOGTAG = "openEditor";

/**
 * 请求代理中间件
 */
export class OpenEditorMiddleware {
    constructor(protected server: Server) {
        this.server.httpServer.app.use("/__open-in-editor", (req, res) => {
            const { file } = url.parse(req.url || "", true).query || {};
            if (!file) {
                res.statusCode = 500;
                res.end(`Missing file address, unable to open target file`);
            } else {
                launch(file);
                res.end();
            }
        });

        logger.debug(LOGTAG, "Editor Service Middleware initialization completed");
    }
}
