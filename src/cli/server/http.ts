import type { ServerOptions as HttpsServerOptions } from "node:https";
import Connect from "connect";
import https from "node:https";
import http, { OutgoingHttpHeaders } from "node:http";
import http2 from "node:http2";
import fs from "fs";
import path from "node:path";
import colors from "picocolors";
import os from "node:os";
import type { CorsOptions } from "cors";
import getEtag from "etag";
import type * as net from "node:net";
import { ProxyOptions } from "./middlewares/proxy";
import { DEFAULT_SERVER_PORT } from "../config";
import { getCodeWithSourcemap, LOOPBACK_HOSTS, openBrowser, transformHostName } from "../utils";
import { logger } from "../logger";
import type { SourceMap } from "rollup";

const LOGTAG = "Http";

// eslint-disable-next-line @typescript-eslint/naming-convention
const ResourceContentTypeMap: Record<string, string> = {
    js: "application/javascript",
    css: "text/css",
    html: "text/html",
    json: "application/json"
};

export type SendOptions = {
    etag?: string;
    cacheControl?: string;
    headers?: http.OutgoingHttpHeaders;
    map?: SourceMap | null;
};

export type HttpServerOptions = {
    /** 服务端口 */
    port?: number;

    /** 服务hostName */
    host?: string;
    /**
     * 是否打开浏览器，可设置自定义打开的地址
     */
    open?: boolean | string;
    /**
     * 是否启用https，https的配置
     */
    https?: boolean | HttpsServerOptions;
    /**
     * 跨域处理配置
     */
    cors?: boolean | CorsOptions;

    headers?: OutgoingHttpHeaders;
    /**
     * 请求代理配置
     */
    proxy?: Record<string, string | ProxyOptions>;
};

type HostName = {
    host: string;
    name: string;
};

export class HttpServer {
    public server: http.Server;

    public app: Connect.Server;

    public hostName?: HostName;

    public sockets = new Set<net.Socket>();

    public hasListened: boolean = false;
    private customPort = false;
    public resolveUrls: { local: string[]; network: string[] } = {
        local: [],
        network: []
    };

    constructor(private config: HttpServerOptions = {}, private basePath?: string) {
        this.app = Connect();

        this.initDefaultValue();

        if (config.https) {
            config.https = this.resolveHttpsServerConfig(typeof config.https === "boolean" ? {} : config.https);

            if (config.proxy) {
                this.server = https.createServer(config.https, this.app);
            } else {
                this.server = http2.createSecureServer(
                    {
                        ...config.https,
                        maxSessionMemory: 1000,
                        allowHTTP1: true
                    },
                    this.app as any
                ) as unknown as http.Server;
            }
        } else {
            this.server = http.createServer(this.app);
        }

        this.initHandler();
    }

    public async start() {
        //启动时再去转换hostName
        this.hostName = await transformHostName(this.config.host);

        new Promise((resolve, reject) => {
            let onStartError = (e: Error & { code?: string }) => {
                //网络地址使用错误
                if (e.code === "EADDRINUSE") {
                    if (this.customPort) {
                        logger.error(
                            LOGTAG,
                            `Port ${this.config.port} is already in use. Please modify the port property.`
                        );
                        this.server.removeListener("error", onStartError);
                        reject(e.code);
                    } else {
                        logger.debug(LOGTAG, `Port ${this.config.port} is occupied, attempting to use another port`);
                        this.config.port!++;
                        this.server.listen(this.config.port, this.hostName?.host);
                    }
                } else {
                    logger.error(LOGTAG, e.message);
                    this.server.removeListener("error", onStartError);
                    reject(e.code);
                }
            };

            this.server.on("error", onStartError);

            this.server.listen(this.config.port, this.hostName?.host, async () => {
                this.server.off("error", onStartError);

                await this.resolveServerUrls();

                resolve(true);

                let path = typeof this.config.open === "string" ? this.config.open : this.basePath ?? "";
                let url = path.startsWith("http")
                    ? path
                    : `${this.config.https ? "https" : "http"}://${this.hostName?.name}:${this.config.port}${path}`;

                if (this.config.open) {
                    openBrowser(url);
                }

                //打印可用服务地址
                this.printServerUrls();

                logger.debug(LOGTAG, `Service started at ${url}`);
            });
        });
    }

