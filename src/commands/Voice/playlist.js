// src/commands/Voice/playlist.js
// Premium feature: save and play named music playlists per user.
// Free users see a lock message with an upgrade prompt.

import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { useMainPlayer } from 'discord-player';
import { getFromDb, setInDb, deleteFromDb } from '../../utils/database.js';
import { getSubscription, getTier, isOwner } from '../../web/stripePayments.js';

const MAX_PLAYLISTS_PREMIUM    = 5;
const MAX_PLAYLISTS_ENTERPRISE = 10;
const MAX_SONGS_PER_PLAYLIST   = 50;

// DB key per user
function playlistKey(userId) {
  return `playlists:${userId}`;
}

async function getUserPlaylists(userId) {
  return (await getFromDb(playlistKey(userId), {}));
}

async function saveUserPlaylists(userId, playlists) {
  return setInDb(playlistKey(userId), playlists);
}

function lockEmbed() {
  return new EmbedBuilder()
    .setColor(0x7c3aed)
    .setTitle('🔒 Premium Feature')
    .setDescription(
      'Custom playlists are a **Premium** feature.\n\n' +
      'Upgrade to save up to 5 playlists with 50 songs each, and play them instantly with `/playlist play`.\n\n' +
      '**Premium — A$7/mo** · **Enterprise — A$15/mo**\n' +
      'Upgrade at: https://phantom1.up.railway.app/dashboard'
    );
}

function errEmbed(msg) {
  return new EmbedBuilder().setColor(0xed4245).setDescription(`❌ ${msg}`);
}

function successEmbed(msg) {
  return new EmbedBuilder().setColor(0x7c3aed).setDescription(`✅ ${msg}`);
}

