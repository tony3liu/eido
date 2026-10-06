// Adapted for Eido from @automatalabs/pi-acp 0.9.4 (Apache-2.0). See ../LICENSE.
export function agentMessages(session) {
    return session.agent.state.messages;
}
export function assistantMessages(messages) {
    return messages.filter((message) => typeof message === "object" && message !== null && message.role === "assistant");
}
export function terminalAssistant(messages) {
    return assistantMessages(messages).at(-1);
}
export function promptUsage(messages) {
    const assistants = assistantMessages(messages);
    const sum = (key) => assistants.reduce((total, message) => total + (message.usage[key] ?? 0), 0);
    const usage = {
        inputTokens: sum("input"),
        outputTokens: sum("output"),
        cachedReadTokens: sum("cacheRead"),
        cachedWriteTokens: sum("cacheWrite"),
        totalTokens: sum("totalTokens"),
    };
    if (assistants.some((message) => message.usage.reasoning !== undefined)) {
        usage.thoughtTokens = sum("reasoning");
    }
    return usage;
}
export function usageUpdate(session) {
    const context = session.getContextUsage();
    return {
        sessionUpdate: "usage_update",
        used: context?.tokens ?? 0,
        size: context?.contextWindow ?? session.model?.contextWindow ?? 0,
        cost: { amount: session.getSessionStats().cost, currency: "USD" },
    };
}
export function response(stopReason, messages) {
    return { stopReason, usage: promptUsage(messages) };
}
