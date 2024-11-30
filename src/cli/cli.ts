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
cli.option("--config <file>", "[string]cli配置文件地址")
    .option("--base <path>", "配置基础地址")
    .option("--log <leve>", `[silent | error | warn | info | debug]日志输出等级`)
    .option("--mode <mode>", `[string] 设置环境模式`);

type GlobalCliOption = {
    config?: string;
    base?: string;
    log?: logger.leve;
    mode?: string;
};
//#endregion

//#region 开发者服务
cli.command("[root]", "开启开发者服务")
    .option("--host [host]", "[string] 自定义hostname")
    .option("--port <port>", "[number] 自定义端口")
    .option("--open [path]", "[boolean | string] 是否默认打开浏览器，可指定自定义地址")
    .action(async (root: string, options: ServerOptions & GlobalCliOption) => {
        let config = await resolveCliConfig(
            {
                root: root,
                base: options.base,
                logLeve: options.log,
                mode: options.mode,
                command: "server",
                server: {
                    host: options.host,
                    port: options.port,
                    open: options.open
                }
            },
            "server",
            options.config
        );

        let server = new Server(config);

        await server.start();
    });
//#endregion

cli.command("build [root]", "打包构建")
    .option("--outDir <dir>", `[string] 产物输出目录，默认为dist`)
    .option("--sourcemap", `[boolean] 是否输出sourcemap文件，默认为false`)
    .action(async (root: string, options: BuildOptions & GlobalCliOption) => {
        let config = await resolveCliConfig(
            {
                root: root,
                base: options.base,
                logLeve: options.log,
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

cli.command("create [name]", "创建项目").action(async (name: string) => {
    let cwdPath = process.cwd();
    let aimDir = path.join(cwdPath, name);
    fs.mkdirSync(aimDir);

    let templatePath = path.join(__dirname, "../template");

    copyDir(templatePath, aimDir);

    console.log("创建完成，请自行安装依赖，建议使用pnpm安装依赖。");
});

cli.help();
cli.version(version);
cli.parse();
