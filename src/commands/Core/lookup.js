// src/commands/Core/lookup.js
// Look up any Roblox user by username — shows profile, stats, badges, and group rank.
import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { logger } from '../../utils/logger.js';

const USERS_API    = 'https://users.roblox.com/v1';
const GROUPS_API   = 'https://groups.roblox.com/v2';
const BADGES_API   = 'https://badges.roblox.com/v1';
const THUMBS_API   = 'https://thumbnails.roblox.com/v1';
const PRESENCE_API = 'https://presence.roblox.com/v1';

async function robloxFetch(url) {
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) return null;
  return res.json();
}

async function getUserByUsername(username) {
  const data = await robloxFetch(`${USERS_API}/usernames/users`, {});
  // Use POST
  const res = await fetch(`${USERS_API}/usernames/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }),
  });
  if (!res.ok) return null;
  const json = await res.json();
  return json.data?.[0] || null;
}

async function getUserById(userId) {
  return robloxFetch(`${USERS_API}/users/${userId}`);
}

async function getUserGroups(userId) {
  const data = await robloxFetch(`${GROUPS_API}/users/${userId}/groups/roles?limit=10`);
  return data?.data || [];
}

async function getBadgeCount(userId) {
  const data = await robloxFetch(`${BADGES_API}/users/${userId}/badges?limit=1`);
  return data?.totalCount ?? null;
}

async function getAvatar(userId) {
  const data = await robloxFetch(
    `${THUMBS_API}/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png&isCircular=false`
  );
  return data?.data?.[0]?.imageUrl || null;
}

async function getPresence(userId) {
  const res = await fetch(`${PRESENCE_API}/presence/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ userIds: [userId] }),
  });
  if (!res.ok) return null;
  const json = await res.json();
  return json.userPresences?.[0] || null;
}

function presenceText(p) {
  if (!p) return '❓ Unknown';
  switch (p.userPresenceType) {
    case 0: return '⚫ Offline';
    case 1: return '🟢 Online (Website)';
    case 2: return `🎮 In Game: ${p.lastLocation || 'Unknown'}`;
    case 3: return '🔧 In Studio';
    default: return '❓ Unknown';
  }
}

export default {
  data: new SlashCommandBuilder()
    .setName('roblox')
    .setDescription('Roblox user and group tools')
    .setDMPermission(false)
    .addSubcommand(s => s
      .setName('lookup')
      .setDescription('Look up a Roblox user profile')
      .addStringOption(o =>
        o.setName('username').setDescription('Roblox username to look up').setRequired(true)
      )
    ),
  category: 'roblox',

  async execute(interaction) {
    const sub      = interaction.options.getSubcommand();
    const username = interaction.options.getString('username').trim();

    await interaction.deferReply();

    try {
      // 1. Resolve username → ID
      const basic = await getUserByUsername(username);
      if (!basic) {
        return interaction.editReply({
          embeds: [new EmbedBuilder().setColor(0xed4245).setDescription(`❌ Roblox user **${username}** not found.`)]
        });
      }

      const userId = basic.id;

      // 2. Fetch all data in parallel
      const [user, groups, badgeCount, avatar, presence] = await Promise.all([
        getUserById(userId),
        getUserGroups(userId),
        getBadgeCount(userId),
        getAvatar(userId),
        getPresence(userId),
      ]);

      if (!user) {
        return interaction.editReply({
          embeds: [new EmbedBuilder().setColor(0xed4245).setDescription('❌ Could not fetch user data.')]
        });
      }

      // 3. Build embed
      const created    = new Date(user.created);
      const accountAge = Math.floor((Date.now() - created.getTime()) / 86400000);

      const embed = new EmbedBuilder()
        .setTitle(`🎮 ${user.name}${user.displayName !== user.name ? ` (${user.displayName})` : ''}`)
        .setURL(`https://www.roblox.com/users/${userId}/profile`)
        .setColor(0x7c3aed)
        .setDescription(user.description?.slice(0, 300) || '*No description*')
        .addFields(
          { name: '🆔 User ID',      value: String(userId),                            inline: true },
          { name: '📅 Joined',       value: `<t:${Math.floor(created.getTime()/1000)}:D>`, inline: true },
          { name: '🗓️ Account Age',  value: `${accountAge} days`,                      inline: true },
          { name: '🌐 Status',       value: presenceText(presence),                    inline: true },
          { name: '🏅 Badges',       value: badgeCount !== null ? String(badgeCount) : 'N/A', inline: true },
          { name: '✅ Verified',     value: user.hasVerifiedBadge ? 'Yes' : 'No',      inline: true },
        )
        .setFooter({ text: 'Phantom • Roblox Lookup', iconURL: 'https://phantombot.org/phantom-icon-192.png' })
        .setTimestamp();

      if (avatar) embed.setThumbnail(avatar);

      // 4. Add top groups
      if (groups.length) {
        const topGroups = groups.slice(0, 5).map(g =>
          `**[${g.group.name}](https://www.roblox.com/groups/${g.group.id})** — ${g.role.name}`
        ).join('\n');
        embed.addFields({ name: `👥 Groups (${groups.length})`, value: topGroups });
      } else {
        embed.addFields({ name: '👥 Groups', value: 'Not in any groups' });
      }

      return interaction.editReply({ embeds: [embed] });
    } catch (err) {
      logger.error('[Roblox Lookup] Error:', err.message);
      return interaction.editReply({
        embeds: [new EmbedBuilder().setColor(0xed4245).setDescription(`❌ Something went wrong: ${err.message}`)]
      });
    }
  },
};
