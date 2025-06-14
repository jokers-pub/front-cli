import { ServerOptions } from ".";
import { WebSocket, WebSocketServer, ServerOptions as WsServerOptions } from "ws";
import { HMRType } from "./hmr";
import { logger } from "../logger";
import { DEFAULT_WS_PORT } from "../config";
import { sleep } from "@joker.front/shared";

export const HMR_HEADER_TAG = "joker-hmr";
const LOGTAG = "Websocket";

export class SocketServer {
    private wss: WebSocketServer;

    //使用weakmap，将按CG回收，只做映射，不做真实数据
    private clientMaps = new WeakMap<WebSocket, WebSocketClient>();

    public wsOption: WsServerOptions = {};

    public readonly timeout = 30000;

    private customPort = false;

    constructor(config: ServerOptions = {}) {
        if (config.hmr) {
            let hmrOption = typeof config.hmr === "boolean" ? {} : config.hmr;
            if (hmrOption.port) {
                this.customPort = true;
            }
            this.wsOption.port = hmrOption.port || DEFAULT_WS_PORT;
            this.wsOption.host = hmrOption.host || undefined;

            this.wss = new WebSocketServer(this.wsOption);
            logger.debug(LOGTAG, `WebSocket created: ${JSON.stringify(this.wsOption)}`);
        } else {
            this.wss = new WebSocketServer({ noServer: true });
            logger.warn(LOGTAG, "HMR disabled, using standalone WebSocket middleware");
        }
        this.initHandler();
    }

    public get clients() {
        return Array.from(this.wss.clients).map((m) => this.getSocketClient(m));
    }

    public async send(v1: HMRType.All | string, data?: any) {
        let hmr: HMRType.All;
        if (typeof v1 === "string") {
            hmr = new HMRType.Custom(v1, data);
        } else {
            hmr = v1;
        }

        let result = JSON.stringify(hmr);

        if (v1 instanceof HMRType.Connected === false) {
            //睡眠200ms，预留ws握手时间
            await sleep(200);
        }
        this.wss.clients.forEach((m) => {
            if (m.readyState === 1) {
                m.send(result);
            }
        });
    }

    public dispose(): Promise<any> {
        return new Promise((resolve, reject) => {
            this.wss.clients.forEach((m) => {
                m.terminate();
            });

            this.wss.close((err) => {
                if (err) {
                    reject();
                } else {
                    resolve(true);
                }
            });
        });
    }

    private initHandler() {
        this.wss.on("upgrade", (req, socket, head) => {
            //如果是hmr时，区分其余代理请求
            if (req.headers["sec-websocket-protocol"] === HMR_HEADER_TAG) {
                this.wss.handleUpgrade(req, socket, head, (ws) => {
                    ws.emit("connection", ws, req);
                });
            }
        });

        this.wss.on("connection", (socket) => {
            socket.on("message", (strData) => {
                // let data: any;
                // try {
                //     data = JSON.parse(String(strData));
                // } catch (e) {}
                // //不符合规则排除
                // if (!data || data.type !== "custom" || !data.event) return;
                //这里可以做扩展
            });

            socket.send(JSON.stringify(new HMRType.Connected()));
        });

        this.wss.on("error", (e: Error & { code: string }) => {
            if (e.code === "EADDRINUSE") {
                if (this.customPort) {
                    throw new Error(
                        `WebSocket port ${this.wsOption.port} is already in use. Configure config.hmr.port to change the HMR port.`
                    );
                }
                logger.debug(LOGTAG, `WebSocket port ${this.wsOption.port} is occupied. Trying alternative ports...`);

                this.wss.removeAllListeners();
                this.wss.close(() => {
                    this.wsOption.port!++;

                    this.wss = new WebSocketServer(this.wsOption);
                    this.initHandler();
                });
            } else {
                logger.error(LOGTAG, `WebSocket error:\n${e.stack || e.message}`);
            }
        });
    }

    private getSocketClient(socket: WebSocket) {
        if (this.clientMaps.has(socket) === false) {
            this.clientMaps.set(socket, {
                send: () => {
                    let hmrData: HMRType.All;
                    if (typeof arguments[0] === "string") {
                        hmrData = new HMRType.Custom(arguments[0], arguments[1]);
                    } else {
                        hmrData = arguments[0];
                    }

                    socket.send(JSON.stringify(hmrData));
                },
                socket
            });
        }

        return this.clientMaps.get(socket);
    }
}

export interface WebSocketClient {
    send(hmrType: HMRType.All): void;
    send(event: string, params: any): void;
    socket: WebSocket;
}

export type WebScoketClinetSendParam<T> = {
    type: string;
    event: string;
    data: T;
};
