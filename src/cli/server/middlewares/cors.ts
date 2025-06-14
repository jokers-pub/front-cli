import { Server } from "..";
import corsMiddleware from "cors";
import { logger } from "../../logger";

const LOGTAG = "CORS Middleware";
/**
 * cors 跨域处理中间件
 */
export class CorsMiddleware {
    constructor(protected server: Server) {
        if (this.server.config.server?.cors) {
            this.server.httpServer.app.use(
                corsMiddleware(
                    typeof this.server.config.server.cors === "boolean" ? {} : this.server.config.server.cors
                )
            );

            logger.debug(LOGTAG, "Initialization completed");
        }
    }
}