export default {
  data: new SlashCommandBuilder()
    .setName('playlist')
    .setDescription('Save and play your own music playlists (Premium)')
    .addSubcommand(sub => sub
      .setName('create')
      .setDescription('Create a new playlist')
      .addStringOption(opt =>
        opt.setName('name').setDescription('Playlist name').setRequired(true).setMaxLength(32)
      ))
    .addSubcommand(sub => sub
      .setName('add')
      .setDescription('Add a song to a playlist')
      .addStringOption(opt =>
        opt.setName('name').setDescription('Playlist name').setRequired(true)
      )
      .addStringOption(opt =>
        opt.setName('song').setDescription('Song name or URL').setRequired(true)
      ))
    .addSubcommand(sub => sub
      .setName('remove')
      .setDescription('Remove a song from a playlist by number')
      .addStringOption(opt =>
        opt.setName('name').setDescription('Playlist name').setRequired(true)
      )
      .addIntegerOption(opt =>
        opt.setName('number').setDescription('Song number from /playlist view').setRequired(true).setMinValue(1)
      ))
    .addSubcommand(sub => sub
      .setName('list')
      .setDescription('Show all your playlists'))
    .addSubcommand(sub => sub
      .setName('view')
      .setDescription('Show all songs in a playlist')
      .addStringOption(opt =>
        opt.setName('name').setDescription('Playlist name').setRequired(true)
      ))
    .addSubcommand(sub => sub
      .setName('play')
      .setDescription('Queue an entire playlist in your voice channel')
      .addStringOption(opt =>
        opt.setName('name').setDescription('Playlist name').setRequired(true)
      ))
    .addSubcommand(sub => sub
      .setName('delete')
      .setDescription('Delete a playlist')
      .addStringOption(opt =>
        opt.setName('name').setDescription('Playlist name').setRequired(true)
      )),

  async execute(interaction, client) {
    await interaction.deferReply({ ephemeral: false });

    const sub = interaction.options.getSubcommand();
    const userId = interaction.user.id;

    // Premium check
    const sub_ = await getSubscription(interaction.guildId);
    const tier = isOwner(interaction.user.id) ? 'enterprise' : getTier(sub_);
    const isPremium = tier === 'premium' || tier === 'enterprise';

    if (!isPremium) {
      return interaction.editReply({ embeds: [lockEmbed()] });
    }

    const maxPlaylists = tier === 'enterprise' ? MAX_PLAYLISTS_ENTERPRISE : MAX_PLAYLISTS_PREMIUM;
    const playlists = await getUserPlaylists(userId);

    // CREATE
    if (sub === 'create') {
      const name = interaction.options.getString('name').toLowerCase();
      if (playlists[name]) {
        return interaction.editReply({ embeds: [errEmbed(`Playlist **${name}** already exists.`)] });
      }
      if (Object.keys(playlists).length >= maxPlaylists) {
        return interaction.editReply({ embeds: [errEmbed(`You've reached the maximum of ${maxPlaylists} playlists.`)] });
      }
      playlists[name] = [];
      await saveUserPlaylists(userId, playlists);
      return interaction.editReply({ embeds: [successEmbed(`Playlist **${name}** created. Use \`/playlist add ${name}\` to add songs.`)] });
    }

    // ADD
    if (sub === 'add') {
      const name = interaction.options.getString('name').toLowerCase();
      const song = interaction.options.getString('song');
      if (!playlists[name]) {
        return interaction.editReply({ embeds: [errEmbed(`Playlist **${name}** doesn't exist. Create it first with \`/playlist create ${name}\`.`)] });
      }
      if (playlists[name].length >= MAX_SONGS_PER_PLAYLIST) {
        return interaction.editReply({ embeds: [errEmbed(`Playlist **${name}** is full (${MAX_SONGS_PER_PLAYLIST} songs max).`)] });
      }
      playlists[name].push(song);
      await saveUserPlaylists(userId, playlists);
      return interaction.editReply({ embeds: [successEmbed(`Added **${song}** to **${name}**. (${playlists[name].length}/${MAX_SONGS_PER_PLAYLIST} songs)`)] });
    }

    // REMOVE
    if (sub === 'remove') {
      const name = interaction.options.getString('name').toLowerCase();
      const num = interaction.options.getInteger('number');
      if (!playlists[name]) {
        return interaction.editReply({ embeds: [errEmbed(`Playlist **${name}** doesn't exist.`)] });
      }
      if (num > playlists[name].length) {
        return interaction.editReply({ embeds: [errEmbed(`Song number ${num} doesn't exist in **${name}**.`)] });
      }
      const removed = playlists[name].splice(num - 1, 1)[0];
      await saveUserPlaylists(userId, playlists);
      return interaction.editReply({ embeds: [successEmbed(`Removed **${removed}** from **${name}**.`)] });
    }

    // LIST
    if (sub === 'list') {
      const names = Object.keys(playlists);
      if (!names.length) {
        return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x7c3aed).setDescription('You have no playlists yet. Create one with `/playlist create`.') ]});
      }
      const embed = new EmbedBuilder()
        .setColor(0x7c3aed)
        .setTitle(`🎵 ${interaction.user.username}'s Playlists`)
        .setDescription(names.map((n, i) => `**${i + 1}.** ${n} — ${playlists[n].length} song(s)`).join('\n'))
        .setFooter({ text: `${names.length}/${maxPlaylists} playlists used` });
      return interaction.editReply({ embeds: [embed] });
    }

    // VIEW
    if (sub === 'view') {
      const name = interaction.options.getString('name').toLowerCase();
      if (!playlists[name]) {
        return interaction.editReply({ embeds: [errEmbed(`Playlist **${name}** doesn't exist.`)] });
      }
      const songs = playlists[name];
      if (!songs.length) {
        return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x7c3aed).setDescription(`**${name}** is empty. Add songs with \`/playlist add ${name}\`.`)] });
      }
      const embed = new EmbedBuilder()
        .setColor(0x7c3aed)
        .setTitle(`🎵 ${name}`)
        .setDescription(songs.map((s, i) => `**${i + 1}.** ${s}`).join('\n'))
        .setFooter({ text: `${songs.length}/${MAX_SONGS_PER_PLAYLIST} songs` });
      return interaction.editReply({ embeds: [embed] });
    }

    // PLAY
    if (sub === 'play') {
      const name = interaction.options.getString('name').toLowerCase();
      if (!playlists[name]) {
        return interaction.editReply({ embeds: [errEmbed(`Playlist **${name}** doesn't exist.`)] });
      }
      const songs = playlists[name];
      if (!songs.length) {
        return interaction.editReply({ embeds: [errEmbed(`Playlist **${name}** is empty.`)] });
      }
      const voiceChannel = interaction.member.voice.channel;
      if (!voiceChannel) {
        return interaction.editReply({ embeds: [errEmbed('Join a voice channel first.')] });
      }
      const player = useMainPlayer();
      let queued = 0;
      for (const song of songs) {
        try {
          await player.play(voiceChannel, song, {
            nodeOptions: {
              metadata: { channel: interaction.channel },
              selfDeaf: true,
              volume: 80,
              leaveOnEmpty: true,
              leaveOnEmptyCooldown: 30000,
              leaveOnEnd: true,
              leaveOnEndCooldown: 30000,
            },
          });
          queued++;
        } catch {
          // Skip songs that can't be found
        }
      }
      return interaction.editReply({
        embeds: [new EmbedBuilder()
          .setColor(0x7c3aed)
          .setTitle('🎵 Playlist Queued')
          .setDescription(`Queued **${queued}** songs from **${name}**`)
          .setFooter({ text: `${songs.length - queued} songs skipped (not found)` })
        ]
      });
    }

    // DELETE
    if (sub === 'delete') {
      const name = interaction.options.getString('name').toLowerCase();
      if (!playlists[name]) {
        return interaction.editReply({ embeds: [errEmbed(`Playlist **${name}** doesn't exist.`)] });
      }
      delete playlists[name];
      await saveUserPlaylists(userId, playlists);
      return interaction.editReply({ embeds: [successEmbed(`Playlist **${name}** deleted.`)] });
    }
  },
};
