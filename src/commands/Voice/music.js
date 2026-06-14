// src/commands/Voice/music.js
// Houses all music control commands as subcommands of /music
import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { useQueue } from 'discord-player';

function errEmbed(msg) {
  return new EmbedBuilder().setColor(0xed4245).setDescription(`❌ ${msg}`);
}

function infoEmbed(msg) {
  return new EmbedBuilder().setColor(0x7c3aed).setDescription(msg);
}

function getQueue(interaction) {
  return useQueue(interaction.guild.id);
}

export default {
  data: new SlashCommandBuilder()
    .setName('music')
    .setDescription('Music controls')
    .addSubcommand(sub => sub
      .setName('skip')
      .setDescription('Skip the current song'))
    .addSubcommand(sub => sub
      .setName('stop')
      .setDescription('Stop music and leave the voice channel'))
    .addSubcommand(sub => sub
      .setName('pause')
      .setDescription('Pause the current song'))
    .addSubcommand(sub => sub
      .setName('resume')
      .setDescription('Resume the paused song'))
    .addSubcommand(sub => sub
      .setName('queue')
      .setDescription('Show the current queue'))
    .addSubcommand(sub => sub
      .setName('nowplaying')
      .setDescription('Show what\'s currently playing'))
    .addSubcommand(sub => sub
      .setName('volume')
      .setDescription('Set the playback volume')
      .addIntegerOption(opt =>
        opt.setName('level')
          .setDescription('Volume level (1-100)')
          .setMinValue(1)
          .setMaxValue(100)
          .setRequired(true)
      ))
    .addSubcommand(sub => sub
      .setName('shuffle')
      .setDescription('Shuffle the queue'))
    .addSubcommand(sub => sub
      .setName('loop')
      .setDescription('Toggle loop mode')
      .addStringOption(opt =>
        opt.setName('mode')
          .setDescription('Loop mode')
          .setRequired(true)
          .addChoices(
            { name: 'Off', value: 'off' },
            { name: 'Track', value: 'track' },
            { name: 'Queue', value: 'queue' },
          )
      )),

  async execute(interaction, client) {
    await interaction.deferReply();
    const sub = interaction.options.getSubcommand();

    // Skip
    if (sub === 'skip') {
      const queue = getQueue(interaction);
      if (!queue?.isPlaying()) return interaction.editReply({ embeds: [errEmbed('Nothing is playing.')] });
      const track = queue.currentTrack;
      queue.node.skip();
      return interaction.editReply({ embeds: [infoEmbed(`⏭️ Skipped **${track.title}**`)] });
    }

    // Stop
    if (sub === 'stop') {
      const queue = getQueue(interaction);
      if (!queue) return interaction.editReply({ embeds: [errEmbed('Nothing is playing.')] });
      queue.delete();
      return interaction.editReply({ embeds: [infoEmbed('⏹️ Stopped and left the voice channel.')] });
    }

    // Pause
    if (sub === 'pause') {
      const queue = getQueue(interaction);
      if (!queue?.isPlaying()) return interaction.editReply({ embeds: [errEmbed('Nothing is playing.')] });
      if (queue.node.isPaused()) return interaction.editReply({ embeds: [errEmbed('Already paused. Use `/music resume`.')] });
      queue.node.pause();
      return interaction.editReply({ embeds: [infoEmbed('⏸️ Paused.')] });
    }

    // Resume
    if (sub === 'resume') {
      const queue = getQueue(interaction);
      if (!queue) return interaction.editReply({ embeds: [errEmbed('Nothing is paused.')] });
      if (!queue.node.isPaused()) return interaction.editReply({ embeds: [errEmbed('Not paused.')] });
      queue.node.resume();
      return interaction.editReply({ embeds: [infoEmbed('▶️ Resumed.')] });
    }

    // Queue
    if (sub === 'queue') {
      const queue = getQueue(interaction);
      if (!queue?.tracks.size && !queue?.currentTrack) {
        return interaction.editReply({ embeds: [errEmbed('The queue is empty.')] });
      }
      const current = queue.currentTrack;
      const tracks = queue.tracks.toArray().slice(0, 10);
      const embed = new EmbedBuilder()
        .setColor(0x7c3aed)
        .setTitle('🎵 Queue')
        .setDescription(
          `**Now Playing:** [${current?.title}](${current?.url}) (${current?.duration})\n\n` +
          (tracks.length
            ? tracks.map((t, i) => `**${i + 1}.** [${t.title}](${t.url}) (${t.duration})`).join('\n')
            : '*No more tracks in queue*')
        )
        .setFooter({ text: `${queue.tracks.size} track(s) in queue` });
      return interaction.editReply({ embeds: [embed] });
    }

    // Now Playing
    if (sub === 'nowplaying') {
      const queue = getQueue(interaction);
      const track = queue?.currentTrack;
      if (!track) return interaction.editReply({ embeds: [errEmbed('Nothing is playing.')] });
      const progress = queue.node.createProgressBar();
      const embed = new EmbedBuilder()
        .setColor(0x7c3aed)
        .setTitle('🎵 Now Playing')
        .setDescription(`**[${track.title}](${track.url})**\n\n${progress}`)
        .addFields(
          { name: 'Duration', value: track.duration, inline: true },
          { name: 'Author', value: track.author || 'Unknown', inline: true },
        )
        .setThumbnail(track.thumbnail);
      return interaction.editReply({ embeds: [embed] });
    }

    // Volume
    if (sub === 'volume') {
      const queue = getQueue(interaction);
      if (!queue?.isPlaying()) return interaction.editReply({ embeds: [errEmbed('Nothing is playing.')] });
      const level = interaction.options.getInteger('level');
      queue.node.setVolume(level);
      return interaction.editReply({ embeds: [infoEmbed(`🔊 Volume set to **${level}%**`)] });
    }

    // Shuffle
    if (sub === 'shuffle') {
      const queue = getQueue(interaction);
      if (!queue?.tracks.size) return interaction.editReply({ embeds: [errEmbed('Not enough tracks to shuffle.')] });
      queue.tracks.shuffle();
      return interaction.editReply({ embeds: [infoEmbed('🔀 Queue shuffled!')] });
    }

    // Loop
    if (sub === 'loop') {
      const queue = getQueue(interaction);
      if (!queue?.isPlaying()) return interaction.editReply({ embeds: [errEmbed('Nothing is playing.')] });
      const { QueueRepeatMode } = await import('discord-player');
      const mode = interaction.options.getString('mode');
      const modeMap = {
        off: QueueRepeatMode.OFF,
        track: QueueRepeatMode.TRACK,
        queue: QueueRepeatMode.QUEUE,
      };
      queue.setRepeatMode(modeMap[mode]);
      return interaction.editReply({ embeds: [infoEmbed(`🔁 Loop mode set to **${mode}**`)] });
    }
  },
};
