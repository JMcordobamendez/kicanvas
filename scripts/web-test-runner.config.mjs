import { defaultReporter, summaryReporter } from "@web/test-runner";
//import { chromeLauncher } from "@web/test-runner-chrome";
import { esbuildPlugin } from "@web/dev-server-esbuild";

// https://modern-web.dev/docs/test-runner/cli-and-configuration/

export default {
    // test/viewers needs the build's compiler settings: scripts/web-test-runner.viewers.config.mjs
    files: ["test/**/*.test.ts", "!test/viewers/**"],
    nodeResolve: true,
    debugger: true,
    // browsers: [
    //     chromeLauncher({
    //         concurrency: 1,
    //         launchOptions: {
    //             devtools: true,
    //         },
    //     }),
    // ],
    plugins: [
        esbuildPlugin({
            ts: true,
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
    reporters: [
        defaultReporter({ reportTestResults: true, reportTestProgress: true }),
        summaryReporter(),
    ],
    testFramework: {
        config: {
            ui: "tdd",
        },
    },
};
