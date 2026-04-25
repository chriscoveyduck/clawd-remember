import type { Embedder, FactPayload, Filters, LLMExtractor, Message, SearchResult, StorageProvider } from "../src/types.js";
export declare class MockEmbedder implements Embedder {
    readonly dimensions = 3;
    embed(text: string): Promise<number[]>;
}
export declare class MockExtractor implements LLMExtractor {
    private readonly facts;
    constructor(facts: string[]);
    extract(_conversation: Message[]): Promise<string[]>;
}
export declare class InMemoryStorageProvider implements StorageProvider {
    private readonly store;
    init(): Promise<void>;
    insert(id: string, vector: number[], payload: FactPayload): Promise<void>;
    search(vector: number[], topK: number, filters?: Filters): Promise<SearchResult[]>;
    get(id: string): Promise<FactPayload | null>;
    delete(id: string): Promise<void>;
    list(filters?: Filters, topK?: number): Promise<FactPayload[]>;
}
