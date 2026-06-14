import { Events, REST, Routes } from "discord.js";
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

      // Clear guild-specific commands from all guilds (removes duplicates)
      for (const [, guild] of client.guilds.cache) {
        try {
          await guild.commands.set([]);
        } catch (err) {
          logger.warn(`Could not clear guild commands for ${guild.name}: ${err.message}`);
        }
      }
      startupLog('✅ Cleared guild-specific commands (using global only)');

      // Register globally using REST API directly — more reliable than client.application.commands.set()
      try {
        const clientId = process.env.CLIENT_ID || '1515029322061054063';
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
        await rest.put(
          Routes.applicationCommands(clientId),
          { body: commands }
        );
        startupLog(`✅ Registered ${commands.length} commands globally`);
      } catch (err) {
        logger.error('Global command registration failed:', err?.message || String(err));
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
