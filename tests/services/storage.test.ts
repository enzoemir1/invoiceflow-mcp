import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Storage } from '../../src/services/storage.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import type { Invoice, Client } from '../../src/models/invoice.js';

const TEST_DIR = path.join(process.cwd(), 'data-test-inv');

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
    status: 'draft',
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

describe('InvoiceFlow Storage', () => {
  let store: Storage;

  beforeEach(() => { store = new Storage(TEST_DIR); });
  afterEach(async () => { try { await fs.rm(TEST_DIR, { recursive: true, force: true }); } catch {} });

  it('should add and retrieve a client', async () => {
    const client = makeClient({ name: 'Acme Corp' });
    await store.addClient(client);
    const found = await store.getClientById(client.id);
    expect(found).not.toBeNull();
    expect(found!.name).toBe('Acme Corp');
  });

  it('should find client by email case-insensitively', async () => {
    const client = makeClient({ email: 'Jane@Corp.com' });
    await store.addClient(client);
    const found = await store.getClientByEmail('jane@corp.com');
    expect(found).not.toBeNull();
  });

  it('should add and retrieve an invoice', async () => {
    const client = makeClient();
    await store.addClient(client);
    const invoice = makeInvoice(client.id, { total: 500, amount_due: 500 });
    await store.addInvoice(invoice);
    const found = await store.getInvoiceById(invoice.id);
    expect(found).not.toBeNull();
    expect(found!.total).toBe(500);
  });

  it('should update an invoice', async () => {
    const client = makeClient();
    await store.addClient(client);
    const invoice = makeInvoice(client.id);
    await store.addInvoice(invoice);
    const updated = await store.updateInvoice(invoice.id, { status: 'paid', amount_paid: 100, amount_due: 0 });
    expect(updated!.status).toBe('paid');
    expect(updated!.amount_due).toBe(0);
  });

  it('should filter invoices by status', async () => {
    const client = makeClient();
    await store.addClient(client);
    await store.addInvoice(makeInvoice(client.id, { status: 'paid' }));
    await store.addInvoice(makeInvoice(client.id, { status: 'draft' }));
    await store.addInvoice(makeInvoice(client.id, { status: 'paid' }));
    const result = await store.searchInvoices({ status: 'paid', overdue_only: false });
    expect(result.total).toBe(2);
  });

  it('should filter overdue invoices', async () => {
    const client = makeClient();
    await store.addClient(client);
    const pastDue = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    await store.addInvoice(makeInvoice(client.id, { status: 'sent', due_date: pastDue }));
    await store.addInvoice(makeInvoice(client.id, { status: 'draft' }));
    const result = await store.searchInvoices({ overdue_only: true });
    expect(result.total).toBe(1);
  });

  it('should generate sequential invoice numbers', async () => {
    const num1 = await store.nextInvoiceNumber();
    const num2 = await store.nextInvoiceNumber();
    expect(num1).toMatch(/^INV-\d{4}-0001$/);
    expect(num2).toMatch(/^INV-\d{4}-0002$/);
  });
});
