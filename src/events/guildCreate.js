// src/events/guildCreate.js
// Fires when Phantom joins a new server.
// Registers slash commands and grants a 7-day premium trial.

import { Events, EmbedBuilder } from 'discord.js';
import { logger } from '../utils/logger.js';
import { getSubscription } from '../web/stripePayments.js';
import { db } from '../utils/database.js';

function subKey(guildId) { return `subscription:${guildId}`; }

async function saveSubscription(guildId, data) {
  try { await db.set(subKey(guildId), data); } catch (e) { logger.error('saveSubscription error:', e); }
}

export default {
  name: Events.GuildCreate,
  once: false,

  async execute(guild, client) {
    try {
      logger.info(`[guildCreate] Joined new guild: ${guild.name} (${guild.id})`);

      // Clear guild-specific commands — global commands will apply
      await guild.commands.set([]).catch(() => {});

      // ── 7-day premium trial ──────────────────────────────────────────────
      const existing = await getSubscription(guild.id);

      // Only grant if they've never had a subscription before
      if (!existing || existing.tier === 'free') {
        const trialEnd = Date.now() + 7 * 24 * 60 * 60 * 1000;
        await saveSubscription(guild.id, {
          tier: 'premium',
          status: 'trialing',
          isTrial: true,
          trialEnd,
          trialGrantedAt: Date.now(),
        });
        logger.info(`[Trial] Granted 7-day premium trial to ${guild.name} (${guild.id})`);

        // DM the guild owner
        try {
          const owner = await client.users.fetch(guild.ownerId);
          await owner.send({
            embeds: [new EmbedBuilder()
              .setTitle('🎉 Your 7-Day Premium Trial Has Started!')
              .setDescription(
                `Thanks for adding **Phantom** to **${guild.name}**!\n\n` +
                `You have been granted a **free 7-day Premium trial** so you can explore everything Phantom has to offer — rank management, auto-rank, audit logs, members tab, and more.\n\n` +
                `**Your trial expires:** <t:${Math.floor(trialEnd / 1000)}:F>\n\n` +
                `To keep Premium after your trial, visit the dashboard:\nhttps://phantom1.up.railway.app/dashboard`
              )
              .setColor(0x7c3aed)
              .setFooter({ text: 'Phantom Premium Trial' })
              .setTimestamp()
            ],
          });
        } catch {
          // Owner has DMs closed
        }
      }
    } catch (err) {
      logger.error(`[guildCreate] Error in ${guild?.name}:`, err.message);
    }
  },
};
