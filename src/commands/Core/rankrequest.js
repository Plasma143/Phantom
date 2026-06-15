// src/commands/Core/rankrequest.js
// Premium — members request a rank change; staff approve/deny with a button
// and Phantom automatically applies the approved rank via Open Cloud.
import {
  SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  MessageFlags,
} from 'discord.js';
import { errorEmbed, successEmbed, infoEmbed } from '../../utils/embeds.js';
import { getConfigValue, updateGuildConfig } from '../../services/guildConfig.js';
import { getGroupRoles, getGroupMembership, updateGroupMemberRank } from '../../utils/roblox.js';
import { getRobloxLink } from '../../utils/robloxDb.js';
import { getSubscription, getTier, isOwner } from '../../web/stripePayments.js';
import { postAuditLog } from '../../services/phantomAudit.js';
import { getFromDb, setInDb } from '../../utils/database.js';
import { db } from '../../utils/database.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { logger } from '../../utils/logger.js';

function requestKey(guildId, id) { return `rankreq:${guildId}:${id}`; }
function counterKey(guildId)     { return `rankreq_counter:${guildId}`; }

async function nextId(guildId) {
  const n = ((await getFromDb(counterKey(guildId), 0)) || 0) + 1;
  await setInDb(counterKey(guildId), n);
  return n;
}

function statusEmbed(req, status) {
  const colors  = { pending: 0x5865f2, approved: 0x57f287, denied: 0xed4245 };
  const labels  = { pending: '⏳ Pending', approved: '✅ Approved', denied: '❌ Denied' };
  const embed = new EmbedBuilder()
    .setTitle(`Rank Request #${req.id}`)
    .setColor(colors[status] ?? 0x5865f2)
    .addFields(
      { name: 'Member', value: `<@${req.userId}>`, inline: true },
      { name: 'Roblox', value: req.robloxUsername || 'Unknown', inline: true },
      { name: 'Current Rank', value: req.currentRank || 'Unknown', inline: true },
      { name: 'Requested Rank', value: req.targetRankName, inline: true },
      { name: 'Status', value: labels[status] ?? '⏳ Pending', inline: true },
    )
    .setTimestamp(req.createdAt);

  if (req.reason) embed.addFields({ name: 'Reason', value: req.reason });
  if (req.reviewNote) embed.addFields({ name: 'Staff Note', value: req.reviewNote });
  if (req.reviewerId) embed.setFooter({ text: `Reviewed by ${req.reviewerTag}` });
  return embed;
}

function actionButtons(id, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`rr_approve:${id}`).setLabel('Approve & Apply').setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`rr_deny:${id}`).setLabel('Deny').setStyle(ButtonStyle.Danger).setDisabled(disabled),
  );
}

