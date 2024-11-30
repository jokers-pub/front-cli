module.exports = {
    build: {
        write: false,
        minify: "terser",
        rollupOptions: {
            input: {
                polyfills: "./main.js"
            },
            output: {
                format: "iife"
            }
        }
    },
    esbuild: false
};
