import App from "./App.joker";
import { Router } from "@joker.front/router";

let router = new Router({
    routes: [
        {
            path: "/",
            redirect: "/index"
        },
        {
            path: "/index",
            component: () => import("./pages/index.joker")
        }
    ]
});

new App().$mount(document.getElementById("app"));
