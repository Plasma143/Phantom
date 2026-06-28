import re

# ── 1. app.js: add GuildInvites intent ──────────────────────────────────────
with open('/root/Phantom/src/app.js', 'r') as f:
    c = f.read()

old = 'GatewayIntentBits.GuildBans,'
new = 'GatewayIntentBits.GuildBans,\n        GatewayIntentBits.GuildInvites,'
assert old in c, "app.js intent target not found"
c = c.replace(old, new, 1)

with open('/root/Phantom/src/app.js', 'w') as f:
    f.write(c)
print("✅ app.js — GuildInvites intent added")

# ── 2. ready.js: cache invites on startup ───────────────────────────────────
with open('/root/Phantom/src/events/ready.js', 'r') as f:
    c = f.read()

old_import = "import { startGroupFundsMonitor } from '../services/groupFundsMonitor.js';"
new_import  = old_import + "\nimport { cacheGuildInvites } from '../services/inviteService.js';"
assert old_import in c, "ready.js import anchor not found"
c = c.replace(old_import, new_import, 1)

old_start = "      startGroupFundsMonitor(client);"
new_start = old_start + """

      // Cache guild invites for invite tracking
      for (const [, guild] of client.guilds.cache) {
        await cacheGuildInvites(guild).catch(() => {});
      }
      startupLog('✅ Invite cache populated');"""
assert old_start in c, "ready.js startup anchor not found"
c = c.replace(old_start, new_start, 1)

with open('/root/Phantom/src/events/ready.js', 'w') as f:
    f.write(c)
print("✅ ready.js — invite cache on startup added")

# ── 3. guildCreate.js: cache invites when bot joins ─────────────────────────
with open('/root/Phantom/src/events/guildCreate.js', 'r') as f:
    c = f.read()

old_import = "import { db } from '../utils/database.js';"
new_import  = old_import + "\nimport { cacheGuildInvites } from '../services/inviteService.js';"
assert old_import in c, "guildCreate.js import anchor not found"
c = c.replace(old_import, new_import, 1)

old_log = "      logger.info(`[guildCreate] Joined new guild: ${guild.name} (${guild.id})`);"
new_log  = old_log + "\n      await cacheGuildInvites(guild).catch(() => {});"
assert old_log in c, "guildCreate.js log anchor not found"
c = c.replace(old_log, new_log, 1)

with open('/root/Phantom/src/events/guildCreate.js', 'w') as f:
    f.write(c)
print("✅ guildCreate.js — invite cache on join added")

# ── 4. guildMemberAdd.js: detect invite + award rewards ─────────────────────
with open('/root/Phantom/src/events/guildMemberAdd.js', 'r') as f:
    c = f.read()

# Insert invite tracking block just before the welcome config section
old_anchor = "        const welcomeConfig = await getWelcomeConfig(member.client, guild.id);"
new_block   = """        // ── Invite tracking ─────────────────────────────────────────────────────
        try {
          const { inviteCache, getInviteRewards } = await import('../services/inviteService.js');
          const { getFromDb, setInDb } = await import('../utils/database.js');
          const { getSubscription, getTier } = await import('../web/stripePayments.js');

          const newInvites = await guild.invites.fetch().catch(() => null);
          if (newInvites) {
            const cached = inviteCache.get(guild.id) || new Map();
            let usedInvite = null;
            for (const [, invite] of newInvites) {
              if ((invite.uses || 0) > (cached.get(invite.code) || 0)) {
                usedInvite = invite;
                break;
              }
            }
            // Always re-cache after fetch
            inviteCache.set(guild.id, new Map(newInvites.map(i => [i.code, i.uses])));

            if (usedInvite?.inviter) {
              const inviterId = usedInvite.inviter.id;
              const sub  = await getSubscription(guild.id);
              const tier = getTier(sub);
              const { coins, xp, mult } = getInviteRewards(tier);

              // Update invite stats
              const iKey  = `invites:${guild.id}:${inviterId}`;
              const iData = (await getFromDb(iKey)) || { total: 0, coinsEarned: 0, xpEarned: 0 };
              iData.total       = (iData.total       || 0) + 1;
              iData.coinsEarned = (iData.coinsEarned || 0) + coins;
              iData.xpEarned    = (iData.xpEarned    || 0) + xp;
              await setInDb(iKey, iData);

              // Award coins + XP to economy
              const eKey  = `economy:${guild.id}:${inviterId}`;
              const eData = (await getFromDb(eKey)) || { wallet: 0, bank: 0, xp: 0 };
              eData.wallet = (eData.wallet || 0) + coins;
              eData.xp     = (eData.xp     || 0) + xp;
              await setInDb(eKey, eData);

              // DM the inviter
              try {
                const inviterUser = await member.client.users.fetch(inviterId);
                const multNote = mult > 1 ? ` *(${tier} ${mult}x multiplier)*` : '';
                await inviterUser.send({
                  embeds: [new EmbedBuilder()
                    .setTitle('📨 Someone joined using your invite!')
                    .setDescription(
                      `**${user.tag}** joined **${guild.name}** using your invite!\\n\\n` +
                      `You earned **${coins} coins** and **${xp} XP**!${multNote}\\n` +
                      `Your total: **${iData.total}** invite${iData.total !== 1 ? 's' : ''}`
                    )
                    .setColor(0x57f287)
                    .setThumbnail(user.displayAvatarURL())
                    .setFooter({ text: 'Phantom Invite Tracker' })
                    .setTimestamp()
                  ],
                });
              } catch {} // DMs may be closed

              logger.info(`[Invites] ${inviterId} invited ${user.tag} to ${guild.name} — +${coins} coins, +${xp} XP`);
            }
          }
        } catch (invErr) {
          logger.debug('[Invites] Tracking error:', invErr.message);
        }
        // ────────────────────────────────────────────────────────────────────

        """ + old_anchor

