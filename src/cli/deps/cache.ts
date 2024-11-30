import fs from "node:fs";
import path from "node:path";
import { getHash, normalizePath, writeFile } from "../utils";
import { logger } from "../logger";
import { DepMetadata } from "./metadata";
import { ResolvedConfig } from "../config";

const CACHE_FILE_NAME = "_manifest.json";
const LOGTAG = "DEP缓存";

export class DepCache {
    public cacheDir: string;
    public relativeCacheDir: string;
    public cacheDirPrefix: string;

    constructor(public config: ResolvedConfig) {
        this.cacheDirPrefix = normalizePath(path.resolve(this.config.cacheDir, "deps"));

        this.cacheDir = this.cacheDirPrefix + (this.config.command === "build" ? this.getBuildId() : "/server");

        let depsCacheDirRelative = normalizePath(path.relative(this.config.root, this.cacheDir));

        this.relativeCacheDir = depsCacheDirRelative.startsWith("../")
            ? `/@fs/${normalizePath(this.cacheDir).replace(/^\//, "")}`
            : `/${depsCacheDirRelative}`;
    }

    public loadCache(configHash: string): DepMetadata | undefined {
        let cacheFileName = path.join(this.cacheDir, CACHE_FILE_NAME);

        let cache: DepMetadata | undefined;
        try {
            cache = this.parserCacheFile(cacheFileName);
        } catch (e) {
            logger.debug(LOGTAG, "解析缓存失败，按没有缓存处理");
        }

        if (cache && cache.hash === configHash) {
            return cache;
        }

        logger.debug(LOGTAG, "cache不存在，或两次hash不一致，不采用");

        //移除失效缓存，在下一次进行更新
        fs.rmSync(this.cacheDir, { recursive: true, force: true });
    }

    public isCacheFile(fileName: string): boolean {
        return fileName.startsWith(this.cacheDir);
    }

    public isCacheUrl(fileName: string): boolean {
        return fileName.startsWith(this.relativeCacheDir);
    }

    public writeCache(metadata: DepMetadata, cacheDir: string) {
        let filePath = path.join(cacheDir, CACHE_FILE_NAME);

        writeFile(filePath, this.stringifyDepMetadata(metadata, cacheDir));
    }

    private getBuildId(): string {
        let outDir = this.config.build.outDir || "";
        if (outDir.length > 8 || outDir.includes("/")) {
            return "/build_" + getHash(outDir);
        }
        return "/build_" + outDir;
    }

    private parserCacheFile(fileName: string): DepMetadata | undefined {
        let content = fs.readFileSync(fileName, "utf-8");

        let cacheData = JSON.parse(content, (key: string, value: string) => {
            //将file、src路径转换为cache目录 绝对路径
            if (key === "file" || key === "src") {
                return normalizePath(path.resolve(this.cacheDir, value));
            }
            return value;
        });

        let result = new DepMetadata(cacheData.hash);

        result.browserHash = cacheData.browserHash;

        for (let id in cacheData.resolved) {
            result.resolved[id] = {
                ...cacheData.resolved[id],
                id,
                browserHash: cacheData.browserHash
            };
        }

        for (let id in cacheData.chunks) {
            result.chunks[id] = {
                ...cacheData.chunks[id],
                id,
                browserHash: cacheData.browserHash,
                needRewriteImport: false
            };
        }

        return result;
    }

    private stringifyDepMetadata(metadata: DepMetadata, cacheDir: string) {
        return JSON.stringify(
            {
                hash: metadata.hash,
                browserHash: metadata.browserHash,
                resolved: Object.fromEntries(
                    Object.values(metadata.resolved).map((m) => [
                        m.id,
                        {
                            src: m.src,
                            file: m.file,
                            fileHash: m.fileHash,
                            needRewriteImport: m.needRewriteImport
                        }
                    ])
                ),
                chunks: Object.fromEntries(Object.values(metadata.chunks).map((m) => [m.id, { file: m.file }]))
            },
            (key: string, value: string) => {
                if (key === "file" || key === "src") {
                    return normalizePath(path.relative(cacheDir, value));
                }
                return value;
            },
            2
        );
    }
}
