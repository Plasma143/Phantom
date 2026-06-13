// utils/robloxDb.js
// Stores the link between a Discord user and their Roblox account.
// Uses a Postgres pool — if you already have a database module/connection,
// swap the `pool` below for that instead of creating a second one.

import pg from 'pg';
import { logger } from './logger.js';

const pool = new pg.Pool({
  host: process.env.POSTGRES_HOST,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB || 'titanbot',
  port: process.env.POSTGRES_PORT || 5432,
});

// Run this once (e.g. in a migration/setup script) to create the table.
export const ROBLOX_LINKS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS roblox_links (
    discord_id VARCHAR(32) PRIMARY KEY,
    roblox_id BIGINT NOT NULL,
    roblox_username VARCHAR(50) NOT NULL,
    verified_at TIMESTAMP NOT NULL DEFAULT NOW()
  );
`;

export async function saveRobloxLink(discordId, robloxId, robloxUsername) {
  try {
    await pool.query(
      `INSERT INTO roblox_links (discord_id, roblox_id, roblox_username, verified_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (discord_id)
       DO UPDATE SET roblox_id = $2, roblox_username = $3, verified_at = NOW()`,
      [discordId, robloxId, robloxUsername],
    );
    return true;
  } catch (err) {
    logger.error('robloxDb saveRobloxLink error:', err);
    return false;
  }
}

export async function getRobloxLink(discordId) {
  try {
    const res = await pool.query(
      `SELECT roblox_id, roblox_username FROM roblox_links WHERE discord_id = $1`,
      [discordId],
    );
    return res.rows[0] ?? null;
  } catch (err) {
    logger.error('robloxDb getRobloxLink error:', err);
    return null;
  }
}

export async function removeRobloxLink(discordId) {
  try {
    await pool.query(`DELETE FROM roblox_links WHERE discord_id = $1`, [discordId]);
    return true;
  } catch (err) {
    logger.error('robloxDb removeRobloxLink error:', err);
    return false;
  }
}
