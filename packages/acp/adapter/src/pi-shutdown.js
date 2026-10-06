// Adapted for Eido from @automatalabs/pi-acp 0.9.4 (Apache-2.0). See ../LICENSE.
// Shut pi down the way pi shuts itself down.
//
// `AgentSession.dispose()` aborts in-flight work and marks the extension context stale — it does
// NOT tell extensions the session is over. Pi's own hosts never call it bare: the interactive mode
// exits through `AgentSessionRuntime.dispose()`, which is exactly
//
//     await emitSessionShutdownEvent(session.extensionRunner, { type: "session_shutdown", reason: "quit" });
//     session.dispose();
//
// The `session_shutdown` event is where extensions release what they own — including any process
// an extension spawned (pi's own MCP servers among them). Calling `dispose()` without it leaves
// those children running. Because pi-acp embeds pi IN-PROCESS, an unreaped grandchild is our
// grandchild: its ChildProcess handle keeps our event loop alive and the process cannot exit. The
// other ACP backends never see this — they run out-of-process, so the OS reaps their tree.
//
// The SDK's `emitSessionShutdownEvent` helper is not exported from the package entry, so this
// reproduces its two-line body against public API (`session.extensionRunner`, `hasHandlers`,
// `emit`) rather than reaching into internals.
//
// NEVER throws: this runs on the disposal path, where a misbehaving extension handler must not be
// able to strand cleanup. A handler that hangs is bounded by the caller's disposal deadline.
export async function emitPiSessionShutdown(session) {
    try {
        const runner = session.extensionRunner;
        if (!runner?.hasHandlers("session_shutdown"))
            return false;
        await runner.emit({ type: "session_shutdown", reason: "quit" });
        return true;
    }
    catch (error) {
        console.error("pi-acp session_shutdown emit error:", error);
        return false;
    }
}
/** `session_shutdown` then `dispose()` — pi's full teardown, in pi's order. */
export async function shutdownPiSession(session) {
    await emitPiSessionShutdown(session);
    try { await session[Symbol.for("eido.pi.ui.close")]?.(); } finally { session.dispose(); }
}
