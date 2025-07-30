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

[Visual Coding IDE](https://vicode.jokers.pub)
