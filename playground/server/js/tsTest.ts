import { TestFunc } from "./c";
import dayjs from "dayjs";
(function () {
    alertWindow(`我是ts文件，我被顺利编译：${Date.now()}hhh`);

    setInterval(() => {
        document.getElementById("timer")!.innerHTML = dayjs(Date.now()).format("YYYY-MM-DD HH:mm:ss");
    }, 1000);
})();

function alertWindow(message: string): void {
    console.log(message);

    setTimeout(() => {
        TestFunc(message + "2232");
    }, 1000);
}
