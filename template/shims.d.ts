declare module "*.joker" {
    import type { Component } from "@joker.front/core";

    export default compnent;
}

interface ImportMeta {
    url: string;
    define: Record<string, any>;
}
declare module "*.json" {
    const value: any;
    export default value;
}
declare module "*.svg";
declare module "*.png";
declare module "*.jpg";
declare module "*.jpeg";
declare module "*.gif";
declare module "*.bmp";
declare module "*.tiff";
