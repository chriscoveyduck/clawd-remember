import { cosineSimilarity } from "../src/utils.js";
export class MockEmbedder {
    dimensions = 3;
    async embed(text) {
        const base = Array.from(text).reduce((sum, char) => sum + char.charCodeAt(0), 0);
        return [base % 7, (base * 3) % 11, (base * 5) % 13];
    }
}
export class MockExtractor {
    facts;
    constructor(facts) {
        this.facts = facts;
    }
    async extract(_conversation) {
        return this.facts;
    }
}
export class InMemoryStorageProvider {
    store = new Map();
    async init() { }
    async insert(id, vector, payload) {
        const existing = Array.from(this.store.entries()).find(([, value]) => value.payload.hash === payload.hash &&
            value.payload.user_id === payload.user_id &&
            value.payload.session_id === payload.session_id);
        const targetId = existing?.[0] ?? id;
        this.store.set(targetId, {
            payload: {
                ...(existing?.[1].payload ?? payload),
                ...payload,
                id: targetId,
            },
            vector,
        });
    }
    async search(vector, topK, filters = {}) {
        return Array.from(this.store.values())
            .filter(({ payload }) => {
            if (filters.user_id && payload.user_id !== filters.user_id) {
                return false;
            }
            if (filters.session_id && payload.session_id !== filters.session_id) {
                return false;
            }
            if (filters.categories?.length) {
                const payloadCategories = payload.categories ?? [];
                return filters.categories.every((category) => payloadCategories.includes(category));
            }
            return true;
        })
            .map(({ payload, vector: storedVector }) => ({
            fact: payload,
            score: cosineSimilarity(vector, storedVector),
        }))
            .sort((a, b) => b.score - a.score)
            .slice(0, topK);
    }
    async get(id) {
        return this.store.get(id)?.payload ?? null;
    }
    async delete(id) {
        this.store.delete(id);
    }
    async list(filters = {}, topK) {
        const items = Array.from(this.store.values())
            .map((value) => value.payload)
            .filter((payload) => {
            if (filters.user_id && payload.user_id !== filters.user_id) {
                return false;
            }
            if (filters.session_id && payload.session_id !== filters.session_id) {
                return false;
            }
            return true;
        })
            .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
        return topK ? items.slice(0, topK) : items;
    }
}
//# sourceMappingURL=helpers.js.map