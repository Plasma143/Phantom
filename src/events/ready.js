import { Events } from "discord.js";
import { logger, startupLog } from "../utils/logger.js";
import config from "../config/application.js";
import { reconcileReactionRoleMessages } from "../services/reactionRoleService.js";

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    try {
      client.user.setPresence(config.bot.presence);

      startupLog(`Ready! Logged in as ${client.user.tag}`);
      startupLog(`Serving ${client.guilds.cache.size} guild(s)`);
      startupLog(`Loaded ${client.commands.size} commands`);

      // Build command list
      const commands = [...client.commands.values()]
        .filter(cmd => cmd.data && typeof cmd.data.toJSON === 'function')
        .map(cmd => cmd.data.toJSON());

      // 1. Register globally (takes up to 1hr to propagate but covers all future servers)
      try {
        await client.application.commands.set(commands);
        startupLog(`✅ Registered ${commands.length} commands globally`);
      } catch (err) {
        logger.error('Global command registration failed:', err.message);
      }

      // 2. Register in every current guild immediately (instant, no propagation delay)
      let guildSuccesses = 0;
      for (const [, guild] of client.guilds.cache) {
        try {
          await guild.commands.set(commands);
          guildSuccesses++;
        } catch (err) {
          logger.warn(`Failed to register commands in ${guild.name}: ${err.message}`);
        }
      }
      startupLog(`✅ Registered commands in ${guildSuccesses}/${client.guilds.cache.size} guilds`);

      const reconciliationSummary = await reconcileReactionRoleMessages(client);
      startupLog(
        `Reaction role reconciliation: scanned ${reconciliationSummary.scannedMessages}, removed ${reconciliationSummary.removedMessages}, errors ${reconciliationSummary.errors}`
      );
    } catch (error) {
      logger.error("Error in ready event:", error);
    }
  },
};
