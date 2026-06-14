import { getColor } from '../../config/bot.js';
import { SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags, EmbedBuilder } from 'discord.js';
import { createEmbed, errorEmbed } from '../../utils/embeds.js';
import { getLevelingConfig, saveLevelingConfig, addLevels, removeLevels, getUserLevelData, setUserLevel } from '../../services/leveling.js';
import { botHasPermission, checkUserPermissions } from '../../utils/permissionGuard.js';
import { TitanBotError, ErrorTypes, handleInteractionError } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { logger } from '../../utils/logger.js';
import levelDashboard from './modules/level_dashboard.js';

export default {
    data: new SlashCommandBuilder()
        .setName('level')
        .setDescription('Manage the leveling system')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .setDMPermission(false)
        .addSubcommand((subcommand) =>
            subcommand
                .setName('setup')
                .setDescription('Set up the leveling system — this also enables it')
                .addChannelOption((option) =>
                    option
                        .setName('channel')
                        .setDescription('Channel to send level-up notifications in')
                        .addChannelTypes(ChannelType.GuildText)
                        .setRequired(true),
                )
                .addIntegerOption((option) =>
                    option
                        .setName('xp_min')
                        .setDescription('Minimum XP awarded per message (default: 15)')
                        .setMinValue(1)
                        .setMaxValue(500)
                        .setRequired(false),
                )
                .addIntegerOption((option) =>
                    option
                        .setName('xp_max')
                        .setDescription('Maximum XP awarded per message (default: 25)')
                        .setMinValue(1)
                        .setMaxValue(500)
                        .setRequired(false),
                )
                .addStringOption((option) =>
                    option
                        .setName('message')
                        .setDescription(
                            'Level-up message. Use {user} and {level} as placeholders (default provided)',
                        )
                        .setMaxLength(500)
                        .setRequired(false),
                )
                .addIntegerOption((option) =>
                    option
                        .setName('xp_cooldown')
                        .setDescription('Seconds between XP grants per user (default: 60)')
                        .setMinValue(0)
                        .setMaxValue(3600)
                        .setRequired(false),
                ),
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('dashboard')
                .setDescription('Open the interactive leveling configuration dashboard'),
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('add')
                .setDescription('Add levels to a user')
                .addUserOption((option) =>
                    option.setName('user').setDescription('The user to add levels to').setRequired(true),
                )
                .addIntegerOption((option) =>
                    option.setName('levels').setDescription('Number of levels to add').setRequired(true).setMinValue(1),
                ),
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('remove')
                .setDescription('Remove levels from a user')
                .addUserOption((option) =>
                    option.setName('user').setDescription('The user to remove levels from').setRequired(true),
                )
                .addIntegerOption((option) =>
                    option.setName('levels').setDescription('Number of levels to remove').setRequired(true).setMinValue(1),
                ),
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('set')
                .setDescription("Set a user's level to a specific value")
                .addUserOption((option) =>
                    option.setName('user').setDescription('The user to update').setRequired(true),
                )
                .addIntegerOption((option) =>
                    option.setName('level').setDescription('The level to set').setRequired(true).setMinValue(0),
                ),
        ),
    category: 'Leveling',

    async execute(interaction, config, client) {
        try {
            const deferred = await InteractionHelper.safeDefer(interaction, {
                flags: MessageFlags.Ephemeral,
            });
            if (!deferred) return;

            if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
                return await InteractionHelper.safeEditReply(interaction, {
                    embeds: [
                        errorEmbed(
                            'Missing Permissions',
                            'You need the **Manage Server** permission to use this command.',
                        ),
                    ],
                });
            }

            const subcommand = interaction.options.getSubcommand();

            if (subcommand === 'dashboard') {
                return levelDashboard.execute(interaction, config, client);
            }

            // Shared leveling-disabled check for admin subcommands
            const requireLevelingEnabled = async () => {
                const cfg = await getLevelingConfig(client, interaction.guildId);
                if (!cfg?.enabled) {
                    await InteractionHelper.safeEditReply(interaction, {
                        embeds: [new EmbedBuilder().setColor('#f1c40f').setDescription('The leveling system is currently disabled on this server.')],
                        flags: MessageFlags.Ephemeral,
                    });
                    return null;
                }
                return cfg;
            };

            const requireMember = async (targetUser) => {
                const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
                if (!member) throw new TitanBotError(`User ${targetUser.id} not in guild`, ErrorTypes.USER_INPUT, 'The specified user is not in this server.');
                return member;
            };

            if (subcommand === 'add') {
                if (!await requireLevelingEnabled()) return;
                const targetUser  = interaction.options.getUser('user');
                const levelsToAdd = interaction.options.getInteger('levels');
                await requireMember(targetUser);
                const userData = await addLevels(client, interaction.guildId, targetUser.id, levelsToAdd);
                logger.info(`[ADMIN] ${interaction.user.tag} added ${levelsToAdd} levels to ${targetUser.tag} in ${interaction.guildId}`);
                return InteractionHelper.safeEditReply(interaction, {
                    embeds: [createEmbed({ title: '✅ Levels Added', description: `Added **${levelsToAdd}** levels to ${targetUser.tag}.\n**New Level:** ${userData.level}`, color: 'success' })],
                });
            }

            if (subcommand === 'remove') {
                if (!await requireLevelingEnabled()) return;
                const targetUser     = interaction.options.getUser('user');
                const levelsToRemove = interaction.options.getInteger('levels');
                await requireMember(targetUser);
                const existing = await getUserLevelData(client, interaction.guildId, targetUser.id);
                if (existing.level === 0) throw new TitanBotError('Already min level', ErrorTypes.VALIDATION, `${targetUser.tag} is already at level 0.`);
                const updated = await removeLevels(client, interaction.guildId, targetUser.id, levelsToRemove);
                logger.info(`[ADMIN] ${interaction.user.tag} removed ${levelsToRemove} levels from ${targetUser.tag} in ${interaction.guildId}`);
                return InteractionHelper.safeEditReply(interaction, {
                    embeds: [createEmbed({ title: '✅ Levels Removed', description: `Removed **${levelsToRemove}** levels from ${targetUser.tag}.\n**New Level:** ${updated.level}`, color: 'success' })],
                });
            }

            if (subcommand === 'set') {
                if (!await requireLevelingEnabled()) return;
                const targetUser = interaction.options.getUser('user');
                const newLevel   = interaction.options.getInteger('level');
                await requireMember(targetUser);
                const userData = await setUserLevel(client, interaction.guildId, targetUser.id, newLevel);
                logger.info(`[ADMIN] ${interaction.user.tag} set ${targetUser.tag}'s level to ${newLevel} in ${interaction.guildId}`);
                return InteractionHelper.safeEditReply(interaction, {
                    embeds: [createEmbed({ title: '✅ Level Set', description: `Set ${targetUser.tag}'s level to **${newLevel}**.\n**Total XP:** ${userData.totalXp}`, color: 'success' })],
                });
            }

            if (subcommand === 'setup') {
                const channel = interaction.options.getChannel('channel');
                const xpMin = interaction.options.getInteger('xp_min') ?? 15;
                const xpMax = interaction.options.getInteger('xp_max') ?? 25;
                const message =
                    interaction.options.getString('message') ??
                    '{user} has leveled up to level {level}!';
                const xpCooldown = interaction.options.getInteger('xp_cooldown') ?? 60;

                if (xpMin > xpMax) {
                    return await InteractionHelper.safeEditReply(interaction, {
                        embeds: [
                            errorEmbed(
                                'Invalid XP Range',
                                `Minimum XP (**${xpMin}**) cannot be greater than maximum XP (**${xpMax}**).`,
                            ),
                        ],
                    });
                }

                if (!botHasPermission(channel, ['SendMessages', 'EmbedLinks'])) {
                    throw new TitanBotError(
                        'Bot missing permissions in the specified channel',
                        ErrorTypes.PERMISSION,
                        `I need **SendMessages** and **EmbedLinks** permissions in ${channel} to send level-up notifications.`,
                    );
                }

                const existingConfig = await getLevelingConfig(client, interaction.guildId);

                if (existingConfig.configured) {
                    return await InteractionHelper.safeEditReply(interaction, {
                        embeds: [
                            errorEmbed(
                                'Leveling System Already Active',
                                `The leveling system is already set up on this server (level-up notifications go to <#${existingConfig.levelUpChannel}>).\n\nUse \`/level dashboard\` to adjust any settings.`,
                            ),
                        ],
                    });
                }

                const newConfig = {
                    ...existingConfig,
                    configured: true,
                    enabled: true,
                    levelUpChannel: channel.id,
                    xpRange: { min: xpMin, max: xpMax },
                    xpCooldown: xpCooldown,
                    levelUpMessage: message,
                    announceLevelUp: true,
                };

                await saveLevelingConfig(client, interaction.guildId, newConfig);

                logger.info(`Leveling system set up in guild ${interaction.guildId}`, {
                    channelId: channel.id,
                    xpMin,
                    xpMax,
                    xpCooldown,
                    userId: interaction.user.id,
                });

                return await InteractionHelper.safeEditReply(interaction, {
                    embeds: [
                        createEmbed({
                            title: '✅ Leveling System Set Up',
                            description:
                                `The leveling system is now **enabled** and ready to go.\n\n` +
                                `**Level-up Channel:** ${channel}\n` +
                                `**XP per Message:** ${xpMin} – ${xpMax}\n` +
                                `**XP Cooldown:** ${xpCooldown}s\n` +
                                `**Level-up Message:** \`${message}\`\n\n` +
                                `Use \`/level dashboard\` to adjust any of these settings at any time.`,
                            color: 'success',
                        }),
                    ],
                });
            }
        } catch (error) {
            logger.error('Level command error:', error);
            await handleInteractionError(interaction, error, {
                type: 'command',
                commandName: 'level',
            });
        }
    },
};
