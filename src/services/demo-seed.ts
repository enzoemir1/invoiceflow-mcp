/**
 * Demo seed service — creates a realistic demo dataset (clients + invoices)
 * so InvoiceFlow can be evaluated via MCP Inspector without real Stripe,
 * SendGrid, or PayPal credentials. Every call generates a fresh batch with
 * unique IDs; safe to call multiple times.
 */

import { randomUUID } from 'node:crypto';
import type { Client, Invoice, LineItem, PaymentHistory } from '../models/invoice.js';
import { Storage, storage as defaultStorage } from './storage.js';

// ─── Seed data ───────────────────────────────────────────────────
interface DemoClientSpec {
  name: string;
  email: string;
  company: string;
  country: 'US' | 'GB' | 'DE' | 'ES' | 'FR' | 'NL';
  city: string;
  currency: 'USD' | 'EUR' | 'GBP';
  archetype: 'on-time' | 'late-payer' | 'high-value' | 'new' | 'chronic-late';
}

const DEMO_CLIENTS: DemoClientSpec[] = [
  { name: 'Sarah Chen',        email: 'sarah.chen@acmetech.example',    company: 'Acme Tech Inc.',       country: 'US', city: 'San Francisco', currency: 'USD', archetype: 'high-value' },
  { name: 'Marcus Weber',      email: 'marcus.weber@bluelabs.example',  company: 'BlueLabs GmbH',        country: 'DE', city: 'Berlin',        currency: 'EUR', archetype: 'on-time' },
  { name: 'Olivia Thompson',   email: 'olivia.t@novastudio.example',    company: 'Nova Studio Ltd',      country: 'GB', city: 'London',        currency: 'GBP', archetype: 'late-payer' },
  { name: 'Diego Martinez',    email: 'diego@peakconsulting.example',   company: 'Peak Consulting SL',   country: 'ES', city: 'Barcelona',     currency: 'EUR', archetype: 'on-time' },
  { name: 'Amelie Dubois',     email: 'amelie@atelierd.example',        company: 'Atelier Dubois',       country: 'FR', city: 'Paris',         currency: 'EUR', archetype: 'high-value' },
  { name: 'Lucas Janssen',     email: 'lucas@northwave.example',        company: 'Northwave BV',         country: 'NL', city: 'Amsterdam',     currency: 'EUR', archetype: 'chronic-late' },
  { name: 'Priya Patel',       email: 'priya@zenithai.example',         company: 'Zenith AI',            country: 'US', city: 'Austin',        currency: 'USD', archetype: 'new' },
  { name: 'Tom Hargreaves',    email: 'tom@stonebridge.example',        company: 'Stonebridge Ltd',      country: 'GB', city: 'Manchester',    currency: 'GBP', archetype: 'on-time' },
];

// Invoice spec tuned per archetype: (count, baseAmount, paidRatio, avgDaysEarlyOrLate)
interface ArchetypeParams {
  count: [number, number];       // invoice count range
  amount: [number, number];      // line total range
  paidRatio: number;             // fraction of invoices paid
  paymentDrift: [number, number]; // days relative to due_date; negative = early, positive = late
}

function archetypeParams(a: DemoClientSpec['archetype']): ArchetypeParams {
  switch (a) {
    case 'on-time':       return { count: [4, 6], amount: [800, 3000],  paidRatio: 0.9, paymentDrift: [-2, 2] };
    case 'late-payer':    return { count: [3, 5], amount: [500, 2000],  paidRatio: 0.7, paymentDrift: [5, 18] };
    case 'high-value':    return { count: [5, 8], amount: [4000, 12000], paidRatio: 0.85, paymentDrift: [-1, 5] };
    case 'new':           return { count: [1, 2], amount: [600, 2500],  paidRatio: 0.5, paymentDrift: [0, 3] };
    case 'chronic-late':  return { count: [3, 4], amount: [900, 2500],  paidRatio: 0.5, paymentDrift: [12, 28] };
  }
}

