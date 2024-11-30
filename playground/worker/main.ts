import { editor, languages } from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import CssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import TsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

//@ts-ignore
self.MonacoEnvironment = {
    getWorker(_, label) {
        if (label === "json") {
            return new JsonWorker();
        } else if (label === "css" || label === "scss" || label === "less") {
            return new CssWorker();
        } else if (label === "html") {
            return new HtmlWorker();
        } else if (label === "typescript" || label === "javascript") {
            return new TsWorker();
        }
        return new EditorWorker();
    }
};

languages.typescript.typescriptDefaults.setEagerModelSync(true);

editor.create(document.getElementById("demo"), {
    value: "",
    language: "json",
    theme: "vs-dark",

    minimap: {
        enabled: true // 是否启用预览图
    }
});
