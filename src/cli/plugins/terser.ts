import path from "path";
import { ResolvedConfig } from "../config";
import { logger } from "../logger";
import { resolvePackageData } from "../package";
import { Plugin } from "../plugin";
import { AsyncWorker } from "../utils/worker";
import type { MinifyOutput, MinifyOptions } from "terser";

const LOGTAG = "terser";

export function terserPlugin(config: ResolvedConfig): Plugin {
    let makeWorker = () =>
        new AsyncWorker(async (terserPath: string, code: string, options: MinifyOptions) => {
            let terser = require(terserPath);

            return terser.minify(code, options) as MinifyOutput;
        });
    let worker: ReturnType<typeof makeWorker> | undefined;

    return {
        name: "joker:terser",

        async renderChunk(code, chunk, opts) {
            if (
                config.build.minify !== "terser" &&
                //@ts-ignore
                !opts.__joker_force_terser__
            ) {
                return null;
            }

            if (config.build.lib && opts.format === "es") {
                return null;
            }

            worker ||= makeWorker();

            let res = await worker.run(getTerserPath(config), code, {
                safari10: true,
                sourceMap: !!opts.sourcemap,
                module: opts.format.startsWith("es"),
                toplevel: opts.format === "cjs"
            });

            return {
                code: res.code!,
                map: res.map as any
            };
        },

        closeBundle() {
            worker?.stop();
        }
    };
}

let terserPath: string | undefined = undefined;

function getTerserPath(config: ResolvedConfig): string {
    if (terserPath) return terserPath;

    let pkg = resolvePackageData("terser", config.root);

    if (!pkg) {
        throw new Error(logger.error(LOGTAG, `未找到terser，请确定是否正确的安装了该依赖。`));
    } else {
        terserPath = path.resolve(pkg.dir, pkg.data.main);
    }

    return terserPath!;
}
