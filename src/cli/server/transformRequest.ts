import type { SourceDescription, SourceMap } from "rollup";
import { Server } from ".";
import { logger } from "../logger";
import { getPublicFilePath, prettifyUrl, removeTimestampQuery } from "../utils";
import getETag from "etag";
import { injectSourcesContent } from "./sourcemap";
import { isFileServingAllowed } from "./middlewares/static";
import { promises as fsp } from "node:fs";
import { cleanUrl } from "@joker.front/shared";

const LOGTAG = "请求转换";

export interface TransformResult {
    code: string;

    map: SourceMap | null;

    etag?: string;

    deps?: string[];

    dynamicDeps?: string[];
}

/**
 * 请求转换处理器
 */
export class TransformRequester {
    /**
     * padding队列
     */
    private paddings: Map<
        string,
        {
            request: Promise<TransformResult | Error | undefined>;
            timestamp: number;
            abort: () => void;
        }
    > = new Map();

    constructor(public server: Server) {}

    public request(url: string, isHtml: boolean = false): Promise<TransformResult | Error | undefined> {
        //区分html 和 其他文件，因为有'/'重定向，js方面也有无后缀场景
        let cacheKey = (isHtml ? "html:" : "file:") + url;

        let padding = this.paddings.get(cacheKey);

        let timestamp = Date.now();

        let moduleUrl = removeTimestampQuery(url);
        if (padding) {
            this.server.moduleMap.getModuleByUrl(moduleUrl).then((m) => {
                //没有找到module或者module之前已经被销毁，都可以继续沿用上一次结果，做新文件请求
                if (m === undefined || timestamp > m.lastDisposeTimestamp) {
                    return padding?.request;
                } else {
                    //如果存在，但是新鲜度不足时，则终止（终止后会剔除padding），再次转换请求
                    padding?.abort();

                    return this.request(url, isHtml);
                }
            });
        }

        let request = this.doTransform(moduleUrl, timestamp, isHtml);

        //在并发请求下，通过闭包，完成该频次的结束回调
        let ended = false;
        let endCallback = () => {
            if (ended) {
                return;
            }

            this.paddings.delete(cacheKey);

            ended = true;
        };

        this.paddings.set(cacheKey, {
            request,
            timestamp,
            abort: endCallback
        });

        request.then(endCallback, endCallback);

        return request;
    }

    private async doTransform(moduleUrl: string, timestamp: number, isHtml: boolean, igTransformError?: boolean) {
        let module = await this.server.moduleMap.getModuleByUrl(moduleUrl);

        /**
         * 如果有缓存时，则返回
         * 当缓存不再是最新鲜时，会进行清除并修改lastDisposeTimestamp
         */
        if (module?.transformResult) {
            return module.transformResult;
        }

        let id = (await this.server.pluginContainer.resolveId(moduleUrl))?.id || moduleUrl;

        let result = this.loadAndTransform(id, moduleUrl, timestamp, isHtml);

        this.server.config.depHandler?.delayDepResolveUntil(id, () => result);

        return result;
    }

    private async loadAndTransform(
        id: string,
        moduleUrl: string,
        timestamp: number,
        isHtml: boolean
    ): Promise<TransformResult | Error | undefined> {
        let loadResult = await this.server.pluginContainer.load(id);
        let code: string | undefined = undefined;
        let map: SourceDescription["map"] | null = null;

        const file = cleanUrl(id);

        if (loadResult === null || loadResult === undefined) {
            if (isHtml && id.endsWith(".html") === false) {
                //spa下，无明确指向的重定向请求，直接跳过
                return;
            }

            if (isFileServingAllowed(file, this.server)) {
                try {
                    code = await fsp.readFile(file, "utf-8");

                    logger.debug(LOGTAG, `${prettifyUrl(file, this.server.config.root)}执行load无插件接管，使用fs模式`);
                } catch (e: any) {
                    if (e.code !== "ENOENT") {
                        throw e;
                    } else {
                        //交由404处理，不做异常阻断
                        logger.warn(LOGTAG, `${file}文件或目录不存在`);
                    }
                }
            } else {
                logger.error(LOGTAG, `${moduleUrl}：超出了项目范围，可配置server.fs.strict=false来关闭检查`);
            }
        } else {
            if (typeof loadResult === "string") {
                code = loadResult;
            } else {
                code = loadResult.code;
                map = loadResult.map;
            }
        }

        if (code === undefined) {
            if (getPublicFilePath(this.server.config.publicDir, moduleUrl)) {
                logger.error(
                    LOGTAG,
                    `${moduleUrl}：当前请求时publicDir下的资源，不允许进行转换类请求，如果必须这么做，请考虑移动到src下，或检查文件重名问题。`
                );
            } else {
                logger.warn(LOGTAG, `${prettifyUrl(id, this.server.config.root)}在执行load时，没有返回任何内容`);
            }
            return;
        }

        //添加module缓存，有则返回，无则初始化
        let module = await this.server.moduleMap.addEntryModuleUrl(moduleUrl);

        this.server.addWatchFile(module.file);

        try {
            let transformResult = await this.server.pluginContainer.transform(code, id, map);

            if (transformResult === null) {
                logger.warn(LOGTAG, `${moduleUrl}：该文件进入插件代码转换后，转换结果为空，先按跳过处理`);
            } else {
                code = transformResult.code;
                map = transformResult.map;
            }

            //有实体文件 && 有map数据
            if (map && module.file) {
                map = (typeof map === "string" ? JSON.parse(map) : map) as SourceMap;

                await injectSourcesContent(map, module.file);
            }

            let result: TransformResult = {
                code,
                map: map as SourceMap,
                etag: getETag(code, { weak: true })
            };

            if (timestamp > module.lastDisposeTimestamp) {
                module.transformResult = result;
            }
            return result;
        } catch (e: any) {
            throw e;
        }
    }
}
