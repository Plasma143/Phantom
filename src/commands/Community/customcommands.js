// src/commands/Community/customcommands.js
// Premium feature: servers create their own custom text commands.
// Triggers are matched in messageCreate and Phantom responds with the set text.
import { SlashCommandBuilder, EmbedBuilder, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { getFromDb, setInDb } from '../../utils/database.js';
import { getSubscription, getTier, isOwner } from '../../web/stripePayments.js';
import { logger } from '../../utils/logger.js';

const MAX_COMMANDS = { free: 0, premium: 25, enterprise: 100 };

function ccKey(guildId) { return `customcmds:${guildId}`; }

async function getCommands(guildId) {
  return (await getFromDb(ccKey(guildId))) || {};
}

async function saveCommands(guildId, cmds) {
  await setInDb(ccKey(guildId), cmds);
}

function err(msg) { return new EmbedBuilder().setColor(0xed4245).setDescription(`❌ ${msg}`); }
function ok(msg)  { return new EmbedBuilder().setColor(0x57f287).setDescription(msg); }

export default {
  data: new SlashCommandBuilder()
    .setName('customcommand')
    .setDescription('Create and manage custom server commands (Premium)')
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(s => s
      .setName('create')
      .setDescription('Create a custom command')
      .addStringOption(o =>
        o.setName('trigger').setDescription('The trigger word or phrase (e.g. !rules)').setRequired(true).setMaxLength(50)
      )
      .addStringOption(o =>
        o.setName('response').setDescription('What Phantom replies with').setRequired(true).setMaxLength(2000)
      )
    )
    .addSubcommand(s => s
      .setName('delete')
      .setDescription('Delete a custom command')
      .addStringOption(o =>
        o.setName('trigger').setDescription('The trigger to delete').setRequired(true)
      )
    )
    .addSubcommand(s => s
      .setName('list')
      .setDescription('List all custom commands for this server')
    )
    .addSubcommand(s => s
      .setName('edit')
      .setDescription('Edit an existing custom command response')
      .addStringOption(o =>
        o.setName('trigger').setDescription('The trigger to edit').setRequired(true)
      )
      .addStringOption(o =>
        o.setName('response').setDescription('The new response').setRequired(true).setMaxLength(2000)
      )
    ),
  category: 'community',

  async execute(interaction) {
    const sub     = interaction.options.getSubcommand();
    const guildId = interaction.guildId;

    // Tier check
    const subData = await getSubscription(guildId);
    const tier    = isOwner(interaction.user.id) ? 'enterprise' : getTier(subData);
    const limit   = MAX_COMMANDS[tier] || 0;

    if (limit === 0) {
      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(0x7c3aed)
          .setTitle('🔒 Premium Feature')
          .setDescription(
            'Custom commands require **Premium** (25 commands) or **Enterprise** (100 commands).\n' +
            'Upgrade at **phantombot.org/dashboard**'
          )
        ],
        flags: MessageFlags.Ephemeral,
      });
    }

    const cmds = await getCommands(guildId);

    if (sub === 'create') {
      const trigger  = interaction.options.getString('trigger').toLowerCase().trim();
      const response = interaction.options.getString('response').trim();

      if (cmds[trigger]) {
        return interaction.reply({ embeds: [err(`Command **${trigger}** already exists. Use \`/customcommand edit\` to update it.`)], flags: MessageFlags.Ephemeral });
      }

      const count = Object.keys(cmds).length;
      if (count >= limit) {
        return interaction.reply({ embeds: [err(`You've reached the limit of **${limit}** custom commands for ${tier}.`)], flags: MessageFlags.Ephemeral });
      }

      cmds[trigger] = { response, createdBy: interaction.user.id, createdAt: Date.now() };
      await saveCommands(guildId, cmds);

      logger.info(`[CustomCmds] Created "${trigger}" in guild ${guildId}`);
      return interaction.reply({
        embeds: [ok(`✅ Custom command **${trigger}** created! (${count + 1}/${limit})\n\nWhen someone types \`${trigger}\` in chat, Phantom will respond with:\n> ${response.slice(0, 100)}${response.length > 100 ? '...' : ''}`)],
      });
    }

    if (sub === 'edit') {
      const trigger  = interaction.options.getString('trigger').toLowerCase().trim();
      const response = interaction.options.getString('response').trim();

      if (!cmds[trigger]) {
        return interaction.reply({ embeds: [err(`Command **${trigger}** not found. Use \`/customcommand list\` to see all commands.`)], flags: MessageFlags.Ephemeral });
      }

      cmds[trigger].response  = response;
      cmds[trigger].editedBy  = interaction.user.id;
      cmds[trigger].editedAt  = Date.now();
      await saveCommands(guildId, cmds);

      return interaction.reply({ embeds: [ok(`✅ **${trigger}** updated.`)] });
    }

    if (sub === 'delete') {
      const trigger = interaction.options.getString('trigger').toLowerCase().trim();

      if (!cmds[trigger]) {
        return interaction.reply({ embeds: [err(`Command **${trigger}** not found.`)], flags: MessageFlags.Ephemeral });
      }

      delete cmds[trigger];
      await saveCommands(guildId, cmds);

      logger.info(`[CustomCmds] Deleted "${trigger}" in guild ${guildId}`);
      return interaction.reply({ embeds: [ok(`🗑️ Custom command **${trigger}** deleted.`)] });
    }

    if (sub === 'list') {
      const entries = Object.entries(cmds);
      if (!entries.length) {
        return interaction.reply({
          embeds: [new EmbedBuilder()
            .setColor(0x7c3aed)
            .setDescription('No custom commands yet. Use `/customcommand create` to add one!')
          ],
          flags: MessageFlags.Ephemeral,
        });
      }

      const lines = entries.map(([trigger, data]) =>
        `**${trigger}** — ${data.response.slice(0, 60)}${data.response.length > 60 ? '...' : ''}`
      );

      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setTitle('⚡ Custom Commands')
          .setColor(0x7c3aed)
          .setDescription(lines.join('\n'))
          .setFooter({ text: `${entries.length}/${limit} commands used` })
        ],
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
