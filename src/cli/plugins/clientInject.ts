import { CLIENT_ENTRY, CLIENT_PLUBLIC_PATH, ResolvedConfig } from "../config";
import { Plugin } from "../plugin";
import { Server } from "../server";
import { normalizePath, transformHostName } from "../utils";

export function clientInjectPlugin(config: ResolvedConfig): Plugin {
    let normalizedClientEntry = normalizePath(CLIENT_ENTRY);
    let server: Server;
    return {
        name: "joker:client-inject",

        configureServer(_server) {
            server = _server;
        },

        resolveId(source, importer, options) {
            if (source === CLIENT_PLUBLIC_PATH) {
                return normalizedClientEntry;
            }
        },

        async transform(code, id) {
            if (id !== normalizedClientEntry) return;

            let serverHostName = (await transformHostName(config.server.host)).name;
            let devBase = config.base;

            let host = server.socketServer.wsOption.host || serverHostName || null;
            let port = server.socketServer.wsOption.port || null;
            let timeout = server.socketServer.timeout;
            return code
                .replace("__BASE__", JSON.stringify(devBase))
                .replace("__HMR_HOSTNAME__", JSON.stringify(host))
                .replace("__HMR_PORT__", JSON.stringify(port))
                .replace("__HMR_HEARTTIMER__", JSON.stringify(timeout));
        }
    };
}
