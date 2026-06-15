// src/commands/Welcome/welcome.js
// Consolidated welcome command — absorbs goodbye and autorole to stay under Discord's 100 command limit.
// /welcome setup — configure welcome message
// /welcome goodbye setup — configure goodbye message
// /welcome autorole add/remove/list — manage auto-assigned roles on join
import { getColor } from '../../config/bot.js';
import { SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder, MessageFlags } from 'discord.js';
import { errorEmbed } from '../../utils/embeds.js';
import { getWelcomeConfig, updateWelcomeConfig } from '../../utils/database.js';
import { formatWelcomeMessage } from '../../utils/welcome.js';
import { getGuildConfig } from '../../services/guildConfig.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

export default {
    data: new SlashCommandBuilder()
        .setName('welcome')
        .setDescription('Configure welcome, goodbye, and auto-role settings')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        // ── /welcome setup ──────────────────────────────────────────────
        .addSubcommand(sub => sub
            .setName('setup')
            .setDescription('Set up the welcome message')
            .addChannelOption(o => o.setName('channel').setDescription('Channel to send welcome messages to').addChannelTypes(ChannelType.GuildText).setRequired(true))
            .addStringOption(o => o.setName('message').setDescription('Welcome message. Variables: {user}, {username}, {server}, {memberCount}').setRequired(true))
            .addStringOption(o => o.setName('image').setDescription('URL of image to include').setRequired(false))
            .addBooleanOption(o => o.setName('ping').setDescription('Ping the user in the welcome message').setRequired(false))
        )
        // ── /welcome goodbye setup ──────────────────────────────────────
        .addSubcommandGroup(group => group
            .setName('goodbye')
            .setDescription('Configure the goodbye message')
            .addSubcommand(sub => sub
                .setName('setup')
                .setDescription('Set up the goodbye message')
                .addChannelOption(o => o.setName('channel').setDescription('Channel to send goodbye messages to').addChannelTypes(ChannelType.GuildText).setRequired(true))
                .addStringOption(o => o.setName('message').setDescription('Goodbye message. Variables: {user}, {username}, {server}, {memberCount}').setRequired(true))
                .addStringOption(o => o.setName('image').setDescription('URL of image to include').setRequired(false))
                .addBooleanOption(o => o.setName('ping').setDescription('Ping the user in the goodbye message').setRequired(false))
            )
        )
        // ── /welcome autorole ───────────────────────────────────────────
        .addSubcommandGroup(group => group
            .setName('autorole')
            .setDescription('Manage roles automatically assigned to new members')
            .addSubcommand(sub => sub
                .setName('add')
                .setDescription('Set a role to be automatically assigned to new members')
                .addRoleOption(o => o.setName('role').setDescription('The role to add').setRequired(true))
            )
            .addSubcommand(sub => sub
                .setName('remove')
                .setDescription('Remove a role from auto-assignment')
                .addRoleOption(o => o.setName('role').setDescription('The role to remove').setRequired(true))
            )
            .addSubcommand(sub => sub
                .setName('list')
                .setDescription('List all auto-assigned roles')
            )
        ),

    async execute(interaction) {
        const deferSuccess = await InteractionHelper.safeDefer(interaction);
        if (!deferSuccess) return;

        const { options, guild, client } = interaction;

        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
            return InteractionHelper.safeEditReply(interaction, {
                embeds: [errorEmbed('Missing Permissions', 'You need the **Manage Server** permission.')],
                flags: MessageFlags.Ephemeral,
            });
        }

        const group = options.getSubcommandGroup(false);
        const sub   = options.getSubcommand();

        // ── /welcome setup ────────────────────────────────────────────────
        if (!group && sub === 'setup') {
            const channel = options.getChannel('channel');
            const message = options.getString('message');
            const image   = options.getString('image');
            const ping    = options.getBoolean('ping') ?? false;

            if (!message?.trim()) {
                return InteractionHelper.safeEditReply(interaction, {
                    embeds: [errorEmbed('Invalid Input', 'Welcome message cannot be empty.')],
                    flags: MessageFlags.Ephemeral,
                });
            }
            if (image) {
                try { new URL(image); } catch {
                    return InteractionHelper.safeEditReply(interaction, {
                        embeds: [errorEmbed('Invalid Image URL', 'Please provide a valid URL starting with http:// or https://')],
                        flags: MessageFlags.Ephemeral,
                    });
                }
            }

            await updateWelcomeConfig(client, guild.id, {
                enabled: true, channelId: channel.id,
                welcomeMessage: message, welcomeImage: image || undefined, welcomePing: ping,
            });

            const preview = formatWelcomeMessage(message, { user: interaction.user, guild });
            const embed = new EmbedBuilder()
                .setColor(getColor('success'))
                .setTitle('✅ Welcome System Configured')
                .setDescription(`Welcome messages will be sent to ${channel}`)
                .addFields({ name: 'Preview', value: preview }, { name: 'Ping', value: ping ? 'Yes' : 'No' });
            if (image) embed.setImage(image);

            logger.info(`[Welcome] Setup by ${interaction.user.tag} in ${guild.name}`);
            return InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
        }

        // ── /welcome goodbye setup ─────────────────────────────────────────
        if (group === 'goodbye' && sub === 'setup') {
            const channel = options.getChannel('channel');
            const message = options.getString('message');
            const image   = options.getString('image');
            const ping    = options.getBoolean('ping') ?? false;

            if (!message?.trim()) {
                return InteractionHelper.safeEditReply(interaction, {
                    embeds: [errorEmbed('Invalid Input', 'Goodbye message cannot be empty.')],
                    flags: MessageFlags.Ephemeral,
                });
            }
            if (image) {
                try { new URL(image); } catch {
                    return InteractionHelper.safeEditReply(interaction, {
                        embeds: [errorEmbed('Invalid Image URL', 'Please provide a valid URL starting with http:// or https://')],
                        flags: MessageFlags.Ephemeral,
                    });
                }
            }

            await updateWelcomeConfig(client, guild.id, {
                goodbyeEnabled: true, goodbyeChannelId: channel.id,
                leaveMessage: message, goodbyePing: ping,
                leaveEmbed: {
                    title: 'Goodbye {user.tag}', description: message,
                    color: getColor('error'), footer: `Goodbye from ${guild.name}!`,
                    ...(image && { image: { url: image } }),
                },
            });

            const preview = formatWelcomeMessage(message, { user: interaction.user, guild });
            const embed = new EmbedBuilder()
                .setColor(getColor('success'))
                .setTitle('✅ Goodbye System Configured')
                .setDescription(`Goodbye messages will be sent to ${channel}`)
                .addFields({ name: 'Preview', value: preview }, { name: 'Ping', value: ping ? 'Yes' : 'No' });
            if (image) embed.setImage(image);

            logger.info(`[Goodbye] Setup by ${interaction.user.tag} in ${guild.name}`);
            return InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
        }

        // ── /welcome autorole ──────────────────────────────────────────────
        if (group === 'autorole') {
            if (sub === 'add') {
                const role = options.getRole('role');
                const guildConfig = await getGuildConfig(client, guild.id);

                if (guildConfig.verification?.enabled || guildConfig.verification?.autoVerify?.enabled) {
                    return InteractionHelper.safeEditReply(interaction, {
                        embeds: [errorEmbed('Setup Conflict', 'You cannot use AutoRole while the verification system or AutoVerify is enabled.')],
                        flags: MessageFlags.Ephemeral,
                    });
                }
                if (role.position >= guild.members.me.roles.highest.position) {
                    return InteractionHelper.safeEditReply(interaction, {
                        embeds: [errorEmbed('Role Too High', "I can't assign roles higher than my highest role.")],
                        flags: MessageFlags.Ephemeral,
                    });
                }

                await updateWelcomeConfig(client, guild.id, { roleIds: [role.id] });
                logger.info(`[Autorole] Set to ${role.name} in ${guild.name} by ${interaction.user.tag}`);
                return InteractionHelper.safeEditReply(interaction, {
                    embeds: [new EmbedBuilder().setColor(getColor('primary')).setDescription(`✅ Auto-role set to ${role}.`)],
                    flags: MessageFlags.Ephemeral,
                });
            }

            if (sub === 'remove') {
                const role   = options.getRole('role');
                const config = await getWelcomeConfig(client, guild.id);
                const roles  = config.roleIds || [];
                if (!roles.includes(role.id)) {
                    return InteractionHelper.safeEditReply(interaction, {
                        embeds: [errorEmbed('Not Found', `${role} is not set to be auto-assigned.`)],
                        flags: MessageFlags.Ephemeral,
                    });
                }
                await updateWelcomeConfig(client, guild.id, { roleIds: roles.filter(id => id !== role.id) });
                logger.info(`[Autorole] Removed ${role.name} in ${guild.name} by ${interaction.user.tag}`);
                return InteractionHelper.safeEditReply(interaction, {
                    embeds: [new EmbedBuilder().setColor(getColor('primary')).setDescription(`✅ Removed ${role} from auto-assigned roles.`)],
                    flags: MessageFlags.Ephemeral,
                });
            }

            if (sub === 'list') {
                const config = await getWelcomeConfig(client, guild.id);
                const roleIds = config.roleIds || [];
                if (!roleIds.length) {
                    return InteractionHelper.safeEditReply(interaction, {
                        embeds: [new EmbedBuilder().setColor(getColor('primary')).setDescription('ℹ️ No auto-role is configured.')],
                        flags: MessageFlags.Ephemeral,
                    });
                }
                const role = guild.roles.cache.get(roleIds[0]);
                return InteractionHelper.safeEditReply(interaction, {
                    embeds: [new EmbedBuilder()
                        .setColor(getColor('primary'))
                        .setTitle('Auto-Assigned Role')
                        .setDescription(role ? `${role}` : `Unknown role (${roleIds[0]})`)
                    ],
                    flags: MessageFlags.Ephemeral,
                });
            }
        }
    },
};
