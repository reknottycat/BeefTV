import { describe, expect, test } from "bun:test";

import { createClientId } from "../src/lib/client-id";

describe("createClientId", () => {
    test("works when the HTTP context does not expose randomUUID", () => {
        const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");
        const httpCrypto = { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) };
        Object.defineProperty(globalThis, "crypto", { configurable: true, value: httpCrypto });
        try {
            expect("randomUUID" in globalThis.crypto).toBe(false);
            const ids = Array.from({ length: 100 }, () => createClientId());
            expect(new Set(ids).size).toBe(ids.length);
            ids.forEach((id) => expect(id).toMatch(/^[A-Za-z0-9_-]{21}$/));
        } finally {
            if (originalCrypto) Object.defineProperty(globalThis, "crypto", originalCrypto);
            else Reflect.deleteProperty(globalThis, "crypto");
        }
    });

    test("生成不依赖 randomUUID 的唯一客户端标识", () => {
        const ids = Array.from({ length: 100 }, () => createClientId());

        expect(new Set(ids).size).toBe(ids.length);
        ids.forEach((id) => expect(id).toMatch(/^[A-Za-z0-9_-]{21}$/));
    });
});
