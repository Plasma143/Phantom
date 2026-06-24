// src/web/stripePayments.js
//
// Handles all Stripe monetization for Phantom:
//   GET  /upgrade/:guildId              → Stripe Checkout (guild subscription)
//   GET  /upgrade/developer/:plan       → Stripe Checkout (personal developer subscription)
//   POST /stripe/webhook                → handle subscription events
//   GET  /dashboard/server/:guildId/billing → billing management portal
//   GET  /dashboard/me/billing          → personal billing portal

import { Router } from 'express';
import Stripe from 'stripe';
import { db } from '../utils/database.js';
import { logger } from '../utils/logger.js';

export const stripeRouter = Router();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');
const WEBHOOK_SECRET      = process.env.STRIPE_WEBHOOK_SECRET || '';
const PREMIUM_PRICE_ID    = process.env.STRIPE_PRICE_ID_PREMIUM || '';
const ENTERPRISE_PRICE_ID = process.env.STRIPE_PRICE_ID_ENTERPRISE || '';
const DEV_BASIC_PRICE_ID  = process.env.STRIPE_PRICE_ID_DEV_BASIC || '';
const DEV_PRO_PRICE_ID    = process.env.STRIPE_PRICE_ID_DEV_PRO || '';
const DEV_ELITE_PRICE_ID  = process.env.STRIPE_PRICE_ID_DEV_ELITE || '';
const PUBLIC_URL          = process.env.PUBLIC_URL || 'https://phantombot.org';
const SUPPORT_GUILD_ID    = process.env.PHANTOM_SUPPORT_GUILD_ID || '';
const BOT_TOKEN           = process.env.DISCORD_TOKEN || '';

// Stripe coupon IDs for boost discounts
const COUPON_BOOST1 = 'phantom_boost1'; // 10% off
const COUPON_BOOST2 = 'phantom_boost2'; // 20% off

// ── Ensure boost coupons exist in Stripe ──────────────────────────────────
async function ensureBoostCoupons() {
  try {
    await stripe.coupons.retrieve(COUPON_BOOST1).catch(async () => {
      await stripe.coupons.create({ id: COUPON_BOOST1, percent_off: 10, duration: 'forever', name: 'Server Booster (1 boost) — 10% off' });
      logger.info('[Stripe] Created phantom_boost1 coupon');
    });
    await stripe.coupons.retrieve(COUPON_BOOST2).catch(async () => {
      await stripe.coupons.create({ id: COUPON_BOOST2, percent_off: 20, duration: 'forever', name: 'Server Booster (2 boosts) — 20% off' });
      logger.info('[Stripe] Created phantom_boost2 coupon');
    });
  } catch (e) {
    logger.warn('[Stripe] Could not ensure boost coupons:', e.message);
  }
}
ensureBoostCoupons();

// ── Cookie helper ─────────────────────────────────────────────────────────
function getCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v || '');
  }
  return null;
}

// ── Boost level helpers ───────────────────────────────────────────────────
export async function getBoostLevel(userId) {
  if (!userId || !SUPPORT_GUILD_ID) return 0;
  const stored = await db.get(`user_boosts:${userId}`).catch(() => null);
  if (stored) return stored;
  try {
    const res = await fetch(`https://discord.com/api/guilds/${SUPPORT_GUILD_ID}/members/${userId}`, {
      headers: { Authorization: `Bot ${BOT_TOKEN}` },
    });
    if (!res.ok) return 0;
    const member = await res.json();
    if (member.premium_since) {
      await db.set(`user_boosts:${userId}`, 1).catch(() => {});
      return 1;
    }
    return 0;
  } catch { return 0; }
}

export async function getBoostDiscount(userId) {
  const level = await getBoostLevel(userId);
  if (level >= 2) return { coupon: COUPON_BOOST2, percent: 20, label: '20% off — thanks for 2 boosts! 🚀' };
  if (level >= 1) return { coupon: COUPON_BOOST1, percent: 10, label: '10% off — thanks for boosting! ⚡' };
  return null;
}

async function getLoggedInUserId(req) {
  const token = getCookie(req, 'dashboard_token');
  if (!token) return null;
  try {
    const res = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const user = await res.json();
    return user.id || null;
  } catch { return null; }
}

// ── Owner bypass ──────────────────────────────────────────────────────────
export function isOwner(userId) {
  const ids = (process.env.ADMIN_DISCORD_IDS || process.env.PHANTOM_OWNER_ID || '').split(',').map(s => s.trim());
  return !!(userId && ids.includes(userId));
}

// ── Guild subscription helpers ────────────────────────────────────────────
function subKey(guildId) { return `subscription:${guildId}`; }

