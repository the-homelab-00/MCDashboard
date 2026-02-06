import { EventEmitter } from 'events';
import { existsSync, mkdirSync } from 'fs';
import mineflayer from 'mineflayer';
import { createClient } from 'bedrock-protocol';
import { Database } from 'bun:sqlite';
import path from 'path';

const IS_CONTAINER = existsSync('/.dockerenv') || process.env.KUBERNETES_SERVICE_HOST;
const DATA_ROOT = IS_CONTAINER ? '/data' : path.join(process.cwd(), 'data');

// Ensure the local data directory exists during dev
if (!existsSync(DATA_ROOT)) {
    mkdirSync(DATA_ROOT, { recursive: true });
}

export type BotType = 'java' | 'bedrock';

export interface BotStats {
    shards: number;
    money: number;
    kills: number;
    deaths: number;
}

export interface BotAccount {
    id: string;
    username: string;
    type: BotType;
    status: 'online' | 'offline' | 'connecting' | 'error';
    logs: string[];
    accountData: BotStats;
}



export class BotManager extends EventEmitter {
    private bots: Map<string, any> = new Map();
    private accounts: Map<string, BotAccount> = new Map();
    private db: Database;

    constructor(dbPath: string = path.join(DATA_ROOT, 'accounts.db')) {
        super();
        this.db = new Database(dbPath, { create: true });
        this.initDb();
        this.loadAccounts();
    }

    private initDb() {
        this.db.query(`
            CREATE TABLE IF NOT EXISTS accounts (
                id TEXT PRIMARY KEY,
                username TEXT,
                type TEXT
            )
        `).run();
    }

    private loadAccounts() {
        const rows = this.db.query('SELECT * FROM accounts').all() as { id: string, username: string, type: string }[];
        for (const row of rows) {
            this.accounts.set(row.id, {
                id: row.id,
                username: row.username,
                type: row.type as BotType,
                status: 'offline',
                logs: [],
                accountData: { shards: 0, money: 0, kills: 0, deaths: 0 }
            });
        }
    }

    async addAccount(account: { id: string, username: string, type: BotType }) {
        this.db.query('INSERT INTO accounts (id, username, type) VALUES (?, ?, ?)')
            .run(account.id, account.username, account.type);

        this.accounts.set(account.id, {
            ...account,
            status: 'offline',
            logs: [],
            accountData: { shards: 0, money: 0, kills: 0, deaths: 0 }
        });
        this.emit('update', this.getAccounts());
    }

    async removeAccount(id: string) {
        await this.disconnectBot(id);
        this.db.query('DELETE FROM accounts WHERE id = ?').run(id);
        this.accounts.delete(id);
        this.emit('update', this.getAccounts());
    }

    getAccounts(): BotAccount[] {
        return Array.from(this.accounts.values());
    }

    log(id: string, message: string) {
        const account = this.accounts.get(id);
        if (account) {
            account.logs.push(`[${new Date().toLocaleTimeString()}] ${message}`);
            if (account.logs.length > 100) account.logs.shift();
            this.emit('update', this.getAccounts());
        }
    }

    async connectBot(id: string) {
        const account = this.accounts.get(id);
        if (!account || account.status === 'online') return;

        account.status = 'connecting';
        this.emit('update', this.getAccounts());
        this.log(id, `Connecting to ${process.env.SERVER_IP} (${account.type})...`);

        if (account.type === 'java') {
            this.connectJava(id, account.username);
        } else {
            this.connectBedrock(id, account.username);
        }
    }

