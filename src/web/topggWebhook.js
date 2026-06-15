// src/web/topggWebhook.js
// Receives Top.gg vote webhooks and rewards the voter with 300-800 coins
// in every mutual server that has economy enabled.
import { Router, json } from 'express';
import EconomyService from '../services/economyService.js';
import { logger } from '../utils/logger.js';

export const topggRouter = Router();

const TOPGG_AUTH = process.env.TOPGG_WEBHOOK_AUTH || '';

topggRouter.post('/topgg/webhook', json(), async (req, res) => {
  try {
    // Verify the request is from Top.gg
    const auth = req.headers.authorization || '';
    if (TOPGG_AUTH && auth !== TOPGG_AUTH) {
      logger.warn('[TopGG] Unauthorised webhook attempt');
      return res.status(401).json({ error: 'Unauthorised' });
    }

    const { user: userId, type, isWeekend } = req.body;
    if (type !== 'upvote' || !userId) {
      return res.status(200).json({ ok: true });
    }

    res.status(200).json({ ok: true }); // respond immediately

    const client = req.app.get('discordClient');
    if (!client) return;

    // Random reward — double on weekends
    const base   = Math.floor(Math.random() * 501) + 300; // 300-800
    const reward = isWeekend ? base * 2 : base;

    // Give coins in all mutual guilds
    const mutualGuilds = client.guilds.cache.filter(g => g.members.cache.has(userId));
    let rewarded = 0;
    for (const [, guild] of mutualGuilds) {
      try {
        await EconomyService.addMoney(client, guild.id, userId, reward, 'topgg_vote');
        rewarded++;
      } catch (err) {
        logger.debug(`[TopGG] Could not add coins in ${guild.name}: ${err.message}`);
      }
    }

    // DM the voter
    try {
      const user = await client.users.fetch(userId);
      const weekendNote = isWeekend ? ' (weekend double reward!)' : '';
      await user.send({
        embeds: [{
          title: '🗳️ Thanks for voting!',
          description: `You voted for Phantom on Top.gg and received **$${reward.toLocaleString()} coins**${weekendNote} in ${rewarded} server${rewarded !== 1 ? 's' : ''}.\n\nVote again in 12 hours for another reward!\nhttps://top.gg/bot/1515029322061054063/vote`,
          color: 0x7c3aed,
          timestamp: new Date().toISOString(),
        }],
      });
    } catch {
      // User has DMs closed — that's fine
    }

    logger.info(`[TopGG] Vote reward: $${reward} to ${userId} in ${rewarded} guild(s)${isWeekend ? ' (weekend x2)' : ''}`);
  } catch (err) {
    logger.error('[TopGG] Webhook error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});