export async function getSubscription(guildId) {
  try {
    return await db.get(subKey(guildId)) || { tier: 'free' };
  } catch { return { tier: 'free' }; }
}

async function saveSubscription(guildId, data) {
  try { await db.set(subKey(guildId), data); } catch (e) { logger.error('saveSubscription error:', e); }
}

// ── User (personal) subscription helpers ─────────────────────────────────
function userSubKey(userId) { return `subscription:user:${userId}`; }

export async function getUserSubscription(userId) {
  try {
    return await db.get(userSubKey(userId)) || { tier: 'free' };
  } catch { return { tier: 'free' }; }
}

async function saveUserSubscription(userId, data) {
  try { await db.set(userSubKey(userId), data); } catch (e) { logger.error('saveUserSubscription error:', e); }
}

// ── Tier resolution ───────────────────────────────────────────────────────
export function getTier(sub) {
  if (!sub || sub.tier === 'free' || sub.status === 'canceled') return 'free';
  if (sub.status !== 'active' && sub.status !== 'trialing') return 'free';
  return sub.tier || 'free';
}

/**
 * Resolves the effective tier for a user in a given context.
 * Priority: owner → personal developer sub → guild sub
 */
export async function getEffectiveTier(userId, guildId) {
  if (isOwner(userId)) return 'enterprise';

  // Check personal developer subscription first
  const userSub = await getUserSubscription(userId);
  const userTier = getTier(userSub);
  if (userTier !== 'free') return userTier;

  // Fall back to guild subscription
  if (guildId) {
    const guildSub = await getSubscription(guildId);
    return getTier(guildSub);
  }

  return 'free';
}

// ── Guild checkout: GET /upgrade/:guildId ─────────────────────────────────
stripeRouter.get('/upgrade/:guildId', async (req, res) => {
  const { guildId } = req.params;
  const plan = req.query.plan === 'enterprise' ? 'enterprise' : 'premium';
  const priceId = plan === 'enterprise' ? ENTERPRISE_PRICE_ID : PREMIUM_PRICE_ID;

  if (!priceId) return res.status(500).send('Stripe not configured.');

  try {
    const userId   = await getLoggedInUserId(req);
    const discount = userId ? await getBoostDiscount(userId) : null;

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { guildId, plan },
      success_url: `${PUBLIC_URL}/dashboard/server/${guildId}?success=Subscription+active+%F0%9F%8E%89`,
      cancel_url:  `${PUBLIC_URL}/dashboard/server/${guildId}?error=Checkout+cancelled`,
      ...(discount
        ? { discounts: [{ coupon: discount.coupon }] }
        : { allow_promotion_codes: true }
      ),
    });
    res.redirect(303, session.url);
  } catch (err) {
    logger.error('Stripe checkout error:', err);
    res.status(500).send('Something went wrong creating the checkout session.');
  }
});

// ── Developer personal checkout: GET /upgrade/developer/:plan ─────────────
stripeRouter.get('/upgrade/developer/:plan', async (req, res) => {
  const { plan } = req.params;

  const priceMap = {
    'basic': DEV_BASIC_PRICE_ID,
    'pro':   DEV_PRO_PRICE_ID,
    'elite': DEV_ELITE_PRICE_ID,
  };

  const priceId = priceMap[plan];
  if (!priceId) return res.status(400).send('Invalid developer plan.');

  const userId = await getLoggedInUserId(req);
  if (!userId) return res.redirect('/dashboard/login');

  try {
    const discount = await getBoostDiscount(userId);

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { userId, plan: `developer-${plan}` },
      success_url: `${PUBLIC_URL}/dashboard/me?success=Developer+subscription+active+%F0%9F%8E%89`,
      cancel_url:  `${PUBLIC_URL}/dashboard/me?error=Checkout+cancelled`,
      ...(discount
        ? { discounts: [{ coupon: discount.coupon }] }
        : { allow_promotion_codes: true }
      ),
    });
    res.redirect(303, session.url);
  } catch (err) {
    logger.error('Stripe developer checkout error:', err);
    res.status(500).send('Something went wrong creating the checkout session.');
  }
});

// ── Guild billing portal: GET /dashboard/server/:guildId/billing ──────────
stripeRouter.get('/dashboard/server/:guildId/billing', async (req, res) => {
  const { guildId } = req.params;
  const sub = await getSubscription(guildId);

  if (!sub.customerId) {
    return res.redirect(`/dashboard/server/${guildId}?error=No+active+subscription+found`);
  }

  try {
    const portal = await stripe.billingPortal.sessions.create({
      customer: sub.customerId,
      return_url: `${PUBLIC_URL}/dashboard/server/${guildId}`,
    });
    res.redirect(303, portal.url);
  } catch (err) {
    logger.error('Stripe portal error:', err);
    res.redirect(`/dashboard/server/${guildId}?error=Could+not+open+billing+portal`);
  }
});

