import 'dotenv/config';
import { Client, Collection, GatewayIntentBits } from 'discord.js';
import { REST } from '@discordjs/rest';
import express from 'express';
import cron from 'node-cron';

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
      startupLog('Discord login successful');
      
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
    <a href="https://discord.gg/phantomstudios" target="_blank">Support</a>
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
    <a href="https://discord.gg/phantomstudios" target="_blank">Support</a>
  </p>
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
      await registerSlashCommands(this, this.config.bot.guildId);
    } catch (error) {
      logger.error('Error registering commands:', error);
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