    private connectJava(id: string, username: string) {
        try {
            const bot = mineflayer.createBot({
                host: process.env.SERVER_IP,
                username: username,
                auth: 'microsoft',
                version: '1.20.2',
                profilesFolder: path.join(DATA_ROOT, 'sessions/java', username),
                onMsaCode: (data) => {
                    const directLink = `https://www.microsoft.com/link?otc=${data.user_code}`
                    this.log(id, `Login Link: ${directLink}`)
                    console.log(`Login Link: ${directLink}`)
                }
            });


            bot.on("windowOpen", (window) => {
                // Find item where Lore matches the random teleport description
                const item = window.slots.find(slot => {
                    if (!slot || !slot.nbt) return false
                    // Mineflayer stores lore in NBT. Check for the specific phrase.
                    const nbt = JSON.stringify(slot.nbt).toLowerCase()
                    return nbt.includes('click to teleport to a random afk area')
                })

                if (item) {
                    this.log(id, `Clicking button index ${item.slot}...`)
                    console.log(`\x1b[35mFound Random AFK in slot ${item.slot}. Clicking...\x1b[0m`)
                    bot.clickWindow(item.slot, 0, 0)
                } else {
                    this.log(id, `Could not find the Random AFK item`)
                    console.log(`\x1b[31mCould not find the Random AFK item.\x1b[0m`)
                }
            })

            bot.on('login', () => {
                const account = this.accounts.get(id);
                if (account) {
                    account.status = 'online';
                    this.log(id, 'Logged in successfully!');
                    this.emit('update', this.getAccounts());
                }
            });

            bot._client.on('teams', (packet) => {
                const account = this.accounts.get(id);
                if (!account) return;

                try {
                    // 1. Parse the JSON Prefix
                    const prefixData = JSON.parse(packet.prefix);
                    let fullText = "";

                    // 2. Extract text from the "extra" array or base "text" property
                    if (prefixData.text) fullText += prefixData.text;
                    if (prefixData.extra) {
                        fullText += prefixData.extra.map((item: any) => item.text).join("");
                    }

                    // 3. Send the flattened text to your stat updater
                    if (fullText) {
                        this.updateStat(id, fullText);
                    }
                } catch (e) {
                    // If it's not JSON (old style), just send the raw string
                    this.updateStat(id, packet.prefix);
                }
            });

            bot.on('scoreUpdated', (scoreboard, updated: any) => {
                const item = scoreboard.items.find(i => i.value === updated.value);

                const account = this.accounts.get(id);
                if (!item || !account) return;

                const text = item.displayName ? item.displayName.toString() : item.name;
                const cleanText = text.replace(/§[0-9a-fk-or]/g, '');

                // Helper to extract number and update if different
                const updateNumericStat = (key: keyof typeof account.accountData, searchStr: string) => {
                    if (cleanText.includes(searchStr)) {
                        // 1. Extract just the number and the suffix (e.g., "1.22m" from "Money 1.22m§")
                        // This regex finds digits, dots, and k/m/b, ignoring everything else
                        const match = cleanText.toLowerCase().match(/(\d+\.?\d*)([kmb])?/);

                        if (match && match[1]) {
                            const numPart = parseFloat(match[1]) || 0;
                            const suffix = match[2];

                            let multiplier = 1;
                            if (suffix === 'k') multiplier = 1_000;
                            else if (suffix === 'm') multiplier = 1_000_000;
                            else if (suffix === 'b') multiplier = 1_000_000_000;

                            const finalVal = numPart * multiplier;

                            if (account.accountData[key] !== finalVal) {
                                account.accountData[key] = finalVal;
                                return true;
                            }
                        }
                    }
                    return false;
                };

                const shardsChanged = updateNumericStat('shards', 'Shards');
                const moneyChanged = updateNumericStat('money', 'Money');

                if (shardsChanged || moneyChanged) {
                    this.emit('update', this.getAccounts());
                }
            });

            bot.on('spawn', () => {
                this.log(id, 'Spawned in world.');
                setTimeout(() => { bot.chat('/afk') }, 2000)
            });

            bot.on('message', (username, message) => {
                this.log(id, `<${username}> ${message}`);
            });

            // --- ADDED: Kicked Event ---
            bot.on('kicked', (reason) => {
                let reasonMsg = reason;
                // Parse JSON reasons if necessary
                if (typeof reason !== 'string') {
                    try {
                        reasonMsg = JSON.stringify(reason);
                    } catch (e) {
                        reasonMsg = 'Unknown JSON reason';
                    }
                }
                this.log(id, `❌ Kicked: ${reasonMsg}`);
            });

            bot.on('error', (err) => {
                this.log(id, `Error: ${err.message}`);
                const account = this.accounts.get(id);
                if (account) account.status = 'error';
                this.emit('update', this.getAccounts());
            });

            // --- UPDATED: End Event with Reason ---
            bot.on('end', (reason) => {
                this.log(id, `Bot disconnected. Reason: ${reason || 'Socket closed'}`);
                const account = this.accounts.get(id);
                if (account) account.status = 'offline';
                this.emit('update', this.getAccounts());
            });

            this.bots.set(id, bot);
        } catch (err: any) {
            this.log(id, `Connection failed: ${err.message}`);
        }
    }