// ── Personal billing portal: GET /dashboard/me/billing ───────────────────
stripeRouter.get('/dashboard/me/billing', async (req, res) => {
  const userId = await getLoggedInUserId(req);
  if (!userId) return res.redirect('/dashboard/login');

  const sub = await getUserSubscription(userId);
  if (!sub.customerId) {
    return res.redirect(`/dashboard/me?error=No+active+subscription+found`);
  }

  try {
    const portal = await stripe.billingPortal.sessions.create({
      customer: sub.customerId,
      return_url: `${PUBLIC_URL}/dashboard/me`,
    });
    res.redirect(303, portal.url);
  } catch (err) {
    logger.error('Stripe personal portal error:', err);
    res.redirect(`/dashboard/me?error=Could+not+open+billing+portal`);
  }
});

// ── Webhook: POST /stripe/webhook ─────────────────────────────────────────
stripeRouter.post('/stripe/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, WEBHOOK_SECRET);
  } catch (err) {
    logger.error('Stripe webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const guildId = session.metadata?.guildId;
        const userId  = session.metadata?.userId;
        const plan    = session.metadata?.plan || 'premium';

        if (userId) {
          // Personal developer subscription
          await saveUserSubscription(userId, {
            tier:           plan,
            status:         'active',
            customerId:     session.customer,
            subscriptionId: session.subscription,
            activatedAt:    new Date().toISOString(),
          });
          logger.info(`[Stripe] Developer ${plan} activated for user ${userId}`);
        } else if (guildId) {
          // Guild subscription
          await saveSubscription(guildId, {
            tier:           plan,
            status:         'active',
            customerId:     session.customer,
            subscriptionId: session.subscription,
            activatedAt:    new Date().toISOString(),
          });
          logger.info(`[Stripe] ${plan} activated for guild ${guildId}`);
        }
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const { target, id } = await findByCustomer(sub.customer);
        if (!id) break;

        if (target === 'user') {
          const existing = await getUserSubscription(id);
          await saveUserSubscription(id, {
            ...existing,
            status: sub.status,
            currentPeriodEnd: new Date(sub.current_period_end * 1000).toISOString(),
          });
        } else {
          const existing = await getSubscription(id);
          await saveSubscription(id, {
            ...existing,
            status: sub.status,
            currentPeriodEnd: new Date(sub.current_period_end * 1000).toISOString(),
          });
        }
        logger.info(`[Stripe] Subscription updated for ${target} ${id}: ${sub.status}`);
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const { target, id } = await findByCustomer(sub.customer);
        if (!id) break;

        if (target === 'user') {
          await saveUserSubscription(id, { tier: 'free', status: 'canceled' });
        } else {
          await saveSubscription(id, { tier: 'free', status: 'canceled' });
        }
        logger.info(`[Stripe] Subscription cancelled for ${target} ${id}`);
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const { target, id } = await findByCustomer(invoice.customer);
        if (!id) break;

        if (target === 'user') {
          const existing = await getUserSubscription(id);
          await saveUserSubscription(id, { ...existing, status: 'past_due' });
        } else {
          const existing = await getSubscription(id);
          await saveSubscription(id, { ...existing, status: 'past_due' });
        }
        logger.warn(`[Stripe] Payment failed for ${target} ${id}`);
        break;
      }
    }
  } catch (err) {
    logger.error('Stripe webhook handler error:', err);
  }

  res.json({ received: true });
});

// ── Find who owns a Stripe customer ID ───────────────────────────────────
// Returns { target: 'guild'|'user', id: guildId|userId } or { target: null, id: null }
async function findByCustomer(customerId) {
  try {
    // Search guild subscriptions
    const guildKeys = await db.list('subscription:');
    for (const key of guildKeys) {
      if (key.startsWith('subscription:user:')) continue; // skip user keys
      const sub = await db.get(key);
      if (sub?.customerId === customerId) {
        return { target: 'guild', id: key.replace('subscription:', '') };
      }
    }

    // Search user subscriptions
    const userKeys = await db.list('subscription:user:');
    for (const key of userKeys) {
      const sub = await db.get(key);
      if (sub?.customerId === customerId) {
        return { target: 'user', id: key.replace('subscription:user:', '') };
      }
    }
  } catch (e) { logger.error('findByCustomer error:', e); }
  return { target: null, id: null };
}

// Legacy alias for anything still calling findGuildByCustomer
async function findGuildByCustomer(customerId) {
  const { target, id } = await findByCustomer(customerId);
  return target === 'guild' ? id : null;
}
