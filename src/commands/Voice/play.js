// src/commands/Voice/play.js
import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { useMainPlayer } from 'discord-player';

export default {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a song or playlist in your voice channel')
    .addStringOption(opt =>
      opt.setName('query')
        .setDescription('Song name, artist, or URL')
        .setRequired(true)
    ),

  async execute(interaction, client) {
    await interaction.deferReply();

    const voiceChannel = interaction.member.voice.channel;
    if (!voiceChannel) {
      return interaction.editReply({ embeds: [errEmbed('Join a voice channel first.')] });
    }

    const query = interaction.options.getString('query');
    const player = useMainPlayer();

    try {
      const { track } = await player.play(voiceChannel, query, {
        requestedBy: interaction.user,
        nodeOptions: {
          metadata: { channel: interaction.channel },
          selfDeaf: true,
          volume: 80,
          leaveOnEmpty: true,
          leaveOnEmptyCooldown: 300000, // 5 minutes when VC is empty
          leaveOnEnd: false,            // stay in VC after queue ends
        },
      });

      return interaction.editReply({
        embeds: [new EmbedBuilder()
          .setColor(0x7c3aed)
          .setDescription(`✅ **[${track.title}](${track.url})** added to queue`)
          .setThumbnail(track.thumbnail)
        ],
      });
    } catch (err) {
      return interaction.editReply({ embeds: [errEmbed(`Could not play that track: ${err.message}`)] });
    }
  },
};

function errEmbed(msg) {
  return new EmbedBuilder().setColor(0xed4245).setDescription(`❌ ${msg}`);
}
