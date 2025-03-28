
declare module "*.svg";
declare module "*.png";
declare module "*.jpg";
declare module "*.jpeg";
declare module "*.gif";
declare module "*.bmp";
declare module "*.tiff";


declare module "*.json" {
    const value: any;
    export default value;
}

interface ImportMeta {
    url: string;
    define: Record<string, any>;
}
