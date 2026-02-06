import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { treaty } from "@elysiajs/eden";
import { app, botManager } from "../server";

interface WSMessage {
    type: 'init' | 'update';
    accounts: any[]; // BotAccount type could be used here if exported
}

describe("WebSocket Server with Eden Treaty (Pattern Match)", () => {
    let api: ReturnType<typeof treaty<typeof app>>;
    let server: any; // server instance type from Elysia is complex, but and 'any' here is less critical than logic types

    beforeAll(async () => {
        server = await app.listen(0);
        const port = server.server?.port;
        if (!port) throw new Error("Server port undefined");

        api = treaty<typeof app>(`http://localhost:${port}`);

        // Ensure botManager is empty for tests
        const accounts = botManager.getAccounts();
        for (const acc of accounts) {
            await botManager.removeAccount(acc.id);
        }
    });

    afterAll(() => {
        if (server) server.stop();
    });

    test("should receive init data on connection", async () => {
        const ws = api.ws.subscribe();

        const message = await new Promise<WSMessage>((resolve, reject) => {
            const timeout = setTimeout(() => reject("Timeout waiting for init"), 5000);

            ws.subscribe((msg) => {
                const data = (msg.data || msg) as WSMessage;
                if (data.type === 'init') {
                    clearTimeout(timeout);
                    resolve(data);
                }
            });
        });

        expect(message.type).toBe("init");
        expect(Array.isArray(message.accounts)).toBe(true);
        ws.close();
    });

    test("should receive real-time update when account is added", async () => {
        const ws = api.ws.subscribe();

        // Wait for connection and init message first
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject("Timeout waiting for init in update test"), 5000);
            ws.subscribe((msg) => {
                const data = (msg.data || msg) as WSMessage;
                if (data.type === 'init') {
                    clearTimeout(timeout);
                    resolve(null);
                }
            });
        });

        const updatePromise = new Promise<WSMessage>((resolve, reject) => {
            const timeout = setTimeout(() => reject("Timeout waiting for update broadcast"), 5000);

            ws.subscribe((msg) => {
                const data = (msg.data || msg) as WSMessage;
                if (data.type === "update") {
                    clearTimeout(timeout);
                    resolve(data);
                }
            });
        });

        // Small delay to ensure subscription is active on server
        await new Promise(r => setTimeout(r, 100));

        // Trigger an account addition
        await botManager.addAccount({
            id: "ws-test-bot-final",
            username: "FinalBot",
            type: "java"
        });

        const update = await updatePromise;
        expect(update.type).toBe("update");
        expect(update.accounts.some((a: any) => a.id === "ws-test-bot-final")).toBe(true);

        ws.close();
    });

    test("should handle incoming messages for controls", async () => {
        const ws = api.ws.subscribe();

        // Wait for connection to be ready
        await new Promise(r => setTimeout(r, 200));

        // Use .send directly on the treaty object
        ws.send({ type: "connect", id: "non-existent" });

        // Just verify no crashes
        await new Promise(r => setTimeout(r, 200));

        ws.close();
    });
});
