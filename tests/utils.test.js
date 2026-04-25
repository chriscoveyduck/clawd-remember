import { describe, expect, it } from "@jest/globals";
import { createFactPayload, hashFact, withTimeout } from "../src/utils.js";
describe("utils", () => {
    it("creates stable hashes", () => {
        expect(hashFact("hello")).toBe(hashFact("hello"));
    });
    it("creates fact payloads", () => {
        const payload = createFactPayload("User likes coffee", "user-1", "session-1", ["prefs"]);
        expect(payload.data).toBe("User likes coffee");
        expect(payload.user_id).toBe("user-1");
        expect(payload.session_id).toBe("session-1");
        expect(payload.categories).toEqual(["prefs"]);
    });
    it("enforces timeouts", async () => {
        await expect(withTimeout(new Promise((resolve) => setTimeout(resolve, 50)), 1, "slow task"))
            .rejects
            .toThrow("slow task timed out after 1ms");
    });
});
//# sourceMappingURL=utils.test.js.map