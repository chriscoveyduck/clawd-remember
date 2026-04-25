import { describe, expect, it, jest } from "@jest/globals";
import { createPlugin } from "../src/index.js";
import { MockEmbedder, InMemoryStorageProvider } from "./helpers.js";
class TestExtractor {
    async extract(conversation) {
        return conversation.map((message) => `Fact: ${message.content}`);
    }
}
describe("plugin entry", () => {
    const config = {
        storage: {
            provider: "sqlite",
            config: { path: "/tmp/test.db" },
        },
        embedder: {
            provider: "ollama",
            config: { url: "http://localhost:11434", model: "nomic-embed-text" },
        },
        llm: {
            provider: "openai-compatible",
            config: { baseURL: "http://localhost:4141/v1", model: "gpt-4o-mini", apiKey: "dummy" },
        },
        userId: "user-1",
        autoRecall: true,
        autoCapture: true,
        topK: 5,
        recallTimeout: 1000,
        captureTimeout: 1000,
    };
    it("captures facts after an agent turn", async () => {
        const plugin = createPlugin({
            createStorageProvider: () => new InMemoryStorageProvider(),
            createEmbedder: () => new MockEmbedder(),
            createExtractor: () => new TestExtractor(),
        });
        const context = await plugin.hooks.after_agent_turn({
            config,
            messages: [{ role: "user", content: "User likes tea" }],
            logger: { warn: jest.fn() },
        });
        expect(context.messages).toHaveLength(1);
    });
    it("injects recall results before prompt build", async () => {
        const plugin = createPlugin({
            createStorageProvider: () => new InMemoryStorageProvider(),
            createEmbedder: () => new MockEmbedder(),
            createExtractor: () => new TestExtractor(),
        });
        const baseContext = {
            config,
            messages: [{ role: "user", content: "User likes tea" }],
            prompt: "What drink does the user prefer?",
            logger: { warn: jest.fn() },
        };
        await plugin.hooks.after_agent_turn(baseContext);
        const updated = await plugin.hooks.before_prompt_build(baseContext);
        expect(updated.prompt).toContain("Relevant memory:");
    });
    it("executes registered tools", async () => {
        const plugin = createPlugin({
            createStorageProvider: () => new InMemoryStorageProvider(),
            createEmbedder: () => new MockEmbedder(),
            createExtractor: () => new TestExtractor(),
        });
        const addTool = plugin.tools.find((tool) => tool.name === "memory_add");
        const searchTool = plugin.tools.find((tool) => tool.name === "memory_search");
        await addTool?.execute({ text: "User likes tea" }, { config, logger: { warn: jest.fn() } });
        const results = await searchTool?.execute({ query: "tea" }, { config, logger: { warn: jest.fn() } });
        expect(results[0]?.fact.data).toBe("Fact: User likes tea");
    });
});
//# sourceMappingURL=index.test.js.map