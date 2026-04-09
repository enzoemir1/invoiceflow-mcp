import { describe, it, expect } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { generateInvoicePDF } from '../../src/services/pdf-generator.js';
import type { Invoice, Client } from '../../src/models/invoice.js';

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  const now = new Date().toISOString();
  return {
    id: uuidv4(), invoice_number: 'INV-2026-0001',
    client_id: uuidv4(), client_name: 'Acme Corp', client_email: 'billing@acme.com',
    status: 'sent', currency: 'USD',
    line_items: [
      { description: 'Web Development', quantity: 40, unit_price: 150, tax_rate: 0, discount_percent: 0, amount: 6000 },
      { description: 'Design', quantity: 10, unit_price: 120, tax_rate: 10, discount_percent: 5, amount: 1140 },
    ],
    subtotal: 7140, tax_total: 120, discount_total: 60, total: 7200,
    amount_paid: 0, amount_due: 7200,
    issue_date: now, due_date: new Date(Date.now() + 30 * 86400000).toISOString(),
    paid_date: null, payment_method: null,
    risk_score: null, risk_action: null,
    reminder_count: 0, last_reminder_at: null,
    created_at: now, updated_at: now,
    ...overrides,
  };
}

function makeClient(): Client {
  const now = new Date().toISOString();
  return {
    id: uuidv4(), name: 'Acme Corp', email: 'billing@acme.com',
    created_at: now, updated_at: now,
  };
}

describe('PDF Generator', () => {
  it('should generate a valid PDF buffer', async () => {
    const pdf = await generateInvoicePDF(makeInvoice());
    expect(pdf).toBeInstanceOf(Uint8Array);
    expect(pdf.length).toBeGreaterThan(1000);
    // PDF magic bytes: %PDF
    expect(pdf[0]).toBe(37); // %
    expect(pdf[1]).toBe(80); // P
    expect(pdf[2]).toBe(68); // D
    expect(pdf[3]).toBe(70); // F
  });

  it('should handle invoice with client info', async () => {
    const pdf = await generateInvoicePDF(makeInvoice(), makeClient());
    expect(pdf).toBeInstanceOf(Uint8Array);
    expect(pdf.length).toBeGreaterThan(1000);
  });

  it('should handle invoice with multiple line items', async () => {
    const invoice = makeInvoice({
      line_items: Array.from({ length: 10 }, (_, i) => ({
        description: `Service ${i + 1}`, quantity: i + 1, unit_price: 100,
        tax_rate: 0, discount_percent: 0, amount: (i + 1) * 100,
      })),
    });
    const pdf = await generateInvoicePDF(invoice);
    expect(pdf.length).toBeGreaterThan(2000);
  });

  it('should handle paid invoice', async () => {
    const pdf = await generateInvoicePDF(makeInvoice({ status: 'paid', amount_paid: 7200, amount_due: 0 }));
    expect(pdf).toBeInstanceOf(Uint8Array);
  });

  it('should handle zero-amount invoice', async () => {
    const pdf = await generateInvoicePDF(makeInvoice({
      line_items: [{ description: 'Free consultation', quantity: 1, unit_price: 0, tax_rate: 0, discount_percent: 0, amount: 0 }],
      subtotal: 0, tax_total: 0, discount_total: 0, total: 0, amount_due: 0,
    }));
    expect(pdf).toBeInstanceOf(Uint8Array);
  });
});
