import 'dotenv/config';
import { Client, Collection, GatewayIntentBits, EmbedBuilder } from 'discord.js';
import { REST } from '@discordjs/rest';
import express from 'express';
import cron from 'node-cron';
import { Player } from 'discord-player';
import { DefaultExtractors } from '@discord-player/extractor';

import config from './config/application.js';
import { initializeDatabase } from './utils/database.js';
import { getGuildConfig } from './services/guildConfig.js';
import { getServerCounters, saveServerCounters, updateCounter } from './services/serverstatsService.js';
import { logger, startupLog, shutdownLog } from './utils/logger.js';
import { checkBirthdays } from './services/birthdayService.js';
import { checkGiveaways } from './services/giveawayService.js';
import { checkReminders } from './commands/Tools/remind.js';
import { loadCommands, registerCommands as registerSlashCommands } from './handlers/commandLoader.js';
import { robloxOAuthRouter } from './web/robloxOAuth.js';
import { dashboardAuthRouter } from './web/dashboardAuth.js';
import { stripeRouter } from './web/stripePayments.js';
import { topggRouter } from './web/topggWebhook.js';
import { setClient } from './utils/clientRef.js';
import { restoreTTSSessions } from './commands/Voice/tts.js';

const ADMIN_DISCORD_ID = '773816670841471006';

class PhantomBot extends Client {
  constructor() {
    super({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildBans,
      ],
    });

