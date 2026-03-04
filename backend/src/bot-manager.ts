import { EventEmitter } from "events";
import { existsSync, mkdirSync } from "fs";
import mineflayer from "mineflayer";
import decancer from "decancer";
import { Database } from "bun:sqlite";
import path from "path";

const IS_CONTAINER = existsSync("/.dockerenv") ||
    process.env.KUBERNETES_SERVICE_HOST;
const DATA_ROOT = IS_CONTAINER ? "/data" : path.join(process.cwd(), "data");

// Ensure the local data directory exists during dev
if (!existsSync(DATA_ROOT)) {
    mkdirSync(DATA_ROOT, { recursive: true });
}

export type BotType = "java" | "bedrock";

export interface BotStats {
    shards: number;
    money: number;
    kills: number;
    deaths: number;
    keys: Record<Crates, number>;
}

const SILENT_PACKETS = [
    'map_chunk',        // The biggest source of memory churn
    'update_light',     // Heavy lighting data
    'unload_chunk',     // Unnecessary if we aren't tracking blocks
    'world_particles',  // Visual spam
    'world_event',      // Sound/visual events
];


enum Crates {
    Prime,
    Amethyst,
    Crimson,
    Gold,
    Common,
}

const DefaultKeys = {
    [Crates.Prime]: 0,
    [Crates.Amethyst]: 0,
    [Crates.Crimson]: 0,
    [Crates.Gold]: 0,
    [Crates.Common]: 0,
};

const KEY_MAP = {
    "#2388d6": Crates.Prime,
    "#3da920": Crates.Common,
    "#e6bb00": Crates.Gold,
    "#6f3baf": Crates.Amethyst,
    "#c62119": Crates.Crimson,
};

export interface BotAccount {
    id: string;
    username: string;
    type: BotType;
    status: "online" | "offline" | "connecting" | "error";
    desiredStatus: "online" | "offline";
    logs: string[];
    accountData: BotStats;
}

export class BotManager extends EventEmitter {
    private bots: Map<string, any> = new Map();
    private accounts: Map<string, BotAccount> = new Map();
    private db: Database;

    constructor(dbPath: string = path.join(DATA_ROOT, "accounts.db")) {
        super();
        this.db = new Database(dbPath, { create: true });
        this.db.run("PRAGMA journal_mode = WAL;");

        this.initDb();
        this.loadAccounts();

        // Auto-connect bots that should be online
        for (const account of this.accounts.values()) {
            if (account.desiredStatus === "online") {
                this.connectBot(account.id);
            }
        }
    }


    private initDb() {
        this.db.query(`
            CREATE TABLE IF NOT EXISTS accounts (
                id TEXT PRIMARY KEY,
                username TEXT,
                type TEXT,
                should_be_online INTEGER DEFAULT 0
            )
        `).run();

        // Migration: Add should_be_online if it doesn't exist
        try {
            this.db.query(
                "ALTER TABLE accounts ADD COLUMN should_be_online INTEGER DEFAULT 0",
            ).run();
        } catch (e) {
            // Column already exists, ignore
        }
    }

    private loadAccounts() {
        const rows = this.db.query("SELECT * FROM accounts").all() as {
            id: string;
            username: string;
            type: string;
            should_be_online: number;
        }[];
        for (const row of rows) {
            this.accounts.set(row.id, {
                id: row.id,
                username: row.username,
                type: row.type as BotType,
                status: "offline",
                desiredStatus: row.should_be_online === 1
                    ? "online"
                    : "offline",
                logs: [],
                accountData: {
                    shards: 0,
                    money: 0,
                    kills: 0,
                    deaths: 0,
                    keys: DefaultKeys,
                },
            });
        }
    }

    async addAccount(account: { id: string; username: string; type: BotType }) {
        this.db.query(
            "INSERT INTO accounts (id, username, type, should_be_online) VALUES (?, ?, ?, 0)",
        )
            .run(account.id, account.username, account.type);

        this.accounts.set(account.id, {
            ...account,
            status: "offline",
            desiredStatus: "offline",
            logs: [],
            accountData: {
                shards: 0,
                money: 0,
                kills: 0,
                deaths: 0,
                keys: DefaultKeys,
            },
        });
        this.triggerUpdate();
    }
    private updateTimeout: ReturnType<typeof setTimeout> | null = null;
    private hasPendingUpdate = false;