// ── Button handlers ────────────────────────────────────────────────────────────
export async function handleRankRequestButton(interaction, client) {
  const [action, idStr] = interaction.customId.split(':');
  const reqId   = parseInt(idStr, 10);
  const guildId = interaction.guildId;

  if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    return interaction.reply({ embeds: [errorEmbed('Permission Denied', 'You need `Manage Server` to review rank requests.')], flags: MessageFlags.Ephemeral });
  }

  const req = await getFromDb(requestKey(guildId, reqId), null);
  if (!req) return interaction.reply({ embeds: [errorEmbed('Not Found', 'Request not found.')], flags: MessageFlags.Ephemeral });
  if (req.status !== 'pending') return interaction.reply({ embeds: [errorEmbed('Already Reviewed', 'This request has already been reviewed.')], flags: MessageFlags.Ephemeral });

  await interaction.deferUpdate();

  const roblox = await getConfigValue({ db }, guildId, 'roblox', {});
  let reviewNote = null;

  if (action === 'rr_approve') {
    // Apply the rank via Open Cloud
    try {
      await updateGroupMemberRank(roblox.groupId, req.robloxId, req.targetRankId, roblox.openCloudKey);
      req.status      = 'approved';
      req.reviewerId  = interaction.user.id;
      req.reviewerTag = interaction.user.tag;
      await setInDb(requestKey(guildId, reqId), req);

      await postAuditLog(client, interaction.guild, 'roblox', {
        color: 0x57f287,
        title: '✅ Rank Request Approved',
        fields: [
          { name: 'Member', value: `<@${req.userId}>`, inline: true },
          { name: 'Roblox', value: req.robloxUsername, inline: true },
          { name: 'New Rank', value: req.targetRankName, inline: true },
          { name: 'Approved by', value: interaction.user.tag, inline: true },
        ],
      }).catch(() => {});

      // DM the member
      const user = await client.users.fetch(req.userId).catch(() => null);
      if (user) {
        await user.send({
          embeds: [successEmbed('Rank Request Approved!', `Your request for **${req.targetRankName}** in **${interaction.guild.name}** has been approved and your rank has been updated.`)],
        }).catch(() => {});
      }

      logger.info(`[RankReq] #${reqId} approved by ${interaction.user.tag} — set ${req.robloxUsername} to ${req.targetRankName}`);
    } catch (err) {
      logger.error('[RankReq] Failed to apply rank:', err.message);
      req.status      = 'denied';
      req.reviewerId  = interaction.user.id;
      req.reviewerTag = interaction.user.tag;
      req.reviewNote  = `Auto-denied: could not apply rank (${err.message})`;
      await setInDb(requestKey(guildId, reqId), req);
    }
  } else {
    req.status      = 'denied';
    req.reviewerId  = interaction.user.id;
    req.reviewerTag = interaction.user.tag;
    await setInDb(requestKey(guildId, reqId), req);

    const user = await client.users.fetch(req.userId).catch(() => null);
    if (user) {
      await user.send({
        embeds: [errorEmbed('Rank Request Denied', `Your request for **${req.targetRankName}** in **${interaction.guild.name}** was denied.`)],
      }).catch(() => {});
    }
  }

  await interaction.message.edit({
    embeds: [statusEmbed(req, req.status)],
    components: [actionButtons(reqId, true)],
  });
}

// ── Slash command ──────────────────────────────────────────────────────────────
export default {
  data: new SlashCommandBuilder()
    .setName('rankrequest')
    .setDescription('Rank request system')
    .setDMPermission(false)
    .addSubcommand(s => s.setName('setup')
      .setDescription('Set the channel for rank requests (admin only)')
      .addChannelOption(o => o.setName('channel').setDescription('Channel where requests are posted for staff review').setRequired(true))
    )
    .addSubcommand(s => s.setName('submit')
      .setDescription('Submit a request to change your Roblox group rank')
      .addStringOption(o => o.setName('reason').setDescription('Why you are requesting this rank (optional)').setMaxLength(300))
    ),

  category: 'core',

  async execute(interaction, config, client) {
    const sub     = interaction.options.getSubcommand();
    const guildId = interaction.guildId;

    if (sub === 'setup') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return InteractionHelper.safeReply(interaction, { embeds: [errorEmbed('Permission Denied', 'You need `Manage Server`.')], flags: MessageFlags.Ephemeral });
      }
      const channel = interaction.options.getChannel('channel');
      await updateGuildConfig(guildId, { rankRequestChannelId: channel.id });
      return InteractionHelper.safeReply(interaction, { embeds: [successEmbed('Rank request channel set to ' + channel.toString())], flags: MessageFlags.Ephemeral });
    }

    if (sub === 'submit') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      // Tier check
      const tierSub = await getSubscription(guildId);
      const tier    = isOwner(interaction.user.id) ? 'enterprise' : getTier(tierSub);
      if (tier === 'free') {
        return interaction.editReply({
          embeds: [new EmbedBuilder().setColor(0x7c3aed).setTitle('🔒 Premium Feature').setDescription('Rank requests require **Premium**.\n\nUpgrade at the [dashboard](https://phantom1.up.railway.app/dashboard).')],
        });
      }

      const guildConfig = await getConfigValue({ db }, guildId, 'guildConfig', {});
      if (!guildConfig.rankRequestChannelId) {
        return interaction.editReply({ embeds: [errorEmbed('Not Configured', 'No rank request channel is set. Ask an admin to run `/rankrequest setup`.')] });
      }

      const roblox = await getConfigValue({ db }, guildId, 'roblox', {});
      if (!roblox.groupId || !roblox.openCloudKey) {
        return interaction.editReply({ embeds: [errorEmbed('Not Configured', 'Roblox group is not set up in the dashboard.')] });
      }

      // Check Roblox link
      const link = await getRobloxLink(interaction.user.id);
      if (!link?.roblox_id) {
        return interaction.editReply({ embeds: [errorEmbed('Not Verified', 'You need to link your Roblox account first. Use the verification panel.')] });
      }

      // Fetch group roles and current rank
      let roles, membership;
      try {
        [roles, membership] = await Promise.all([
          getGroupRoles(roblox.groupId, roblox.openCloudKey),
          getGroupMembership(roblox.groupId, link.roblox_id, roblox.openCloudKey),
        ]);
      } catch (err) {
        return interaction.editReply({ embeds: [errorEmbed('Roblox Error', `Could not fetch group data: \`${err.message}\``)] });
      }

      const currentRank = membership?.role?.name || 'Guest';

      // Build rank dropdown — exclude ranks equal to or below current rank
      const currentRankPos = membership?.role?.rank ?? 0;
      const options = roles
        .filter(r => r.rank > 0 && r.rank !== currentRankPos)
        .slice(0, 25)
        .map(r => new StringSelectMenuOptionBuilder()
          .setLabel(r.name)
          .setDescription(`Rank ${r.rank}`)
          .setValue(`${r.rank}:${r.name}`)
        );

      if (!options.length) {
        return interaction.editReply({ embeds: [errorEmbed('No Ranks Available', 'There are no ranks available to request.')] });
      }

      const select = new StringSelectMenuBuilder()
        .setCustomId(`rr_select:${interaction.user.id}`)
        .setPlaceholder('Select the rank you are requesting...')
        .addOptions(options);

      await interaction.editReply({
        embeds: [infoEmbed('Select a Rank', `Your current rank: **${currentRank}**\n\nChoose the rank you want to request below.`)],
        components: [new ActionRowBuilder().addComponents(select)],
      });
    }
  },
};

