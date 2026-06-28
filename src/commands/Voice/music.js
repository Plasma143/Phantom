// src/commands/Voice/music.js
// Music controls: skip, stop, pause, resume, queue, nowplaying, volume, shuffle, loop.
import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { musicQueues, destroyGuildQueue, formatDuration } from '../../services/musicQueue.js';

function err(msg)  { return new EmbedBuilder().setColor(0xed4245).setDescription(`❌ ${msg}`); }
function ok(msg)   { return new EmbedBuilder().setColor(0x57f287).setDescription(msg); }

export default {
  data: new SlashCommandBuilder()
    .setName('music')
    .setDescription('Music controls')
    .setDMPermission(false)
    .addSubcommand(s => s.setName('skip').setDescription('Skip the current track'))
    .addSubcommand(s => s.setName('stop').setDescription('Stop music and leave the voice channel'))
    .addSubcommand(s => s.setName('pause').setDescription('Pause the current track'))
    .addSubcommand(s => s.setName('resume').setDescription('Resume the paused track'))
    .addSubcommand(s => s.setName('queue').setDescription('Show the current queue'))
    .addSubcommand(s => s.setName('nowplaying').setDescription("Show what's currently playing"))
    .addSubcommand(s => s.setName('shuffle').setDescription('Toggle shuffle mode'))
    .addSubcommand(s => s.setName('loop').setDescription('Toggle loop mode for the current track'))
    .addSubcommand(s => s
      .setName('volume')
      .setDescription('Set the playback volume (takes effect on next track)')
      .addIntegerOption(o =>
        o.setName('level').setDescription('Volume 1-100').setMinValue(1).setMaxValue(100).setRequired(true)
      )
    ),
  category: 'voice',

  async execute(interaction) {
    const sub     = interaction.options.getSubcommand();
    const guildId = interaction.guildId;
    const q       = musicQueues.get(guildId);

    if (!q) {
      return interaction.reply({ embeds: [err('No music is playing. Use `/play` to start.')], flags: MessageFlags.Ephemeral });
    }

    switch (sub) {
      case 'skip': {
        if (!q.queue.length && !q.loop) {
          destroyGuildQueue(guildId);
          return interaction.reply({ embeds: [ok('⏭️ Skipped — queue is now empty.')] });
        }
        q.player.stop();
        return interaction.reply({ embeds: [ok('⏭️ Skipped!')] });
      }

      case 'stop': {
        destroyGuildQueue(guildId);
        return interaction.reply({ embeds: [ok('⏹️ Stopped and left the voice channel.')] });
      }

      case 'pause': {
        q.player.pause();
        return interaction.reply({ embeds: [ok('⏸️ Paused.')] });
      }

      case 'resume': {
        q.player.unpause();
        return interaction.reply({ embeds: [ok('▶️ Resumed.')] });
      }

      case 'queue': {
        if (!q.current && !q.queue.length) {
          return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x7c3aed).setDescription('Queue is empty. Use `/play` to add tracks!')] });
        }
        const lines = [];
        if (q.current) lines.push(`**▶ Now:** [${q.current.title}](${q.current.jamendoUrl}) — ${q.current.artist}`);
        q.queue.slice(0, 10).forEach((t, i) =>
          lines.push(`**${i + 1}.** ${t.title} — ${t.artist}`)
        );
        if (q.queue.length > 10) lines.push(`*...and ${q.queue.length - 10} more*`);
        return interaction.reply({
          embeds: [new EmbedBuilder()
            .setTitle('🎵 Queue')
            .setColor(0x7c3aed)
            .setDescription(lines.join('\n'))
            .setFooter({ text: `${q.queue.length} track(s) remaining | Loop: ${q.loop ? 'ON' : 'OFF'} | Shuffle: ${q.shuffle ? 'ON' : 'OFF'}` })
          ]
        });
      }

      case 'nowplaying': {
        if (!q.current) return interaction.reply({ embeds: [err('Nothing is playing.')], flags: MessageFlags.Ephemeral });
        const t = q.current;
        const embed = new EmbedBuilder()
          .setTitle('🎵 Now Playing')
          .setDescription(`**[${t.title}](${t.jamendoUrl})**\nby ${t.artist}`)
          .setColor(0x7c3aed)
          .addFields(
            { name: 'Duration', value: formatDuration(t.duration), inline: true },
            { name: 'Album',    value: t.album,                    inline: true },
            { name: 'License',  value: '✅ Royalty-free (CC)',     inline: true },
          );
        if (t.image) embed.setThumbnail(t.image);
        return interaction.reply({ embeds: [embed] });
      }

      case 'volume': {
        const level = interaction.options.getInteger('level');
        q.volume = level / 100;
        return interaction.reply({ embeds: [ok(`🔊 Volume set to **${level}%** — takes effect on the next track.`)] });
      }

      case 'shuffle': {
        q.shuffle = !q.shuffle;
        return interaction.reply({ embeds: [ok(`🔀 Shuffle ${q.shuffle ? '**enabled**' : '**disabled**'}.`)] });
      }

      case 'loop': {
        q.loop = !q.loop;
        return interaction.reply({ embeds: [ok(`🔁 Loop ${q.loop ? '**enabled**' : '**disabled**'}.`)] });
      }
    }
  },
};
