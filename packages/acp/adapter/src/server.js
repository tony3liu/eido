// Adapted for Eido from @automatalabs/pi-acp 0.9.4 (Apache-2.0). See ../LICENSE.
import { Readable, Writable } from "node:stream";
import { agent as acpAgent, methods, ndJsonStream, } from "@agentclientprotocol/sdk";
import { PiAcpAgent } from "./agent.js";
import { resolveDeps } from "./deps.js";
import { SESSION_STEERING_METHOD, steeringRequestParser } from "./steering.js";
import { LOADED_TURN_QUERY_METHOD, loadedTurnQueryParser } from "./loaded-turn.js";
export { PiAcpAgent } from "./agent.js";
export async function runAcp(options = {}) {
    const impl = new PiAcpAgent(await resolveDeps(options.deps));
    const app = acpAgent({ name: "@automatalabs/pi-acp" })
        .onRequest(methods.agent.initialize, (context) => impl.initialize(context))
        .onRequest(methods.agent.authenticate, (context) => impl.authenticate(context))
        .onRequest(methods.agent.session.new, (context) => impl.newSession(context))
        .onRequest(methods.agent.session.load, (context) => impl.loadSession(context))
        .onRequest(methods.agent.session.resume, (context) => impl.resumeSession(context))
        .onRequest(methods.agent.session.fork, (context) => impl.forkSession(context))
        .onRequest(methods.agent.session.list, (context) => impl.listSessions(context))
        .onRequest(methods.agent.session.close, (context) => impl.closeSession(context))
        .onRequest(methods.agent.session.delete, (context) => impl.deleteSession(context))
        .onRequest(methods.agent.session.setConfigOption, (context) => impl.setConfigOption(context))
        .onRequest(methods.agent.session.prompt, (context) => impl.prompt(context))
        .onRequest(SESSION_STEERING_METHOD, steeringRequestParser, (context) => impl.steer(context))
        .onRequest("_eido/ui/state", {parse(value) { if (!value || typeof value.sessionId !== "string" || typeof value.instance !== "string" || !Number.isSafeInteger(value.revision) || typeof value.text !== "string") throw new Error("Invalid native editor state"); return value; }}, ({params}) => { const ui = impl.live.get(params.sessionId)?.pi[Symbol.for("eido.pi.ui.state")]; if (!ui) return {handled: false}; ui.receive(params); return {handled: true}; })
        .onRequest("_eido/delivery/status", {parse(value) { if (!value || typeof value.sessionId !== "string" || !Array.isArray(value.ids) || value.ids.length > 256 || value.ids.some(id => typeof id !== "string")) throw new Error("Invalid delivery query"); return value; }}, ({params}) => { const ledger = impl.live.get(params.sessionId)?.pi[Symbol.for("eido.pi.delivery")]; if (!ledger) throw new Error("Load this session before reconciling deliveries"); return ledger.status(params.ids); })
        .onRequest("_eido/ui/complete", {parse(value) { if (!value || typeof value.sessionId !== "string" || typeof value.text !== "string" || !Number.isSafeInteger(value.cursor)) throw new Error("Invalid completion input"); return value; }}, ({params, signal}) => impl.live.get(params.sessionId)?.pi[Symbol.for("eido.pi.autocomplete")]?.complete(params, signal) ?? {handled: false, items: []})
        .onRequest("_eido/ui/shortcut", {parse(value) { if (!value || typeof value.sessionId !== "string" || typeof value.key !== "string" || value.key.length > 100 || typeof value.generation !== "string" || value.generation.length > 100) throw new Error("Invalid shortcut input"); return value; }}, ({params, signal}) => impl.live.get(params.sessionId)?.pi[Symbol.for("eido.pi.shortcuts")]?.invoke(params, signal) ?? {handled: false})
        .onRequest(LOADED_TURN_QUERY_METHOD, loadedTurnQueryParser, (context) => impl.loadedTurnQuery(context))
        .onNotification(methods.agent.session.cancel, (context) => impl.cancel(context));
    const stream = options.stream ?? ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
    const connection = app.connect(stream);
    return { connection, agent: impl };
}
