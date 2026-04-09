import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { Storage } from '../../src/services/storage.js';
import { assessInvoiceRisk } from '../../src/services/risk-model.js';
import type { Invoice, Client } from '../../src/models/invoice.js';

const TEST_DIR = path.join(process.cwd(), 'data-test-risk');

function makeClient(overrides: Partial<Client> = {}): Client {
  const now = new Date().toISOString();
  return {
    id: uuidv4(),
    name: 'Test Client',
    email: `test-${Date.now()}-${Math.random()}@example.com`,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function makeInvoice(clientId: string, overrides: Partial<Invoice> = {}): Invoice {
  const now = new Date().toISOString();
  const due = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  return {
    id: uuidv4(),
    invoice_number: `INV-2026-${Math.floor(Math.random() * 9999).toString().padStart(4, '0')}`,
    client_id: clientId,
    client_name: 'Test Client',
    client_email: 'test@example.com',
    status: 'sent',
    currency: 'USD',
    line_items: [{ description: 'Service', quantity: 1, unit_price: 100, tax_rate: 0, discount_percent: 0, amount: 100 }],
    subtotal: 100,
    tax_total: 0,
    discount_total: 0,
    total: 100,
    amount_paid: 0,
    amount_due: 100,
    issue_date: now,
    due_date: due,
    paid_date: null,
    payment_method: null,
    risk_score: null,
    risk_action: null,
    reminder_count: 0,
    last_reminder_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

describe('Risk Model', () => {
  let store: Storage;

  beforeEach(() => { store = new Storage(TEST_DIR); });
  afterEach(async () => { try { await fs.rm(TEST_DIR, { recursive: true, force: true }); } catch {} });

  it('should return low risk for a small invoice with excellent client history', async () => {
    const client = makeClient({
      payment_history: {
        total_invoices: 20,
        paid_invoices: 20,
        avg_days_to_payment: 5,
        late_payment_count: 0,
        total_revenue: 10000,
      },
    });
    await store.addClient(client);

    const invoice = makeInvoice(client.id, {
      total: 200,
      amount_due: 200,
      due_date: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString(),
      reminder_count: 0,
    });
    await store.addInvoice(invoice);

    const result = await assessInvoiceRisk(invoice.id, store);
    expect(result.risk_score).toBeLessThanOrEqual(30);
    expect(result.risk_level).toBe('low');
  });

  it('should return higher risk for a high-value invoice with a new client', async () => {
    const client = makeClient();
    await store.addClient(client);

    const invoice = makeInvoice(client.id, {
      total: 15000,
      amount_due: 15000,
      due_date: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString(),
    });
    await store.addInvoice(invoice);

    const result = await assessInvoiceRisk(invoice.id, store);
    expect(result.risk_score).toBeGreaterThan(30);
  });

  it('should assign high risk for a significantly overdue invoice', async () => {
    const client = makeClient({
      payment_history: {
        total_invoices: 5,
        paid_invoices: 3,
        avg_days_to_payment: 25,
        late_payment_count: 2,
        total_revenue: 5000,
      },
    });
    await store.addClient(client);

    const invoice = makeInvoice(client.id, {
      total: 3000,
      amount_due: 3000,
      due_date: new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString(),
      reminder_count: 3,
    });
    await store.addInvoice(invoice);

    const result = await assessInvoiceRisk(invoice.id, store);
    expect(result.risk_score).toBeGreaterThan(60);
    expect(result.risk_level).toBe('high');
  });

  it('should increase risk when many reminders have been sent', async () => {
    const client = makeClient({
      payment_history: {
        total_invoices: 10,
        paid_invoices: 10,
        avg_days_to_payment: 10,
        late_payment_count: 0,
        total_revenue: 8000,
      },
    });
    await store.addClient(client);

    const invoiceNoReminders = makeInvoice(client.id, {
      total: 500,
      amount_due: 500,
      reminder_count: 0,
    });
    const invoiceManyReminders = makeInvoice(client.id, {
      total: 500,
      amount_due: 500,
      reminder_count: 5,
    });
    await store.addInvoice(invoiceNoReminders);
    await store.addInvoice(invoiceManyReminders);

    const resultLow = await assessInvoiceRisk(invoiceNoReminders.id, store);
    const resultHigh = await assessInvoiceRisk(invoiceManyReminders.id, store);

    expect(resultHigh.risk_score).toBeGreaterThan(resultLow.risk_score);
  });

  it('should reflect poor client history in a higher score', async () => {
    const goodClient = makeClient({
      payment_history: {
        total_invoices: 20,
        paid_invoices: 20,
        avg_days_to_payment: 7,
        late_payment_count: 0,
        total_revenue: 20000,
      },
    });
    const badClient = makeClient({
      payment_history: {
        total_invoices: 10,
        paid_invoices: 3,
        avg_days_to_payment: 60,
        late_payment_count: 7,
        total_revenue: 3000,
      },
    });
    await store.addClient(goodClient);
    await store.addClient(badClient);

    const invoiceGood = makeInvoice(goodClient.id, { total: 1000, amount_due: 1000 });
    const invoiceBad = makeInvoice(badClient.id, { total: 1000, amount_due: 1000 });
    await store.addInvoice(invoiceGood);
    await store.addInvoice(invoiceBad);

    const resultGood = await assessInvoiceRisk(invoiceGood.id, store);
    const resultBad = await assessInvoiceRisk(invoiceBad.id, store);

    expect(resultBad.risk_score).toBeGreaterThan(resultGood.risk_score);
  });

  it('should classify low risk correctly', async () => {
    const client = makeClient({
      payment_history: {
        total_invoices: 50,
        paid_invoices: 50,
        avg_days_to_payment: 3,
        late_payment_count: 0,
        total_revenue: 100000,
      },
    });
    await store.addClient(client);

    const safeInvoice = makeInvoice(client.id, {
      total: 100,
      amount_due: 100,
      due_date: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
      reminder_count: 0,
    });
    await store.addInvoice(safeInvoice);
    const safeResult = await assessInvoiceRisk(safeInvoice.id, store);
    expect(safeResult.risk_level).toBe('low');
    expect(safeResult.risk_score).toBeLessThanOrEqual(30);
  });

  it('should return complete risk assessment structure', async () => {
    const client = makeClient();
    await store.addClient(client);
    const invoice = makeInvoice(client.id);
    await store.addInvoice(invoice);

    const result = await assessInvoiceRisk(invoice.id, store);

    expect(result).toHaveProperty('invoice_id', invoice.id);
    expect(result).toHaveProperty('risk_score');
    expect(result).toHaveProperty('risk_level');
    expect(result).toHaveProperty('factors');
    expect(result).toHaveProperty('recommended_action');
    expect(result).toHaveProperty('next_reminder_date');
    expect(result.risk_score).toBeGreaterThanOrEqual(0);
    expect(result.risk_score).toBeLessThanOrEqual(100);
    expect(['low', 'medium', 'high']).toContain(result.risk_level);
    expect(result.factors).toHaveLength(4);
    expect(result.factors.map((f) => f.factor)).toEqual(
      expect.arrayContaining(['invoice_amount', 'client_history', 'due_date', 'reminders'])
    );
  });
});
