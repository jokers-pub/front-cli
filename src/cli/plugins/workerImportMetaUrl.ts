import MagicString from "magic-string";
import { ResolvedConfig } from "../config";
import { Plugin } from "../plugin";
import { stripLiteral } from "strip-literal";
import path from "node:path";
import { addUrlQuery, evalValue, slash, transformStableResult } from "../utils";
import { fileToUrl } from "./asset";
import { WORKER_FILE_ID, workerFileToUrl } from "./worker";
import { cleanUrl } from "@joker.front/shared";
import { RollupError } from "rollup";
import { ResolveFn, tryFsResolve } from "./resolve";

export function workerImportMetaUrlPlugin(config: ResolvedConfig): Plugin {
    let workerResolver: ResolveFn;
    return {
        name: "joker:worker-import-meta-url",
        async transform(code, id) {
            if (
                (code.includes("new Worker") || code.includes("new SharedWorker")) &&
                code.includes("new URL") &&
                code.includes("import.meta.url")
            ) {
                let s: MagicString | undefined;
                const cleanString = stripLiteral(code);
                const workerImportMetaUrlRE =
                    /\bnew\s+(?:Worker|SharedWorker)\s*\(\s*(new\s+URL\s*\(\s*('[^']+'|"[^"]+"|`[^`]+`)\s*,\s*import\.meta\.url\s*\))/dg;

                let match: RegExpExecArray | null;
                while ((match = workerImportMetaUrlRE.exec(cleanString))) {
                    const [[, endIndex], [expStart, expEnd], [urlStart, urlEnd]] = match.indices!;

                    const rawUrl = code.slice(urlStart, urlEnd);

                    // potential dynamic template string
                    if (rawUrl[0] === "`" && rawUrl.includes("${")) {
                        this.error(`\`new URL(url, import.meta.url)\` 在动态模板字符串中不受支持。`, expStart);
                    }

                    s ||= new MagicString(code);
                    const workerType = getWorkerType(code, cleanString, endIndex);
                    const url = rawUrl.slice(1, -1);
                    let file: string | undefined;
                    if (url[0] === ".") {
                        file = path.resolve(path.dirname(id), url);
                        file =
                            tryFsResolve(file, {
                                ...config,
                                ...config.resolve,
                                asSrc: true
                            }) ?? file;
                    } else {
                        workerResolver ??= config.createResolver({
                            extensions: [],
                            tryIndex: false,
                            preferRelative: true
                        });
                        file = await workerResolver(url, id);
                        file ??=
                            url[0] === "/"
                                ? slash(path.join(config.publicDir as string, url))
                                : slash(path.resolve(path.dirname(id), url));
                    }

                    let builtUrl: string;
                    if (config.command === "build") {
                        builtUrl = await workerFileToUrl(config, file!);
                    } else {
                        builtUrl = await fileToUrl(cleanUrl(file!), config, this);
                        builtUrl = addUrlQuery(builtUrl, `${WORKER_FILE_ID}&type=${workerType}`);
                    }
                    s.update(expStart, expEnd, `new URL('' + ${JSON.stringify(builtUrl)}, import.meta.url)`);
                }
                if (s) {
                    return transformStableResult(s, id, config);
                }

                return null;
            }
        }
    };
}

function getWorkerType(raw: string, clean: string, i: number): WorkerType {
    const commaIndex = clean.indexOf(",", i);
    if (commaIndex === -1) {
        return "classic";
    }
    const endIndex = clean.indexOf(")", i);

    // case: ') ... ,' mean no worker options params
    if (commaIndex > endIndex) {
        return "classic";
    }

    // need to find in comment code
    const workerOptString = raw.substring(commaIndex + 1, endIndex).replace(/\}[\s\S]*,/g, "}"); // strip trailing comma for parsing

    // need to find in no comment code
    const cleanWorkerOptString = clean.substring(commaIndex + 1, endIndex).trim();
    if (!cleanWorkerOptString.length) {
        return "classic";
    }

    const workerOpts = parseWorkerOptions(workerOptString, commaIndex + 1);
    if (workerOpts.type && ["classic", "module"].includes(workerOpts.type)) {
        return workerOpts.type;
    }

    return "classic";
}

function parseWorkerOptions(rawOpts: string, optsStartIndex: number): WorkerOptions {
    let opts: WorkerOptions = {};
    try {
        opts = evalValue<WorkerOptions>(rawOpts);
    } catch {
        throw err(
            "Vite is unable to parse the worker options as the value is not static." +
                "To ignore this error, please use /* @vite-ignore */ in the worker options.",
            optsStartIndex
        );
    }

    if (!opts) {
        return {};
    }

    if (typeof opts !== "object") {
        throw err(`Expected worker options to be an object, got ${typeof opts}`, optsStartIndex);
    }

    return opts;
}

function err(e: string, pos: number) {
    const error = new Error(e) as RollupError;
    error.pos = pos;
    return error;
}