// ── Select menu handler ───────────────────────────────────────────────────────
export async function handleRankRequestSelect(interaction, client) {
  const [, requesterId] = interaction.customId.split(':');
  if (interaction.user.id !== requesterId) {
    return interaction.reply({ embeds: [errorEmbed('Not Yours', 'This menu is not for you.')], flags: MessageFlags.Ephemeral });
  }

  await interaction.deferUpdate();

  const [targetRankId, ...rankNameParts] = interaction.values[0].split(':');
  const targetRankName = rankNameParts.join(':');
  const guildId = interaction.guildId;

  const roblox    = await getConfigValue({ db }, guildId, 'roblox', {});
  const link      = await getRobloxLink(interaction.user.id);
  const membership = await getGroupMembership(roblox.groupId, link.roblox_id, roblox.openCloudKey).catch(() => null);
  const currentRank = membership?.role?.name || 'Guest';

  const reason = null; // Could add a follow-up modal for reason here
  const reqId  = await nextId(guildId);
  const reqData = {
    id: reqId,
    userId: interaction.user.id,
    robloxId: link.roblox_id,
    robloxUsername: link.roblox_username,
    currentRank,
    targetRankId: parseInt(targetRankId, 10),
    targetRankName,
    reason,
    status: 'pending',
    reviewerId: null,
    reviewerTag: null,
    reviewNote: null,
    createdAt: Date.now(),
  };

  await setInDb(requestKey(guildId, reqId), reqData);

  // Post to rank request channel
  const guildConfig = await getConfigValue({ db }, guildId, 'guildConfig', {});
  const channel = interaction.guild.channels.cache.get(guildConfig.rankRequestChannelId);
  if (channel) {
    await channel.send({
      embeds: [statusEmbed(reqData, 'pending')],
      components: [actionButtons(reqId)],
    });
  }

  await interaction.editReply({
    embeds: [successEmbed('Request Submitted!', `Your request for **${targetRankName}** has been sent to staff for review. You will be DM'd when it is reviewed.`)],
    components: [],
  });

  logger.info(`[RankReq] #${reqId} submitted by ${interaction.user.tag} → ${targetRankName}`);
}
