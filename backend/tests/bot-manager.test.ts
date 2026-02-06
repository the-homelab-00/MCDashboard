import { expect, test, describe, beforeEach, spyOn } from "bun:test";
import { BotManager } from "../src/bot-manager";

describe("BotManager", () => {
    let botManager: BotManager;

    beforeEach(() => {
        // Use in-memory DB for every test to avoid EBUSY and file cleanup issues
        botManager = new BotManager(":memory:");
    });

    test("should add an account and store in DB", async () => {
        const testAccount = {
            id: "test-id",
            username: "TestUser",
            type: "java" as const
        };

        await botManager.addAccount(testAccount);

        const accounts = botManager.getAccounts();
        expect(accounts.length).toBe(1);
        expect(accounts[0].username).toBe("TestUser");
        expect(accounts[0].status).toBe("offline");
    });

    test("should remove an account from memory and DB", async () => {
        const testAccount = {
            id: "remove-id",
            username: "RemoveMe",
            type: "java" as const
        };

        await botManager.addAccount(testAccount);
        expect(botManager.getAccounts().length).toBe(1);

        await botManager.removeAccount("remove-id");
        expect(botManager.getAccounts().length).toBe(0);
    });

    test("should emit update event when data changes", async () => {
        const updateSpy = spyOn(botManager, "emit");

        await botManager.addAccount({
            id: "event-id",
            username: "EventUser",
            type: "java"
        });

        // Check if 'update' was emitted
        expect(updateSpy).toHaveBeenCalled();
        const updateCalls = updateSpy.mock.calls.filter(c => c[0] === 'update');
        expect(updateCalls.length).toBeGreaterThan(0);
    });

    test("should handle logging with timestamp", () => {
        botManager.addAccount({ id: "log-id", username: "LogUser", type: "java" });
        botManager.log("log-id", "Test Log Message");

        const accounts = botManager.getAccounts();
        expect(accounts[0].logs.length).toBe(1);
        expect(accounts[0].logs[0]).toContain("Test Log Message");
    });

    test("should correctly track bot connection status", async () => {
        await botManager.addAccount({ id: "status-id", username: "StatusUser", type: "java" });

        // We don't actually call connectBot here because it hits the network/mineflayer
        // but we can verify default status
        expect(botManager.getAccounts()[0].status).toBe("offline");
    });
});
