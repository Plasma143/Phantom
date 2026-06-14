import { Events } from "discord.js";
import { logger, startupLog } from "../utils/logger.js";
import config from "../config/application.js";
import { reconcileReactionRoleMessages } from "../services/reactionRoleService.js";
import { loadCommands } from "../handlers/commandLoader.js";

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    try {
      client.user.setPresence(config.bot.presence);

      startupLog(`Ready! Logged in as ${client.user.tag}`);
      startupLog(`Serving ${client.guilds.cache.size} guild(s)`);
      startupLog(`Loaded ${client.commands.size} commands`);

      // Register commands globally now that client.application is available
      try {
        const commands = [...client.commands.values()]
          .filter(cmd => cmd.data && typeof cmd.data.toJSON === 'function')
          .map(cmd => cmd.data.toJSON());

        await client.application.commands.set(commands);
        startupLog(`✅ Registered ${commands.length} slash commands globally`);
      } catch (err) {
        logger.error('Failed to register global commands in ready event:', err.message);
      }

      const reconciliationSummary = await reconcileReactionRoleMessages(client);
      startupLog(
        `Reaction role reconciliation: scanned ${reconciliationSummary.scannedMessages}, removed ${reconciliationSummary.removedMessages}, errors ${reconciliationSummary.errors}`
      );
    } catch (error) {
      logger.error("Error in ready event:", error);
    }
  },
};
