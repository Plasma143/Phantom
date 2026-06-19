import { logger } from '../utils/logger.js';
import { db } from '../utils/database.js';
import { getConfigValue } from '../services/guildConfig.js';
import { EmbedBuilder } from 'discord.js';

const CHECK_INTERVAL_MS = 30 * 60 * 1000;
const alerted = new Set();

export function startGroupFundsMonitor(client) {
  logger.info('[FUNDS] Group funds monitor started (checks every 30 minutes)');
  setInterval(() => checkAll(client), CHECK_INTERVAL_MS);
}

async function checkAll(client) {
  let keys = [];
  try { keys = await db.list('guild:'); } catch { return; }

  for (const key of keys) {
    const guildId = key.replace('guild:', '').replace(':config', '');
    if (!guildId || guildId.includes(':')) continue;
    try {
      const cfg = await getConfigValue(client, guildId, 'groupFunds', {});
      if (!cfg.enabled || !cfg.channelId || !cfg.threshold) continue;
      const roblox = await getConfigValue(client, guildId, 'roblox', {});
      if (!roblox.groupId || !roblox.openCloudKey) continue;
      await checkFunds(client, guildId, cfg, roblox);
    } catch (err) { logger.error(`[FUNDS] Error checking guild ${guildId}:`, err); }
  }
}

async function checkFunds(client, guildId, cfg, roblox) {
  try {
    let balance;
    const res = await fetch(`https://apis.roblox.com/cloud/v2/groups/${roblox.groupId}/revenue/summary/v1`, {
      headers: { 'x-api-key': roblox.openCloudKey },
    });
    if (res.ok) {
      const data = await res.json();
      balance = data?.pendingRobux ?? data?.robux;
    } else {
      const legRes = await fetch(`https://economy.roblox.com/v1/groups/${roblox.groupId}/currency`);
      if (!legRes.ok) return;
      balance = (await legRes.json())?.robux;
    }
    if (balance === undefined) return;
    await maybeAlert(client, guildId, cfg, balance);
  } catch (err) { logger.error(`[FUNDS] API call failed for guild ${guildId}:`, err); }
}

async function maybeAlert(client, guildId, cfg, balance) {
  const threshold = parseInt(cfg.threshold) || 0;
  if (balance >= threshold) { alerted.delete(guildId); return; }
  if (alerted.has(guildId)) return;
  alerted.add(guildId);
  const channel = await client.channels.fetch(cfg.channelId).catch(() => null);
  if (!channel) return;
  const embed = new EmbedBuilder()
    .setTitle('⚠️ Group Funds Alert')
    .setColor(0xed4245)
    .setDescription(`Your Roblox group's Robux balance has dropped below the configured threshold.`)
    .addFields(
      { name: '💰 Current Balance', value: `**${balance.toLocaleString()} R$**`, inline: true },
      { name: '🎯 Alert Threshold', value: `${threshold.toLocaleString()} R$`, inline: true },
    )
    .setTimestamp();
  await channel.send({ embeds: [embed] }).catch(() => {});
  logger.info(`[FUNDS] Balance ${balance} below threshold ${threshold} — alerted guild ${guildId}`);
}
