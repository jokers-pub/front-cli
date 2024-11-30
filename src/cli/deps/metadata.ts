import { getHash, getPartObject } from "../utils";

export class DepMetadata {
    constructor(public hash: string, deps: Record<string, DepInfo> = {}) {
        this.browserHash = getHash(hash + JSON.stringify(getPartObject(deps, "src")) + Date.now());
    }

    /**
     * hash + 引用 + 时间 = 计算出来的浏览时的hash，用作运行时使用
     */
    public browserHash: string;

    /**
     * 发现的dep
     */
    public discovered: Record<string, DepInfo> = {};

    /**
     * 已被解析的dep
     */
    public resolved: Record<string, DepInfo> = {};

    /**
     *  没有入口或者是动态导入的dep
     */
    public chunks: Record<string, DepInfo> = {};
}

export interface DepInfo {
    /**
     * 唯一
     */
    id: string;
    /**
     * 缓存文件路径
     */
    file: string;
    /**
     * 请求路径
     */
    src?: string;
    /**
     * 浏览时hash
     */
    browserHash?: string;
    /**
     * 文件hash
     */
    fileHash?: string;
    /**
     * 当前dep输出程序
     */
    exportDatas?: Promise<ExportDatas>;
    /**
     * 是否需要重写import引入
     */
    needRewriteImport?: boolean;
    /**
     * dep 解析进程
     */
    processing?: Promise<void>;
}

export type ExportDatas = {
    hasImport: boolean;

    exports: readonly string[];

    facade: boolean;

    /**是否有转输出的场景，e.g. export xxx from 'xxx'**/
    hasTransferExports: boolean;
};
