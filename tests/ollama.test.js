import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { OllamaEmbedder } from "../src/embedders/ollama.js";
describe("OllamaEmbedder", () => {
    const originalFetch = global.fetch;
    afterEach(() => {
        global.fetch = originalFetch;
    });
    it("embeds text and caches dimensions", async () => {
        global.fetch = jest.fn(async () => ({
            ok: true,
            json: async () => ({ embedding: [0.1, 0.2, 0.3] }),
        }));
        const embedder = new OllamaEmbedder({
            url: "http://localhost:11434",
            model: "nomic-embed-text",
        });
        await expect(embedder.embed("hello")).resolves.toEqual([0.1, 0.2, 0.3]);
        expect(embedder.dimensions).toBe(3);
    });
});
//# sourceMappingURL=ollama.test.js.map