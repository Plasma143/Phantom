// src/handlers/robloxVerify.js
//
// Roblox account-linking flow — separate from your existing verify_user
// button. That one gates server access; this one links a Discord account
// to a specific Roblox account and syncs roles based on Roblox group rank.
//
//   "Link Roblox" button -> modal asking for Roblox username
//   modal submit          -> looks up the account, shows a one-time code
//   "Confirm" button      -> checks the bio for that code, links + syncs roles
//   "Update" button       -> re-syncs roles/nickname for an already-linked user
//   "Sign in with Roblox" -> shows a link button that starts the OAuth login flow

import {
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { successEmbed, errorEmbed } from '../utils/embeds.js';
import { handleInteractionError } from '../utils/errorHandler.js';
import { logger } from '../utils/logger.js';
import { InteractionHelper } from '../utils/interactionHelper.js';
import {
  getRobloxUserByUsername,
  getRobloxRankInGroup,
  generateVerificationCode,
  bioContainsCode,
} from '../utils/roblox.js';
import { saveRobloxLink, getRobloxLink } from '../utils/robloxDb.js';
import { botConfig } from '../config/bot.js';

export const ROBLOX_LINK_BUTTON_ID = 'roblox_link_start';
export const ROBLOX_CONFIRM_BUTTON_ID = 'roblox_link_confirm';
export const ROBLOX_UPDATE_BUTTON_ID = 'roblox_link_update';
export const ROBLOX_OAUTH_BUTTON_ID = 'roblox_oauth_start';
export const USERNAME_MODAL_ID = 'roblox_username_modal';
export const USERNAME_INPUT_ID = 'roblox_username_input';

// Base URL of this bot's web server (Railway's public domain).
// Override with the PUBLIC_URL env var if the domain ever changes.
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://r2-d2-production.up.railway.app';

// Tracks in-progress links: discordId -> { robloxId, robloxUsername, code }
// Resets on restart — fine, codes are only needed briefly.
const pendingLinks = new Map();

function confirmButtonRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(ROBLOX_CONFIRM_BUTTON_ID)
      .setLabel('Confirm')
      .setStyle(ButtonStyle.Success),
  );
}

// "Link Roblox" button — opens a modal for the Roblox username.
// IMPORTANT: showModal must be the FIRST response to this interaction,
// so this handler does NOT call InteractionHelper.safeDefer.
export async function handleRobloxLinkButton(interaction, client) {
  try {
    if (!interaction.guild) {
      return await interaction.reply({
        embeds: [errorEmbed("Guild Only", "This button can only be used in a server.")],
        flags: MessageFlags.Ephemeral,
      });
    }

    const existing = await getRobloxLink(interaction.user.id);
    if (existing) {
      return await interaction.reply({
        embeds: [errorEmbed(
          "Already Linked",
          `You're already linked to Roblox account **${existing.roblox_username}**. Use the Update button if your rank changed.`,
        )],
        flags: MessageFlags.Ephemeral,
      });
    }

    const modal = new ModalBuilder()
      .setCustomId(USERNAME_MODAL_ID)
      .setTitle('Link Roblox Account');

    const usernameInput = new TextInputBuilder()
      .setCustomId(USERNAME_INPUT_ID)
      .setLabel('Your Roblox username')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(usernameInput));
    await interaction.showModal(modal);
  } catch (error) {
    logger.error('Error in Roblox link button handler', {
      error: error.message,
      userId: interaction.user.id,
    });
    await handleInteractionError(interaction, error, { command: 'roblox_link', action: 'show_modal' });
  }
}

// "Sign in with Roblox" button — replies with a link button that starts
// the OAuth login flow on the bot's web server.
export async function handleRobloxOAuthButton(interaction, client) {
  try {
    const url = `${PUBLIC_URL}/auth/roblox?discordId=${interaction.user.id}`;

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('Sign in with Roblox')
        .setStyle(ButtonStyle.Link)
        .setURL(url),
    );

    await interaction.reply({
      embeds: [successEmbed(
        "Sign in with Roblox",
        "Click the button below to log in with your Roblox account in your browser.\n\n" +
          "This option is still in testing and may only work for a few people until Roblox approves it — " +
          "if it doesn't work, use **Link Roblox** instead.",
      )],
      components: [row],
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    logger.error('Error in Roblox OAuth button handler', {
      error: error.message,
      userId: interaction.user.id,
    });
    await handleInteractionError(interaction, error, { command: 'roblox_oauth', action: 'show_link' });
  }
}

// Modal submit — looks up the Roblox account and generates a one-time code.
export async function handleRobloxUsernameModal(interaction, client) {
  try {
    await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });

    const username = interaction.fields.getTextInputValue(USERNAME_INPUT_ID).trim();
    const robloxUser = await getRobloxUserByUsername(username);

    if (!robloxUser) {
      return await InteractionHelper.safeEditReply(interaction, {
        embeds: [errorEmbed(
          "User Not Found",
          `Couldn't find a Roblox user named **${username}**. Check the spelling and try again.`,
        )],
      });
    }

    const code = generateVerificationCode();
    pendingLinks.set(interaction.user.id, {
      robloxId: robloxUser.id,
      robloxUsername: robloxUser.name,
      code,
    });

    logger.debug('User started Roblox link', {
      userId: interaction.user.id,
      robloxId: robloxUser.id,
      robloxUsername: robloxUser.name,
    });

    await InteractionHelper.safeEditReply(interaction, {
      embeds: [successEmbed(
        "Almost there!",
        `1. Open your [Roblox profile](https://www.roblox.com/users/${robloxUser.id}/profile)\n` +
          `2. Edit your **About** section to include this code:\n\`\`\`${code}\`\`\`\n` +
          `3. Click **Confirm** below once it's saved.`,
      )],
      components: [confirmButtonRow()],
    });
  } catch (error) {
    logger.error('Error in Roblox username modal handler', {
      error: error.message,
      userId: interaction.user.id,
    });
    await handleInteractionError(interaction, error, { command: 'roblox_link', action: 'username_modal' });
  }
}

