// src/commands/Community/alliance.js
// Alliance system — link two Discord servers so they can sync announcements
// and optionally sync bans. Each alliance is mutual and stored on both sides.
import {
  SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, MessageFlags,
} from 'discord.js';
import { errorEmbed, successEmbed, infoEmbed } from '../../utils/embeds.js';
import { getFromDb, setInDb, deleteFromDb } from '../../utils/database.js';
import { getGuildConfig, updateGuildConfig } from '../../services/guildConfig.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { randomBytes } from 'crypto';

function allianceKey(guildId)  { return `alliances:${guildId}`; }
function codeKey(code)          { return `alliance_code:${code}`; }

async function getAlliances(guildId) {
  return await getFromDb(allianceKey(guildId), []);
}

async function saveAlliances(guildId, list) {
  await setInDb(allianceKey(guildId), list);
}

function generateCode() {
  return randomBytes(4).toString('hex').toUpperCase(); // e.g. A3F2C1B4
}

export default {
  data: new SlashCommandBuilder()
    .setName('alliance')
    .setDescription('Manage server alliances')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addSubcommand(s => s.setName('invite')
      .setDescription('Generate an alliance invite code for another server to use')
    )
    .addSubcommand(s => s.setName('join')
      .setDescription('Join an alliance using an invite code from another server')
      .addStringOption(o => o.setName('code').setDescription('The alliance invite code').setRequired(true))
    )
    .addSubcommand(s => s.setName('list')
      .setDescription('Show all current alliances')
    )
    .addSubcommand(s => s.setName('remove')
      .setDescription('Remove an alliance')
      .addStringOption(o => o.setName('server_id').setDescription('The allied server ID to remove').setRequired(true))
    )
    .addSubcommand(s => s.setName('sync')
      .setDescription('Toggle sync features with an allied server')
      .addStringOption(o => o.setName('server_id').setDescription('The allied server ID').setRequired(true))
      .addStringOption(o => o.setName('feature').setDescription('Feature to toggle').setRequired(true)
        .addChoices(
          { name: 'Announcement sync', value: 'syncAnnouncements' },
          { name: 'Ban sync', value: 'syncBans' },
        )
      )
    ),

  category: 'community',

  async execute(interaction, config, client) {
    const sub     = interaction.options.getSubcommand();
    const guildId = interaction.guildId;

    // ── INVITE ────────────────────────────────────────────────────────────
    if (sub === 'invite') {
      const code    = generateCode();
      const expires = Date.now() + 24 * 60 * 60 * 1000; // 24h

      await setInDb(codeKey(code), {
        guildId,
        guildName: interaction.guild.name,
        expiresAt: expires,
      });

      return InteractionHelper.safeReply(interaction, {
        embeds: [new EmbedBuilder()
          .setTitle('Alliance Invite Code')
          .setDescription(`Share this code with the server you want to ally with. They run \`/alliance join ${code}\` to link up.\n\n**Code:** \`${code}\`\n**Expires:** <t:${Math.floor(expires / 1000)}:R>`)
          .setColor(0x7c3aed)
        ],
        flags: MessageFlags.Ephemeral,
      });
    }

    // ── JOIN ──────────────────────────────────────────────────────────────
    if (sub === 'join') {
      const code = interaction.options.getString('code').trim().toUpperCase();
      const data = await getFromDb(codeKey(code), null);

      if (!data) {
        return InteractionHelper.safeReply(interaction, {
          embeds: [errorEmbed('Invalid Code', 'This code is invalid or has already been used.')],
          flags: MessageFlags.Ephemeral,
        });
      }
      if (data.expiresAt < Date.now()) {
        await deleteFromDb(codeKey(code));
        return InteractionHelper.safeReply(interaction, {
          embeds: [errorEmbed('Code Expired', 'This invite code has expired. Ask them to generate a new one.')],
          flags: MessageFlags.Ephemeral,
        });
      }
      if (data.guildId === guildId) {
        return InteractionHelper.safeReply(interaction, {
          embeds: [errorEmbed('Invalid', 'You cannot ally with your own server.')],
          flags: MessageFlags.Ephemeral,
        });
      }

      const partnerGuildId   = data.guildId;
      const partnerGuildName = data.guildName;

      // Check not already allied
      const existing = await getAlliances(guildId);
      if (existing.find(a => a.partnerGuildId === partnerGuildId)) {
        return InteractionHelper.safeReply(interaction, {
          embeds: [errorEmbed('Already Allied', `You are already allied with **${partnerGuildName}**.`)],
          flags: MessageFlags.Ephemeral,
        });
      }

      // Create alliance on both sides
      const allianceEntry = (myId, myName, theirId, theirName) => ({
        partnerGuildId: theirId,
        partnerGuildName: theirName,
        syncAnnouncements: false,
        syncBans: false,
        formedAt: Date.now(),
      });

      const myAlliances      = await getAlliances(guildId);
      const partnerAlliances = await getAlliances(partnerGuildId);

      myAlliances.push(allianceEntry(guildId, interaction.guild.name, partnerGuildId, partnerGuildName));
      partnerAlliances.push(allianceEntry(partnerGuildId, partnerGuildName, guildId, interaction.guild.name));

      await saveAlliances(guildId, myAlliances);
      await saveAlliances(partnerGuildId, partnerAlliances);
      await deleteFromDb(codeKey(code));

      // Notify the partner server
      try {
        const partnerGuild = client.guilds.cache.get(partnerGuildId);
        if (partnerGuild) {
          const owner = await client.users.fetch(partnerGuild.ownerId);
          await owner.send({
            embeds: [new EmbedBuilder()
              .setTitle('🤝 New Alliance Formed!')
              .setDescription(`**${interaction.guild.name}** has joined your alliance using your invite code.`)
              .setColor(0x57f287)
              .setTimestamp()
            ],
          }).catch(() => {});
        }
      } catch {}

      logger.info(`[Alliance] ${interaction.guild.name} (${guildId}) allied with ${partnerGuildName} (${partnerGuildId})`);

      return InteractionHelper.safeReply(interaction, {
        embeds: [successEmbed('Alliance Formed!', `**${interaction.guild.name}** is now allied with **${partnerGuildName}**.\n\nUse \`/alliance sync\` to enable announcement or ban syncing.`)],
      });
    }

    // ── LIST ──────────────────────────────────────────────────────────────
    if (sub === 'list') {
      const alliances = await getAlliances(guildId);
      if (!alliances.length) {
        return InteractionHelper.safeReply(interaction, {
          embeds: [infoEmbed('No Alliances', 'You have no alliances. Use `/alliance invite` to create one.')],
          flags: MessageFlags.Ephemeral,
        });
      }

      const lines = alliances.map(a => {
        const syncs = [];
        if (a.syncAnnouncements) syncs.push('📢 Announcements');
        if (a.syncBans) syncs.push('🔨 Bans');
        return `**${a.partnerGuildName}** \`${a.partnerGuildId}\`\n${syncs.length ? syncs.join(' · ') : 'No sync enabled'} · <t:${Math.floor(a.formedAt / 1000)}:R>`;
      }).join('\n\n');

      return InteractionHelper.safeReply(interaction, {
        embeds: [new EmbedBuilder()
          .setTitle(`🤝 Alliances (${alliances.length})`)
          .setDescription(lines)
          .setColor(0x7c3aed)
        ],
        flags: MessageFlags.Ephemeral,
      });
    }

    // ── REMOVE ────────────────────────────────────────────────────────────
    if (sub === 'remove') {
      const targetId = interaction.options.getString('server_id').trim();
      const list     = await getAlliances(guildId);
      const idx      = list.findIndex(a => a.partnerGuildId === targetId);

      if (idx === -1) {
        return InteractionHelper.safeReply(interaction, {
          embeds: [errorEmbed('Not Found', 'No alliance found with that server ID.')],
          flags: MessageFlags.Ephemeral,
        });
      }

      const [removed] = list.splice(idx, 1);
      await saveAlliances(guildId, list);

      // Remove from partner side too
      const partnerList = await getAlliances(targetId);
      const partnerIdx  = partnerList.findIndex(a => a.partnerGuildId === guildId);
      if (partnerIdx !== -1) {
        partnerList.splice(partnerIdx, 1);
        await saveAlliances(targetId, partnerList);
      }

      logger.info(`[Alliance] ${interaction.guild.name} removed alliance with ${removed.partnerGuildName}`);

      return InteractionHelper.safeReply(interaction, {
        embeds: [successEmbed('Alliance Removed', `Alliance with **${removed.partnerGuildName}** has been ended.`)],
      });
    }

    // ── SYNC ──────────────────────────────────────────────────────────────
    if (sub === 'sync') {
      const targetId = interaction.options.getString('server_id').trim();
      const feature  = interaction.options.getString('feature');
      const list     = await getAlliances(guildId);
      const alliance = list.find(a => a.partnerGuildId === targetId);

      if (!alliance) {
        return InteractionHelper.safeReply(interaction, {
          embeds: [errorEmbed('Not Found', 'No alliance found with that server ID. Use `/alliance list` to see allied servers.')],
          flags: MessageFlags.Ephemeral,
        });
      }

      alliance[feature] = !alliance[feature];
      await saveAlliances(guildId, list);

      const featureLabel = feature === 'syncAnnouncements' ? 'Announcement sync' : 'Ban sync';
      const state        = alliance[feature] ? 'enabled' : 'disabled';

      return InteractionHelper.safeReply(interaction, {
        embeds: [successEmbed(`${featureLabel} ${state} for **${alliance.partnerGuildName}**.`)],
      });
    }
  },
};
