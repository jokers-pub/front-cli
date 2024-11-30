import color from "picocolors";

export namespace logger {
    const loggerLeve = ["silent", "error", "warn", "info", "debug"];
    /**
     * 日志等级，默认为警告和错误
     */
    export type leve = "silent" | "error" | "warn" | "info" | "debug";

    export let logLeve: leve = "info";

    //时间戳
    function getTimer(): string {
        let date = new Date();
        function supplyZero(value: number, length: number = 2): string {
            return value.toString().padStart(length, "0");
        }

        return (
            supplyZero(date.getHours()) +
            ":" +
            supplyZero(date.getMinutes()) +
            ":" +
            supplyZero(date.getSeconds()) +
            ":" +
            supplyZero(date.getMilliseconds(), 3)
        );
    }

    /**
     * 日志输出
     *
     * 当前方法只控制日志输出等级，不做逻辑注入
     * 无论是H5、小程序、客户端，都需要在浏览器/V8中执行
     * 日志输出到容器内即可
     * @param type
     * @param tagName
     * @param content
     */
    function writeLog(type: leve, tagName: string, message: string) {
        if (loggerLeve.indexOf(type) <= loggerLeve.indexOf(logLeve)) {
            let str = `${color.dim(getTimer())} `;

            switch (type) {
                case "info":
                    str += `[${color.cyan(color.bold(tagName))}] `;
                    break;
                case "warn":
                    str += `[${color.yellow(color.bold(tagName))}] `;
                    break;
                case "error":
                    str += `[${color.red(color.bold(tagName))}] `;
                    break;
                case "debug":
                    str += `[${color.cyan(color.bold(tagName))}] `;
                    type = "info";
                    break;
            }

            str += `: ${message}`;

            console[type as "error" | "info" | "warn"](str);
        }
    }

    export function debug(tag: string, content: any) {
        writeLog("debug", tag, content);
    }

    /**
     * 信息
     * @param tag
     * @param content
     */
    export function info(tag: string, content: any) {
        writeLog("info", tag, content);
    }

    /**
     * 警告
     * @param tag
     * @param content
     */
    export function warn(tag: string, content: any) {
        writeLog("warn", tag, content);
        return content;
    }

    /**
     * 错误
     * @param tag
     * @param content
     */
    export function error(tag: string, content: any, err?: Error): string {
        writeLog("error", tag, content);
        err && console.error(err);
        return content + (err?.message ? `\n${err?.message}` : "");
    }
}
