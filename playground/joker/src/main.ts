import { Component } from "@joker.front/core";
import page from "./page.joker";

new page().$mount(document.getElementById("app"));

let prevHmr: any = undefined;

let hmrTestBtn = document.getElementById("onHmrTest");

if (hmrTestBtn !== null) {
    hmrTestBtn.onclick = function () {
        if (prevHmr) {
            //@ts-ignore
            prevHmr.$destroy();
        }
        //@ts-ignore
        prevHmr = new page().$mount(document.getElementById("hmr"));
    };
}
