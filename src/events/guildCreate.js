// src/events/guildCreate.js
//
// Fires when Phantom joins a new server.
// Immediately registers slash commands for that guild so they appear
// without waiting for global propagation (which can take up to 1 hour).

import { Events } from 'discord.js';
import { logger, startupLog } from '../utils/logger.js';

export default {
  name: Events.GuildCreate,
  once: false,

  async execute(guild, client) {
    try {
      logger.info(`[guildCreate] Joined new guild: ${guild.name} (${guild.id})`);

      // Build command list from loaded commands
      const commands = [...client.commands.values()]
        .filter((cmd) => cmd.data && typeof cmd.data.toJSON === 'function')
        .map((cmd) => cmd.data.toJSON());

      if (!commands.length) {
        logger.warn('[guildCreate] No commands to register');
        return;
      }

      // Clear any existing guild-specific commands to prevent duplicates with global
      await guild.commands.set([]);
      logger.info(`[guildCreate] Cleared guild-specific commands in ${guild.name} — global commands will apply`);

    } catch (err) {
      logger.error(`[guildCreate] Failed to register commands in ${guild?.name}:`, err.message);
    }
  },
};