    public async resolveServerUrls() {
        let address = this.server.address();

        if (typeof address === "string" || address === null) {
            return;
        }

        let protocol = this.config.https ? "https" : "http";
        let port = address.port;
        let base = this.basePath === "./" || this.basePath === "" ? "/" : this.basePath;
        //不再更新hostName，执行地址解析时，一定是触发完start

        if (this.hostName?.host && LOOPBACK_HOSTS.includes(this.hostName.host)) {
            let hostnameName = this.hostName.name;

            if (hostnameName === "::1" || hostnameName === "0000:0000:0000:0000:0000:0000:0000:0001") {
                hostnameName = `[${hostnameName}]`;
            }

            this.resolveUrls.local.push(`${protocol}://${hostnameName}:${port}${base}`);
        } else {
            Object.values(os.networkInterfaces())
                .flatMap((m) => m ?? [])
                .filter((item) => item && item.address && typeof item.family === "string" && item.family === "IPv4")
                .forEach((m) => {
                    let host = m.address.replace("127.0.0.1", this.hostName?.name || "");

                    let url = `${protocol}://${host}:${port}${base}`;

                    if (m.address.includes("127.0.0.1")) {
                        this.resolveUrls.local.push(url);
                    } else {
                        this.resolveUrls.network.push(url);
                    }
                });
        }
    }

    public send(
        req: http.IncomingMessage,
        res: http.ServerResponse,
        content: string | Buffer,
        type: string,
        options: SendOptions = {}
    ) {
        let { etag = getEtag(content), cacheControl = "no-cache", headers } = options;

        if (res.writableEnded) {
            return;
        }

        //缓存设定
        if (req.headers["if-none-match"] === etag) {
            res.statusCode = 304;
            res.end();
            return;
        }

        res.setHeader("Content-Type", ResourceContentTypeMap[type] || type);
        res.setHeader("Cache-Control", cacheControl);
        res.setHeader("Etag", etag);

        if (headers) {
            for (let name in headers) {
                res.setHeader(name, headers[name]!);
            }
        }

        if (options.map && options.map.mappings) {
            if (type === "js" || type === "css") {
                content = getCodeWithSourcemap(type, content.toString(), options.map);
            }
        }

        res.statusCode = 200;
        res.end(content);
    }

    public async close() {
        await new Promise<void>((resolve, reject) => {
            this.sockets.forEach((sc) => sc.destroy());

            if (this.hasListened) {
                this.server.close((err) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve();
                    }
                });
            } else {
                resolve();
            }
        });
    }

    public printServerUrls() {
        if (this.resolveUrls.local.length === 0 && this.resolveUrls.network.length === 0) {
            logger.error(LOGTAG, "No available service address found. The server may not have started correctly.");
            return;
        }

        let printColor = (url: string) => {
            return colors.cyan(url.replace(/:(\d+)\//, (_, port) => `:${colors.bold(port)}/`));
        };

        for (let url of this.resolveUrls.local) {
            logger.info(LOGTAG, `${colors.green("➡️")}   ${colors.bold("Local:")}    ${printColor(url)}`);
        }

        for (let url of this.resolveUrls.network) {
            logger.info(LOGTAG, `${colors.green("➡️")}   ${colors.bold("Network:")}    ${printColor(url)}`);
        }

        if (this.resolveUrls.network.length === 0 && this.config.host === undefined) {
            logger.info(
                LOGTAG,
                `${colors.dim("➡️")}   ${colors.bold("Network:")}    Host not specified. Configure with ${colors.white(
                    colors.bold("--host")
                )}`
            );
        }
    }

    private initHandler() {
        this.server.on("connection", (socket) => {
            this.sockets.add(socket);

            socket.on("close", () => {
                this.sockets.delete(socket);
            });
        });

        this.server.on("listening", () => {
            this.hasListened = true;
        });
    }

    private initDefaultValue() {
        if (this.config.port) {
            this.customPort = true;
        }
        this.config.port = this.config.port ?? DEFAULT_SERVER_PORT;
    }

    private resolveHttpsServerConfig(httpsServerOptions: HttpsServerOptions) {
        let httpsOption = { ...httpsServerOptions };

        Object.assign(httpsOption, {
            ca: this.readHttpsCertContent(httpsOption.ca),
            cert: this.readHttpsCertContent(httpsOption.cert),
            key: this.readHttpsCertContent(httpsOption.key),
            pfx: this.readHttpsCertContent(httpsOption.pfx)
        });

        return httpsOption as HttpsServerOptions;
    }

    private readHttpsCertContent(value?: string | Buffer | any[]) {
        if (typeof value === "string") {
            try {
                return fs.readFileSync(path.resolve(value));
            } catch (e) {
                return value;
            }
        }
        return value;
    }
}