// Deterministic-ish random using a numeric seed
function rand(min: number, max: number, seed: number): number {
  const x = Math.sin(seed * 9301 + 49297) * 233280;
  const r = x - Math.floor(x);
  return min + r * (max - min);
}
function randInt(min: number, max: number, seed: number): number {
  return Math.floor(rand(min, max + 1, seed));
}

const SERVICE_DESCRIPTIONS = [
  'Strategy consulting — quarterly retainer',
  'Product design sprint',
  'API integration engineering',
  'Custom dashboard development',
  'Marketing campaign design',
  'UX research + usability testing',
  'Frontend implementation',
  'Data pipeline build',
  'Technical audit',
  'Training workshop (2 days)',
];

// ─── Main seed function ──────────────────────────────────────────
export interface DemoSeedResult {
  clients: number;
  invoices: number;
  paid_invoices: number;
  overdue_invoices: number;
  total_invoiced: number;
  total_collected: number;
  client_ids: string[];
  sample_invoice_ids: string[];
  message: string;
}

/**
 * Populate the store with demo clients and invoices covering multiple
 * archetypes: on-time payers, chronic-late payers, high-value clients,
 * and new relationships. Every tool (invoice_list, invoice_risk,
 * cashflow_report, payment_reconcile, etc.) will return meaningful
 * results against this dataset without needing real Stripe/PayPal keys.
 */
