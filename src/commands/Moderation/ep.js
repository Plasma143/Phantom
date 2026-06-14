// src/commands/Moderation/ep.js
// Event Points system — staff award EP to members for attending events,
// completing tasks, etc. Supports weekly reset, auto-punishments, and logs.
import {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  MessageFlags,
} from 'discord.js';
import { pgDb } from '../../utils/postgresDatabase.js';
import { logger } from '../../utils/logger.js';

// ── DB helpers ────────────────────────────────────────────────────────────────

async function getEpConfig(guildId) {
  const data = await pgDb.get(`ep_config:${guildId}`);
  return {
    name:           'Event Points',
    abbr:           'EP',
    logChannelId:   null,
    managerRoleId:  null,
    weeklyReset:    false,
    minPoints:      null,
    minPointsAction: null, // 'warn' | 'kick' | 'role'
    minPointsRoleId: null,
    ...(data || {}),
  };
}

async function getEp(guildId, userId) {
  const data = await pgDb.get(`ep:${guildId}:${userId}`);
  return { points: 0, totalEarned: 0, lastReset: null, ...(data || {}) };
}

async function setEp(guildId, userId, data) {
  await pgDb.set(`ep:${guildId}:${userId}`, data);
}

async function canManageEp(member, config) {
  if (member.permissions.has(PermissionFlagsBits.ManageGuild)) return true;
  if (config.managerRoleId && member.roles.cache.has(config.managerRoleId)) return true;
  return false;
}

async function logEpChange(client, guildId, config, { user, actor, before, after, reason }) {
  if (!config.logChannelId) return;
  const ch = client.channels.cache.get(config.logChannelId) ||
    await client.channels.fetch(config.logChannelId).catch(() => null);
  if (!ch) return;

  const diff = after - before;
  const sign = diff >= 0 ? '+' : '';
  const color = diff >= 0 ? 0x57f287 : 0xed4245;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`${config.abbr} Updated`)
    .setThumbnail(user.displayAvatarURL({ size: 64 }))
    .addFields(
      { name: 'Member',  value: `${user} (${user.tag})`, inline: true },
      { name: 'Change',  value: `${sign}${diff} → **${after} ${config.abbr}**`, inline: true },
      { name: 'By',      value: actor.tag, inline: true },
    )
    .setTimestamp();
  if (reason) embed.setDescription(`**Reason:** ${reason}`);

  await ch.send({ embeds: [embed] }).catch(() => {});
}

// ── Main export ───────────────────────────────────────────────────────────────

