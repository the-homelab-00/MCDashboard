import { Elysia, t } from 'elysia';
import { cors } from '@elysiajs/cors';
import path from 'path';
import { BotManager } from './src/bot-manager';
import staticPlugin from '@elysiajs/static';


const globalForBots = global as unknown as {
    botManager: BotManager;
    isInitialized: boolean;
};

const botManager = globalForBots.botManager || new BotManager();
if (process.env.NODE_ENV !== 'production') {
    globalForBots.botManager = botManager;
}

const app = new Elysia()
    .use(cors())
    .state('botManager', botManager)
    .use(staticPlugin({
        assets: path.join(process.cwd(), '../frontend/dist'),
        prefix: '/',
        alwaysStatic: false,
    }))
    .get('/', async () => {
        let html = await Bun.file('../frontend/dist/index.html').text();
        // Inject variables at runtime from K8s env
        html = html.replace('__VITE_API_URL__', process.env.VITE_API_URL || '');
        html = html.replace('__VITE_WS_URL__', process.env.VITE_WS_URL || '');
        return new Response(html, { headers: { 'Content-Type': 'text/html' } });
    })
    .ws('/ws', {
        open(ws) {
            console.log('✅ [WS] Client connected, subscribing to "accounts"');
            ws.subscribe('accounts');
            ws.send({ type: 'init', accounts: botManager.getAccounts() });
        },
        message(ws, message: { type: string, id?: string }) {
            console.log('📩 [WS] Message received:', message);
            if (message.type === 'connect' && message.id) {
                botManager.connectBot(message.id);
            } else if (message.type === 'disconnect' && message.id) {
                botManager.disconnectBot(message.id);
            }
        },
        close(ws) {
            console.log('❌ [WS] Client disconnected');
        }
    })
    .get('/accounts', () => botManager.getAccounts())
    .post('/accounts', ({ body }) => {
        const { username, type } = body as { username: string, type: 'java' | 'bedrock' };
        console.log(`➕ Adding new account: ${username} (${type})`);
        const id = Math.random().toString(36).substring(7);
        botManager.addAccount({ id, username, type });
        return { success: true, id };
    }, {
        body: t.Object({
            username: t.String(),
            type: t.Union([t.Literal('java'), t.Literal('bedrock')])
        })
    })
    .delete('/accounts/:id', ({ params: { id } }) => {
        botManager.removeAccount(id);
        return { success: true };
    });



const broadcastUpdate = (accounts: any) => {
    const data = { type: 'update', accounts };
    if (app.server) {
        const count = app.server.publish('accounts', JSON.stringify(data));
        console.log(`📡 [WS] Published to ${count} subscribers`);
    }
};


botManager.removeAllListeners('update');
if (!globalForBots.isInitialized) {
    botManager.on('update', broadcastUpdate);
    globalForBots.isInitialized = true;
}

const PORT = process.env.PORT || 3001;

if (process.env.NODE_ENV !== 'test') {
    app.listen(PORT);
    console.log(`🚀 Dashboard Server running at ${app.server?.hostname}:${app.server?.port}`);
}

export { app, botManager };
