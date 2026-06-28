// src/commands/Community/invites.js
// View invite stats, top inviters, and per-user invite history.
import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { getFromDb } from '../../utils/database.js';
import { logger } from '../../utils/logger.js';

function invKey(guildId, userId)  { return `invites:${guildId}:${userId}`; }

export default {
  data: new SlashCommandBuilder()
    .setName('invites')
    .setDescription('View invite statistics for this server')
    .setDMPermission(false)
    .addSubcommand(s =>
      s.setName('me').setDescription('View your own invite stats')
    )
    .addSubcommand(s =>
      s.setName('user')
        .setDescription("View another member's invite stats")
        .addUserOption(o =>
          o.setName('target').setDescription('The member to look up').setRequired(true)
        )
    )
    .addSubcommand(s =>
      s.setName('top').setDescription('Show the top inviters leaderboard')
    ),
  category: 'community',

  async execute(interaction) {
    const sub     = interaction.options.getSubcommand();
    const guildId = interaction.guildId;

    // ── /invites me | /invites user ─────────────────────────────────────────
    if (sub === 'me' || sub === 'user') {
      const target = sub === 'user'
        ? interaction.options.getUser('target')
        : interaction.user;

      const data = (await getFromDb(invKey(guildId, target.id))) || {};
      const total       = data.total       || 0;
      const coinsEarned = data.coinsEarned || 0;
      const xpEarned    = data.xpEarned    || 0;

      const embed = new EmbedBuilder()
        .setTitle(`📨 Invite Stats — ${target.displayName || target.username}`)
        .setThumbnail(target.displayAvatarURL())
        .setColor(0x7c3aed)
        .addFields(
          { name: '✅ Total Invites',  value: String(total),       inline: true },
          { name: '🪙 Coins Earned',   value: String(coinsEarned), inline: true },
          { name: '⭐ XP Earned',      value: String(xpEarned),    inline: true },
        )
        .setFooter({ text: 'Phantom Invite Tracker' })
        .setTimestamp();

      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    // ── /invites top ────────────────────────────────────────────────────────
    if (sub === 'top') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const { pgDb } = await import('../../utils/postgresDatabase.js');
        const prefix = `invites:${guildId}:`;
        const res = await pgDb.query(
          `SELECT key, value FROM keyvalue WHERE key LIKE $1`,
          [prefix + '%']
        );

        if (!res.rows.length) {
          return interaction.editReply({ content: 'No invite data yet — share your invite link to get started!' });
        }

        const parsed = res.rows
          .map(r => {
            const userId = r.key.replace(prefix, '');
            const d = typeof r.value === 'string' ? JSON.parse(r.value) : r.value;
            return { userId, total: d.total || 0, coins: d.coinsEarned || 0 };
          })
          .sort((a, b) => b.total - a.total)
          .slice(0, 10);

        const medals = ['🥇', '🥈', '🥉'];
        const lines  = parsed.map((p, i) =>
          `${medals[i] || `**${i + 1}.**`} <@${p.userId}> — **${p.total}** invite${p.total !== 1 ? 's' : ''} · 🪙 ${p.coins}`
        );

        const embed = new EmbedBuilder()
          .setTitle('📨 Top Inviters')
          .setColor(0x7c3aed)
          .setDescription(lines.join('\n'))
          .setFooter({ text: 'Phantom Invite Tracker' })
          .setTimestamp();

        return interaction.editReply({ embeds: [embed] });
      } catch (err) {
        logger.error('[Invites] Leaderboard error:', err.message);
        return interaction.editReply({ content: '❌ Could not load leaderboard.' });
      }
    }
  },
};