    private triggerUpdate() {
        if (this.updateTimeout) {
            this.hasPendingUpdate = true;
            return;
        }

        // Emit immediately so the UI is fast
        this.emit("update", this.getAccounts());

        // Lock for 50ms to absorb Minecraft server spam
        this.updateTimeout = setTimeout(() => {
            this.updateTimeout = null;

            // If we absorbed spam during the 50ms lock, update the UI one last time
            if (this.hasPendingUpdate) {
                this.hasPendingUpdate = false;
                this.emit("update", this.getAccounts());
            }
        }, 50);
    }

    async removeAccount(id: string) {
        await this.disconnectBot(id);
        this.db.query("DELETE FROM accounts WHERE id = ?").run(id);
        this.accounts.delete(id);
        this.triggerUpdate();
    }

    getAccounts(): BotAccount[] {
        return Array.from(this.accounts.values());
    }

    log(id: string, message: string) {
        const account = this.accounts.get(id);
        if (account) {
            account.logs.push(
                `[${new Date().toLocaleTimeString()}] ${message}`,
            );
            if (account.logs.length > 100) account.logs.shift();
            this.triggerUpdate();
        }
    }

    async connectBot(id: string, force: boolean = false) {
        const account = this.accounts.get(id);
        if (!account) return;

        // If it's already online and we aren't forcing, stop.
        if (!force && account.status === "online") return;

        // If it's already connecting, only allow it if we are forcing it (user clicked button)
        if (!force && account.status === "connecting") return;

        // CLEANUP: If a bot instance exists, kill it properly before starting a new one
        if (this.bots.has(id)) {
            this.log(id, "🧹 Cleaning up existing instance...");
            const oldBot = this.bots.get(id);
            try {
                oldBot.removeAllListeners();
                oldBot.quit(); // Use quit() for Java
            } catch (e) { }
            this.bots.delete(id);
        }

        account.status = "connecting";
        account.desiredStatus = "online";
        this.db.query("UPDATE accounts SET should_be_online = 1 WHERE id = ?")
            .run(id);
        this.triggerUpdate();

        this.log(id, `Connecting to ${process.env.SERVER_IP} (java)...`);
        this.connectJava(id, account.username);
    }

    private packetStats: Map<string, Map<string, number>> = new Map();

    private startPacketProfiling(id: string, bot: any) {
        if (!this.packetStats.has(id)) {
            this.packetStats.set(id, new Map());
        }

        const stats = this.packetStats.get(id)!;

        // Listen to every single raw packet
        bot._client.on('packet', (data: any, metadata: any) => {
            const name = metadata.name;
            stats.set(name, (stats.get(name) || 0) + 1);
        });

        // Print a report every 10 seconds
        const interval = setInterval(() => {
            if (bot.status === 'offline') {
                clearInterval(interval);
                return;
            }

            console.log(`\n--- [${id}] Packet Profile (Last 10s) ---`);

            // Sort packets by frequency (highest first)
            const sorted = Array.from(stats.entries())
                .sort((a, b) => b[1] - a[1])
                .slice(0, 10); // Top 10 spammiest packets

            sorted.forEach(([name, count]) => {
                console.log(`${name.padEnd(25)}: ${count} packets`);
            });

            // Reset stats for the next window
            stats.clear();
        }, 10000);
    }


