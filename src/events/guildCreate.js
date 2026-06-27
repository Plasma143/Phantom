// src/events/guildCreate.js
// Fires when Phantom joins a new server.
// Registers slash commands and grants a 7-day premium trial (once per owner, ever).
import { Events, EmbedBuilder } from 'discord.js';
import { logger } from '../utils/logger.js';
import { getSubscription } from '../web/stripePayments.js';
import { db } from '../utils/database.js';

function subKey(guildId)    { return `subscription:${guildId}`; }
function ownerTrialKey(id)  { return `trial:owner:${id}`; }

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

      // ── 7-day premium trial (one per owner, ever) ───────────────────────
      const existing = await getSubscription(guild.id);

      // Skip if guild already has an active paid subscription
      if (existing && existing.tier !== 'free' && !existing.wasTrialUser && !existing.isTrial) return;

      // Check if this Discord account has already used a trial on any server
      let ownerUsedTrial = false;
      try {
        const ownerRecord = await db.get(ownerTrialKey(guild.ownerId));
        ownerUsedTrial = !!ownerRecord;
      } catch {}

      if (ownerUsedTrial) {
        logger.info(`[Trial] Skipped — owner ${guild.ownerId} already used their trial (${guild.name})`);
        return;
      }

      // Grant the 7-day trial
      const trialEnd = Date.now() + 7 * 24 * 60 * 60 * 1000;
      await saveSubscription(guild.id, {
        tier: 'premium',
        status: 'trialing',
        isTrial: true,
        trialEnd,
        trialGrantedAt: Date.now(),
        ownerId: guild.ownerId,
      });

      // Lock this owner so they can't get another trial by re-adding the bot
      await db.set(ownerTrialKey(guild.ownerId), { usedAt: Date.now(), guildId: guild.id });

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
              `To keep Premium after your trial, visit the dashboard:\nhttps://phantombot.org/dashboard`
            )
            .setColor(0x7c3aed)
            .setFooter({ text: 'Phantom Premium Trial' })
            .setTimestamp()
          ],
        });
      } catch {
        // Owner has DMs closed — that's fine
      }
    } catch (err) {
      logger.error(`[guildCreate] Error in ${guild?.name}:`, err.message);
    }
  },
};
