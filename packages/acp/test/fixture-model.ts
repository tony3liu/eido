import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage, type ToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export type FixtureStep = (context: TranscriptContext, signal?: AbortSignal) => ToolCall[] | string | Promise<ToolCall[] | string>;

export async function fixtureModel(directory: string, steps: FixtureStep[]) {
  const runtime = await ModelRuntime.create({
    authPath: join(directory, "fixture-auth.json"), modelsPath: null,
    modelsStorePath: join(directory, "fixture-models.json"), refreshOnCreate: false,
  });
  let requests = 0;
  runtime.registerProvider("eido-fixture", {
    name: "Local deterministic test fixture", api: "eido-fixture", baseUrl: "http://127.0.0.1/unused",
    apiKey: "fixture-never-sent", models: [{
      id: "scripted", name: "Scripted (no inference)", reasoning: false, input: ["text", "image"],
      contextWindow: 128000, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(async () => {
        try {
          const output = await steps[requests++]?.(context, options?.signal) ?? "Fixture complete. No model inference was performed.";
          const message: AssistantMessage = {
            role: "assistant", api: model.api, provider: model.provider, model: model.id,
            content: typeof output === "string" ? [{ type: "text", text: output }] : output,
            stopReason: typeof output === "string" ? "stop" : "toolUse", timestamp: Date.now(),
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          };
          stream.push({ type: "start", partial: message });
          if (typeof output === "string") {
            stream.push({ type: "text_start", contentIndex: 0, partial: message });
            stream.push({ type: "text_delta", contentIndex: 0, delta: output, partial: message });
            stream.push({ type: "text_end", contentIndex: 0, content: output, partial: message });
          }
          stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
          stream.end();
        } catch (error) {
          if (!options?.signal?.aborted) console.error("Deterministic model assertion failed:", error);
          const message: AssistantMessage = {
            role: "assistant", api: model.api, provider: model.provider, model: model.id,
            content: [], stopReason: options?.signal?.aborted ? "aborted" : "error", errorMessage: String(error), timestamp: Date.now(),
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          };
          stream.push({ type: "error", reason: options?.signal?.aborted ? "aborted" : "error", error: message });
          stream.end();
        }
      });
      return stream;
    },
  });
  return { runtime, requests: () => requests };
}

export const call = (name: string, args: ToolCall["arguments"] = {}): ToolCall[] => [{
  type: "toolCall", id: `fixture-${crypto.randomUUID()}`, name, arguments: args,
}];

export function lastToolText(context: TranscriptContext, name: string) {
  const result = context.messages.findLast((message) => message.role === "toolResult" && message.toolName === name);
  if (!result || result.role !== "toolResult") throw new Error(`Missing tool result: ${name}`);
  if (result.isError) throw new Error(`Tool failed: ${JSON.stringify(result.content)}`);
  return result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}