assert old_anchor in c, "guildMemberAdd.js anchor not found"
c = c.replace(old_anchor, new_block, 1)

with open('/root/Phantom/src/events/guildMemberAdd.js', 'w') as f:
    f.write(c)
print("✅ guildMemberAdd.js — invite detection + rewards added")

# ── 5. dashboardAuth.js: add invites leaderboard to server dashboard ─────────
with open('/root/Phantom/src/web/dashboardAuth.js', 'r') as f:
    c = f.read()

old_server_data = "      const [rolesRes, channelsRes, membersRes, roblox, auditLogs, verification, autoRank, enterprise, securityRaw, subscription, boostDiscount, scheduledAnns, inGameMonitor, joinNotify, groupFunds, applications, rolePanels] = await Promise.all(["
new_server_data  = "      const [rolesRes, channelsRes, membersRes, roblox, auditLogs, verification, autoRank, enterprise, securityRaw, subscription, boostDiscount, scheduledAnns, inGameMonitor, joinNotify, groupFunds, applications, rolePanels, inviteRows] = await Promise.all(["

if old_server_data in c:
    c = c.replace(old_server_data, new_server_data, 1)

    # Also add the invites query to the Promise.all array - find its closing
    old_promise_end = "        getConfigValue({ db }, guildId, 'rolePanels', []),"
    new_promise_end  = old_promise_end + """
        (async () => { try { const { pgDb } = await import('./database.js'); const r = await pgDb.query('SELECT key, value FROM keyvalue WHERE key LIKE $1 ORDER BY (value::json->>\'total\')::int DESC LIMIT 5', ['invites:' + guildId + ':%']); return r.rows; } catch { return []; } })(),"""
    if old_promise_end in c:
        c = c.replace(old_promise_end, new_promise_end, 1)

    # Add invites section to the body after the upgradeBanner
    old_body_start = "      <img src=\"${guildIconUrl(guild)}\" width=\"56\" style=\"border-radius:50%; margin-bottom:10px;\" />"
    new_body_start  = old_body_start + """
      ${(() => {
        if (!inviteRows || !inviteRows.length) return '';
        const lines = inviteRows.map((r, i) => {
          const uid = r.key.replace('invites:' + guildId + ':', '');
          const d   = typeof r.value === 'string' ? JSON.parse(r.value) : r.value;
          const medals = ['🥇','🥈','🥉'];
          return '<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #2b2d31;">' +
            '<span style="font-size:18px;">' + (medals[i] || (i+1)+'.') + '</span>' +
            '<span style="flex:1;color:#fff;font-weight:600;"><@' + uid + '></span>' +
            '<span style="color:#a78bfa;">' + (d.total||0) + ' invites</span>' +
            '<span style="color:#f59e0b;margin-left:12px;">🪙 ' + (d.coinsEarned||0) + '</span>' +
          '</div>';
        }).join('');
        return '<div style="background:#1e2124;border-radius:12px;padding:16px 20px;margin-bottom:20px;max-width:700px;margin-left:auto;margin-right:auto;">' +
          '<p style="color:#a78bfa;font-weight:700;font-size:13px;text-transform:uppercase;letter-spacing:.08em;margin:0 0 10px;">📨 Top Inviters</p>' +
          lines +
          '<p style="color:#6b7280;font-size:12px;margin:10px 0 0;">Use <code>/invites top</code> for the full leaderboard</p>' +
        '</div>';
      })()}"""
    if old_body_start in c:
        c = c.replace(old_body_start, new_body_start, 1)
        print("✅ dashboardAuth.js — invite leaderboard section added")
    else:
        print("⚠️ dashboardAuth.js body anchor not found — skipping dashboard section")
else:
    print("⚠️ dashboardAuth.js Promise.all anchor not found — skipping dashboard changes")

with open('/root/Phantom/src/web/dashboardAuth.js', 'w') as f:
    f.write(c)

print("All patches complete!")
