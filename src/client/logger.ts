export namespace logger {
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
    function writeLog(type: "info" | "warn" | "error", message: string) {
        let str = `[JOKERCLI]: ${message}`;

        console[type](str);
    }

    /**
     * 信息
     * @param tag
     * @param content
     */
    export function info(content: any) {
        writeLog("info", content);
    }

    /**
     * 警告
     * @param tag
     * @param content
     */
    export function warn(content: any) {
        writeLog("warn", content);
    }

    /**
     * 错误
     * @param tag
     * @param content
     */
    export function error(content: any, err?: Error) {
        writeLog("error", content);
        err && console.error(err);
    }
}
