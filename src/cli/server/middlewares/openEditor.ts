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
                res.end(`缺失file地址，无法打开目标文件`);
            } else {
                launch(file);
                res.end();
            }
        });

        logger.debug(LOGTAG, "打开编辑器服务中间件初始化完成");
    }
}
