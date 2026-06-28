// src/commands/Voice/playlist.js
// Save and play personal music playlists — Premium (50 tracks) / Enterprise (200 tracks).
import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { joinVoiceChannel } from '@discordjs/voice';
import { getFromDb, setInDb } from '../../utils/database.js';
import { getSubscription, getTier, isOwner } from '../../web/stripePayments.js';
import { musicQueues, createGuildQueue, searchJamendo, formatTrack, playNext } from '../../services/musicQueue.js';
import { logger } from '../../utils/logger.js';

const LIMITS = { premium: 50, enterprise: 200 };

function pKey(guildId, userId, name) {
  return `playlist:${guildId}:${userId}:${name.toLowerCase().replace(/\s+/g, '_')}`;
}
function err(msg) { return new EmbedBuilder().setColor(0xed4245).setDescription(`❌ ${msg}`); }
function ok(msg)  { return new EmbedBuilder().setColor(0x57f287).setDescription(msg); }

export default {
  data: new SlashCommandBuilder()
    .setName('playlist')
    .setDescription('Save and play personal music playlists (Premium+)')
    .setDMPermission(false)
    .addSubcommand(s => s
      .setName('create').setDescription('Create a new playlist')
      .addStringOption(o => o.setName('name').setDescription('Playlist name').setRequired(true))
    )
    .addSubcommand(s => s
      .setName('add').setDescription('Add a track to a playlist')
      .addStringOption(o => o.setName('playlist').setDescription('Playlist name').setRequired(true))
      .addStringOption(o => o.setName('query').setDescription('Track to search').setRequired(true))
    )
    .addSubcommand(s => s
      .setName('remove').setDescription('Remove a track by position')
      .addStringOption(o => o.setName('playlist').setDescription('Playlist name').setRequired(true))
      .addIntegerOption(o => o.setName('position').setDescription('Track number to remove').setRequired(true))
    )
    .addSubcommand(s => s
      .setName('play').setDescription('Queue a saved playlist')
      .addStringOption(o => o.setName('name').setDescription('Playlist name').setRequired(true))
    )
    .addSubcommand(s => s.setName('list').setDescription('List your playlists'))
    .addSubcommand(s => s
      .setName('view').setDescription('View tracks in a playlist')
      .addStringOption(o => o.setName('name').setDescription('Playlist name').setRequired(true))
    )
    .addSubcommand(s => s
      .setName('delete').setDescription('Delete a playlist')
      .addStringOption(o => o.setName('name').setDescription('Playlist name').setRequired(true))
    ),
  category: 'voice',

  async execute(interaction) {
    const sub     = interaction.options.getSubcommand();
    const guildId = interaction.guildId;
    const userId  = interaction.user.id;

    // Tier check
    const subData = await getSubscription(guildId);
    const tier    = isOwner(userId) ? 'enterprise' : getTier(subData);
    const limit   = LIMITS[tier];

    if (!limit) {
      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(0x7c3aed)
          .setTitle('🔒 Premium Feature')
          .setDescription('Playlists require **Premium** (50 tracks) or **Enterprise** (200 tracks).\nUpgrade at **phantombot.org/dashboard**')
        ],
        flags: MessageFlags.Ephemeral,
      });
    }

    const key = (name) => pKey(guildId, userId, name);

    if (sub === 'create') {
      const name = interaction.options.getString('name').trim();
      if (await getFromDb(key(name))) return interaction.reply({ embeds: [err(`**${name}** already exists.`)], flags: MessageFlags.Ephemeral });
      await setInDb(key(name), { name, tracks: [] });
      return interaction.reply({ embeds: [ok(`✅ Playlist **${name}** created! Use \`/playlist add\` to add tracks.`)] });
    }

    if (sub === 'add') {
      const name  = interaction.options.getString('playlist').trim();
      const query = interaction.options.getString('query');
      const pl    = await getFromDb(key(name));
      if (!pl) return interaction.reply({ embeds: [err(`Playlist **${name}** not found.`)], flags: MessageFlags.Ephemeral });
      if (pl.tracks.length >= limit) return interaction.reply({ embeds: [err(`Playlist is full (${limit} tracks max for ${tier}).`)], flags: MessageFlags.Ephemeral });

      await interaction.deferReply();
      const results = await searchJamendo(query, 1);
      if (!results.length) return interaction.editReply({ embeds: [err('No tracks found.')] });
      const track = formatTrack(results[0]);
      pl.tracks.push(track);
      await setInDb(key(name), pl);
      return interaction.editReply({ embeds: [ok(`➕ Added **${track.title}** by ${track.artist} to **${name}** (${pl.tracks.length}/${limit})`)] });
    }

    if (sub === 'remove') {
      const name = interaction.options.getString('playlist').trim();
      const pos  = interaction.options.getInteger('position') - 1;
      const pl   = await getFromDb(key(name));
      if (!pl) return interaction.reply({ embeds: [err(`Playlist **${name}** not found.`)], flags: MessageFlags.Ephemeral });
      if (pos < 0 || pos >= pl.tracks.length) return interaction.reply({ embeds: [err('Invalid position.')], flags: MessageFlags.Ephemeral });
      const [removed] = pl.tracks.splice(pos, 1);
      await setInDb(key(name), pl);
      return interaction.reply({ embeds: [ok(`🗑️ Removed **${removed.title}** from **${name}**.`)] });
    }

    if (sub === 'play') {
      const name = interaction.options.getString('name').trim();
      const pl   = await getFromDb(key(name));
      if (!pl?.tracks.length) return interaction.reply({ embeds: [err(`Playlist **${name}** is empty or not found.`)], flags: MessageFlags.Ephemeral });
      const vc = interaction.member.voice?.channel;
      if (!vc) return interaction.reply({ embeds: [err('Join a voice channel first.')], flags: MessageFlags.Ephemeral });

      await interaction.deferReply();
      let q = musicQueues.get(guildId);
      if (!q) {
        q = createGuildQueue(guildId, interaction.channel);
        const connection = joinVoiceChannel({ channelId: vc.id, guildId, adapterCreator: interaction.guild.voiceAdapterCreator, selfDeaf: true });
        connection.subscribe(q.player);
      }
      q.textChannel = interaction.channel;
      q.queue.push(...pl.tracks);
      if (!q.current) await playNext(guildId);
      return interaction.editReply({ embeds: [ok(`▶️ Queued **${pl.tracks.length}** tracks from **${name}**!`)] });
    }

    if (sub === 'list') {
      const { pgDb } = await import('../../utils/postgresDatabase.js');
      const prefix   = `playlist:${guildId}:${userId}:`;
      const res      = await pgDb.query('SELECT key FROM keyvalue WHERE key LIKE $1', [prefix + '%']);
      if (!res.rows.length) return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x7c3aed).setDescription('No playlists yet. Use `/playlist create` to make one!')] });
      const names = res.rows.map(r => r.key.replace(prefix, ''));
      return interaction.reply({ embeds: [new EmbedBuilder().setTitle('📋 Your Playlists').setColor(0x7c3aed).setDescription(names.map((n, i) => `**${i+1}.** ${n}`).join('\n'))] });
    }

    if (sub === 'view') {
      const name = interaction.options.getString('name').trim();
      const pl   = await getFromDb(key(name));
      if (!pl) return interaction.reply({ embeds: [err(`Playlist **${name}** not found.`)], flags: MessageFlags.Ephemeral });
      const lines = pl.tracks.map((t, i) => `**${i+1}.** ${t.title} — ${t.artist}`);
      return interaction.reply({ embeds: [new EmbedBuilder().setTitle(`📋 ${name}`).setColor(0x7c3aed).setDescription(lines.length ? lines.slice(0, 20).join('\n') : 'Empty playlist').setFooter({ text: `${pl.tracks.length}/${limit} tracks` })] });
    }

    if (sub === 'delete') {
      const name = interaction.options.getString('name').trim();
      const pl   = await getFromDb(key(name));
      if (!pl) return interaction.reply({ embeds: [err(`Playlist **${name}** not found.`)], flags: MessageFlags.Ephemeral });
      const { deleteFromDb } = await import('../../utils/database.js');
      await deleteFromDb(key(name));
      return interaction.reply({ embeds: [ok(`🗑️ Deleted playlist **${name}**.`)] });
    }
  },
};
