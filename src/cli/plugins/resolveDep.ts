import { cleanUrl } from "@joker.front/shared";
import { promises as fs } from "node:fs";
import { ResolvedConfig } from "../config";
import { logger } from "../logger";
import { Plugin } from "../plugin";
import { getDepVersion } from "../utils";

const LOGTAG = "DEP缓存";

export function resolveDepPlugin(config: ResolvedConfig): Plugin {
    return {
        name: "joker:resolve-dep",

        resolveId(source, importer, options) {
            if (config.depHandler.isResolvedDepFile(source)) {
                return source;
            }
        },

        async load(id) {
            if (config.depHandler.isResolvedDepFile(id)) {
                config.depHandler.firstRun();

                let file = cleanUrl(id);

                let metadata = config.depHandler.depMetadata;

                let browserHash = getDepVersion(id);

                let depInfo = config.depHandler.getDepInfoFromFile(file);

                if (depInfo) {
                    //已失效
                    if (browserHash && depInfo.browserHash !== browserHash) {
                        throwOutdatedRequest(id);
                    }

                    try {
                        await depInfo.processing;
                    } catch {
                        //重置resolved索引，用于下次重置版本v=?
                        config.depHandler.server?.pluginContainer.resolveIdCache.clear();
                        throwProcessingError(id);
                    }

                    //commitProcessing 时，会重新定义metadata
                    if (metadata !== config.depHandler.depMetadata) {
                        //延迟、重新校准browserHash
                        let newDep = config.depHandler.getDepInfoFromFile(file);
                        if (depInfo.browserHash !== newDep?.browserHash) {
                            logger.warn(
                                LOGTAG,
                                `ID:${depInfo.id}，该依赖发现新版本，正在尝试更新缓存，若无法按新依赖生效，请重启CLI。`
                            );

                            //重置resolved索引，用于下次重置版本v=?
                            config.depHandler.server?.pluginContainer.resolveIdCache.clear();
                        }
                    }
                }

                /**
                 * 从缓存加载文件，而不是等待其他插件加载钩子来避免竞争条件，
                 * 一旦处理解决，我们确保文件已正确保存到磁盘
                 */
                try {
                    //采用异步，不阻塞，挂起多线程处理
                    return await fs.readFile(file, "utf-8");
                } catch {
                    //重置resolved索引，用于下次重置版本v=?
                    config.depHandler.server?.pluginContainer.resolveIdCache.clear();
                    throwOutdatedRequest(id);
                }
            }
        }
    };
}

export function resolveDepBuildPlugin(config: ResolvedConfig): Plugin {
    return {
        name: "joker:resolve-dep-build",
        buildStart() {
            config.depHandler.reset();
        },
        resolveId(source, importer, options) {
            if (config.depHandler.isResolvedDepFile(source)) {
                return source;
            }
        },
        transform(code, id) {
            config.depHandler.delayDepResolveUntil(id, async () => {
                //this -> pluginContext
                await this.load({ id });
            });
        },
        async load(id) {
            if (config.depHandler.isResolvedDepFile(id) === false) {
                return;
            }

            config.depHandler.firstRun();

            let file = cleanUrl(id);

            let depInfo = config.depHandler.getDepInfoFromFile(file);

            if (depInfo) {
                try {
                    await depInfo.processing;
                } catch {
                    return;
                }
            } else {
                return;
            }

            try {
                return await fs.readFile(file, "utf-8");
            } catch {
                return "";
            }
        }
    };
}

export const ERR_OUTDATED_RESOLVED_DEP = "ERR_OUTDATED_RESOLVED_DEP";

export const ERR_RESOLVE_DEP_PROCESSING_ERROR = "ERR_RESOLVE_DEP_PROCESSING_ERROR";

export function throwOutdatedRequest(id: string): never {
    let err: any = new Error(
        logger.error(LOGTAG, `当前：${id}包发现另一个版本，请尝试清除浏览器缓存以便能顺利加载到最新的版本。`)
    );

    err.code = ERR_OUTDATED_RESOLVED_DEP;

    throw err;
}

function throwProcessingError(id: string): never {
    let err: any = new Error(`${id}:在解析时，发生了异常终端，需要刷新页面/重启脚手架进行重新初始化`);

    err.code = ERR_RESOLVE_DEP_PROCESSING_ERROR;
    throw err;
}