    this.config = config;
    this.commands = new Collection();
    this.events = new Collection();
    this.buttons = new Collection();
    this.selectMenus = new Collection();
    this.modals = new Collection();
    this.cooldowns = new Collection();
    this.db = null;
    this.rest = new REST({ version: '10' }).setToken(config.bot.token);
  }

  async start() {
    try {
      startupLog('Starting PhantomBot...');
      await new Promise(resolve => setTimeout(resolve, 1000));

      startupLog('Initializing database...');
      const dbInstance = await initializeDatabase();
      this.db = dbInstance.db;

      const dbStatus = this.db.getStatus();
      if (dbStatus.isDegraded) {
        logger.warn('');
        logger.warn('╔══════════════════════════════════════════════════════╗');
        logger.warn('║ ⚠️  DATABASE RUNNING IN DEGRADED MODE                 ║');
        logger.warn('║                                                       ║');
        logger.warn('║ Connection: In-Memory Storage (PostgreSQL unavailable)║');
        logger.warn('║ Data Persistence: DISABLED - data lost on restart    ║');
        logger.warn('║ Action Required: Fix PostgreSQL and restart bot      ║');
        logger.warn('╚══════════════════════════════════════════════════════╝');
        logger.warn('');
      } else {
        startupLog(`✅ Database Status: ${dbStatus.connectionType} (fully operational)`);
      }

      startupLog('Starting web server...');
      this.startWebServer();

      startupLog('Loading commands...');
      await loadCommands(this);
      startupLog(`Commands loaded: ${this.commands.size}`);

      startupLog('Loading handlers...');
      await this.loadHandlers();
      startupLog('Handlers loaded');

      startupLog('Logging into Discord...');
      await this.login(this.config.bot.token);
      setClient(this);
      startupLog('Discord login successful');

      startupLog('Restoring TTS sessions...');
      await restoreTTSSessions(this);
      startupLog('TTS sessions restored');

      startupLog('Initialising music player...');
      const player = new Player(this);
      await player.extractors.loadMulti(DefaultExtractors, {
        SpotifyExtractor: {
          clientId:     process.env.SPOTIFY_CLIENT_ID     || '',
          clientSecret: process.env.SPOTIFY_CLIENT_SECRET || '',
        },
        AppleMusicExtractor: { countryCode: 'AU' },
        SoundCloudExtractor: {},
      });
      this.player = player;

      player.events.on('playerStart', (queue, track) => {
        const channel = queue.metadata?.channel;
        if (!channel?.send) return;
        const timestamp = queue.node.getTimestamp();
        const total = timestamp?.total?.label ?? track.duration;
        const embed = new EmbedBuilder()
          .setColor(0x7c3aed)
          .setAuthor({ name: '🎵 Now Playing' })
          .setTitle(track.title)
          .setURL(track.url)
          .addFields(
            { name: 'Duration',     value: total,                                                              inline: true },
            { name: 'Author',       value: track.author || 'Unknown',                                         inline: true },
            { name: 'Requested by', value: track.requestedBy ? `<@${track.requestedBy.id}>` : 'Unknown',     inline: true },
          )
          .setThumbnail(track.thumbnail ?? null);
        channel.send({ embeds: [embed] }).catch(() => {});
      });

      player.events.on('emptyQueue', (queue) => {
        const channel = queue.metadata?.channel;
        if (channel?.send) {
          channel.send({ embeds: [new EmbedBuilder().setColor(0x7c3aed).setDescription('✅ Queue finished — use `/play` to add more songs!')] }).catch(() => {});
        }
      });

      startupLog('Music player ready');

      startupLog('Registering slash commands...');
      await this.registerCommands();
      startupLog('Slash commands registration complete');

      const databaseMode = dbStatus.isDegraded
        ? 'Optional in-memory mode (data resets after restart)'
        : 'Connected (persistent data enabled)';
      const handlerSummary = `${this.buttons.size} buttons, ${this.selectMenus.size} menus, ${this.modals.size} modals`;
      startupLog(`ONLINE ✅ | ${this.commands.size} commands loaded | ${handlerSummary} | Database: ${databaseMode}`);

      this.setupCronJobs();
    } catch (error) {
      logger.error(`Failed to start bot: ${error.message || error}`);
      process.exit(1);
    }
  }

  startWebServer() {
    const app = express();
    app.use('/stripe/webhook', express.raw({ type: 'application/json' }));
    app.use(express.urlencoded({ extended: false }));
    app.use(robloxOAuthRouter);
    app.use(dashboardAuthRouter);
    app.use(stripeRouter);
    app.use(topggRouter);
    app.set('discordClient', this);

    const configuredPort = Number(this.config.api?.port || process.env.PORT || 3000);
    const maxPortRetryAttempts = Number(process.env.PORT_RETRY_ATTEMPTS || 5);
    const host = process.env.WEB_HOST || '0.0.0.0';
    const corsOrigin = this.config.api?.cors?.origin || '*';

    app.use((req, res, next) => {
      const allowedOrigins = Array.isArray(corsOrigin) ? corsOrigin : [corsOrigin];
      const origin = req.headers.origin;
      if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
        res.header('Access-Control-Allow-Origin', origin || '*');
      }
      res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      if (req.method === 'OPTIONS') return res.sendStatus(200);
      next();
    });

    const requestCounts = new Map();
    const windowMs = 60000;
    const maxRequests = this.config.api?.rateLimit?.max || 100;

    app.use((req, res, next) => {
      const ip = req.ip;
      const now = Date.now();
      const windowStart = now - windowMs;
      if (!requestCounts.has(ip)) requestCounts.set(ip, []);
      const times = requestCounts.get(ip).filter(t => t > windowStart);
      if (times.length >= maxRequests) return res.status(429).json({ error: 'Too many requests' });
      times.push(now);
      requestCounts.set(ip, times);
      next();
    });

    app.get('/health', (req, res) => {
      const dbStatus = this.db?.getStatus?.() || { isDegraded: 'unknown' };
      res.status(200).json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        database: {
          connected: dbStatus.connectionType !== 'none',
          degraded: dbStatus.isDegraded,
          type: dbStatus.connectionType,
        },
      });
    });

    app.get('/ready', (req, res) => {
      const dbStatus = this.db?.getStatus?.() || { isDegraded: true };
      const isReady = this.isReady() && !dbStatus.isDegraded;
      if (isReady) return res.status(200).json({ ready: true, message: 'Bot is ready' });
      res.status(503).json({ ready: false, reason: !this.isReady() ? 'Bot not Ready' : 'Database degraded' });
    });

    app.get('/', (req, res) => {
      const INVITE_URL = `https://discord.com/oauth2/authorize?client_id=${process.env.CLIENT_ID || '1515029322061054063'}&permissions=8&scope=bot+applications.commands`;
      res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Phantom — Roblox Group Management for Discord</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0a0b0f; color: #e0e5ff; line-height: 1.6; }
    a { color: inherit; text-decoration: none; }
    .nav { display: flex; align-items: center; justify-content: space-between; padding: 8px 48px; background: rgba(10,10,15,0.95); border-bottom: 1px solid #101640; position: sticky; top: 0; z-index: 100; backdrop-filter: blur(10px); }
    .nav-logo { display: flex; align-items: center; }
    .nav-logo img { height: 100px; width: auto; display: block; border-radius: 8px; }
    .nav-links { display: flex; align-items: center; gap: 24px; }
    .nav-links a { color: #8b9cfa; font-size: 14px; font-weight: 500; transition: color 0.15s; }
    .nav-links a:hover { color: #fff; }
    .btn { display: inline-block; padding: 12px 28px; border-radius: 10px; font-weight: 700; font-size: 15px; transition: opacity 0.15s, transform 0.1s; cursor: pointer; border: none; }
    .btn:hover { opacity: 0.88; transform: translateY(-1px); }
    .btn-primary { background: #3a46ed; color: #fff; }
    .btn-secondary { background: transparent; color: #8784fc; border: 1px solid #2129b6; }
    .hero { text-align: center; padding: 100px 24px 80px; max-width: 800px; margin: 0 auto; }
    .hero-badge { display: inline-block; background: #080e40; color: #8b9cfa; border: 1px solid #1f38a8; border-radius: 99px; padding: 6px 16px; font-size: 13px; font-weight: 600; margin-bottom: 28px; }
    .hero h1 { font-size: clamp(40px, 7vw, 72px); font-weight: 900; line-height: 1.05; letter-spacing: -2px; margin-bottom: 24px; background: linear-gradient(135deg, #e0e5ff 0%, #8784fc 50%, #3a46ed 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .hero p { font-size: 20px; color: #8b9cfa; margin-bottom: 40px; max-width: 560px; margin-left: auto; margin-right: auto; }
    .hero-buttons { display: flex; gap: 16px; justify-content: center; flex-wrap: wrap; }
    .features { padding: 80px 24px; max-width: 1100px; margin: 0 auto; }
    .features h2 { text-align: center; font-size: 36px; font-weight: 800; margin-bottom: 16px; color: #fff; }
    .features-sub { text-align: center; color: #8b9cfa; margin-bottom: 56px; font-size: 17px; }
    .features-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 20px; }
    .feature-card { background: #080c20; border: 1px solid #1b2869; border-radius: 16px; padding: 28px; transition: border-color 0.2s, transform 0.2s; }
    .feature-card:hover { border-color: #3a46ed; transform: translateY(-3px); }
    .feature-icon { font-size: 32px; margin-bottom: 16px; }
    .feature-card h3 { font-size: 18px; font-weight: 700; color: #fff; margin-bottom: 10px; }
    .feature-card p { color: #7d86b5; font-size: 14px; line-height: 1.7; }
    .pricing { padding: 80px 24px; background: #03060f; }
    .pricing h2 { text-align: center; font-size: 36px; font-weight: 800; margin-bottom: 16px; color: #fff; }
    .pricing-sub { text-align: center; color: #8b9cfa; margin-bottom: 56px; font-size: 17px; }
    .pricing-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 24px; max-width: 900px; margin: 0 auto; }
    .pricing-card { background: #080c20; border: 1px solid #1b2869; border-radius: 16px; padding: 36px 32px; text-align: center; position: relative; }
    .pricing-card.featured { border-color: #3a46ed; background: #080e40; }
    .pricing-badge { position: absolute; top: -12px; left: 50%; transform: translateX(-50%); background: #3a46ed; color: #fff; font-size: 12px; font-weight: 700; padding: 4px 16px; border-radius: 99px; white-space: nowrap; }
    .pricing-card h3 { font-size: 20px; font-weight: 800; color: #fff; margin-bottom: 8px; }
    .pricing-price { font-size: 42px; font-weight: 900; color: #8784fc; margin: 16px 0 4px; }
    .pricing-price span { font-size: 16px; color: #7d86b5; font-weight: 400; }
    .pricing-features { list-style: none; margin: 24px 0 32px; text-align: left; }
    .pricing-features li { color: #8b9cfa; font-size: 14px; padding: 6px 0; border-bottom: 1px solid #101640; display: flex; align-items: center; gap: 10px; }
    .pricing-features li::before { content: "✓"; color: #3a46ed; font-weight: 800; flex-shrink: 0; }
    .cta { text-align: center; padding: 80px 24px; }
    .cta h2 { font-size: 36px; font-weight: 800; color: #fff; margin-bottom: 16px; }
    .cta p { color: #8b9cfa; font-size: 17px; margin-bottom: 36px; }
    .footer { text-align: center; padding: 32px 24px; border-top: 1px solid #101640; color: #4f61a0; font-size: 13px; }
    .footer a { color: #3a46ed; margin: 0 12px; }
    .stat-strip { display: flex; justify-content: center; gap: 48px; flex-wrap: wrap; padding: 48px 24px; border-top: 1px solid #101640; border-bottom: 1px solid #101640; }
    .stat { text-align: center; }
    .stat-number { font-size: 36px; font-weight: 900; color: #8784fc; }
    .stat-label { font-size: 13px; color: #7d86b5; margin-top: 4px; }
    @media (max-width: 600px) { .nav { padding: 14px 20px; } .nav-links { gap: 14px; } }
  </style>
</head>
<body>
<nav class="nav">
  <div class="nav-logo"><img src="/logo.png" alt="Phantom" onerror="this.style.display='none'"></div>
  <div class="nav-links">
    <a href="#features">Features</a>
    <a href="/dashboard">App</a>
    <a href="#pricing">Pricing</a>
    <a href="/dashboard/commands">Commands</a>
    <a href="https://discord.gg/fYtxnNqGNn" target="_blank">Support</a>
    <a href="/dashboard" class="btn btn-primary" style="padding:8px 18px;font-size:13px;">Dashboard</a>
  </div>
</nav>

<section class="hero">
  <div class="hero-badge">⚡ Built for Roblox communities</div>
  <h1>The smarter way to manage your Roblox group</h1>
  <p>Phantom connects your Discord server to your Roblox group — verification, role sync, rank management, and more, all from one dashboard.</p>
  <div class="hero-buttons">
    <a href="${INVITE_URL}" class="btn btn-primary">➕ Add to Server — Free</a>
    <a href="/dashboard" class="btn btn-secondary">View Dashboard</a>
  </div>
</section>

<div class="stat-strip">
  <div class="stat"><div class="stat-number">80+</div><div class="stat-label">Commands</div></div>
  <div class="stat"><div class="stat-number">3</div><div class="stat-label">Seconds to link</div></div>
  <div class="stat"><div class="stat-number">0</div><div class="stat-label">Extra apps needed</div></div>
  <div class="stat"><div class="stat-number">24/7</div><div class="stat-label">Uptime</div></div>
</div>

<section class="features" id="features">
  <h2>Everything your group needs</h2>
  <p class="features-sub">Phantom replaces the clutter of multiple bots with one powerful system.</p>
  <div class="features-grid">
    <div class="feature-card"><div class="feature-icon">🔗</div><h3>Roblox Account Linking</h3><p>Members link via bio-code or OAuth. Fast, secure, no third-party apps.</p></div>
    <div class="feature-card"><div class="feature-icon">🏅</div><h3>Automatic Role Sync</h3><p>Discord roles update automatically based on Roblox group rank.</p></div>
    <div class="feature-card"><div class="feature-icon">👑</div><h3>Dashboard Rank Management</h3><p>Promote or demote members directly from the web dashboard.</p></div>
    <div class="feature-card"><div class="feature-icon">⚡</div><h3>AI Auto-Ranking</h3><p>Phantom reads your promotion log channel and applies ranks automatically.</p></div>
    <div class="feature-card"><div class="feature-icon">📋</div><h3>Audit Logs</h3><p>Every join, leave, ban, and rank change logged automatically.</p></div>
    <div class="feature-card"><div class="feature-icon">🌐</div><h3>Web Dashboard</h3><p>7-tab admin dashboard — overview, group setup, ranks, logs, members, documents, verification.</p></div>
  </div>
</section>

<section class="pricing" id="pricing">
  <h2>Simple, honest pricing</h2>
  <p class="pricing-sub">Start free. Upgrade when you need more.</p>
  <div class="pricing-grid">
    <div class="pricing-card">
      <h3>Free</h3>
      <div class="pricing-price">A$0<span>/mo</span></div>
      <ul class="pricing-features">
        <li>Roblox account linking</li>
        <li>Automatic role sync</li>
        <li>Group Setup dashboard</li>
        <li>80+ bot commands</li>
      </ul>
      <a href="${INVITE_URL}" class="btn btn-secondary" style="width:100%;display:block;">Add to Server</a>
    </div>
    <div class="pricing-card featured">
      <div class="pricing-badge">Most Popular</div>
      <h3>Premium</h3>
      <div class="pricing-price">A$7<span>/mo</span></div>
      <ul class="pricing-features">
        <li>Everything in Free</li>
        <li>Rank Management dashboard</li>
        <li>Auto-rank from promotion logs</li>
        <li>Audit log posting</li>
        <li>Priority support</li>
      </ul>
      <a href="/dashboard" class="btn btn-primary" style="width:100%;display:block;">Get Started</a>
    </div>
    <div class="pricing-card">
      <h3>Enterprise</h3>
      <div class="pricing-price">A$15<span>/mo</span></div>
      <ul class="pricing-features">
        <li>Everything in Premium</li>
        <li>Scheduled rank sync</li>
        <li>Custom bot branding</li>
        <li>Dedicated support</li>
      </ul>
      <a href="/dashboard" class="btn btn-secondary" style="width:100%;display:block;">Get Started</a>
    </div>
  </div>
</section>

<section class="cta">
  <h2>Ready to upgrade your Roblox community?</h2>
  <p>Join for free — no credit card required.</p>
  <a href="${INVITE_URL}" class="btn btn-primary" style="font-size:17px;padding:16px 40px;">➕ Add Phantom to Discord</a>
</section>

<footer class="footer">
  <p>© 2026 Phantom Studios &nbsp;·&nbsp;
    <a href="/dashboard">Dashboard</a>
    <a href="/dashboard/commands">Commands</a>
    <a href="https://discord.gg/fYtxnNqGNn" target="_blank">Support</a>
    <a href="/tos">Terms of Service</a>
    <a href="/privacy">Privacy Policy</a>
  </p>
</footer>
</body>
</html>`);
    });

    app.get('/tos', (req, res) => {
      res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Terms of Service — Phantom</title><style>*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0a0b0f;color:#e0e5ff;line-height:1.8}.nav{display:flex;align-items:center;justify-content:space-between;padding:8px 48px;background:rgba(10,10,15,.95);border-bottom:1px solid #101640}.nav a{color:#8b9cfa;text-decoration:none;font-size:14px}.container{max-width:780px;margin:60px auto;padding:0 24px 80px}h1{font-size:36px;font-weight:900;color:#fff;margin-bottom:8px}.updated{color:#4f61a0;font-size:13px;margin-bottom:48px}h2{font-size:20px;font-weight:700;color:#8784fc;margin:40px 0 12px}p{color:#8b9cfa;margin-bottom:16px;font-size:15px}ul{color:#8b9cfa;padding-left:24px;margin-bottom:16px;font-size:15px}ul li{margin-bottom:8px}a{color:#3a46ed}.footer{text-align:center;padding:32px 24px;border-top:1px solid #101640;color:#4f61a0;font-size:13px}.footer a{color:#3a46ed;margin:0 10px}</style></head><body><nav class="nav"><a href="/">← Back to home</a></nav><div class="container"><h1>Terms of Service</h1><p class="updated">Last updated: 14 June 2026</p><h2>1. Acceptance of Terms</h2><p>By adding Phantom to your Discord server or using the Phantom Dashboard, you agree to be bound by these Terms of Service.</p><h2>2. Description of Service</h2><p>Phantom is a Discord bot and web dashboard that connects Discord servers to Roblox groups, providing role sync, rank management, audit logging, and more.</p><h2>3. Eligibility</h2><p>You must be at least 13 years of age to use the Service, in compliance with Discord's Terms of Service.</p><h2>4. User Responsibilities</h2><ul><li>Do not use the Service for any unlawful purpose</li><li>Do not attempt to exploit or disrupt the Service</li><li>Take responsibility for all actions taken through your server's Phantom configuration</li></ul><h2>5. Roblox Integration</h2><p>By enabling rank management features, you confirm you have authority to make changes within your Roblox group. Phantom Studios takes no responsibility for unintended rank changes from misconfiguration.</p><h2>6. Subscriptions and Billing</h2><p>Premium and Enterprise tiers are billed monthly through Stripe. Subscriptions renew automatically unless cancelled. Refunds are not provided for partial billing periods unless required by Australian Consumer Law.</p><h2>7. Data and Privacy</h2><p>We store Discord user IDs, Roblox usernames, and server configuration data. We do not sell your data. See our <a href="/privacy">Privacy Policy</a> for details.</p><h2>8. Termination</h2><p>We reserve the right to suspend or terminate access for violations of these Terms, Discord's Terms, or Roblox's Terms, without prior notice.</p><h2>9. Contact</h2><p>Questions? Join our <a href="https://discord.gg/fYtxnNqGNn" target="_blank">support server</a>.</p></div><footer class="footer">© 2026 Phantom Studios &nbsp;·&nbsp;<a href="/">Home</a><a href="/privacy">Privacy Policy</a></footer></body></html>`);
    });

    app.get('/privacy', (req, res) => {
      res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Privacy Policy — Phantom</title><style>*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0a0b0f;color:#e0e5ff;line-height:1.8}.nav{display:flex;align-items:center;justify-content:space-between;padding:8px 48px;background:rgba(10,10,15,.95);border-bottom:1px solid #101640}.nav a{color:#8b9cfa;text-decoration:none;font-size:14px}.container{max-width:780px;margin:60px auto;padding:0 24px 80px}h1{font-size:36px;font-weight:900;color:#fff;margin-bottom:8px}.updated{color:#4f61a0;font-size:13px;margin-bottom:48px}h2{font-size:20px;font-weight:700;color:#8784fc;margin:40px 0 12px}p{color:#8b9cfa;margin-bottom:16px;font-size:15px}ul{color:#8b9cfa;padding-left:24px;margin-bottom:16px;font-size:15px}ul li{margin-bottom:8px}a{color:#3a46ed}.footer{text-align:center;padding:32px 24px;border-top:1px solid #101640;color:#4f61a0;font-size:13px}.footer a{color:#3a46ed;margin:0 10px}</style></head><body><nav class="nav"><a href="/">← Back to home</a></nav><div class="container"><h1>Privacy Policy</h1><p class="updated">Last updated: 14 June 2026</p><h2>1. Introduction</h2><p>Phantom Studios operates the Phantom Discord bot and web dashboard. This Privacy Policy explains what data we collect and how we use it.</p><h2>2. Data We Collect</h2><ul><li>Discord User ID</li><li>Roblox Username and User ID (when you link your account)</li><li>Discord Server ID and configuration settings</li><li>Roblox Open Cloud API Key (stored encrypted)</li><li>Subscription status</li></ul><h2>3. Data We Do Not Collect</h2><ul><li>We do not read or store message content</li><li>We do not collect passwords or payment card details</li><li>We do not use advertising trackers</li></ul><h2>4. How We Use Your Data</h2><p>Data is used solely to provide the Service: linking accounts, syncing roles, applying ranks, and managing subscriptions.</p><h2>5. Data Sharing</h2><p>We do not sell your data. We share with Stripe (payments), Discord (OAuth login), and Roblox (Open Cloud API) only as needed to provide the Service.</p><h2>6. Your Rights</h2><p>You may request access, correction, or deletion of your data by opening a ticket in our <a href="https://discord.gg/fYtxnNqGNn" target="_blank">support server</a>.</p><h2>7. Contact</h2><p>Questions? Join our <a href="https://discord.gg/fYtxnNqGNn" target="_blank">support server</a>.</p></div><footer class="footer">© 2026 Phantom Studios &nbsp;·&nbsp;<a href="/">Home</a><a href="/tos">Terms of Service</a></footer></body></html>`);
    });

    // ============ ADMIN PANEL ============
    app.get('/admin', async (req, res) => {
      if (req.session?.user?.id !== ADMIN_DISCORD_ID) {
        return res.status(403).send('Forbidden');
      }

      let guilds = [];
      try {
        const dbMod = await import('./utils/database.js');
        const pgDb = dbMod.pgDb;
        if (pgDb?.pool) {
          const result = await pgDb.pool.query(
            `SELECT guild_id, COALESCE(data->>'tier', 'free') as tier FROM guild_configs ORDER BY guild_id`
          );
          guilds = result.rows;
        }
      } catch (e) {
        logger.error('Admin panel DB error: ' + (e.message || e));
      }

      const rows = guilds.map(g => `
        <tr>
          <td>${g.guild_id}</td>
          <td><span class="tier tier-${g.tier}">${g.tier}</span></td>
          <td>
            <form method="POST" action="/admin/set-tier" style="display:inline-flex;gap:8px">
              <input type="hidden" name="guild_id" value="${g.guild_id}">
              <select name="tier">
                <option ${g.tier === 'free' ? 'selected' : ''}>free</option>
                <option ${g.tier === 'premium' ? 'selected' : ''}>premium</option>
                <option ${g.tier === 'enterprise' ? 'selected' : ''}>enterprise</option>
              </select>
              <button type="submit">Set</button>
            </form>
          </td>
        </tr>`).join('');

      res.send(`<!DOCTYPE html>
<html>
<head>
<title>Phantom Admin</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0f0f13; color: #e0e0e0; font-family: sans-serif; padding: 40px; }
  h1 { color: #fff; margin-bottom: 8px; }
  p { color: #888; margin-bottom: 32px; }
  .add-form { background: #1a1a24; border: 1px solid #2a2a3a; border-radius: 12px; padding: 24px; margin-bottom: 32px; display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; }
  .add-form label { display: block; color: #aaa; font-size: 12px; margin-bottom: 6px; }
  .add-form input, .add-form select, td select { background: #0f0f13; border: 1px solid #2a2a3a; color: #fff; padding: 8px 12px; border-radius: 8px; font-size: 14px; }
  .add-form input { width: 280px; }
  button { background: #5865f2; color: #fff; border: none; padding: 8px 16px; border-radius: 8px; cursor: pointer; font-size: 14px; }
  button:hover { background: #4752c4; }
  table { width: 100%; border-collapse: collapse; background: #1a1a24; border-radius: 12px; overflow: hidden; }
  th { background: #12121a; color: #888; font-size: 12px; text-transform: uppercase; padding: 12px 16px; text-align: left; }
  td { padding: 12px 16px; border-top: 1px solid #2a2a3a; font-size: 14px; }
  .tier { padding: 3px 10px; border-radius: 20px; font-size: 12px; font-weight: 600; }
  .tier-free { background: #2a2a3a; color: #aaa; }
  .tier-premium { background: #1a2a4a; color: #5b9bd5; }
  .tier-enterprise { background: #2a1a4a; color: #a855f7; }
</style>
</head>
<body>
<h1>🔐 Phantom Admin</h1>
<p>Manage guild tiers. Only visible to you.</p>

<div class="add-form">
  <form method="POST" action="/admin/set-tier" style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap">
    <div>
      <label>Guild ID</label>
      <input type="text" name="guild_id" placeholder="e.g. 333949691962195969" required>
    </div>
    <div>
      <label>Tier</label>
      <select name="tier">
        <option value="free">Free</option>
        <option value="premium">Premium</option>
        <option value="enterprise">Enterprise</option>
      </select>
    </div>
    <button type="submit">Set Tier</button>
  </form>
</div>

<table>
  <thead><tr><th>Guild ID</th><th>Tier</th><th>Action</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="3" style="color:#666;text-align:center;padding:24px">No guilds found</td></tr>'}</tbody>
</table>
</body>
</html>`);
    });

    app.post('/admin/set-tier', async (req, res) => {
      if (req.session?.user?.id !== ADMIN_DISCORD_ID) {
        return res.status(403).send('Forbidden');
      }

      const { guild_id, tier } = req.body;
      if (!guild_id || !tier) return res.redirect('/admin');

      try {
        const dbMod = await import('./utils/database.js');
        const pgDb = dbMod.pgDb;
        if (pgDb?.pool) {
          await pgDb.pool.query(
            `INSERT INTO guild_configs (guild_id, data)
             VALUES ($1, jsonb_build_object('tier', $2::text))
             ON CONFLICT (guild_id) DO UPDATE
               SET data = guild_configs.data || jsonb_build_object('tier', $2::text)`,
            [guild_id, tier]
          );
        }
      } catch (e) {
        logger.error('Admin set-tier error: ' + (e.message || e));
      }

      res.redirect('/admin');
    });
    // ============ END ADMIN PANEL ============

    const startServer = (port, attempt = 0) => {
      let hasStartedListening = false;
      const server = app.listen(port, host, () => {
        hasStartedListening = true;
        this.webServer = server;
        startupLog(`✅ Web Server running on ${host}:${port}`);
        startupLog(`Health endpoint: http://localhost:${port}/health`);
        startupLog(`Ready endpoint: http://localhost:${port}/ready`);
      });

      server.on('error', (error) => {
        const errorCode = error?.code || 'UNKNOWN_ERROR';
        const errorMessage = error?.message || 'Unknown server error';

        if (!hasStartedListening && errorCode === 'EADDRINUSE' && attempt < maxPortRetryAttempts) {
          const nextPort = port + 1;
          startupLog(`Port ${port} is already in use. Trying port ${nextPort}...`);
          setTimeout(() => startServer(nextPort, attempt + 1), 250);
          return;
        }

        if (hasStartedListening && errorCode === 'EADDRINUSE') {
          logger.warn(`Web server reported a duplicate bind warning on ${host}:${port}, but the bot remains online.`);
          return;
        }

        logger.error(`❌ Web server error on port ${port} (${errorCode}): ${errorMessage}`);
        if (!hasStartedListening) process.exit(1);
      });
    };

    startServer(configuredPort, 0);
  }

  setupCronJobs() {
    cron.schedule('0 6 * * *', () => checkBirthdays(this));
    cron.schedule('* * * * *', () => checkGiveaways(this));
    cron.schedule('*/15 * * * *', () => this.updateAllCounters());
    cron.schedule('0 * * * *', () => this.runScheduledRankSync());
    cron.schedule('0 3 * * *', () => this.autoCloseStaleTickets());
    cron.schedule('* * * * *', () => checkReminders(this));
    cron.schedule('0 4 * * *', () => this.expireTrials());
  }

  async expireTrials() {
    try {
      const { db } = await import('./utils/database.js');
      const { EmbedBuilder } = await import('discord.js');
      const now = Date.now();
      const WARNING_MS = 24 * 60 * 60 * 1000;

      const keys = await db.list('subscription:').catch(() => []);
      for (const key of keys) {
        try {
          const sub = await db.get(key);
          if (!sub?.isTrial || sub.status !== 'trialing') continue;

          const guildId = key.replace('subscription:', '');
          const trialEnd = sub.trialEnd || 0;

          if (!sub.warningSent && trialEnd - now <= WARNING_MS && trialEnd > now) {
            sub.warningSent = true;
            await db.set(key, sub);
            try {
              const guild = this.guilds.cache.get(guildId);
              if (guild) {
                const owner = await this.users.fetch(guild.ownerId);
                await owner.send({
                  embeds: [new EmbedBuilder()
                    .setTitle('⚠️ Your Premium Trial Expires Tomorrow')
                    .setDescription(`Your 7-day Premium trial for **${guild.name}** expires <t:${Math.floor(trialEnd / 1000)}:R>.\n\nSubscribe at: https://phantombot.org/dashboard`)
                    .setColor(0xffa500)
                    .setTimestamp()],
                });
              }
            } catch {}
          }

          if (trialEnd <= now) {
            await db.set(key, { tier: 'free', status: 'canceled', wasTrialUser: true });
            logger.info(`[Trial] Expired trial for guild ${guildId}`);
            try {
              const guild = this.guilds.cache.get(guildId);
              if (guild) {
                const owner = await this.users.fetch(guild.ownerId);
                await owner.send({
                  embeds: [new EmbedBuilder()
                    .setTitle('⏰ Your Premium Trial Has Ended')
                    .setDescription(`Your free trial for **${guild.name}** has expired. Subscribe to keep Premium features: https://phantombot.org/dashboard`)
                    .setColor(0xed4245)
                    .setTimestamp()],
                });
              }
            } catch {}
          }
        } catch (err) {
          logger.debug(`[Trial] Error processing key ${key}: ${err.message}`);
        }
      }
    } catch (err) {
      logger.error(`[Trial] expireTrials error: ${err.message || err}`);
    }
  }

  async autoCloseStaleTickets() {
    try {
      const { pgDb } = await import('./utils/database.js');
      const { closeTicket, deleteTicket } = await import('./services/ticket.js');
      const { pgConfig } = await import('./config/postgres.js');

      if (!pgDb?.pool) {
        logger.debug('[AutoClose] No PostgreSQL pool available, skipping');
        return;
      }

      const CLOSE_DAYS = 3;
      const DELETE_DAYS = 7;
      const closeCutoff  = new Date(Date.now() - CLOSE_DAYS  * 24 * 60 * 60 * 1000).toISOString();
      const deleteCutoff = new Date(Date.now() - DELETE_DAYS * 24 * 60 * 60 * 1000).toISOString();

      const openResult = await pgDb.pool.query(
        `SELECT guild_id, channel_id, data FROM ${pgConfig.tables.tickets}
         WHERE data->>'status' = 'open' AND (data->>'createdAt')::text < $1`,
        [closeCutoff]
      );

      if (openResult.rows.length) {
        logger.info(`[AutoClose] Found ${openResult.rows.length} stale open ticket(s) to close`);
        for (const row of openResult.rows) {
          try {
            const channel = await this.channels.fetch(row.channel_id).catch(() => null);
            if (!channel) continue;
            await closeTicket(channel, this.user, `Automatically closed after ${CLOSE_DAYS} days of inactivity.`);
            logger.info(`[AutoClose] Closed ticket ${row.channel_id} in guild ${row.guild_id}`);
          } catch (err) {
            logger.error(`[AutoClose] Failed to close ticket ${row.channel_id}: ${err.message}`);
          }
        }
      }

      const closedResult = await pgDb.pool.query(
        `SELECT guild_id, channel_id, data FROM ${pgConfig.tables.tickets}
         WHERE data->>'status' = 'closed' AND (data->>'createdAt')::text < $1`,
        [deleteCutoff]
      );

      if (closedResult.rows.length) {
        logger.info(`[AutoDelete] Found ${closedResult.rows.length} stale closed ticket(s) to delete`);
        for (const row of closedResult.rows) {
          try {
            const channel = await this.channels.fetch(row.channel_id).catch(() => null);
            if (!channel) continue;
            await deleteTicket(channel, this.user);
            logger.info(`[AutoDelete] Deleted ticket ${row.channel_id} in guild ${row.guild_id}`);
          } catch (err) {
            logger.error(`[AutoDelete] Failed to delete ticket ${row.channel_id}: ${err.message}`);
          }
        }
      }
    } catch (err) {
      logger.error(`[AutoClose] autoCloseStaleTickets error: ${err.message || err}`);
    }
  }

  async runScheduledRankSync() {
    try {
      const { pgDb, getConfigValue, updateGuildConfig } = await import('./utils/database.js');
      const { getGroupRoles, getGroupMembership } = await import('./utils/roblox.js');
      const { getSubscription, getTier } = await import('./web/stripePayments.js');

      for (const [guildId, guild] of this.guilds.cache) {
        try {
          const enterprise = await getConfigValue({ db: this.db }, guildId, 'enterprise', {});
          if (!enterprise.syncEnabled) continue;

          const sub  = await getSubscription(guildId);
          const tier = getTier(sub);
          if (tier !== 'enterprise') continue;

          const intervalMs = (enterprise.syncInterval || 24) * 60 * 60 * 1000;
          if (enterprise.lastSync && Date.now() - enterprise.lastSync < intervalMs) continue;

          const roblox = await getConfigValue({ db: this.db }, guildId, 'roblox', {});
          if (!roblox.groupId || !roblox.openCloudKey) continue;

          const linkedKeys = await pgDb.list('roblox_link:');
          let synced = 0, failed = 0;

          for (const key of linkedKeys) {
            const discordId = key.replace('roblox_link:', '');
            const member = await guild.members.fetch(discordId).catch(() => null);
            if (!member) continue;
            const link = await pgDb.get(key);
            if (!link?.robloxId) continue;

            try {
              const membership = await getGroupMembership(roblox.groupId, link.robloxId, roblox.openCloudKey);
              if (!membership) continue;
              const currentRank = Number(membership.role?.split('/').pop()) || 0;
              const rankRoles = roblox.rankRoles || {};
              const allRankRoleIds = Object.values(rankRoles);
              await member.roles.remove(member.roles.cache.filter(r => allRankRoleIds.includes(r.id)).map(r => r.id)).catch(() => {});
              const roleId = rankRoles[currentRank];
              if (roleId) await member.roles.add(roleId).catch(() => {});
              synced++;
            } catch { failed++; }
          }

          await updateGuildConfig({ db: this.db }, guildId, { enterprise: { ...enterprise, lastSync: Date.now() } });

          if (enterprise.syncLogChannelId) {
            const ch = guild.channels.cache.get(enterprise.syncLogChannelId);
            if (ch) await ch.send(`🔄 **Scheduled rank sync complete** — ${synced} members synced${failed ? `, ${failed} failed` : ''}.`).catch(() => {});
          }
          logger.info(`[rankSync] Guild ${guildId}: ${synced} synced, ${failed} failed`);
        } catch (e) {
          logger.error(`[rankSync] Guild ${guildId} error: ${e.message || e}`);
        }
      }
    } catch (e) {
      logger.error(`[rankSync] Fatal error: ${e.message || e}`);
    }
  }

  async updateAllCounters() {
    if (!this.db) {
      logger.warn('Database not available for counter updates');
      return;
    }

    for (const [guildId, guild] of this.guilds.cache) {
      try {
        const counters = await getServerCounters(this, guildId);
        const validCounters = [];
        const orphanedCounters = [];

        for (const counter of counters) {
          if (counter && counter.type && counter.channelId && counter.enabled !== false) {
            const channel = guild.channels.cache.get(counter.channelId);
            if (channel) {
              validCounters.push(counter);
              await updateCounter(this, guild, counter);
            } else {
              orphanedCounters.push(counter);
              logger.info(`Removing orphaned counter ${counter.id} (type: ${counter.type}, deleted channel: ${counter.channelId}) from guild ${guildId}`);
            }
          }
        }

        if (orphanedCounters.length > 0) {
          await saveServerCounters(this, guildId, validCounters);
          logger.info(`Cleaned up ${orphanedCounters.length} orphaned counter(s) from guild ${guildId}`);
        }
      } catch (error) {
        logger.error(`Error updating counters for guild ${guildId}: ${error.message || error}`);
      }
    }
  }

  async loadHandlers() {
    const handlers = [
      { path: 'events',        type: 'default', required: true },
      { path: 'interactions',  type: 'default', required: true },
    ];

    for (const handler of handlers) {
      try {
        const module = await import(`./handlers/${handler.path}.js`);
        const loaderFn = handler.type.startsWith('named:')
          ? module[handler.type.split(':')[1]]
          : module.default;

        if (typeof loaderFn === 'function') {
          await loaderFn(this);
          logger.info(`✅ Loaded ${handler.path}`);
        } else {
          throw new Error(`Invalid loader export from ${handler.path}`);
        }
      } catch (error) {
        if (handler.required) {
          logger.error(`❌ Failed to load required handler ${handler.path}: ${error.message || error}`);
          throw error;
        } else if (error.code !== 'MODULE_NOT_FOUND') {
          logger.warn(`⚠️  Failed to load optional handler ${handler.path}: ${error.message || error}`);
        }
      }
    }
  }

  async registerCommands() {
    try {
      logger.info('Command registration deferred to ready event (global only).');
    } catch (error) {
      logger.error(`Error in registerCommands: ${error.message || error}`);
    }
  }

  async shutdown(reason = 'UNKNOWN') {
    shutdownLog(`Bot is shutting down (${reason})...`);
    logger.info(`\n${'='.repeat(60)}`);
    logger.info(`🛑 Graceful Shutdown Initiated (${reason})`);
    logger.info(`${'='.repeat(60)}`);

    try {
      logger.info('Stopping cron jobs...');
      cron.getTasks().forEach(task => task.stop());
      logger.info('✅ Cron jobs stopped');

      if (this.db && this.db.db) {
        logger.info('Closing database connection...');
        try {
          if (this.db.db.pool) {
            await this.db.db.pool.end();
            logger.info('✅ Database connection closed');
          }
        } catch (error) {
          logger.warn(`Error closing database pool: ${error.message || error}`);
        }
      }

      logger.info('Destroying Discord client...');
      if (this.isReady()) {
        try {
          this.destroy();
          logger.info('✅ Discord client destroyed');
        } catch (error) {
          logger.warn(`Discord client destroy warning (non-critical): ${error.message || error}`);
        }
      }

      logger.info('✅ Graceful shutdown complete');
      shutdownLog('Bot stopped successfully.');
      process.exit(0);
    } catch (error) {
      logger.error(`Error during graceful shutdown: ${error.message || error}`);
      process.exit(1);
    }
  }
}

try {
  const bot = new PhantomBot();

  const setupShutdown = () => {
    process.on('SIGTERM', () => bot.shutdown('SIGTERM'));
    process.on('SIGINT',  () => bot.shutdown('SIGINT'));
    process.on('uncaughtException', (error) => {
      logger.error(`Uncaught Exception: ${error?.message || error}`);
      bot.shutdown('UNCAUGHT_EXCEPTION');
    });
    process.on('unhandledRejection', (reason) => {
      logger.error(`Unhandled Rejection: ${reason?.message || reason}`);
      bot.shutdown('UNHANDLED_REJECTION');
    });
  };

  setupShutdown();
  bot.start();
} catch (error) {
  logger.error(`Fatal error during bot startup: ${error.message || error}`);
  process.exit(1);
}

export default PhantomBot;
