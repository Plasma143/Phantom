// src/commands/Voice/play.js
// Play royalty-free music from Jamendo (100% legal, CC licensed).
import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { joinVoiceChannel } from '@discordjs/voice';
import { musicQueues, createGuildQueue, searchJamendo, formatTrack, playNext } from '../../services/musicQueue.js';
import { logger } from '../../utils/logger.js';

function err(msg) { return new EmbedBuilder().setColor(0xed4245).setDescription(`❌ ${msg}`); }

export default {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play royalty-free music from Jamendo')
    .setDMPermission(false)
    .addStringOption(o =>
      o.setName('query')
        .setDescription('Song name, artist, or genre to search')
        .setRequired(true)
    ),
  category: 'voice',

  async execute(interaction) {
    const query = interaction.options.getString('query');
    const vc    = interaction.member.voice?.channel;

    if (!vc) {
      return interaction.reply({ embeds: [err('Join a voice channel first.')], flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply();

    try {
      const results = await searchJamendo(query, 1);
      if (!results.length) {
        return interaction.editReply({ embeds: [err(`No tracks found for **${query}**. Try a different search.`)] });
      }

      const track   = formatTrack(results[0]);
      const guildId = interaction.guildId;

      let q = musicQueues.get(guildId);
      if (!q) {
        q = createGuildQueue(guildId, interaction.channel);
        const connection = joinVoiceChannel({
          channelId:         vc.id,
          guildId,
          adapterCreator:    interaction.guild.voiceAdapterCreator,
          selfDeaf:          true,
        });
        connection.subscribe(q.player);
      }
      q.textChannel = interaction.channel;

      if (q.current) {
        q.queue.push(track);
        const embed = new EmbedBuilder()
          .setTitle('➕ Added to Queue')
          .setDescription(`**[${track.title}](${track.jamendoUrl})**\nby ${track.artist}`)
          .setColor(0x7c3aed)
          .addFields({ name: 'Position', value: String(q.queue.length), inline: true })
          .setFooter({ text: '✅ Royalty-free via Jamendo' });
        if (track.image) embed.setThumbnail(track.image);
        return interaction.editReply({ embeds: [embed] });
      } else {
        q.queue.push(track);
        await playNext(guildId);
        return interaction.editReply({
          embeds: [new EmbedBuilder().setColor(0x57f287).setDescription(`▶️ Starting **${track.title}** by ${track.artist}`)]
        });
      }
    } catch (e) {
      logger.error('[Music] Play error:', e.message);
      return interaction.editReply({ embeds: [err(`Something went wrong: ${e.message}`)] });
    }
  },
};
