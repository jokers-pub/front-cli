import { IHMRType } from "./hmr";

/**遮罩元素ID */
const OVERLAY_ID = "joker-error-overlay";
const FILE_RE = /(?:[a-zA-Z]:\\|\/).*?:\d+:\d+/g;
const CODE_FRAME_RE = /^(?:>?\s+\d+\s+\|.*|\s+\|\s*\^.*)\r?\n/gm;

const TEMPLATE = `
<style>
:host {
    position: fixed;
    top: 0;
    left: 0;
    z-index: 99999;
    width: 100%;
    height: 100%;
    overflow-y: scroll;
    margin: 0;
    background: rgba(0, 0, 0, 0.66);

    --font: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, Courier;
    --red: #ff5555;
    --yellow: #e2aa53;
    --purple: #cfa4ff;
    --cyan: #2dd9da;
    --dim: #c9c9c9;
}

.window {
    font-family: var(--font);
    line-height: 1.5;
    color: #d8d8d8;
    margin: 30px 0;
    padding: 25px 40px;
    position: relative;
    background: #181818;
    border-radius: 6px 6px 8px 8px;
    box-shadow: 0 19px 38px rgba(0, 0, 0, 0.3), 0 15px 12px rgba(0, 0, 0, 0.22);
    overflow: hidden;
    border-top: 8px solid var(--red);
    direction: ltr;
    text-align: left;
}

pre {
    font-family: var(--font);
    font-size: 16px;
    margin-top: 0;
    margin-bottom: 1em;
    overflow-x: scroll;
    scrollbar-width: none;
}

pre::-webkit-scrollbar {
    display: none;
}

.message {
    line-height: 1.3;
    font-weight: 600;
    white-space: pre-wrap;
}

.message-body {
    color: var(--red);
}

.plugin {
    color: var(--purple);
}

.file {
    color: var(--cyan);
    margin-bottom: 0;
    white-space: pre-wrap;
    word-break: break-all;
}

.frame {
    color: var(--yellow);
}

.stack {
    font-size: 13px;
    color: var(--dim);
}

.tip {
    font-size: 13px;
    color: #999;
    border-top: 1px dotted #999;
    padding-top: 13px;
}

.file-link {
    text-decoration: underline;
    cursor: pointer;
}
</style>
<div class="window">
    <pre class="message">
        <span class="plugin"></span>
        <span class="message-body"></span>
    </pre>
    <pre class="file"></pre>
    <pre class="frame"></pre>
    <pre class="stack"></pre>
    <div class="tip">点击空白处关闭该遮罩提示</div>
</div>
`;

export class ErrorOverlay extends HTMLElement {
    root: ShadowRoot;

    constructor(err: IHMRType.Error["err"]) {
        super();

        this.root = this.attachShadow({ mode: "open" });

        this.root.innerHTML = TEMPLATE;

        CODE_FRAME_RE.lastIndex = 0;

        let hasFrame = err.frame && CODE_FRAME_RE.test(err.frame);
        let message = hasFrame ? err.message.replace(CODE_FRAME_RE, "") : err.message;

        if (err.plugin) {
            this.text(".plugin", `[插件：${err.plugin}]`);
        }

        this.text(".message-body", message.trim());

        let [file] = (err.loc?.file || err.id || "未知文件").split("?");

        if (err.loc) {
            this.text(".file", `${file}:${err.loc.line}:${err.loc.column}`, true);
        } else if (err.id) {
            this.text(".file", file);
        }

        if (hasFrame) {
            this.text(".frame", err.frame!.trim());
        }

        this.text(".stack", err.stack, true);

        this.root.querySelector(".window")?.addEventListener("click", (e) => {
            e.stopPropagation();
        });

        this.addEventListener("click", () => {
            this.close();
        });
    }

    text(selector: string, text: string, linkFiles = false): void {
        let el = this.root.querySelector(selector)!;

        if (linkFiles === false) {
            el.textContent = text;
            return;
        }

        let currentIndex = 0;
        let match: RegExpMatchArray | null;

        while ((match = FILE_RE.exec(text))) {
            let { 0: file, index } = match;

            if (index !== null) {
                let frag = text.slice(currentIndex, index);

                el.appendChild(document.createTextNode(frag));

                let link = document.createElement("a");
                link.textContent = file;
                link.className = "file-link";

                link.onclick = () => {
                    fetch(`/__open-in-editor?file=${encodeURIComponent(file)}`);
                };

                el.appendChild(link);
                currentIndex += frag.length + file.length;
            }
        }
    }

    close(): void {
        this.parentNode?.removeChild(this);
    }
}

if (customElements.get(OVERLAY_ID) === undefined) {
    customElements.define(OVERLAY_ID, ErrorOverlay);
}

export function hasErrorOverlay(): boolean {
    return document.querySelectorAll(OVERLAY_ID).length !== 0;
}

export function clearErrorOverlay(): void {
    document.querySelectorAll(OVERLAY_ID).forEach((el) => {
        (el as ErrorOverlay).close();
    });
}

export function createErrorOverlay(err: IHMRType.Error["err"]) {
    clearErrorOverlay();

    document.body.appendChild(new ErrorOverlay(err));
}
