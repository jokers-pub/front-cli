# Joker CLI Project ![NPM Version](https://img.shields.io/npm/v/%40joker.front%2Fcli)

The Next-Generation Front-End Toolchain: Swift, Efficient, and Adaptive.

## Features

-   **ESM (Module) Support**: Joker CLI embraces the ESM (EcmaScript Modules) mode. This empowers it to harness the latest JavaScript module standard and offer on-demand compilation. This mode not only augments loading efficiency but also ensures that only the code truly required by the user is compiled and parsed, thereby remarkably enhancing the application's responsiveness and performance.
-   **Asynchronous Static Scanning of Front-End Entry Dependencies**: The asynchronous static scanning of front-end entry dependencies is executed without impeding the main thread. This transforms the pre-compilation of third-party dependencies into directly executable files. This characteristic is especially conspicuous during cold start, capable of substantially diminishing application startup time and optimizing user experience.
-   **Hot Module Replacement (HMR) Functionality**: The support for hot module replacement enables developers to instantaneously witness the effects of code alterations while the application is running, eliminating the necessity to reload the page or restart the application. This is of utmost significance for augmenting development efficiency and iteration speed.
-   **Adherence to Rollup Plugin Specification**: Conforming to the Rollup plugin specification allows Joker CLI to seamlessly integrate with the widely adopted Rollup plugin ecosystem, endowing developers with extensive flexibility and expandability.
-   **Production Build Support**: Joker CLI backs production environment builds, signifying that it can generate optimized code for the production environment, facilitating developers in creating high-performance, optimized applications.
-   **Support for Joker Syntax Compilation**: The Joker SFC plugin is employed for compiling Joker files and is deeply integrated with HRM (Hot Module Replacement), exhibiting outstanding performance.
-   **Low-Code Platform Internal Compilation**: It internally integrates real-time compilation capabilities for the low-code platform, boasting remarkable performance, rapid responsiveness, and timely operation.

## Installation and Usage

```
pnpm add @joker.front/cli
```

It furnishes two commands, "server" and "build", which respectively denote development and production build. It also has internal integration for parsing Joker SFC files.

## Documentation

[Official Website](https://www.jokers.pub)

[Help Documentation](https://front.jokers.pub/cli/introduction)

[Low-Code Platform](https://lowcode.jokers.pub)

# Joker CLI 脚手架项目

下一代前端工具链：快速、高效、适配。

## 特点

-   **ESM（模块化）支持**：Joker CLI 支持 ESM（EcmaScript 模块）模式。这意味着它能够利用最新的 JavaScript 模块标准，提供按需编译功能。此模式不仅提升了加载效率，还确保只有用户实际所需的代码才会被编译与解析，从而显著增强应用的响应速度与性能。
-   **前端入口依赖异步静态扫描**：对前端入口依赖采用异步方式进行静态扫描，可在不阻塞主线程的情况下执行。如此一来，三方依赖的预编译得以转换为可直接运行的文件。该特性在冷启动时格外显著，能够大幅削减应用的启动时间，优化用户体验。
-   **热更新功能**：支持热更新表示开发者在应用运行时可即时看到代码更改的效果，无需重新加载页面或重启应用，这对于提高开发效率和迭代速度极为关键。
-   **遵循 rollup 插件规范**：遵循 rollup 插件规范使得 Joker CLI 能与广泛运用的 rollup 插件生态系统无缝对接，为开发者赋予极大的灵活性与扩展性。
-   **生产构建支持**：Joker CLI 支持生产环境构建，意味着它能够生成适用于生产环境的优化代码，助力开发者打造高性能、优化的应用程序。
-   **支持 Joker 语法编译**：运用 Joker SFC 插件来编译 Joker 文件，并深度整合 HRM 热更新，性能卓越。
-   **低代码平台内部编译**：内部集成了低代码平台的实时编译能力，性能超凡，响应快速且及时。

## 安装使用

```
pnpm add @joker.front/cli
```

提供“server”和“build”两种命令，分别代表开发和生产构建，并且内部集成了对 Joker SFC 文件的解析功能。

## 文档

[官网](https://www.jokers.pub)

[帮助文档](https://front.jokers.pub/cli/introduction)

[低代码平台](https://lowcode.jokers.pub)