// "Confirm" button — checks the bio for the code, then links + syncs roles.
export async function handleRobloxConfirmButton(interaction, client) {
  try {
    await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });

    const pending = pendingLinks.get(interaction.user.id);
    if (!pending) {
      return await InteractionHelper.safeEditReply(interaction, {
        embeds: [errorEmbed("Session Expired", "Click the Link Roblox button to start again.")],
      });
    }

    const found = await bioContainsCode(pending.robloxId, pending.code);
    if (!found) {
      return await InteractionHelper.safeEditReply(interaction, {
        embeds: [errorEmbed(
          "Code Not Found",
          "That code isn't showing up in your bio yet. Roblox can take a minute to update — wait a bit and click Confirm again.",
        )],
        components: [confirmButtonRow()],
      });
    }

    await saveRobloxLink(interaction.user.id, pending.robloxId, pending.robloxUsername);
    pendingLinks.delete(interaction.user.id);

    await syncRobloxRoles(interaction.member, pending.robloxId);
    await interaction.member.setNickname(pending.robloxUsername).catch(() => {
      // Bot may not be able to rename this member (e.g. server owner) — safe to ignore.
    });

    logger.info('User linked Roblox account', {
      userId: interaction.user.id,
      robloxId: pending.robloxId,
      robloxUsername: pending.robloxUsername,
    });

    await InteractionHelper.safeEditReply(interaction, {
      embeds: [successEmbed("Linked!", `Your Discord account is now linked to Roblox account **${pending.robloxUsername}**.`)],
      components: [],
    });
  } catch (error) {
    logger.error('Error in Roblox confirm button handler', {
      error: error.message,
      userId: interaction.user.id,
    });
    await handleInteractionError(interaction, error, { command: 'roblox_link', action: 'confirm' });
  }
}

// "Update" button — re-checks rank for an already-linked user and
// re-syncs their Discord roles/nickname.
export async function handleRobloxUpdateButton(interaction, client) {
  try {
    await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });

    const link = await getRobloxLink(interaction.user.id);
    if (!link) {
      return await InteractionHelper.safeEditReply(interaction, {
        embeds: [errorEmbed("Not Linked", "You haven't linked a Roblox account yet — click Link Roblox first.")],
      });
    }

    await syncRobloxRoles(interaction.member, link.roblox_id);
    await interaction.member.setNickname(link.roblox_username).catch(() => {});

    await InteractionHelper.safeEditReply(interaction, {
      embeds: [successEmbed("Updated!", `Your roles now match your current Roblox group rank, **${link.roblox_username}**.`)],
    });
  } catch (error) {
    logger.error('Error in Roblox update button handler', {
      error: error.message,
      userId: interaction.user.id,
    });
    await handleInteractionError(interaction, error, { command: 'roblox_link', action: 'update' });
  }
}

// Adds/removes Discord roles based on the member's current Roblox group rank.
// Reads botConfig.roblox.{groupId, rankRoles, verifiedRole}.
async function syncRobloxRoles(member, robloxId) {
  const { groupId, rankRoles, verifiedRole } = botConfig.roblox ?? {};

  if (verifiedRole) {
    await member.roles.add(verifiedRole).catch((err) => logger.error('Add verified role failed:', err));
  }

  if (!groupId || !rankRoles) return;

  const rank = await getRobloxRankInGroup(robloxId, groupId);

  const allRankRoleIds = Object.values(rankRoles);
  const toRemove = member.roles.cache
    .filter((role) => allRankRoleIds.includes(role.id))
    .map((role) => role.id);
  if (toRemove.length) {
    await member.roles.remove(toRemove).catch((err) => logger.error('Remove rank roles failed:', err));
  }

  const roleId = rankRoles[rank];
  if (roleId) {
    await member.roles.add(roleId).catch((err) => logger.error('Add rank role failed:', err));
  }
}
