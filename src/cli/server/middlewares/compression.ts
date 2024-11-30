import zlib from "node:zlib";
import type { NextFunction } from "connect";
import type * as http from "node:http";
import { Server } from "..";
import { logger } from "../../logger";

/**媒体类型 */
const MIMES_RE = /text|javascript|\/json|xml/i;
/**阀值 */
const THRESHOLD = 1024;
/**压缩等级 */
const LEVE = -1;
const LOGTAG = "压缩中间件";

export class CompressionMiddleware {
    constructor(server: Server) {
        server.httpServer.app.use(this.exec.bind(this));

        logger.debug(LOGTAG, `zlib中间件已初始化`);
    }

    exec(req: http.IncomingMessage, res: http.ServerResponse, next: NextFunction): void {
        let accept = req.headers["accept-encoding"] + "";
        let encoding = accept.match(/\bgiz\b/)?.[0] || "";

        //没有response || 没有encoding的 不做压缩处理
        if (req.method === "HEAD" || !encoding) return next();

        let pendingStatus: number;
        let size: number = 0;
        let started = false;
        let pendingListeners: Set<[string, (...args: any[]) => void]> | undefined = new Set();
        let compress: zlib.BrotliCompress;

        function start() {
            started = true;

            // @ts-ignore
            size = res.getHeader("Content-Length") | 0 || size;

            let compressible = MIMES_RE.test(String(res.getHeader("Content-Type") || "text/plain"));

            let clearText = !res.getHeader("Content-Encoding");
            let listeners = pendingListeners || new Set();

            if (compressible && clearText && size >= THRESHOLD) {
                res.setHeader("Content-Encoding", encoding);
                res.removeHeader("Content-Length");

                if (encoding === "br") {
                    let params = {
                        [zlib.constants.BROTLI_PARAM_QUALITY]: LEVE,
                        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: size
                    };

                    compress = zlib.createBrotliCompress({
                        params
                    });
                } else {
                    compress = zlib.createGzip({
                        level: LEVE
                    });
                }

                compress.on("data", (chunk) => {
                    //@ts-ignore
                    return res.write.call(res, chunk) === false && compress.pause();
                });

                res.on.call(res, "drain", () => compress.resume());
                //@ts-ignore
                compress.on("end", () => res.end.call(res));
                listeners.forEach((l) => compress.on.apply(compress, l));
            } else {
                pendingListeners = undefined;
                listeners.forEach((l) => res.on.apply(res, l));
            }

            res.writeHead.call(res, pendingStatus || res.statusCode);
        }

        //@ts-ignore
        res.writeHead = function (statusCode, statusMessage, headers) {
            if (typeof statusMessage !== "string") {
                [statusMessage, headers] = [headers as any, statusMessage];
            }

            if (headers) {
                if (Array.isArray(headers)) {
                    for (let i in headers) {
                        res.setHeader(i, headers[i]);
                    }
                } else {
                    for (let key in headers) {
                        res.setHeader(key, headers[key] ?? "");
                    }
                }
            }

            pendingStatus = statusCode;
            return this;
        };

        //@ts-ignore
        res.write = function (chunk, encoding, callback): boolean {
            if (typeof encoding === "function") {
                [encoding, callback] = [callback as any, encoding];
                encoding = encoding as BufferEncoding;
            }

            size += getChunkSize(chunk, encoding);

            if (started === false) {
                start();
            }

            if (!compress) {
                //@ts-ignore
                return res.write.apply(this, arguments);
            }

            //@ts-ignore
            return compress.write.apply(compress, arguments);
        };

        //@ts-ignore
        res.end = function (chunk, encoding, callback) {
            if (arguments.length > 0 && typeof chunk !== "function") {
                size += getChunkSize(chunk, encoding);
            }

            if (typeof encoding === "function") {
                [encoding, callback] = [callback as any, encoding];
                encoding = encoding as BufferEncoding;
            }

            if (!started) start();

            //@ts-ignore
            if (!compress) return res.end.apply(this, arguments);

            //@ts-ignore
            return compress.end.apply(compress, arguments);
        };

        res.on = function (type, listener) {
            if (!pendingListeners || type !== "drain") {
                res.on.call(this, type, listener);
            } else if (compress) {
                compress.on(type, listener);
            } else {
                pendingListeners.add([type, listener]);
            }
            return this;
        };

        next();
    }
}

function getChunkSize(chunk: any, enc?: BufferEncoding): number {
    return chunk ? Buffer.byteLength(chunk, enc) : 0;
}
