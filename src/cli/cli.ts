import { cac } from "cac";
import { Server, ServerOptions } from "./server";
import { logger } from "./logger";
import { resolveCliConfig, version } from "./config";
import { build, BuildOptions } from "./build";
import fs from "node:fs";
import path from "node:path";
import { copyDir } from "./utils";

const cli = cac("joker");

//#region 通用配置
cli.option("--config <file>", "[string] Path to CLI configuration file")
    .option("--base <path>", "Configure base URL path")
    .option("--log <level>", "[silent | error | warn | info | debug] Logging verbosity level")
    .option("--mode <mode>", "[string] Set environment mode");

type GlobalCliOption = {
    config?: string;
    base?: string;
    log?: logger.leve;
    mode?: string;
};
//#endregion

//#region 开发者服务
cli.command("[root]", "Start development server")
    .option("--host [host]", "[string] Custom hostname")
    .option("--port <port>", "[number] Custom port number")
    .option("--open [path]", "[boolean | string] Automatically open browser, optionally specify path")
    .action(async (root: string, options: ServerOptions & GlobalCliOption) => {
        let config = await resolveCliConfig(
            {
                root: root,
                base: options.base,
                logLevel: options.log,
                mode: options.mode,
                command: "server",
                server: {
                    host: options.host,
                    port: options.port,
                    open: transformBooleanStrValue(options.open || true)
                }
            },
            "server",
            options.config
        );

        let server = new Server(config);

        await server.start();
    });
//#endregion

cli.command("build [root]", "Build project for production")
    .option("--outDir <dir>", "[string] Output directory for build artifacts (default: dist)")
    .option("--sourcemap", "[boolean] Generate sourcemap files (default: false)")
    .action(async (root: string, options: BuildOptions & GlobalCliOption) => {
        let config = await resolveCliConfig(
            {
                root: root,
                base: options.base,
                logLevel: options.log,
                command: "build",
                mode: options.mode,
                build: {
                    sourcemap: options.sourcemap,
                    outDir: options.outDir
                }
            },
            "build",
            options.config
        );

        await build(config);
    });

cli.command("create [name]", "Create a new project").action(async (name) => {
    const cwdPath = process.cwd();
    const targetDir = path.join(cwdPath, name);

    fs.mkdirSync(targetDir);

    const templatePath = path.join(__dirname, "../template");

    await copyDir(templatePath, targetDir);

    console.log("Project created successfully. Please install dependencies manually. It is recommended to use pnpm.");
});
cli.help();
cli.version(version);
cli.parse();

function transformBooleanStrValue(value: any) {
    if (value === "false") {
        return false;
    } else if (typeof value !== "string" || value === "true") {
        return true;
    }
    return value;
}
