import 'dotenv/config';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { pgDb } from './db.js';

const cfg = loadConfig();
const db = pgDb(cfg.databaseUrl);
const app = createApp({ cfg, db });

const server = app.listen(cfg.port, () => console.log(`Family Portal API listening on :${cfg.port}`));

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => server.close(() => db.close().then(() => process.exit(0))));
}
