import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { v4 as uuidv4 } from 'uuid';
import { storage } from '../../src/services/storage.js';
import { generateCashflowReport } from '../../src/services/cashflow.js';
import type { Invoice, Client } from '../../src/models/invoice.js';

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
  const due = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString();
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

describe('Cashflow Report', () => {
  beforeEach(() => {
    (storage as any).initialized = false;
  });

  afterEach(async () => {
    try { await fs.rm('data', { recursive: true, force: true }); } catch {}
  });

  it('should return zeroed report when no invoices exist', async () => {
    const report = await generateCashflowReport();
    expect(report.total_invoiced).toBe(0);
    expect(report.total_collected).toBe(0);
    expect(report.total_outstanding).toBe(0);
    expect(report.total_overdue).toBe(0);
    expect(report.collection_rate).toBe(0);
    expect(report.avg_days_to_payment).toBeNull();
    expect(report.projected_income_30d).toBe(0);
  });

  it('should calculate correct totals for paid and unpaid invoices', async () => {
    const client = makeClient({ name: 'Acme Corp' });
    await storage.addClient(client);

    const issueDate = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    const paidDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();

    await storage.addInvoice(makeInvoice(client.id, {
      client_name: 'Acme Corp',
      status: 'paid',
      total: 500,
      amount_paid: 500,
      amount_due: 0,
      issue_date: issueDate,
      paid_date: paidDate,
    }));
    await storage.addInvoice(makeInvoice(client.id, {
      client_name: 'Acme Corp',
      status: 'sent',
      total: 300,
      amount_paid: 0,
      amount_due: 300,
    }));

    const report = await generateCashflowReport();
    expect(report.total_invoiced).toBe(800);
    expect(report.total_collected).toBe(500);
    expect(report.total_outstanding).toBe(300);
  });

  it('should detect overdue invoices', async () => {
    const client = makeClient({ name: 'Late Co' });
    await storage.addClient(client);

    await storage.addInvoice(makeInvoice(client.id, {
      client_name: 'Late Co',
      status: 'sent',
      total: 1000,
      amount_due: 1000,
      due_date: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
    }));

    const report = await generateCashflowReport();
    expect(report.total_overdue).toBe(1000);
    expect(report.total_outstanding).toBe(1000);
  });

  it('should calculate collection rate correctly', async () => {
    const client = makeClient();
    await storage.addClient(client);

    const issueDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    await storage.addInvoice(makeInvoice(client.id, {
      status: 'paid',
      total: 400,
      amount_paid: 400,
      amount_due: 0,
      issue_date: issueDate,
      paid_date: new Date().toISOString(),
    }));
    await storage.addInvoice(makeInvoice(client.id, {
      status: 'sent',
      total: 600,
      amount_due: 600,
    }));

    const report = await generateCashflowReport();
    expect(report.collection_rate).toBe(40);
  });

  it('should project income for invoices due within 30 days', async () => {
    const client = makeClient();
    await storage.addClient(client);

    await storage.addInvoice(makeInvoice(client.id, {
      status: 'sent',
      total: 250,
      amount_due: 250,
      due_date: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString(),
    }));
    await storage.addInvoice(makeInvoice(client.id, {
      status: 'sent',
      total: 750,
      amount_due: 750,
      due_date: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
    }));

    const report = await generateCashflowReport();
    expect(report.projected_income_30d).toBe(250);
  });

  it('should break down by client correctly', async () => {
    const clientA = makeClient({ name: 'Alpha Inc' });
    const clientB = makeClient({ name: 'Beta LLC' });
    await storage.addClient(clientA);
    await storage.addClient(clientB);

    await storage.addInvoice(makeInvoice(clientA.id, {
      client_name: 'Alpha Inc',
      status: 'sent',
      total: 500,
      amount_due: 500,
      due_date: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
    }));
    await storage.addInvoice(makeInvoice(clientB.id, {
      client_name: 'Beta LLC',
      status: 'sent',
      total: 200,
      amount_due: 200,
    }));

    const report = await generateCashflowReport();
    expect(report.by_client).toHaveLength(2);
    expect(report.by_client[0].client_name).toBe('Alpha Inc');
    expect(report.by_client[0].outstanding).toBe(500);
    expect(report.by_client[0].overdue).toBe(500);
    expect(report.by_client[1].client_name).toBe('Beta LLC');
    expect(report.by_client[1].outstanding).toBe(200);
    expect(report.by_client[1].overdue).toBe(0);
  });
});
