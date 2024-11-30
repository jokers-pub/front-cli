import { Component } from "@joker.front/core";
import page from "./page.joker";

new page().$mount(document.getElementById("app"));

let prevHmr: Component | undefined = undefined;

let hmrTestBtn = document.getElementById("onHmrTest");

if (hmrTestBtn) {
    hmrTestBtn.onclick = function () {
        if (prevHmr) {
            prevHmr.$destroy();
        }
        prevHmr = new page().$mount(document.getElementById("hmr"));
    };
}
