import { Elysia, t } from "elysia";
import { cors } from "@elysiajs/cors";
import path from "path";
import { BotManager } from "./src/bot-manager";
import staticPlugin from "@elysiajs/static";

const globalForApp = global as unknown as {
    botManager: BotManager;
    serverId: string;
    app: any;
};

// Ensure BotManager is a singleton
if (!globalForApp.botManager) {
    globalForApp.botManager = new BotManager();
}
const botManager = globalForApp.botManager;

const CURRENT_SERVER_ID = Math.random().toString(36).substring(7);

if (globalForApp.app) {
    console.log(`[${globalForApp.serverId}] 🛑 Shutting down old server...`);
    globalForApp.app.stop();
}
globalForApp.app = null;

const indexHtml = await Bun.file("../frontend/dist/index.html").text();

const app = new Elysia()
    .use(cors())
    .state("botManager", botManager)
    .use(staticPlugin({
        assets: path.join(process.cwd(), "../frontend/dist"),
        prefix: "/",
        alwaysStatic: false,
    }))
    .get("/", async () => {
        const configScript = `
<script>
  window._ENV_ = {
    VITE_API_URL: "${process.env.VITE_API_URL || ""}",
    VITE_WS_URL: "${process.env.VITE_WS_URL || ""}"
  };
</script>`;

        return new Response(
            indexHtml.replace("</head>", `${configScript}</head>`),
            {
                headers: { "Content-Type": "text/html" },
            },
        );
    })
    .ws("/ws", {
        idleTimeout: 30,
        open(ws) {
            console.log('✅ [WS] Client connected, subscribing to "accounts"');
            ws.subscribe("accounts");
            ws.send({ type: "init", accounts: botManager.getAccounts() });
        },
        message(ws, message: { type: string; id?: string }) {
            console.log("📩 [WS] Message received:", message);
            if (message.type === "connect" && message.id) {
                botManager.connectBot(message.id);
            } else if (message.type === "disconnect" && message.id) {
                botManager.disconnectBot(message.id);
            }
        },
        close(ws) {
            ws.unsubscribe("accounts");
            console.log("❌ [WS] Client disconnected");
        },
    })
    .get("/accounts", () => botManager.getAccounts())
    .post("/accounts", ({ body }) => {
        const { username, type } = body as {
            username: string;
            type: "java" | "bedrock";
        };
        console.log(`➕ Adding new account: ${username} (${type})`);
        const id = Math.random().toString(36).substring(7);
        botManager.addAccount({ id, username, type });
        return { success: true, id };
    }, {
        body: t.Object({
            username: t.String(),
            type: t.Union([t.Literal("java"), t.Literal("bedrock")]),
        }),
    })
    .delete("/accounts/:id", ({ params: { id } }) => {
        botManager.removeAccount(id);
        return { success: true };
    });

botManager.removeAllListeners("update");

botManager.on("update", (accounts) => {
    const data = { type: "update", accounts };
    if (app.server) {
        // Send the data (returns bytes)
        const bytesSent = app.server.publish("accounts", JSON.stringify(data));

        // Get actual number of connected tabs
        const activeTabs = app.server.subscriberCount("accounts");

        console.log(
            `📡 [WS] Sent ${bytesSent} bytes to ${activeTabs} active dashboards`,
        );
    }
});

globalForApp.app = app;

const PORT = process.env.PORT || 3001;

if (process.env.NODE_ENV !== "test") {
    app.listen(PORT);
    console.log(
        `🚀 Dashboard Server running at ${app.server?.hostname}:${app.server?.port}`,
    );
}

export { app, botManager };