    private connectJava(id: string, username: string) {
        try {
            const bot = mineflayer.createBot({
                host: process.env.SERVER_IP,
                noPongTimeout: 300 * 1000,
                closeTimeout: 300 * 1000,
                checkTimeoutInterval: 300 * 1000,
                viewDistance: "tiny",
                colorsEnabled: false,
                username: username,
                auth: "microsoft",
                physicsEnabled: false,
                version: "1.20.2",
                profilesFolder: path.join(DATA_ROOT, "sessions/java", username),
                plugins: {
                    // These 5 are the primary causes of GC churn and CPU usage
                    physics: false,    // Stops the 20Hz math loop
                    entities: true,   // Stops tracking/allocating Mobs/Players
                    blocks: false,     // Stops parsing/storing Chunks
                    particle: false    // Stops processing visual effects
                },
                onMsaCode: (data) => {
                    const directLink =
                        `https://www.microsoft.com/link?otc=${data.user_code}`;
                    this.log(id, `Login Link: ${directLink}`);
                    console.log(`Login Link: ${directLink}`);
                },
                hideErrors: true,
            });
            bot.blockAt = () => null;
            bot.findBlock = () => null;
            bot.canSeeBlock = () => false;

            this.bots.set(id, bot);
            this.startPacketProfiling(id, bot);





            const loginTimeout = setTimeout(() => {
                const acc = this.accounts.get(id);
                if (acc && acc.status === "connecting") {
                    this.log(
                        id,
                        "⚠️ Login timed out (Microsoft Auth hang). Retrying...",
                    );
                    this.connectBot(id, true); // Force a retry
                }
            }, 120000);





            bot.once('inject_allowed', () => {
                // These are the packets causing your "Full Garbage Collection"
                const HEAVY_PACKETS = [
                    'map_chunk',
                    'update_light',
                    'unload_chunk',
                    'entity_metadata',
                    'world_particles',
                    'world_event',
                    'action_bar',
                    'rel_entity_move',
                    'entity_move_look',
                    'entity_look',
                    'entity_head_rotation',
                    'animation',
                    'entity_teleport',
                    'entity_head_look',
                    'entity_velocity',
                    'player_info',        // Tab list updates
                    'bundle_delimiter',   // 1.20 grouping packet (useless for us)
                    'block_break_animation',
                    'entity_update_attributes',
                    'custom_payload',
                    'entity_sound_effect',
                    'entity_status',
                    'entity_equipment',
                    'set_slot',
                    'entity_equipment',
                    'playerlist_header'
                ];
                const originalEmit = bot._client.emit;

                bot._client.emit = function (name: string, ...args: any[]) {
                    if (name == "raw") {
                        return false
                    }
                    // 1. Clean the name: removes 'raw.' prefix if it exists
                    const cleanName = name.startsWith('raw.') ? name.slice(4) : name;

                    // 2. Block if the clean name is in our list
                    if (HEAVY_PACKETS.includes(cleanName)) {
                        return false;
                    }


                    // 3. Block the generic 'packet' event based on the metadata name
                    if (name === 'packet' && args[1]) {
                        const metaName = args[1].name;
                        const cleanMetaName = metaName.startsWith('raw.') ? metaName.slice(4) : metaName;

                        if (HEAVY_PACKETS.includes(cleanMetaName)) {
                            return false;
                        }
                    }

                    return originalEmit.apply(this, [name, ...args]);
                };




                HEAVY_PACKETS.forEach(packetName => {
                    // This removes Mineflayer's internal listeners for these packets
                    bot._client.removeAllListeners(packetName);
                });

                // Safety: some plugins might still try to access world data
                // so we provide these "empty" mocks.
                // @ts-ignore
                bot.blockAt = () => null;
            });



            bot.once("login", () => {
                if (bot.world) {
                    bot.world.getColumns = () => [];
                    bot.world.getColumn = () => null;
                    bot.world.setBlock = () => { };

                }
                clearTimeout(loginTimeout); // Cancel the safety timeout
                const account = this.accounts.get(id);
                if (account) {
                    account.status = "online";
                    this.log(id, "Logged in successfully!");
                    this.triggerUpdate();
                }
            });

            bot.on("windowOpen", (window) => {
                // Find item where Lore matches the random teleport description
                const item = window.slots.find((slot) => {
                    if (!slot || !slot.nbt) return false;
                    // Mineflayer stores lore in NBT. Check for the specific phrase.
                    const nbt = JSON.stringify(slot.nbt).toLowerCase();
                    return nbt.includes(
                        "click to teleport to a random afk area",
                    );
                });

                if (item) {
                    this.log(id, `Clicking button index ${item.slot}...`);
                    console.log(
                        `\x1b[35mFound Random AFK in slot ${item.slot}. Clicking...\x1b[0m`,
                    );
                    bot.clickWindow(item.slot, 0, 0);
                } else {
                    this.log(id, `Could not find the Random AFK item`);
                    console.log(
                        `\x1b[31mCould not find the Random AFK item.\x1b[0m`,
                    );
                }
            });

            bot.on("login", () => {
                const account = this.accounts.get(id);
                if (account) {
                    account.status = "online";
                    this.log(id, "Logged in successfully!");
                    this.triggerUpdate();
                }
            });

            bot._client.on("teams", (packet) => {
                if (!packet.prefix) return;

                const account = this.accounts.get(id);

                const raw = packet.prefix.toLowerCase();
                if (!raw.includes("money") && !raw.includes("shards")) return;


                if (!account) return;

                try {
                    // 1. Parse the JSON Prefix
                    const prefixData = JSON.parse(packet.prefix);
                    let fullText = "";

                    // 2. Extract text from the "extra" array or base "text" property
                    if (prefixData.text) fullText += prefixData.text;
                    if (prefixData.extra) {
                        fullText += prefixData.extra.map((item: any) =>
                            item.text
                        ).join("");
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

            bot.on("scoreUpdated", (scoreboard, updated: any) => {
                const item = scoreboard.items.find((i) =>
                    i.value === updated.value
                );

                const account = this.accounts.get(id);
                if (!item || !account) return;

                const text = item.displayName
                    ? item.displayName.toString()
                    : item.name;
                const cleanText = text.replace(/§[0-9a-fk-or]/g, "");

                // Helper to extract number and update if different
                const updateNumericStat = (
                    key: keyof typeof account.accountData,
                    searchStr: string,
                ) => {
                    if (cleanText.includes(searchStr)) {
                        // 1. Extract just the number and the suffix (e.g., "1.22m" from "Money 1.22m§")
                        // This regex finds digits, dots, and k/m/b, ignoring everything else
                        const match = cleanText.toLowerCase().match(
                            /(\d+\.?\d*)([kmb])?/,
                        );

                        if (match && match[1]) {
                            const numPart = parseFloat(match[1]) || 0;
                            const suffix = match[2];

                            let multiplier = 1;
                            if (suffix === "k") multiplier = 1_000;
                            else if (suffix === "m") multiplier = 1_000_000;
                            else if (suffix === "b") multiplier = 1_000_000_000;

                            const finalVal = numPart * multiplier;

                            if (account.accountData[key] !== finalVal) {
                                account.accountData[key] = finalVal;
                                return true;
                            }
                        }
                    }
                    return false;
                };

                const shardsChanged = updateNumericStat("shards", "Shards");
                const moneyChanged = updateNumericStat("money", "Money");

                if (shardsChanged || moneyChanged) {
                    this.triggerUpdate();
                }
            });

            function filterKeyEntities(this: BotManager, entity) {
                try {
                    if (entity?.name !== "armor_stand") return;
                    const rawName = entity.getCustomName();
                    if (!rawName) return;

                    const text = rawName.json.text;
                    if (text.includes("Players")) return;

                    const extra = rawName.extra;
                    if (!extra) return;

                    const hasKeys = extra.find((message) => {
                        const text = decancer(message.text).toString();
                        if (text === "keys") return true;
                    });

                    if (!hasKeys) return;

                    const keysText = extra[0];
                    const amount = extra[1];
                    if (!keysText || !amount) return;

                    const keyColor = keysText.color as never as string;
                    const keyType = KEY_MAP[keyColor] as Crates | undefined;

                    if (
                        typeof keyType === "number" &&
                        typeof amount === "string"
                    ) {
                        const amountParsed = Number(amount.trim());
                        if (typeof amountParsed === "number") {
                            this.log(id, `${Crates[keyType]} ${amountParsed}`);
                            console.log(Crates[keyType], amountParsed);
                            this.setKeys(id, keyType, amountParsed);
                        }
                    } else {
                        console.log("unmatched", rawName);
                    }
                } catch { }
            }

            function findStaticEntities(this: BotManager) {
                Object.values(bot.entities).forEach((entity) => {
                    filterKeyEntities(this, entity);
                });
            }

            // bot.on("entitySpawn", (entity) => {
            //     filterKeyEntities(this, entity);
            // });

            bot.on("spawn", () => {
                this.log(id, "Spawned in world.");
                // setTimeout(() => { bot.chat('/afk') }, 2000)

                // setTimeout(() => {
                //     bot.chat("/warp crates");
                // }, 2000);
                // setTimeout(() => {
                //     findStaticEntities(this);
                // }, 4000);
                setTimeout(() => {
                    bot.chat("/afk");
                }, 6000);
            });

            bot.on("message", (username, message) => {
                this.log(id, `<${username}> ${message}`);
            });

            // --- ADDED: Kicked Event ---
            bot.on("kicked", (reason) => {
                let reasonMsg = reason;
                // Parse JSON reasons if necessary
                if (typeof reason !== "string") {
                    try {
                        reasonMsg = JSON.stringify(reason);
                    } catch (e) {
                        reasonMsg = "Unknown JSON reason";
                    }
                }
                this.log(id, `❌ Kicked: ${reasonMsg}`);
            });

            bot._client.on("error", (err: any) => {
                if (err.code === "EPIPE" || err.code === "ECONNRESET") return; // Ignore silent drops
                this.log(id, `Client Error: ${err.message}`);
            });

            bot.on("error", (err) => {
                if (err.message.includes("429")) {
                    this.log(
                        id,
                        "🛑 Microsoft Rate Limit (429). Wait 15+ minutes.",
                    );
                } else {
                    this.log(id, `Error: ${err.message}`);
                }
                const account = this.accounts.get(id);
                if (account) account.status = "error";
                this.triggerUpdate();
            });

            // --- UPDATED: End Event with Reason ---
            bot.on("end", (reason) => {
                clearTimeout(loginTimeout);
                this.log(id, `Disconnected: ${reason}`);

                const account = this.accounts.get(id);
                this.bots.delete(id); // Important: remove from map so we can reconnect

                if (account) {
                    account.status = "offline";
                    this.triggerUpdate();

                    // Auto-reconnect logic
                    if (account.desiredStatus === "online") {
                        this.log(
                            id,
                            "Attempting to reconnect in 15 seconds...",
                        );
                        setTimeout(() => {
                            // Check again if desiredStatus is still online before reconnecting
                            if (
                                this.accounts.get(id)?.desiredStatus ===
                                "online"
                            ) {
                                this.connectBot(id);
                            }
                        }, 15000);
                    }
                }
            });

            this.bots.set(id, bot);
        } catch (err: any) {
            this.log(id, `Connection failed: ${err.message}`);
        }
    }

    private setKeys(id: string, crateType: Crates, amount: number) {
        const account = this.accounts.get(id);
        if (!account) return;
        account.accountData.keys[crateType] = amount;
        this.triggerUpdate();
    }

    private incrementKeys(id: string, crateType: Crates, amount: number) {
        const account = this.accounts.get(id);
        if (!account) return;
        account.accountData.keys[crateType] += amount;
        this.triggerUpdate();
    }

    private updateStat(id: string, rawText: string) {
        if (!rawText || rawText === "undefined") return;

        const account = this.accounts.get(id);
        if (!account) return;

        // 1. Unified Cleanup: Strips Minecraft codes, icons, and whitespace
        const clean = rawText.replace(/§./g, "").replace(/[★$🗡☠⌛⌚]/g, "")
            .toLowerCase();

        // 2. Identification Logic
        const label = ["money", "shards"].find((l) => clean.includes(l));

        if (!label) return;

        // 3. Extraction: Get everything after the label
        const valuePart = clean.split(label)[1]?.trim() || "";
        const match = valuePart.match(/(\d+\.?\d*)([kmb])?/);

        if (match && match[1]) {
            const numPart = parseFloat(match[1]);
            const suffix = match[2];
            const multiplier = { k: 1e3, m: 1e6, b: 1e9 }[suffix as string] ||
                1;
            const finalVal = numPart * multiplier;

            const key = label as "money" | "shards";
            if (account.accountData[key] !== finalVal) {
                account.accountData[key] = finalVal;
                this.triggerUpdate();
            }
        }
    }

    async disconnectBot(id: string) {
        const bot = this.bots.get(id);
        const account = this.accounts.get(id);

        if (account) {
            account.desiredStatus = "offline";
            this.db.query(
                "UPDATE accounts SET should_be_online = 0 WHERE id = ?",
            ).run(id);
        }

        if (bot) {
            this.log(id, "🔌 Disconnecting manually...");

            // FIX: Remove listeners to prevent memory trapping
            //bot.removeAllListeners();

            if (account?.type === "java") {
                bot.quit();
            } else {
                bot.close();
            }
            //this.bots.delete(id);
        }
        this.triggerUpdate();
    }

    close() {
        this.db.close();
    }
}

process.on("uncaughtException", (err: any) => {
    if (err.code === "EPIPE" || err.code === "ECONNRESET") {
        console.warn("⚠️ Ignored fatal socket disconnect error:", err.message);
        return;
    }
    console.error("Fatal Error:", err);
});

process.on("unhandledRejection", (err: any) => {
    console.warn(
        "⚠️ Ignored unhandled promise rejection:",
        err?.message || err,
    );
});
