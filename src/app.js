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
import { loadCommands, registerCommands as registerSlashCommands } from './handlers/commandLoader.js';
import { robloxOAuthRouter } from './web/robloxOAuth.js';
import { dashboardAuthRouter } from './web/dashboardAuth.js';
import { stripeRouter } from './web/stripePayments.js';
import { setClient } from './utils/clientRef.js';

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
      
      // Check database status and report
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

      startupLog('Initialising music player...');
      const player = new Player(this);
      await player.extractors.loadMulti(DefaultExtractors, {
        // Spotify — finds full YouTube equivalents using Spotify metadata
        SpotifyExtractor: {
          clientId:     process.env.SPOTIFY_CLIENT_ID     || '',
          clientSecret: process.env.SPOTIFY_CLIENT_SECRET || '',
        },
        // Apple Music — needed for Apple Original/exclusive content
        AppleMusicExtractor: {
          countryCode: 'AU',
        },
        // SoundCloud — extra coverage for tracks not on YouTube
        SoundCloudExtractor: {},
      });
      this.player = player;

      // Auto-post a rich Now Playing card whenever a track starts
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
            { name: 'Duration',     value: total,                                                               inline: true },
            { name: 'Author',       value: track.author || 'Unknown',                                          inline: true },
            { name: 'Requested by', value: track.requestedBy ? `<@${track.requestedBy.id}>` : 'Unknown',      inline: true },
          )
          .setThumbnail(track.thumbnail ?? null);

        channel.send({ embeds: [embed] }).catch(() => {});
      });

      // Notify when the queue ends
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
      startupLog(
        `ONLINE ✅ | ${this.commands.size} commands loaded | ${handlerSummary} | Database: ${databaseMode}`
      );
      
      this.setupCronJobs();
    } catch (error) {
      logger.error('Failed to start bot:', error);
      process.exit(1);
    }
  }

  startWebServer() {
    const app = express();
    // Raw body needed for Stripe webhook signature verification — must come first
    app.use('/stripe/webhook', express.raw({ type: 'application/json' }));
    app.use(robloxOAuthRouter);
    app.use(dashboardAuthRouter);
    app.use(stripeRouter);
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
      
      if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
      }
      next();
    });

    const requestCounts = new Map();
    const windowMs = 60000; 
    const maxRequests = this.config.api?.rateLimit?.max || 100;
    
    app.use((req, res, next) => {
      const ip = req.ip;
      const now = Date.now();
      const windowStart = now - windowMs;
      
      if (!requestCounts.has(ip)) {
        requestCounts.set(ip, []);
      }
      
      const times = requestCounts.get(ip).filter(t => t > windowStart);
      
      if (times.length >= maxRequests) {
        return res.status(429).json({ error: 'Too many requests' });
      }
      
      times.push(now);
      requestCounts.set(ip, times);
      next();
    });

    app.get('/health', (req, res) => {
      const dbStatus = this.db?.getStatus?.() || { isDegraded: 'unknown' };
      const status = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        database: {
          connected: dbStatus.connectionType !== 'none',
          degraded: dbStatus.isDegraded,
          type: dbStatus.connectionType
        }
      };
      res.status(200).json(status);
    });

    app.get('/ready', (req, res) => {
      const dbStatus = this.db?.getStatus?.() || { isDegraded: true };
      const isReady = this.isReady() && !dbStatus.isDegraded;

      if (isReady) {
        return res.status(200).json({
          ready: true,
          message: 'Bot is ready'
        });
      }

      res.status(503).json({
        ready: false,
        reason: !this.isReady() ? 'Bot not Ready' : 'Database degraded'
      });
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
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0a0a0f; color: #e8e0ff; line-height: 1.6; }
    a { color: inherit; text-decoration: none; }
    .nav { display: flex; align-items: center; justify-content: space-between; padding: 18px 48px; background: rgba(10,10,15,0.95); border-bottom: 1px solid #1e1040; position: sticky; top: 0; z-index: 100; backdrop-filter: blur(10px); }
    .nav-logo { font-size: 22px; font-weight: 800; color: #c084fc; letter-spacing: -0.5px; }
    .nav-links { display: flex; align-items: center; gap: 24px; }
    .nav-links a { color: #a78bfa; font-size: 14px; font-weight: 500; transition: color 0.15s; }
    .nav-links a:hover { color: #fff; }
    .btn { display: inline-block; padding: 12px 28px; border-radius: 10px; font-weight: 700; font-size: 15px; transition: opacity 0.15s, transform 0.1s; cursor: pointer; border: none; }
    .btn:hover { opacity: 0.88; transform: translateY(-1px); }
    .btn-primary { background: #7c3aed; color: #fff; }
    .btn-secondary { background: transparent; color: #c084fc; border: 1px solid #5b21b6; }
    .hero { text-align: center; padding: 100px 24px 80px; max-width: 800px; margin: 0 auto; }
    .hero-badge { display: inline-block; background: #1a0840; color: #a78bfa; border: 1px solid #3b1fa8; border-radius: 99px; padding: 6px 16px; font-size: 13px; font-weight: 600; margin-bottom: 28px; }
    .hero h1 { font-size: clamp(40px, 7vw, 72px); font-weight: 900; line-height: 1.05; letter-spacing: -2px; margin-bottom: 24px; background: linear-gradient(135deg, #e8e0ff 0%, #c084fc 50%, #7c3aed 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .hero p { font-size: 20px; color: #a78bfa; margin-bottom: 40px; max-width: 560px; margin-left: auto; margin-right: auto; }
    .hero-buttons { display: flex; gap: 16px; justify-content: center; flex-wrap: wrap; }
    .features { padding: 80px 24px; max-width: 1100px; margin: 0 auto; }
    .features h2 { text-align: center; font-size: 36px; font-weight: 800; margin-bottom: 16px; color: #fff; }
    .features-sub { text-align: center; color: #a78bfa; margin-bottom: 56px; font-size: 17px; }
    .features-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 20px; }
    .feature-card { background: #0d0820; border: 1px solid #2d1b69; border-radius: 16px; padding: 28px; transition: border-color 0.2s, transform 0.2s; }
    .feature-card:hover { border-color: #7c3aed; transform: translateY(-3px); }
    .feature-icon { font-size: 32px; margin-bottom: 16px; }
    .feature-card h3 { font-size: 18px; font-weight: 700; color: #fff; margin-bottom: 10px; }
    .feature-card p { color: #8b7db5; font-size: 14px; line-height: 1.7; }
    .pricing { padding: 80px 24px; background: #05030f; }
    .pricing h2 { text-align: center; font-size: 36px; font-weight: 800; margin-bottom: 16px; color: #fff; }
    .pricing-sub { text-align: center; color: #a78bfa; margin-bottom: 56px; font-size: 17px; }
    .pricing-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 24px; max-width: 900px; margin: 0 auto; }
    .pricing-card { background: #0d0820; border: 1px solid #2d1b69; border-radius: 16px; padding: 36px 32px; text-align: center; position: relative; }
    .pricing-card.featured { border-color: #7c3aed; background: #1a0840; }
    .pricing-badge { position: absolute; top: -12px; left: 50%; transform: translateX(-50%); background: #7c3aed; color: #fff; font-size: 12px; font-weight: 700; padding: 4px 16px; border-radius: 99px; white-space: nowrap; }
    .pricing-card h3 { font-size: 20px; font-weight: 800; color: #fff; margin-bottom: 8px; }
    .pricing-price { font-size: 42px; font-weight: 900; color: #c084fc; margin: 16px 0 4px; }
    .pricing-price span { font-size: 16px; color: #8b7db5; font-weight: 400; }
    .pricing-features { list-style: none; margin: 24px 0 32px; text-align: left; }
    .pricing-features li { color: #a78bfa; font-size: 14px; padding: 6px 0; border-bottom: 1px solid #1e1040; display: flex; align-items: center; gap: 10px; }
    .pricing-features li::before { content: "✓"; color: #7c3aed; font-weight: 800; flex-shrink: 0; }
    .cta { text-align: center; padding: 80px 24px; }
    .cta h2 { font-size: 36px; font-weight: 800; color: #fff; margin-bottom: 16px; }
    .cta p { color: #a78bfa; font-size: 17px; margin-bottom: 36px; }
    .footer { text-align: center; padding: 32px 24px; border-top: 1px solid #1e1040; color: #5b4fa0; font-size: 13px; }
    .footer a { color: #7c3aed; margin: 0 12px; }
    .stat-strip { display: flex; justify-content: center; gap: 48px; flex-wrap: wrap; padding: 48px 24px; border-top: 1px solid #1e1040; border-bottom: 1px solid #1e1040; }
    .stat { text-align: center; }
    .stat-number { font-size: 36px; font-weight: 900; color: #c084fc; }
    .stat-label { font-size: 13px; color: #8b7db5; margin-top: 4px; }
    @media (max-width: 600px) { .nav { padding: 14px 20px; } .nav-links { gap: 14px; } }
  </style>
</head>
<body>

<nav class="nav">
  <div class="nav-logo">👻 Phantom</div>
  <div class="nav-links">
    <a href="#features">Features</a>
    <a href="#pricing">Pricing</a>
    <a href="/dashboard/commands">Commands</a>
    <a href="https://discord.gg/fYtxnNqGNn" target="_blank">Support</a>
    <a href="/dashboard" class="btn btn-primary" style="padding:8px 18px; font-size:13px;">Dashboard</a>
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
  <div class="stat"><div class="stat-number">100+</div><div class="stat-label">Commands</div></div>
  <div class="stat"><div class="stat-number">3</div><div class="stat-label">Seconds to link</div></div>
  <div class="stat"><div class="stat-number">0</div><div class="stat-label">Extra apps needed</div></div>
  <div class="stat"><div class="stat-number">24/7</div><div class="stat-label">Uptime</div></div>
</div>

<section class="features" id="features">
  <h2>Everything your group needs</h2>
  <p class="features-sub">Phantom replaces the clutter of multiple bots with one powerful system.</p>
  <div class="features-grid">
    <div class="feature-card">
      <div class="feature-icon">🔗</div>
      <h3>Roblox Account Linking</h3>
      <p>Members link their Roblox account via bio-code or OAuth "Sign in with Roblox". Fast, secure, no third-party apps.</p>
    </div>
    <div class="feature-card">
      <div class="feature-icon">🏅</div>
      <h3>Automatic Role Sync</h3>
      <p>Discord roles update automatically based on Roblox group rank. One click to auto-bind all your existing roles.</p>
    </div>
    <div class="feature-card">
      <div class="feature-icon">👑</div>
      <h3>Dashboard Rank Management</h3>
      <p>Look up any member and change their Roblox group rank directly from the web dashboard — no more logging into Roblox.</p>
    </div>
    <div class="feature-card">
      <div class="feature-icon">⚡</div>
      <h3>AI-Free Auto-Ranking</h3>
      <p>Phantom watches your promotion log channel and automatically applies ranks — any format, zero API costs.</p>
    </div>
    <div class="feature-card">
      <div class="feature-icon">📋</div>
      <h3>Audit Logs</h3>
      <p>Every join, leave, ban, rank change and dashboard action logged automatically to your chosen channels.</p>
    </div>
    <div class="feature-card">
      <div class="feature-icon">🌐</div>
      <h3>Web Dashboard</h3>
      <p>A full admin dashboard with 7 tabs — overview, group setup, rank management, audit logs, members, documents and verification.</p>
    </div>
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
        <li>Verification panel</li>
        <li>100+ bot commands</li>
      </ul>
      <a href="${INVITE_URL}" class="btn btn-secondary" style="width:100%; display:block;">Add to Server</a>
    </div>
    <div class="pricing-card featured">
      <div class="pricing-badge">Most Popular</div>
      <h3>Premium</h3>
      <div class="pricing-price">A$7<span>/mo</span></div>
      <ul class="pricing-features">
        <li>Everything in Free</li>
        <li>Rank Management dashboard</li>
        <li>Auto-rank from promotion logs</li>
        <li>Live member rank display</li>
        <li>Audit log posting</li>
        <li>Documents tab</li>
        <li>Priority support</li>
      </ul>
      <a href="/dashboard" class="btn btn-primary" style="width:100%; display:block;">Get Started</a>
    </div>
    <div class="pricing-card">
      <h3>Enterprise</h3>
      <div class="pricing-price">A$15<span>/mo</span></div>
      <ul class="pricing-features">
        <li>Everything in Premium</li>
        <li>Multiple group bindings</li>
        <li>Custom bot branding</li>
        <li>Analytics dashboard</li>
        <li>Dedicated support</li>
      </ul>
      <a href="/dashboard" class="btn btn-secondary" style="width:100%; display:block;">Get Started</a>
    </div>
  </div>
</section>

<section class="cta">
  <h2>Ready to upgrade your Roblox community?</h2>
  <p>Join for free — no credit card required.</p>
  <a href="${INVITE_URL}" class="btn btn-primary" style="font-size:17px; padding:16px 40px;">➕ Add Phantom to Discord</a>
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

    // ── Terms of Service ──────────────────────────────────────────────────────
    app.get('/tos', (req, res) => {
      res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Terms of Service — Phantom</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0a0a0f; color: #e8e0ff; line-height: 1.8; }
    .nav { display: flex; align-items: center; justify-content: space-between; padding: 18px 48px; background: rgba(10,10,15,0.95); border-bottom: 1px solid #1e1040; }
    .nav-logo { font-size: 20px; font-weight: 800; color: #c084fc; text-decoration: none; }
    .nav a { color: #a78bfa; text-decoration: none; font-size: 14px; }
    .container { max-width: 780px; margin: 60px auto; padding: 0 24px 80px; }
    h1 { font-size: 36px; font-weight: 900; color: #fff; margin-bottom: 8px; }
    .updated { color: #5b4fa0; font-size: 13px; margin-bottom: 48px; }
    h2 { font-size: 20px; font-weight: 700; color: #c084fc; margin: 40px 0 12px; }
    p { color: #a78bfa; margin-bottom: 16px; font-size: 15px; }
    ul { color: #a78bfa; padding-left: 24px; margin-bottom: 16px; font-size: 15px; }
    ul li { margin-bottom: 8px; }
    a { color: #7c3aed; }
    .footer { text-align: center; padding: 32px 24px; border-top: 1px solid #1e1040; color: #5b4fa0; font-size: 13px; }
    .footer a { color: #7c3aed; margin: 0 10px; }
  </style>
</head>
<body>
<nav class="nav">
  <a href="/" class="nav-logo">👻 Phantom</a>
  <a href="/">← Back to home</a>
</nav>
<div class="container">
  <h1>Terms of Service</h1>
  <p class="updated">Last updated: 14 June 2026</p>

  <h2>1. Acceptance of Terms</h2>
  <p>By adding Phantom ("the Bot") to your Discord server or using the Phantom Dashboard ("the Service"), you agree to be bound by these Terms of Service. If you do not agree, do not use the Service.</p>

  <h2>2. Description of Service</h2>
  <p>Phantom is a Discord bot and web dashboard that connects Discord servers to Roblox groups. Features include Roblox account linking, role synchronisation, rank management, audit logging, and more.</p>

  <h2>3. Eligibility</h2>
  <p>You must be at least 13 years of age to use the Service, in compliance with Discord's Terms of Service. By using Phantom, you confirm that you meet this requirement.</p>

  <h2>4. User Responsibilities</h2>
  <p>By using the Service, you agree to:</p>
  <ul>
    <li>Not use the Service for any unlawful purpose or in violation of Discord's or Roblox's Terms of Service</li>
    <li>Not attempt to exploit, abuse, or disrupt the Service</li>
    <li>Not use the Service to harass, harm, or demote members without legitimate reason</li>
    <li>Take responsibility for all actions taken through your server's Phantom configuration</li>
  </ul>

  <h2>5. Roblox Integration</h2>
  <p>Phantom uses Roblox's Open Cloud API to read group data and, when configured, apply rank changes. By enabling rank management features, you confirm you have the authority to make changes within your Roblox group. Phantom Studios takes no responsibility for unintended rank changes resulting from misconfiguration.</p>

  <h2>6. Subscriptions and Billing</h2>
  <p>Premium and Enterprise tiers are billed monthly through Stripe. Subscriptions renew automatically unless cancelled. You may cancel at any time through the billing portal accessible from your dashboard. Refunds are not provided for partial billing periods unless required by Australian Consumer Law.</p>

  <h2>7. Data and Privacy</h2>
  <p>Phantom stores Discord user IDs, Roblox usernames, and server configuration data necessary to provide the Service. We do not sell your data to third parties. See our <a href="/privacy">Privacy Policy</a> for full details.</p>

  <h2>8. Service Availability</h2>
  <p>We aim to keep Phantom running 24/7 but do not guarantee uninterrupted availability. We reserve the right to perform maintenance, updates, or shut down the Service with reasonable notice.</p>

  <h2>9. Termination</h2>
  <p>We reserve the right to suspend or terminate access to the Service for servers or users found to be violating these Terms, Discord's Terms of Service, or Roblox's Terms of Service, without prior notice.</p>

  <h2>10. Limitation of Liability</h2>
  <p>Phantom Studios is not liable for any indirect, incidental, or consequential damages arising from use of the Service, including but not limited to unintended rank changes, data loss, or service interruptions.</p>

  <h2>11. Changes to Terms</h2>
  <p>We may update these Terms from time to time. Continued use of the Service after changes constitutes acceptance of the updated Terms. We will notify users of significant changes via the Phantom Studios Discord server.</p>

  <h2>12. Contact</h2>
  <p>Questions about these Terms? Join our <a href="https://discord.gg/fYtxnNqGNn" target="_blank">support server</a> or open a ticket.</p>
</div>
<footer class="footer">
  © 2026 Phantom Studios &nbsp;·&nbsp;
  <a href="/">Home</a>
  <a href="/privacy">Privacy Policy</a>
  <a href="/dashboard">Dashboard</a>
</footer>
</body>
</html>`);
    });

    // ── Privacy Policy ────────────────────────────────────────────────────────
    app.get('/privacy', (req, res) => {
      res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Privacy Policy — Phantom</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0a0a0f; color: #e8e0ff; line-height: 1.8; }
    .nav { display: flex; align-items: center; justify-content: space-between; padding: 18px 48px; background: rgba(10,10,15,0.95); border-bottom: 1px solid #1e1040; }
    .nav-logo { font-size: 20px; font-weight: 800; color: #c084fc; text-decoration: none; }
    .nav a { color: #a78bfa; text-decoration: none; font-size: 14px; }
    .container { max-width: 780px; margin: 60px auto; padding: 0 24px 80px; }
    h1 { font-size: 36px; font-weight: 900; color: #fff; margin-bottom: 8px; }
    .updated { color: #5b4fa0; font-size: 13px; margin-bottom: 48px; }
    h2 { font-size: 20px; font-weight: 700; color: #c084fc; margin: 40px 0 12px; }
    p { color: #a78bfa; margin-bottom: 16px; font-size: 15px; }
    ul { color: #a78bfa; padding-left: 24px; margin-bottom: 16px; font-size: 15px; }
    ul li { margin-bottom: 8px; }
    a { color: #7c3aed; }
    .footer { text-align: center; padding: 32px 24px; border-top: 1px solid #1e1040; color: #5b4fa0; font-size: 13px; }
    .footer a { color: #7c3aed; margin: 0 10px; }
  </style>
</head>
<body>
<nav class="nav">
  <a href="/" class="nav-logo">👻 Phantom</a>
  <a href="/">← Back to home</a>
</nav>
<div class="container">
  <h1>Privacy Policy</h1>
  <p class="updated">Last updated: 14 June 2026</p>

  <h2>1. Introduction</h2>
  <p>Phantom Studios ("we", "us", "our") operates the Phantom Discord bot and web dashboard. This Privacy Policy explains what data we collect, how we use it, and your rights regarding that data.</p>

  <h2>2. Data We Collect</h2>
  <p>We collect and store the minimum data necessary to provide the Service:</p>
  <ul>
    <li><strong>Discord User ID</strong> — used to identify your account across sessions</li>
    <li><strong>Roblox Username and User ID</strong> — stored when you link your Roblox account</li>
    <li><strong>Discord Server ID and Configuration</strong> — your server's Phantom settings (group ID, role mappings, audit log channels, etc.)</li>
    <li><strong>Roblox Open Cloud API Key</strong> — stored encrypted, used only to apply rank changes in your Roblox group</li>
    <li><strong>Subscription Status</strong> — whether your server has an active Premium or Enterprise subscription, managed via Stripe</li>
  </ul>

  <h2>3. Data We Do Not Collect</h2>
  <ul>
    <li>We do not read, store, or log message content from your Discord server</li>
    <li>We do not collect passwords, email addresses, or payment card details (payments handled by Stripe)</li>
    <li>We do not track browsing behaviour or use advertising trackers</li>
  </ul>

  <h2>4. How We Use Your Data</h2>
  <p>Data collected is used solely to provide the Service:</p>
  <ul>
    <li>Linking your Discord account to your Roblox account</li>
    <li>Syncing Discord roles based on your Roblox group rank</li>
    <li>Applying rank changes via the dashboard or auto-rank system</li>
    <li>Displaying linked member information in the dashboard</li>
    <li>Processing and managing your subscription</li>
  </ul>

  <h2>5. Data Sharing</h2>
  <p>We do not sell, rent, or share your data with third parties except:</p>
  <ul>
    <li><strong>Stripe</strong> — for payment processing. Stripe's privacy policy applies to payment data</li>
    <li><strong>Discord</strong> — OAuth2 is used for dashboard login. Discord's privacy policy applies</li>
    <li><strong>Roblox</strong> — the Open Cloud API is called to read/write group data. Roblox's privacy policy applies</li>
    <li><strong>Legal requirements</strong> — if required by law or to protect our rights</li>
  </ul>

  <h2>6. Data Retention</h2>
  <p>We retain your data for as long as you use the Service. When you remove Phantom from your server, server configuration data is no longer actively used. You may request deletion of your data at any time by contacting us.</p>

  <h2>7. Security</h2>
  <p>We take reasonable steps to protect your data, including encrypted storage of API keys and secure HTTPS connections. No system is 100% secure — please contact us immediately if you suspect a breach.</p>

  <h2>8. Your Rights</h2>
  <p>Under Australian Privacy Law and GDPR (where applicable), you have the right to:</p>
  <ul>
    <li>Access the data we hold about you</li>
    <li>Request correction of inaccurate data</li>
    <li>Request deletion of your data</li>
    <li>Withdraw consent for data processing</li>
  </ul>
  <p>To exercise these rights, open a ticket in our <a href="https://discord.gg/fYtxnNqGNn" target="_blank">support server</a>.</p>

  <h2>9. Children's Privacy</h2>
  <p>Phantom is not directed at children under 13. We do not knowingly collect data from children under 13. If you believe we have inadvertently collected such data, please contact us immediately.</p>

  <h2>10. Changes to This Policy</h2>
  <p>We may update this Privacy Policy from time to time. We will notify users of significant changes via the Phantom Studios Discord server. Continued use of the Service constitutes acceptance of the updated policy.</p>

  <h2>11. Contact</h2>
  <p>Questions about this Privacy Policy? Join our <a href="https://discord.gg/fYtxnNqGNn" target="_blank">support server</a> or open a ticket.</p>
</div>
<footer class="footer">
  © 2026 Phantom Studios &nbsp;·&nbsp;
  <a href="/">Home</a>
  <a href="/tos">Terms of Service</a>
  <a href="/dashboard">Dashboard</a>
</footer>
</body>
</html>`);
    });

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

        if (!hasStartedListening) {
          process.exit(1);
        }
      });
    };

    startServer(configuredPort, 0);
  }

  setupCronJobs() {
    cron.schedule('0 6 * * *', () => checkBirthdays(this));
    cron.schedule('* * * * *', () => checkGiveaways(this));
    cron.schedule('*/15 * * * *', () => this.updateAllCounters());
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
        
        // Save cleaned counters if any were orphaned
        if (orphanedCounters.length > 0) {
          await saveServerCounters(this, guildId, validCounters);
          logger.info(`Cleaned up ${orphanedCounters.length} orphaned counter(s) from guild ${guildId} during scheduled update`);
        }
      } catch (error) {
        logger.error(`Error updating counters for guild ${guildId}:`, error);
      }
    }
  }

  async loadHandlers() {
    const handlers = [
      { path: 'events', type: 'default', required: true },
      { path: 'interactions', type: 'default', required: true }
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
          logger.error(`❌ Failed to load required handler ${handler.path}:`, error.message);
          throw error;
        } else if (error.code !== 'MODULE_NOT_FOUND') {
          logger.warn(`⚠️  Failed to load optional handler ${handler.path}:`, error.message);
        }
      }
    }
  }

  async registerCommands() {
    try {
      // Global registration is handled in the ready event (ready.js)
      // where client.application is available. Guild-specific registration
      // is skipped to prevent duplicate commands appearing in servers.
      logger.info('Command registration deferred to ready event (global only).');
    } catch (error) {
      logger.error('Error in registerCommands:', error);
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

      // Close database connection
      if (this.db && this.db.db) {
        logger.info('Closing database connection...');
        try {
          if (this.db.db.pool) {
            await this.db.db.pool.end();
            logger.info('✅ Database connection closed');
          }
        } catch (error) {
          logger.warn('Error closing database pool:', error.message);
        }
      }

      
      logger.info('Destroying Discord client...');
      if (this.isReady()) {
        try {
          this.destroy();
          logger.info('✅ Discord client destroyed');
        } catch (error) {
          
          
          logger.warn('Discord client destroy warning (non-critical):', error.message);
        }
      }

      logger.info('✅ Graceful shutdown complete');
  shutdownLog('Bot stopped successfully.');
      process.exit(0);
    } catch (error) {
      logger.error('Error during graceful shutdown:', error);
      process.exit(1);
    }
  }
}

try {
  const bot = new PhantomBot();
  
  const setupShutdown = () => {
    process.on('SIGTERM', () => bot.shutdown('SIGTERM'));
    process.on('SIGINT', () => bot.shutdown('SIGINT'));
    
    process.on('uncaughtException', (error) => {
      logger.error('Uncaught Exception:', error);
      bot.shutdown('UNCAUGHT_EXCEPTION');
    });
    
    process.on('unhandledRejection', (reason, promise) => {
      logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
      bot.shutdown('UNHANDLED_REJECTION');
    });
  };
  
  setupShutdown();
  bot.start();
} catch (error) {
  logger.error('Fatal error during bot startup:', error);
  process.exit(1);
}

export default PhantomBot;