export default {
  data: new SlashCommandBuilder()
    .setName('ep')
    .setDescription('Event Points — reward members for participation')
    .setDMPermission(false)

    .addSubcommand(s => s
      .setName('add')
      .setDescription('Add EP to a member')
      .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true))
      .addIntegerOption(o => o.setName('amount').setDescription('Points to add').setRequired(true).setMinValue(1).setMaxValue(10000))
      .addStringOption(o => o.setName('reason').setDescription('Reason').setMaxLength(200)))

    .addSubcommand(s => s
      .setName('remove')
      .setDescription('Remove EP from a member')
      .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true))
      .addIntegerOption(o => o.setName('amount').setDescription('Points to remove').setRequired(true).setMinValue(1).setMaxValue(10000))
      .addStringOption(o => o.setName('reason').setDescription('Reason').setMaxLength(200)))

    .addSubcommand(s => s
      .setName('set')
      .setDescription('Set a member\'s EP to an exact value')
      .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true))
      .addIntegerOption(o => o.setName('amount').setDescription('New EP total').setRequired(true).setMinValue(0).setMaxValue(999999)))

    .addSubcommand(s => s
      .setName('check')
      .setDescription('Check EP balance')
      .addUserOption(o => o.setName('user').setDescription('Member (leave blank for yourself)')))

    .addSubcommand(s => s
      .setName('leaderboard')
      .setDescription('Show top 10 EP leaderboard'))

    .addSubcommand(s => s
      .setName('reset')
      .setDescription('Reset EP (staff only)')
      .addUserOption(o => o.setName('user').setDescription('Reset a specific member (leave blank to reset everyone)'))
      .addBooleanOption(o => o.setName('confirm').setDescription('Confirm mass reset').setRequired(false)))

    .addSubcommand(s => s
      .setName('config')
      .setDescription('Configure the EP system (admin only)')
      .addStringOption(o => o.setName('name').setDescription('Full name, e.g. "Event Points"').setMaxLength(32))
      .addStringOption(o => o.setName('abbreviation').setDescription('Short form, e.g. "EP"').setMaxLength(8))
      .addRoleOption(o => o.setName('manager_role').setDescription('Role that can manage EP'))
      .addChannelOption(o => o.setName('log_channel').setDescription('Channel to log EP changes'))
      .addBooleanOption(o => o.setName('weekly_reset').setDescription('Auto-reset EP every Monday'))
      .addIntegerOption(o => o.setName('min_points').setDescription('Auto-punish if below this (0 = disabled)').setMinValue(0))
      .addStringOption(o => o
        .setName('min_points_action')
        .setDescription('Punishment for going below min_points')
        .addChoices(
          { name: 'Warn (DM)', value: 'warn' },
          { name: 'Kick', value: 'kick' },
          { name: 'Assign role', value: 'role' },
        ))
      .addRoleOption(o => o.setName('min_points_role').setDescription('Role to assign for min_points_action=role'))),

  category: 'commands',

  async execute(interaction) {
    const sub     = interaction.options.getSubcommand();
    const guildId = interaction.guildId;
    const config  = await getEpConfig(guildId);

    // ── CHECK ──
    if (sub === 'check') {
      const target = interaction.options.getUser('user') || interaction.user;
      const ep     = await getEp(guildId, target.id);
      const embed  = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle(`${config.abbr} Balance`)
        .setThumbnail(target.displayAvatarURL({ size: 64 }))
        .setDescription(`**${target.tag}**`)
        .addFields(
          { name: `Current ${config.abbr}`,      value: `**${ep.points}**`,      inline: true },
          { name: `Total Earned`,                 value: `${ep.totalEarned}`,     inline: true },
        )
        .setTimestamp();
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    // ── LEADERBOARD ──
    if (sub === 'leaderboard') {
      await interaction.deferReply();
      try {
        const keys = await pgDb.list(`ep:${guildId}:`);
        const entries = (await Promise.all(keys.map(async k => {
          const uid  = k.replace(`ep:${guildId}:`, '');
          const data = await pgDb.get(k);
          return { uid, points: data?.points || 0 };
        }))).filter(e => e.points > 0).sort((a, b) => b.points - a.points).slice(0, 10);

        if (!entries.length) {
          return interaction.editReply(`No ${config.abbr} recorded yet.`);
        }

        const lines = await Promise.all(entries.map(async (e, i) => {
          const member = await interaction.guild.members.fetch(e.uid).catch(() => null);
          const name   = member ? member.displayName : `Unknown (${e.uid})`;
          const medal  = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `**${i + 1}.**`;
          return `${medal} ${name} — **${e.points} ${config.abbr}**`;
        }));

        const embed = new EmbedBuilder()
          .setColor(0xf59e0b)
          .setTitle(`🏆 ${config.name} Leaderboard`)
          .setDescription(lines.join('\n'))
          .setTimestamp();
        return interaction.editReply({ embeds: [embed] });
      } catch (e) {
        logger.error('EP leaderboard error:', e);
        return interaction.editReply('Failed to load leaderboard.');
      }
    }

    // ── STAFF COMMANDS — require manager role or ManageGuild ──
    if (!await canManageEp(interaction.member, config)) {
      return interaction.reply({ content: `❌ You don't have permission to manage ${config.abbr}.`, flags: MessageFlags.Ephemeral });
    }

    // ── ADD ──
    if (sub === 'add') {
      const target = interaction.options.getUser('user');
      const amount = interaction.options.getInteger('amount');
      const reason = interaction.options.getString('reason');

      const ep     = await getEp(guildId, target.id);
      const before = ep.points;
      ep.points     += amount;
      ep.totalEarned += amount;
      await setEp(guildId, target.id, ep);

      await logEpChange(interaction.client, guildId, config, {
        user: target, actor: interaction.user,
        before, after: ep.points, reason,
      });

      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(0x57f287)
          .setDescription(`✅ Added **+${amount} ${config.abbr}** to ${target}. New total: **${ep.points}**`)],
        flags: MessageFlags.Ephemeral,
      });
    }

    // ── REMOVE ──
    if (sub === 'remove') {
      const target = interaction.options.getUser('user');
      const amount = interaction.options.getInteger('amount');
      const reason = interaction.options.getString('reason');

      const ep     = await getEp(guildId, target.id);
      const before = ep.points;
      ep.points     = Math.max(0, ep.points - amount);
      await setEp(guildId, target.id, ep);

      await logEpChange(interaction.client, guildId, config, {
        user: target, actor: interaction.user,
        before, after: ep.points, reason,
      });

      // Apply min points punishment if configured
      if (config.minPoints !== null && ep.points < config.minPoints && config.minPointsAction) {
        const member = await interaction.guild.members.fetch(target.id).catch(() => null);
        if (member) {
          if (config.minPointsAction === 'warn') {
            await target.send(`⚠️ Your ${config.abbr} in **${interaction.guild.name}** dropped below **${config.minPoints}**. You may be subject to punishment.`).catch(() => {});
          } else if (config.minPointsAction === 'kick') {
            await member.kick(`${config.abbr} fell below minimum threshold (${config.minPoints})`).catch(() => {});
          } else if (config.minPointsAction === 'role' && config.minPointsRoleId) {
            await member.roles.add(config.minPointsRoleId).catch(() => {});
          }
        }
      }

      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(0xed4245)
          .setDescription(`✅ Removed **-${amount} ${config.abbr}** from ${target}. New total: **${ep.points}**`)],
        flags: MessageFlags.Ephemeral,
      });
    }

    // ── SET ──
    if (sub === 'set') {
      const target = interaction.options.getUser('user');
      const amount = interaction.options.getInteger('amount');

      const ep     = await getEp(guildId, target.id);
      const before = ep.points;
      if (amount > ep.points) ep.totalEarned += (amount - ep.points);
      ep.points = amount;
      await setEp(guildId, target.id, ep);

      await logEpChange(interaction.client, guildId, config, {
        user: target, actor: interaction.user,
        before, after: ep.points, reason: 'Manual set',
      });

      return interaction.reply({
        content: `✅ Set ${target}'s ${config.abbr} to **${amount}**.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // ── RESET ──
    if (sub === 'reset') {
      const target  = interaction.options.getUser('user');
      const confirm = interaction.options.getBoolean('confirm');

      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ content: '❌ Only admins can reset EP.', flags: MessageFlags.Ephemeral });
      }

      if (target) {
        const ep = await getEp(guildId, target.id);
        ep.points = 0;
        ep.lastReset = Date.now();
        await setEp(guildId, target.id, ep);
        return interaction.reply({ content: `✅ Reset ${target}'s ${config.abbr} to 0.`, flags: MessageFlags.Ephemeral });
      }

      if (!confirm) {
        return interaction.reply({
          content: `⚠️ This will reset **everyone's** ${config.abbr} to 0. Run again with \`confirm: True\` to proceed.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const keys = await pgDb.list(`ep:${guildId}:`);
      await Promise.all(keys.map(k => pgDb.set(k, { points: 0, totalEarned: 0, lastReset: Date.now() })));
      return interaction.editReply(`✅ Reset ${keys.length} members' ${config.abbr} to 0.`);
    }

    // ── CONFIG ──
    if (sub === 'config') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ content: '❌ Only admins can configure EP.', flags: MessageFlags.Ephemeral });
      }

      const updates = {};
      const name        = interaction.options.getString('name');
      const abbr        = interaction.options.getString('abbreviation');
      const managerRole = interaction.options.getRole('manager_role');
      const logChannel  = interaction.options.getChannel('log_channel');
      const weekly      = interaction.options.getBoolean('weekly_reset');
      const minPts      = interaction.options.getInteger('min_points');
      const minAction   = interaction.options.getString('min_points_action');
      const minRole     = interaction.options.getRole('min_points_role');

      if (name)        updates.name          = name;
      if (abbr)        updates.abbr          = abbr;
      if (managerRole) updates.managerRoleId = managerRole.id;
      if (logChannel)  updates.logChannelId  = logChannel.id;
      if (weekly !== null) updates.weeklyReset = weekly;
      if (minPts  !== null) updates.minPoints   = minPts || null;
      if (minAction)   updates.minPointsAction  = minAction;
      if (minRole)     updates.minPointsRoleId  = minRole.id;

      await pgDb.set(`ep_config:${guildId}`, { ...config, ...updates });

      const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle(`${config.abbr} Config Updated`)
        .setDescription(Object.entries(updates).map(([k, v]) => `**${k}:** ${v}`).join('\n') || 'No changes.')
        .setTimestamp();
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }
  },
};