    private updateStat(id: string, rawText: string) {

        if (!rawText || rawText === "undefined") return;

        const account = this.accounts.get(id);
        if (!account) return;

        // 1. Unified Cleanup: Strips Minecraft codes, icons, and whitespace
        const clean = rawText.replace(/§./g, '').replace(/[★$🗡☠⌛⌚]/g, '').toLowerCase();

        // 2. Identification Logic
        const label = ['money', 'shards'].find(l => clean.includes(l));



        if (!label) return;

        // 3. Extraction: Get everything after the label
        const valuePart = clean.split(label)[1]?.trim() || "";
        const match = valuePart.match(/(\d+\.?\d*)([kmb])?/);

        if (match && match[1]) {
            const numPart = parseFloat(match[1]);
            const suffix = match[2];
            const multiplier = { k: 1e3, m: 1e6, b: 1e9 }[suffix as string] || 1;
            const finalVal = numPart * multiplier;

            const key = label as 'money' | 'shards';
            if (account.accountData[key] !== finalVal) {
                account.accountData[key] = finalVal;
                this.emit('update', this.getAccounts());
            }
        }
    }

    private connectBedrock(id: string, username: string) {
        try {
            const client = createClient({
                host: process.env.SERVER_IP,
                port: 19132,
                username: username,
                offline: false,
                profilesFolder: path.join(DATA_ROOT, 'sessions/bedrock', username),
                onMsaCode: (data) => {
                    const directLink = `https://www.microsoft.com/link?otc=${data.user_code}`
                    this.log(id, `Login Link: ${directLink}`)
                    console.log(`Login Link: ${directLink}`)
                }
            });

            client.on('spawn', () => {
                const account = this.accounts.get(id);
                if (account) {
                    account.status = 'online';
                    this.log(id, 'Bedrock bot spawned!');
                    this.emit('update', this.getAccounts());
                }
            });

            client.on('modal_form_request', (packet) => {
                const formData = JSON.parse(packet.data)
                // Bedrock buttons usually put lore in the button text or subtext
                const btnIdx = formData.buttons.findIndex(b => {
                    const txt = b.text.toLowerCase()
                    return txt.includes('random afk area') || txt.includes('click to teleport')
                })

                const targetIdx = btnIdx !== -1 ? btnIdx : 0
                this.log(id, `Clicking button index ${targetIdx}...`)
                console.log(`Clicking button index ${targetIdx}...`)

                client.queue('modal_form_response', {
                    form_id: packet.form_id,
                    data: JSON.stringify(targetIdx)
                })
            })

            client.on('text', (packet) => {
                this.log(id, `[CHAT] ${packet.message}`);
            });



            client.on('set_score', (packet) => {
                packet.entries.forEach(e => this.updateStat(id, e.custom_name || e.fake_player));
            });

            // --- ADDED: Bedrock Kick Event ---
            client.on('kick', (packet) => {
                this.log(id, `❌ Kicked: ${packet.message}`);
            });

            client.on('error', (err) => {
                this.log(id, `Bedrock Error: ${err.message}`);
                const account = this.accounts.get(id);
                if (account) account.status = 'error';
                this.emit('update', this.getAccounts());
            });

            client.on('close', () => {
                this.log(id, 'Bedrock connection closed.');
                const account = this.accounts.get(id);
                if (account) account.status = 'offline';
                this.emit('update', this.getAccounts());
            });

            this.bots.set(id, client);
        } catch (err: any) {
            this.log(id, `Bedrock Connection failed: ${err.message}`);
        }
    }

    async disconnectBot(id: string) {
        const bot = this.bots.get(id);
        if (bot) {
            // Log user-initiated disconnect
            this.log(id, '🔌 Disconnecting manually...');

            if (this.accounts.get(id)?.type === 'java') {
                bot.quit();
            } else {
                bot.close();
            }
            this.bots.delete(id);
        }
    }

    close() {
        this.db.close();
    }
}