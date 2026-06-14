// src/commands/Moderation/security.js
// Security management commands — lockdown, scan, status.
import {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  MessageFlags,
  ChannelType,
} from 'discord.js';
import { pgDb } from '../../utils/postgresDatabase.js';
import { logger } from '../../utils/logger.js';

async function getSecurityConfig(guildId) {
  const data = await pgDb.get(`security:${guildId}`);
  return {
    enabled:              true,
    minAccountAgeDays:    0,
    newAccountAction:     'none', // 'none'|'warn'|'kick'|'ban'|'role'
    newAccountRoleId:     null,
    newAccountLogChannel: null,
    raidProtection:       false,
    raidThreshold:        10,     // joins in...
    raidWindowSeconds:    30,     // ...this many seconds
    raidAction:           'lockdown', // 'lockdown'|'kick'|'ban'
    lockdownActive:       false,
    ...(data || {}),
  };
}

export default {
  data: new SlashCommandBuilder()
    .setName('security')
    .setDescription('Security tools — lockdown, scan, and monitor your server')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)

    .addSubcommand(s => s
      .setName('status')
      .setDescription('Show current security configuration and status'))

    .addSubcommand(s => s
      .setName('lockdown')
      .setDescription('Toggle server lockdown (disables @everyone sending messages)')
      .addStringOption(o => o
        .setName('action')
        .setDescription('Enable or disable lockdown')
        .setRequired(true)
        .addChoices(
          { name: 'Enable lockdown', value: 'enable' },
          { name: 'Disable lockdown', value: 'disable' },
        ))
      .addStringOption(o => o.setName('reason').setDescription('Reason for lockdown').setMaxLength(200)))

    .addSubcommand(s => s
      .setName('scan')
      .setDescription('Scan a member for risk factors')
      .addUserOption(o => o.setName('user').setDescription('Member to scan').setRequired(true)))

    .addSubcommand(s => s
      .setName('config')
      .setDescription('Configure security settings')
      .addIntegerOption(o => o.setName('min_account_age').setDescription('Min account age in days to join (0 = disabled)').setMinValue(0).setMaxValue(365))
      .addStringOption(o => o
        .setName('new_account_action')
        .setDescription('Action for accounts below min age')
        .addChoices(
          { name: 'None (log only)', value: 'none' },
          { name: 'Warn via DM', value: 'warn' },
          { name: 'Kick', value: 'kick' },
          { name: 'Ban', value: 'ban' },
          { name: 'Assign role', value: 'role' },
        ))
      .addRoleOption(o => o.setName('new_account_role').setDescription('Role to assign for new_account_action=role'))
      .addChannelOption(o => o
        .setName('log_channel')
        .setDescription('Channel to log security events')
        .addChannelTypes(ChannelType.GuildText))
      .addBooleanOption(o => o.setName('raid_protection').setDescription('Auto-respond to raid-like join patterns'))
      .addIntegerOption(o => o.setName('raid_threshold').setDescription('Joins that trigger raid detection').setMinValue(3).setMaxValue(100))
      .addIntegerOption(o => o.setName('raid_window').setDescription('Time window in seconds for raid detection').setMinValue(5).setMaxValue(300))
      .addStringOption(o => o
        .setName('raid_action')
        .setDescription('Action when raid is detected')
        .addChoices(
          { name: 'Lockdown server', value: 'lockdown' },
          { name: 'Kick all new joiners', value: 'kick' },
          { name: 'Ban all new joiners', value: 'ban' },
        ))),

  category: 'commands',

  async execute(interaction) {
    const sub     = interaction.options.getSubcommand();
    const guildId = interaction.guildId;
    const config  = await getSecurityConfig(guildId);

    // ── STATUS ──
    if (sub === 'status') {
      const ms = config.minAccountAgeDays;
      const fields = [
        { name: '🛡️ Min Account Age',  value: ms > 0 ? `${ms} day${ms !== 1 ? 's' : ''} — action: **${config.newAccountAction}**` : 'Disabled', inline: false },
        { name: '🚨 Raid Protection',   value: config.raidProtection ? `**ON** — ${config.raidThreshold} joins in ${config.raidWindowSeconds}s → ${config.raidAction}` : 'Disabled', inline: false },
        { name: '🔒 Lockdown',          value: config.lockdownActive ? '**ACTIVE**' : 'Off', inline: true },
        { name: '📋 Log Channel',        value: config.newAccountLogChannel ? `<#${config.newAccountLogChannel}>` : 'None', inline: true },
      ];
      const embed = new EmbedBuilder()
        .setColor(config.lockdownActive ? 0xed4245 : 0x57f287)
        .setTitle('🔐 Security Status')
        .addFields(fields)
        .setTimestamp();
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    // ── LOCKDOWN ──
    if (sub === 'lockdown') {
      const action = interaction.options.getString('action');
      const reason = interaction.options.getString('reason') || 'No reason given';
      const enable = action === 'enable';

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const everyoneRole = interaction.guild.roles.everyone;
      const textChannels = interaction.guild.channels.cache.filter(c =>
        c.type === ChannelType.GuildText && c.permissionsFor(everyoneRole).has('SendMessages', false)
      );

      let changed = 0;
      for (const [, ch] of textChannels) {
        try {
          await ch.permissionOverwrites.edit(everyoneRole, { SendMessages: enable ? false : null });
          changed++;
        } catch {}
      }

      // Save state
      await pgDb.set(`security:${guildId}`, { ...config, lockdownActive: enable });

      // Post to log channel
      if (config.newAccountLogChannel) {
        const logCh = interaction.guild.channels.cache.get(config.newAccountLogChannel);
        if (logCh) {
          await logCh.send({
            embeds: [new EmbedBuilder()
              .setColor(enable ? 0xed4245 : 0x57f287)
              .setTitle(enable ? '🔒 Server Lockdown Enabled' : '🔓 Server Lockdown Disabled')
              .addFields(
                { name: 'By', value: interaction.user.tag, inline: true },
                { name: 'Reason', value: reason, inline: true },
                { name: 'Channels Affected', value: String(changed), inline: true },
              )
              .setTimestamp()],
          }).catch(() => {});
        }
      }

      return interaction.editReply(`${enable ? '🔒 Lockdown enabled' : '🔓 Lockdown disabled'} across **${changed}** channels.\n**Reason:** ${reason}`);
    }

    // ── SCAN ──
    if (sub === 'scan') {
      const user   = interaction.options.getUser('user');
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);

      if (!member) return interaction.reply({ content: '❌ Member not found.', flags: MessageFlags.Ephemeral });

      const now            = Date.now();
      const accountAgeDays = Math.floor((now - user.createdTimestamp) / 86400000);
      const joinedAgoDays  = member.joinedTimestamp ? Math.floor((now - member.joinedTimestamp) / 86400000) : null;
      const isNewAccount   = accountAgeDays < 7;
      const noAvatar       = !user.avatar;
      const defaultName    = /^[A-Za-z0-9]+$/.test(user.username) && user.username.length < 6;

      let riskScore = 0;
      const flags = [];

      if (accountAgeDays < 1)   { riskScore += 40; flags.push('⚠️ Account created < 24 hours ago'); }
      else if (accountAgeDays < 7)  { riskScore += 25; flags.push('⚠️ Account created < 7 days ago'); }
      else if (accountAgeDays < 30) { riskScore += 10; flags.push('ℹ️ Account created < 30 days ago'); }

      if (noAvatar)  { riskScore += 10; flags.push('ℹ️ No profile picture'); }
      if (!member.nickname && defaultName) { riskScore += 5; flags.push('ℹ️ Short default-looking username'); }
      if (member.roles.cache.size <= 1) { riskScore += 5; flags.push('ℹ️ No roles assigned'); }

      const riskLabel = riskScore >= 50 ? '🔴 HIGH' : riskScore >= 20 ? '🟡 MEDIUM' : '🟢 LOW';
      const riskColor = riskScore >= 50 ? 0xed4245 : riskScore >= 20 ? 0xf59e0b : 0x57f287;

      const embed = new EmbedBuilder()
        .setColor(riskColor)
        .setTitle(`🔍 Security Scan — ${user.tag}`)
        .setThumbnail(user.displayAvatarURL({ size: 128 }))
        .addFields(
          { name: 'Risk Level',    value: `${riskLabel} (${riskScore}/100)`, inline: true },
          { name: 'Account Age',   value: `${accountAgeDays} day${accountAgeDays !== 1 ? 's' : ''}`, inline: true },
          { name: 'Server Join',   value: joinedAgoDays !== null ? `${joinedAgoDays}d ago` : 'Unknown', inline: true },
          { name: 'Flags',         value: flags.length ? flags.join('\n') : '✅ No flags' },
        )
        .setFooter({ text: `User ID: ${user.id}` })
        .setTimestamp();

      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    // ── CONFIG ──
    if (sub === 'config') {
      const updates = {};
      const minAge      = interaction.options.getInteger('min_account_age');
      const action      = interaction.options.getString('new_account_action');
      const role        = interaction.options.getRole('new_account_role');
      const logChannel  = interaction.options.getChannel('log_channel');
      const raid        = interaction.options.getBoolean('raid_protection');
      const raidThresh  = interaction.options.getInteger('raid_threshold');
      const raidWindow  = interaction.options.getInteger('raid_window');
      const raidAction  = interaction.options.getString('raid_action');

      if (minAge     !== null) updates.minAccountAgeDays    = minAge;
      if (action)             updates.newAccountAction      = action;
      if (role)               updates.newAccountRoleId      = role.id;
      if (logChannel)         updates.newAccountLogChannel  = logChannel.id;
      if (raid !== null)      updates.raidProtection        = raid;
      if (raidThresh !== null) updates.raidThreshold        = raidThresh;
      if (raidWindow !== null) updates.raidWindowSeconds    = raidWindow;
      if (raidAction)         updates.raidAction            = raidAction;

      await pgDb.set(`security:${guildId}`, { ...config, ...updates });

      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(0x5865F2)
          .setTitle('🔐 Security Config Updated')
          .setDescription(Object.entries(updates).map(([k, v]) => `**${k}:** ${v}`).join('\n') || 'No changes.')
          .setTimestamp()],
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
