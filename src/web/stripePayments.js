// src/web/stripePayments.js
//
// Handles all Stripe monetization for Phantom:
//   GET  /upgrade/:guildId          → redirect to Stripe Checkout
//   POST /stripe/webhook            → handle subscription events
//   GET  /dashboard/server/:guildId/billing → billing management portal

import { Router } from 'express';
import Stripe from 'stripe';
import { db } from '../utils/database.js';
import { logger } from '../utils/logger.js';

export const stripeRouter = Router();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');
const WEBHOOK_SECRET   = process.env.STRIPE_WEBHOOK_SECRET || '';
const PREMIUM_PRICE_ID    = process.env.STRIPE_PRICE_ID_PREMIUM || '';
const ENTERPRISE_PRICE_ID = process.env.STRIPE_PRICE_ID_ENTERPRISE || '';
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://phantom1.up.railway.app';

// ── Helpers ────────────────────────────────────────────────────────────────

function subKey(guildId) { return `subscription:${guildId}`; }

export async function getSubscription(guildId) {
  try {
    return await db.get(subKey(guildId)) || { tier: 'free' };
  } catch { return { tier: 'free' }; }
}

async function saveSubscription(guildId, data) {
  try { await db.set(subKey(guildId), data); } catch (e) { logger.error('saveSubscription error:', e); }
}

export function getTier(sub) {
  if (!sub || sub.tier === 'free' || sub.status === 'canceled') return 'free';
  if (sub.status !== 'active' && sub.status !== 'trialing') return 'free';
  return sub.tier || 'free';
}

// ── Checkout: GET /upgrade/:guildId?plan=premium|enterprise ───────────────

stripeRouter.get('/upgrade/:guildId', async (req, res) => {
  const { guildId } = req.params;
  const plan = req.query.plan === 'enterprise' ? 'enterprise' : 'premium';
  const priceId = plan === 'enterprise' ? ENTERPRISE_PRICE_ID : PREMIUM_PRICE_ID;

  if (!priceId) return res.status(500).send('Stripe not configured.');

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { guildId, plan },
      success_url: `${PUBLIC_URL}/dashboard/server/${guildId}?success=Subscription+active+%F0%9F%8E%89`,
      cancel_url:  `${PUBLIC_URL}/dashboard/server/${guildId}?error=Checkout+cancelled`,
      allow_promotion_codes: true,
    });
    res.redirect(303, session.url);
  } catch (err) {
    logger.error('Stripe checkout error:', err);
    res.status(500).send('Something went wrong creating the checkout session.');
  }
});

// ── Billing portal: GET /dashboard/server/:guildId/billing ────────────────

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

// ── Webhook: POST /stripe/webhook ─────────────────────────────────────────
// Must use raw body — registered BEFORE express.json() middleware

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
        const plan    = session.metadata?.plan || 'premium';
        if (!guildId) break;

        await saveSubscription(guildId, {
          tier:           plan,
          status:         'active',
          customerId:     session.customer,
          subscriptionId: session.subscription,
          activatedAt:    new Date().toISOString(),
        });
        logger.info(`[Stripe] ${plan} activated for guild ${guildId}`);
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const guildId = await findGuildByCustomer(sub.customer);
        if (!guildId) break;

        const existing = await getSubscription(guildId);
        await saveSubscription(guildId, {
          ...existing,
          status: sub.status,
          currentPeriodEnd: new Date(sub.current_period_end * 1000).toISOString(),
        });
        logger.info(`[Stripe] Subscription updated for guild ${guildId}: ${sub.status}`);
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const guildId = await findGuildByCustomer(sub.customer);
        if (!guildId) break;

        await saveSubscription(guildId, { tier: 'free', status: 'canceled' });
        logger.info(`[Stripe] Subscription cancelled for guild ${guildId}`);
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const guildId = await findGuildByCustomer(invoice.customer);
        if (!guildId) break;

        const existing = await getSubscription(guildId);
        await saveSubscription(guildId, { ...existing, status: 'past_due' });
        logger.warn(`[Stripe] Payment failed for guild ${guildId}`);
        break;
      }
    }
  } catch (err) {
    logger.error('Stripe webhook handler error:', err);
  }

  res.json({ received: true });
});

// Find which guild a Stripe customer ID belongs to
async function findGuildByCustomer(customerId) {
  try {
    const keys = await db.list('subscription:');
    for (const key of keys) {
      const sub = await db.get(key);
      if (sub?.customerId === customerId) {
        return key.replace('subscription:', '');
      }
    }
  } catch (e) { logger.error('findGuildByCustomer error:', e); }
  return null;
}
