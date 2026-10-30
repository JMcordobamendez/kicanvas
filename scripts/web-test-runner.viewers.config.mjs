import { fileURLToPath } from "node:url";
import config from "./web-test-runner.config.mjs";
import { esbuildPlugin } from "@web/dev-server-esbuild";

// The tests of the viewers (test/viewers), which draw on a real canvas.
//
// They are compiled with tsconfig.json, like the build: the painters depend on
// useDefineForClassFields being false and the viewers use decorators. The
// other tests were written against esbuild's defaults, so they run with
// web-test-runner.config.mjs.

export default {
    ...config,
    files: "test/viewers/**/*.test.ts",
    plugins: [
        esbuildPlugin({
            ts: true,
            tsconfig: fileURLToPath(new URL("../tsconfig.json", import.meta.url)),
            loaders: {
                ".js": "ts",
                ".glsl": "text",
                ".css": "text",
                ".kicad_pcb": "text",
                ".kicad_sch": "text",
                ".kicad_wks": "text",
                ".kicad_pro": "text",
            },
        }),
    ],
};
