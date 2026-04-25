import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { OpenAICompatibleExtractor } from "../src/extractors/openai.js";
describe("OpenAICompatibleExtractor", () => {
    const originalFetch = global.fetch;
    afterEach(() => {
        global.fetch = originalFetch;
    });
    it("extracts facts from a JSON response", async () => {
        global.fetch = jest.fn(async () => ({
            ok: true,
            json: async () => ({
                choices: [
                    {
                        message: {
                            content: JSON.stringify({
                                facts: ["User runs Astro 6 on Cloudflare Workers"],
                            }),
                        },
                    },
                ],
            }),
        }));
        const extractor = new OpenAICompatibleExtractor({
            baseURL: "http://localhost:4141/v1",
            model: "gpt-4o-mini",
            apiKey: "dummy",
        });
        await expect(extractor.extract([{ role: "user", content: "test" }]))
            .resolves
            .toEqual(["User runs Astro 6 on Cloudflare Workers"]);
    });
});
//# sourceMappingURL=openai.test.js.map