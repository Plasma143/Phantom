// src/interactions/modals/partnership.js
// Handles partnership_ad_modal (post to partnerships channel + grant partner trial)
// and partnership_deny_modal (send denial and close ticket).
import { MessageFlags, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { logger } from '../../utils/logger.js';
import { getSubscription } from '../../web/stripePayments.js';
import { db } from '../../utils/database.js';

const PARTNER_TRIAL_WEEKS = 3;

const partnershipAdModal = {
  name: 'partnership_ad_modal',
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const serverName     = interaction.fields.getTextInputValue('server_name').trim();
    const inviteLink     = interaction.fields.getTextInputValue('invite_link').trim();
    const description    = interaction.fields.getTextInputValue('description').trim();
    const memberCount    = interaction.fields.getTextInputValue('member_count').trim();
    const partnerGuildId = interaction.fields.getTextInputValue('partner_guild_id')?.trim() || '';

    // Find the #partnerships channel
    const partnershipsChannel = interaction.guild.channels.cache.find(
      c => c.name === 'partnerships' || c.name === 'partnership'
    );

    if (!partnershipsChannel) {
      return interaction.editReply({
        content: '❌ Could not find a **#partnerships** channel. Please create one and try again.',
      });
    }

    // Format the invite link cleanly
    const invite = inviteLink.startsWith('http') ? inviteLink : `https://discord.gg/${inviteLink.replace(/^discord\.gg\//, '')}`;

    // Post the partnership advertisement
    const adEmbed = new EmbedBuilder()
      .setTitle(`🤝 ${serverName}`)
      .setDescription(description)
      .addFields(
        { name: 'Members', value: memberCount, inline: true },
        { name: 'Invite', value: invite, inline: true },
      )
      .setColor(0x5865F2)
      .setFooter({ text: 'Phantom Studios Partnerships' })
      .setTimestamp();

    await partnershipsChannel.send({ embeds: [adEmbed] });

    // Notify the ticket that the ad was posted
    await interaction.channel.send({
      embeds: [new EmbedBuilder()
        .setTitle('✅ Partnership Accepted')
        .setDescription(`The advertisement for **${serverName}** has been posted in ${partnershipsChannel}.`)
        .setColor(0x57f287)
      ],
    });

    // ── Grant partner bonus trial ───────────────────────────────────────
    if (partnerGuildId && /^\d{17,20}$/.test(partnerGuildId)) {
      try {
        const existingSub = await getSubscription(partnerGuildId);
        const canGrant = !existingSub || existingSub.tier === 'free' || existingSub.wasTrialUser;

        if (canGrant) {
          const trialEnd = Date.now() + PARTNER_TRIAL_WEEKS * 7 * 24 * 60 * 60 * 1000;
          await db.set(`subscription:${partnerGuildId}`, {
            tier: 'premium',
            status: 'trialing',
            isTrial: true,
            isPartnerTrial: true,
            trialEnd,
            trialGrantedAt: Date.now(),
          });

          await interaction.channel.send({
            embeds: [new EmbedBuilder()
              .setTitle(`🎁 ${PARTNER_TRIAL_WEEKS}-Week Partner Trial Granted`)
              .setDescription(
                `A **${PARTNER_TRIAL_WEEKS}-week Premium trial** has been granted to the partner server.\n` +
                `Expires: <t:${Math.floor(trialEnd / 1000)}:F>`
              )
              .setColor(0x7c3aed)
            ],
          });

          logger.info(`[Partnership] Granted ${PARTNER_TRIAL_WEEKS}-week partner trial to guild ${partnerGuildId} (${serverName})`);
        } else {
          await interaction.channel.send({
            content: `ℹ️ Partner server \`${partnerGuildId}\` already has an active subscription — no trial granted.`,
          });
        }
      } catch (err) {
        logger.error('[Partnership] Failed to grant partner trial:', err.message);
      }
    }

    // Disable the accept/deny buttons in the original message
    try {
      const messages = await interaction.channel.messages.fetch({ limit: 20 });
      const botMsg = messages.find(m =>
        m.author.bot && m.components.length > 0 &&
        m.components[0]?.components?.some(c => c.customId === 'partnership_accept')
      );
      if (botMsg) await botMsg.edit({ components: [] });
    } catch {}

    await interaction.editReply({ content: `✅ Advertisement posted in ${partnershipsChannel}!` });
    logger.info(`[Partnership] Accepted: ${serverName} posted to ${partnershipsChannel.name} in ${interaction.guild.name}`);
  },
};

const partnershipDenyModal = {
  name: 'partnership_deny_modal',
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const reason = interaction.fields.getTextInputValue('reason')?.trim()
      || 'Your application did not meet our current partnership requirements.';

    // Notify the ticket
    await interaction.channel.send({
      embeds: [new EmbedBuilder()
        .setTitle('❌ Partnership Declined')
        .setDescription(
          `Thank you for your interest in partnering with **Phantom Studios**.\n\nUnfortunately, your application has been declined at this time.\n\n**Reason:** ${reason}\n\nYou are welcome to apply again in the future if your community grows or circumstances change.`
        )
        .setColor(0xed4245)
        .setFooter({ text: 'Phantom Studios Partnerships' })
      ],
    });

    // Disable the accept/deny buttons
    try {
      const messages = await interaction.channel.messages.fetch({ limit: 20 });
      const botMsg = messages.find(m =>
        m.author.bot && m.components.length > 0 &&
        m.components[0]?.components?.some(c => c.customId === 'partnership_accept')
      );
      if (botMsg) await botMsg.edit({ components: [] });
    } catch {}

    await interaction.editReply({ content: '❌ Partnership declined and user notified.' });
    logger.info(`[Partnership] Denied in ${interaction.guild.name}. Reason: ${reason}`);
  },
};

export default [partnershipAdModal, partnershipDenyModal];
