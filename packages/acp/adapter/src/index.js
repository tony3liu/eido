// Adapted for Eido from @automatalabs/pi-acp 0.9.4 (Apache-2.0). See ../LICENSE.
#!/usr/bin/env node
// No static pi/SDK/adapter imports: stdout is reserved before module evaluation.
if (process.argv.includes("--version") || process.argv.includes("-v")) {
    const manifest = await import("../package.json", { with: { type: "json" } }).then((module) => module.default);
    process.stdout.write(`${manifest.version}\n`);
    process.exit(0);
}
console.log = console.error;
console.info = console.error;
console.warn = console.error;
console.debug = console.error;
process.on("unhandledRejection", (reason) => {
    console.error("unhandledRejection:", reason);
});
function withTimeout(promise, milliseconds) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("shutdown timed out")), milliseconds);
        promise.then((value) => {
            clearTimeout(timer);
            resolve(value);
        }, (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}
try {
    const { runAcp } = await import("./server.js");
    const { connection, agent } = await runAcp();
    let shuttingDown;
    const shutdown = (code) => {
        shuttingDown ??= (async () => {
            try {
                await withTimeout(agent.dispose(), 66_000);
                process.exit(code);
            }
            catch {
                console.error("shutdown cleanup failed");
                process.exit(1);
            }
        })();
        return shuttingDown;
    };
    connection.closed.then(() => shutdown(0), () => shutdown(1));
    process.on("SIGTERM", () => { void shutdown(0); });
    process.on("SIGINT", () => { void shutdown(0); });
    process.stdin.resume();
}
catch (error) {
    console.error("startup error:", error);
    process.exit(1);
}
export {};
