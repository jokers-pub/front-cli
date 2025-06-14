import type { NextFunction } from "connect";
import type * as http from "node:http";
import type * as net from "node:net";
import { Server } from "..";
import HttpProxy from "http-proxy";
import { logger } from "../../logger";
import { HMR_HEADER_TAG } from "../websocket";

const LOGTAG = "proxy";

export interface ProxyOptions extends HttpProxy.ServerOptions {
    /**
     * 重写地址
     * @param path
     * @returns
     */
    rewrite?: (path: string) => string;
}

/**
 * 请求代理中间件
 */
export class ProxyMiddleware {
    private proxies: Record<string, [HttpProxy, ProxyOptions]> = {};

    constructor(protected devServer: Server) {
        if (this.devServer.config.server?.proxy) {
            this.initProxy();

            this.devServer.httpServer.app.use(this.exec.bind(this));

            logger.debug(LOGTAG, "Proxy Service Middleware initialization completed");
        }
    }

    private initProxy() {
        let proxyOptions = this.devServer.config.server.proxy || {};

        Object.keys(proxyOptions).forEach((key) => {
            let opt = proxyOptions[key];

            if (typeof opt === "string") {
                opt = { target: opt, changeOrigin: true };
            }

            let proxy = HttpProxy.createProxyServer(opt);

            proxy.on("error", (err, _, originalRes) => {
                let res = originalRes as http.ServerResponse | net.Socket;

                if ("req" in res) {
                    logger.error(LOGTAG, `Proxy request error occurred`, err);

                    if (!res.writableEnded) {
                        // eslint-disable-next-line @typescript-eslint/naming-convention
                        res.writeHead(500, { "Content-Type": "text/plain" }).end();
                    }
                } else {
                    logger.error(LOGTAG, `WebSocket proxy error occurred`, err);

                    res.end();
                }
            });

            this.proxies[key] = [proxy, { ...opt }];
        });

        this.devServer.httpServer.server.on("upgrade", (req, socket, head) => {
            let url = req.url!;

            for (let key in this.proxies) {
                if (this.checkProxyContextMatchUrl(key, url)) {
                    let [proxy, opt] = this.proxies[key];

                    //如果是ws代理，并且不是hmr代理
                    if (
                        (opt.ws || opt.target?.toString().startsWith("ws:")) &&
                        req.headers["sec-websocket-protocol"] !== HMR_HEADER_TAG
                    ) {
                        if (opt.rewrite) {
                            req.url = opt.rewrite(url);
                        }

                        logger.debug(LOGTAG, `Proxy request redirected: ${req.url} -> ws ${opt.target}`);

                        proxy.ws(req, socket, head);
                        return;
                    }
                }
            }
        });
    }

    private checkProxyContextMatchUrl(key: string, url: string): boolean {
        return (key.startsWith("^") && new RegExp(key).test(url)) || url.startsWith(key);
    }

    exec(req: http.IncomingMessage, res: http.ServerResponse, next: NextFunction): void {
        let url = req.url!;

        for (let key in this.proxies) {
            if (this.checkProxyContextMatchUrl(key, url)) {
                let [proxy, opt] = this.proxies[key];

                if (opt.rewrite) {
                    req.url = opt.rewrite(url);
                }

                let target = (opt.target || opt.forward) as string;
                let reqUrl = req.url;
                if (target.endsWith("/")) {
                    target = target.slice(0, -1);
                }

                if (reqUrl?.startsWith("/")) {
                    reqUrl = reqUrl.substring(1);
                }
                logger.info(LOGTAG, `${url} -> ${target}/${reqUrl}`);

                proxy.web(req, res);
                return;
            }
        }

        next();
    }
}
