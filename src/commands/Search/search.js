// src/commands/Search/search.js
// Replaces: define.js, google.js, movie.js, urban.js
import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import axios from 'axios';
import { createEmbed, errorEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { handleInteractionError } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { getGuildConfig } from '../../services/guildConfig.js';

const TMDB_API_KEY   = process.env.TMDB_API_KEY || '4e44d9029b1270a757cddc766a1bcb63';
const IMAGE_BASE_URL = 'https://image.tmdb.org/t/p/w500';

export default {
  data: new SlashCommandBuilder()
    .setName('search')
    .setDescription('Search the web for information')
    // define
    .addSubcommand(sub => sub
      .setName('define')
      .setDescription('Look up a word definition')
      .addStringOption(opt => opt.setName('word').setDescription('The word to look up').setRequired(true)))
    // google
    .addSubcommand(sub => sub
      .setName('google')
      .setDescription('Get a Google search link')
      .addStringOption(opt => opt.setName('query').setDescription('What to search for').setRequired(true)))
    // movie
    .addSubcommand(sub => sub
      .setName('movie')
      .setDescription('Search for a movie or TV show')
      .addStringOption(opt => opt.setName('title').setDescription('Title of the movie or TV show').setRequired(true).setMaxLength(100))
      .addStringOption(opt => opt.setName('type').setDescription('Type of content').addChoices({ name: 'Movie', value: 'movie' }, { name: 'TV Show', value: 'tv' })))
    // urban
    .addSubcommand(sub => sub
      .setName('urban')
      .setDescription('Look up a term on Urban Dictionary')
      .addStringOption(opt => opt.setName('term').setDescription('Term to look up').setRequired(true))),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    try {

      // ── DEFINE ──────────────────────────────────────────────────────────
      if (sub === 'define') {
        await InteractionHelper.safeDefer(interaction);
        const word = interaction.options.getString('word');
        if (word.length < 2)
          return InteractionHelper.safeEditReply(interaction, { embeds: [errorEmbed('Error', 'Please enter a word with at least 2 characters.')], flags: MessageFlags.Ephemeral });

        const res = await axios.get(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`, { timeout: 5000 });
        if (!res.data?.length)
          return InteractionHelper.safeEditReply(interaction, { embeds: [errorEmbed('Not Found', `No definitions found for "${word}".`)] });

        const data  = res.data[0];
        const embed = createEmbed({ title: data.word, description: data.phonetic ? `*${data.phonetic}*` : '', color: 'success' });
        data.meanings.slice(0, 5).forEach(m => {
          const defs = m.definitions.slice(0, 3).map((d, i) => `${i + 1}. ${d.definition}${d.example ? `\n   *Example: ${d.example}*` : ''}`).join('\n\n');
          if (defs) embed.addFields({ name: `**${m.partOfSpeech || 'Definition'}**`, value: defs, inline: false });
        });
        embed.setFooter({ text: 'Powered by Free Dictionary API' });
        await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
      }

      // ── GOOGLE ──────────────────────────────────────────────────────────
      else if (sub === 'google') {
        const query = interaction.options.getString('query');
        const url   = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
        const embed = createEmbed({ title: 'Google Search', description: `[Search for "${query}"](${url})`, color: 'info' })
          .setFooter({ text: 'Google Search Results' });
        await InteractionHelper.safeReply(interaction, { embeds: [embed] });
      }

      // ── MOVIE ───────────────────────────────────────────────────────────
      else if (sub === 'movie') {
        await InteractionHelper.safeDefer(interaction);
        const title       = interaction.options.getString('title');
        const type        = interaction.options.getString('type') || 'movie';
        const guildConfig = await getGuildConfig(interaction.client, interaction.guild?.id);

        if (guildConfig?.disabledCommands?.includes('movie'))
          return InteractionHelper.safeEditReply(interaction, { embeds: [errorEmbed('Command Disabled', 'Movie search is disabled in this server.')], flags: MessageFlags.Ephemeral });

        const searchRes = await axios.get(`https://api.themoviedb.org/3/search/${type}`, {
          params: { api_key: TMDB_API_KEY, query: title, include_adult: guildConfig?.allowNsfwContent ? undefined : false, language: 'en-US', page: 1 },
          timeout: 8000,
        });

        if (!searchRes.data?.results?.length)
          return InteractionHelper.safeEditReply(interaction, { embeds: [errorEmbed('Not Found', `No ${type === 'movie' ? 'movies' : 'TV shows'} found for "${title}".`)] });

        const result      = searchRes.data.results[0];
        const mediaTitle  = result.title || result.name || 'Unknown Title';
        const releaseDate = result.release_date || result.first_air_date;
        const year        = releaseDate ? new Date(releaseDate).getFullYear() : 'N/A';

        const detailRes = await axios.get(`https://api.themoviedb.org/3/${type}/${result.id}`, {
          params: { api_key: TMDB_API_KEY, language: 'en-US', append_to_response: 'credits,release_dates,content_ratings' },
          timeout: 8000,
        });
        const details = detailRes.data;
        const runtime = details.runtime
          ? `${Math.floor(details.runtime / 60)}h ${details.runtime % 60}m`
          : details.episode_run_time?.[0] ? `${details.episode_run_time[0]}m per episode` : 'N/A';

        let rating = 'N/A';
        if (type === 'movie') {
          const us = details.release_dates?.results?.find(r => r.iso_3166_1 === 'US');
          if (us?.release_dates?.[0]?.certification) rating = us.release_dates[0].certification;
        } else {
          const us = details.content_ratings?.results?.find(r => r.iso_3166_1 === 'US');
          if (us?.rating) rating = us.rating;
        }

        const embed = createEmbed({ title: `${mediaTitle} (${year})`, description: details.overview || 'No overview available.', color: 'info' })
          .setURL(`https://www.themoviedb.org/${type}/${result.id}`)
          .setThumbnail(result.poster_path ? `${IMAGE_BASE_URL}${result.poster_path}` : null)
          .addFields(
            { name: 'Type', value: type === 'movie' ? 'Movie' : 'TV Show', inline: true },
            { name: 'Rating', value: result.vote_average ? `⭐ ${result.vote_average.toFixed(1)}/10 (${result.vote_count.toLocaleString()} votes)` : 'N/A', inline: true },
            { name: 'Content Rating', value: rating, inline: true },
            { name: 'Runtime', value: runtime, inline: true },
            { name: 'Release Date', value: releaseDate ? new Date(releaseDate).toLocaleDateString() : 'N/A', inline: true },
            { name: 'Genres', value: details.genres?.map(g => g.name).join(', ') || 'N/A', inline: true },
            { name: 'Cast', value: details.credits?.cast?.slice(0, 3).map(p => p.name).join(', ') || 'N/A', inline: false },
          )
          .setFooter({ text: 'Powered by The Movie Database' });
        if (result.backdrop_path) embed.setImage(`https://image.tmdb.org/t/p/w1280${result.backdrop_path}`);
        await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
      }

      // ── URBAN ───────────────────────────────────────────────────────────
      else if (sub === 'urban') {
        const term = interaction.options.getString('term');
        if (term.length < 2)
          return InteractionHelper.safeReply(interaction, { embeds: [errorEmbed('Error', 'Please enter a term with at least 2 characters.')], flags: MessageFlags.Ephemeral });

        const guildConfig = await getGuildConfig(interaction.client, interaction.guild?.id);
        if (guildConfig?.disabledCommands?.includes('urban'))
          return InteractionHelper.safeReply(interaction, { embeds: [errorEmbed('Command Disabled', 'Urban Dictionary is disabled in this server.')], flags: MessageFlags.Ephemeral });

        await InteractionHelper.safeDefer(interaction);
        const res = await axios.get(`https://api.urbandictionary.com/v0/define?term=${encodeURIComponent(term)}`, { timeout: 5000 });
        if (!res.data?.list?.length)
          return InteractionHelper.safeEditReply(interaction, { embeds: [errorEmbed('Not Found', `No definitions found for "${term}" on Urban Dictionary.`)] });

        const def = res.data.list[0];
        const cleanDef     = def.definition.replace(/\[|\]/g, '').replace(/\n\s*\n/g, '\n\n').slice(0, 2000);
        const cleanExample = def.example ? `*"${def.example.replace(/\[|\]/g, '').replace(/\n/g, ' ').slice(0, 500)}..."*` : '*No example provided*';
        const embed = createEmbed({ title: def.word, description: cleanDef, color: 'info' })
          .setURL(def.permalink)
          .addFields(
            { name: 'Example', value: cleanExample, inline: false },
            { name: 'Stats', value: `👍 ${def.thumbs_up.toLocaleString()} • 👎 ${def.thumbs_down.toLocaleString()}`, inline: true },
            { name: 'Author', value: def.author || 'Anonymous', inline: true },
          )
          .setFooter({ text: 'Urban Dictionary' });
        await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
      }

    } catch (error) {
      logger.error(`Search/${sub} error:`, error);
      if (error.response?.status === 404) {
        const msg = sub === 'define' ? `No definitions found for "${interaction.options.getString('word')}".`
          : sub === 'movie' ? 'The requested movie/TV show could not be found.'
          : `No definitions found for "${interaction.options.getString('term')}" on Urban Dictionary.`;
        await InteractionHelper.safeEditReply(interaction, { embeds: [errorEmbed('Not Found', msg)] });
      } else {
        await handleInteractionError(interaction, error, { commandName: `search ${sub}`, source: 'search_command' });
      }
    }
  },
};
