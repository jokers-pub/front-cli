//此文件做方法、类型输出
import type { JokerChunkMetadata } from "./plugins/metadata";
export * from "./cli";

export { resolvePackageData } from "./package";
export { build, resolveBuildOpt, toOutputFilePath } from "./build";
export { normalizePath } from "./utils/index";
export { resolveCliConfig } from "./config";

export type { ResolvedConfig } from "./config";
export type { Plugin } from "./plugin";
export type { BuildOptions } from "./build";
export type { HtmlTagDescriptor, IndexHtmlTransform } from "./utils/html";

declare module "rollup" {
    export interface RenderedChunk {
        jokerMetadata: JokerChunkMetadata;
    }
}