export async function seedDemoData(store?: Storage): Promise<DemoSeedResult> {
  const s = store ?? defaultStorage;
  const now = new Date();
  const nowMs = now.getTime();

  const clients: Client[] = [];
  const invoices: Invoice[] = [];
  let invoiceCounter = 1000;
  let totalInvoiced = 0;
  let totalCollected = 0;
  let paidCount = 0;
  let overdueCount = 0;

  for (let ci = 0; ci < DEMO_CLIENTS.length; ci++) {
    const spec = DEMO_CLIENTS[ci];
    const params = archetypeParams(spec.archetype);
    const clientId = randomUUID();

    const invoiceCount = randInt(params.count[0], params.count[1], ci * 31 + 7);
    let clientPaid = 0;
    let clientLate = 0;
    let clientTotalRevenue = 0;
    let daysToPaymentSum = 0;

    for (let j = 0; j < invoiceCount; j++) {
      const seed = ci * 101 + j * 13;
      // Issue date: spread across the last ~180 days
      const ageDays = randInt(5, 180, seed + 1);
      const issueDate = new Date(nowMs - ageDays * 86_400_000);
      const dueDate = new Date(issueDate.getTime() + 30 * 86_400_000);

      // Build 1–3 line items
      const itemCount = randInt(1, 3, seed + 2);
      const targetTotal = rand(params.amount[0], params.amount[1], seed + 3);
      const lineItems: LineItem[] = [];
      let subtotal = 0;
      for (let k = 0; k < itemCount; k++) {
        const qty = randInt(1, 4, seed + 4 + k);
        const unit = Math.round((targetTotal / itemCount / qty) * 100) / 100;
        const tax = k === 0 ? 10 : 0;
        const lineAmount = Math.round(qty * unit * 100) / 100;
        lineItems.push({
          description: SERVICE_DESCRIPTIONS[(seed + k) % SERVICE_DESCRIPTIONS.length],
          quantity: qty,
          unit_price: unit,
          tax_rate: tax,
          discount_percent: 0,
          amount: lineAmount,
        });
        subtotal += qty * unit;
      }
      subtotal = Math.round(subtotal * 100) / 100;
      const taxTotal = Math.round(lineItems[0].quantity * lineItems[0].unit_price * 0.1 * 100) / 100;
      const total = Math.round((subtotal + taxTotal) * 100) / 100;

      // Payment outcome
      const paidRoll = rand(0, 1, seed + 20);
      const paid = paidRoll < params.paidRatio;
      const drift = randInt(params.paymentDrift[0], params.paymentDrift[1], seed + 21);
      const paidDate = paid ? new Date(dueDate.getTime() + drift * 86_400_000) : null;
      const isPastDue = !paid && dueDate.getTime() < nowMs;

      let status: Invoice['status'];
      if (paid) status = 'paid';
      else if (isPastDue) status = 'overdue';
      else status = 'sent';

      const amountPaid = paid ? total : 0;
      const amountDue = Math.round((total - amountPaid) * 100) / 100;

      const invoiceNumber = `INV-${now.getFullYear()}-${String(invoiceCounter++).padStart(4, '0')}`;
      const invoice: Invoice = {
        id: randomUUID(),
        invoice_number: invoiceNumber,
        client_id: clientId,
        client_name: spec.name,
        client_email: spec.email,
        status,
        currency: spec.currency,
        line_items: lineItems,
        subtotal,
        tax_total: taxTotal,
        discount_total: 0,
        total,
        amount_paid: amountPaid,
        amount_due: amountDue,
        issue_date: issueDate.toISOString(),
        due_date: dueDate.toISOString(),
        paid_date: paidDate ? paidDate.toISOString() : null,
        notes: undefined,
        terms: 'Net 30',
        payment_method: paid ? (['stripe', 'bank_transfer', 'paypal'] as const)[j % 3] : null,
        risk_score: null,
        risk_action: null,
        reminder_count: isPastDue ? randInt(1, 3, seed + 22) : 0,
        last_reminder_at: isPastDue ? new Date(nowMs - 3 * 86_400_000).toISOString() : null,
        created_at: issueDate.toISOString(),
        updated_at: (paidDate ?? issueDate).toISOString(),
      };

      invoices.push(invoice);
      totalInvoiced += total;
      if (paid) {
        paidCount++;
        clientPaid++;
        totalCollected += total;
        clientTotalRevenue += total;
        const days = (invoice.paid_date ? new Date(invoice.paid_date).getTime() : dueDate.getTime()) - issueDate.getTime();
        daysToPaymentSum += days / 86_400_000;
        if (drift > 0) clientLate++;
      }
      if (isPastDue) overdueCount++;
    }

    const paymentHistory: PaymentHistory = {
      total_invoices: invoiceCount,
      paid_invoices: clientPaid,
      avg_days_to_payment: clientPaid > 0 ? Math.round((daysToPaymentSum / clientPaid) * 10) / 10 : null,
      late_payment_count: clientLate,
      total_revenue: Math.round(clientTotalRevenue * 100) / 100,
    };

    const client: Client = {
      id: clientId,
      name: spec.name,
      email: spec.email,
      company: spec.company,
      address: undefined,
      city: spec.city,
      country: spec.country,
      tax_id: undefined,
      phone: undefined,
      default_currency: spec.currency,
      notes: `Demo client — archetype: ${spec.archetype}`,
      payment_history: paymentHistory,
      created_at: new Date(nowMs - 200 * 86_400_000).toISOString(),
      updated_at: now.toISOString(),
    };
    clients.push(client);
  }

  // Persist everything
  for (const c of clients) await s.addClient(c);
  for (const inv of invoices) await s.addInvoice(inv);

  return {
    clients: clients.length,
    invoices: invoices.length,
    paid_invoices: paidCount,
    overdue_invoices: overdueCount,
    total_invoiced: Math.round(totalInvoiced * 100) / 100,
    total_collected: Math.round(totalCollected * 100) / 100,
    client_ids: clients.map((c) => c.id),
    sample_invoice_ids: invoices.slice(0, 5).map((i) => i.id),
    message: `Seeded ${clients.length} clients and ${invoices.length} invoices (${paidCount} paid, ${overdueCount} overdue). Try: invoice_list, cashflow_report, invoice_risk on any sample invoice.`,
  };
}
