import type { CustomPluginOptions, Plugin as RollupPlugin, PluginContext, ResolveIdResult } from "rollup";
import { Config, ResolvedConfig } from "./config";
import { Server } from "./server";
import { HMRContext } from "./server/hmr";
import { ModuleNode } from "./server/moduleMap";
import { IndexHtmlTransform } from "./utils/html";

export interface Plugin extends RollupPlugin {
    /**
     * 执行顺序
     * prev前置预处理
     * post构建后处理
     */
    enforce?: "pre" | "post";

    /**
     * 触发场景，空代表全部执行
     */
    apply?: Config["command"] | "all";

    /**
     * 配置server把柄
     */
    configureServer?: (server: Server) => void | Promise<void>;

    /**
     * 配置文件转换
     */
    configTransform?: (config: ResolvedConfig) => Promise<void> | void;

    /**
     * 首页html转换Hook方法
     * 可通过该钩子实现：注入入口脚本等等
     */
    indexHtmlTransform?: IndexHtmlTransform;

    /**
     * 扩展rollup中的options，添加scan属性
     */
    resolveId?: (
        this: PluginContext,
        source: string,
        importer: string | undefined,
        options: { custom?: CustomPluginOptions; isEntry: boolean; scan?: boolean }
    ) => Promise<ResolveIdResult> | ResolveIdResult;

    /**
     * 热更新模块Update上下文
     * 可以通过该hook实现对modules等属性的更新
     * @param ctx
     */
    hmrUpdate?(ctx: HMRContext, server: Server): ModuleNode[] | void | Promise<ModuleNode[] | void>;
}

export function sortPlugins(plugins: Plugin[]) {
    let result: { pre: Plugin[]; normal: Plugin[]; post: Plugin[] } = {
        pre: [],
        normal: [],
        post: []
    };

    plugins.forEach((p) => {
        switch (p.enforce) {
            case "pre":
                result.pre.push(p);
                break;
            case "post":
                result.post.push(p);
                break;
            default:
                result.normal.push(p);
                break;
        }
    });

    return result;
}
