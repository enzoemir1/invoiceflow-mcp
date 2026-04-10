import { v4 as uuidv4 } from 'uuid';
import type { Invoice, InvoiceCreateInput, LineItem } from '../models/invoice.js';
import { storage as defaultStorage, Storage } from '../services/storage.js';
import { NotFoundError, validateUUID } from '../utils/errors.js';

function computeLineItem(input: {
  description: string;
  quantity: number;
  unit_price: number;
  tax_rate?: number;
  discount_percent?: number;
}): LineItem {
  const taxRate = input.tax_rate ?? 0;
  const discountPct = input.discount_percent ?? 0;
  const baseAmount = input.quantity * input.unit_price;
  const discountAmount = baseAmount * (discountPct / 100);
  const taxableAmount = baseAmount - discountAmount;
  const taxAmount = taxableAmount * (taxRate / 100);
  const amount = Math.round((taxableAmount + taxAmount) * 100) / 100;

  return {
    description: input.description,
    quantity: input.quantity,
    unit_price: input.unit_price,
    tax_rate: taxRate,
    discount_percent: discountPct,
    amount,
  };
}

export async function createInvoice(input: InvoiceCreateInput, store?: Storage): Promise<Invoice> {
  const storage = store ?? defaultStorage;
  validateUUID(input.client_id, 'client');

  const client = await storage.getClientById(input.client_id);
  if (!client) throw new NotFoundError('Client', input.client_id);

  const lineItems = input.line_items.map(computeLineItem);

  const subtotal = lineItems.reduce((sum, item) => {
    return sum + item.quantity * item.unit_price;
  }, 0);

  const discountTotal = lineItems.reduce((sum, item) => {
    return sum + item.quantity * item.unit_price * (item.discount_percent / 100);
  }, 0);

  const taxTotal = lineItems.reduce((sum, item) => {
    const taxable = item.quantity * item.unit_price * (1 - item.discount_percent / 100);
    return sum + taxable * (item.tax_rate / 100);
  }, 0);

  const total = Math.round((subtotal - discountTotal + taxTotal) * 100) / 100;

  const now = new Date();
  // issue_date and due_date come pre-normalised to ISO datetime by
  // FlexibleDateSchema; if the caller passes only an issue_date we
  // default due_date to issue_date + 30 days so the two stay coherent.
  const issueDate = input.issue_date ?? now.toISOString();
  const dueDate =
    input.due_date ??
    new Date(new Date(issueDate).getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const invoiceNumber = await storage.nextInvoiceNumber();

  const invoice: Invoice = {
    id: uuidv4(),
    invoice_number: invoiceNumber,
    client_id: client.id,
    client_name: client.name,
    client_email: client.email,
    status: 'draft',
    currency: input.currency ?? client.default_currency ?? 'USD',
    line_items: lineItems,
    subtotal: Math.round(subtotal * 100) / 100,
    tax_total: Math.round(taxTotal * 100) / 100,
    discount_total: Math.round(discountTotal * 100) / 100,
    total,
    amount_paid: 0,
    amount_due: total,
    issue_date: issueDate,
    due_date: dueDate,
    paid_date: null,
    notes: input.notes,
    terms: input.terms,
    payment_method: null,
    risk_score: null,
    risk_action: null,
    reminder_count: 0,
    last_reminder_at: null,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };

  const saved = await storage.addInvoice(invoice);

  // Update client's total_invoices count
  const currentHistory = client.payment_history ?? {
    total_invoices: 0, paid_invoices: 0, avg_days_to_payment: null, late_payment_count: 0, total_revenue: 0,
  };
  await storage.updateClient(client.id, {
    payment_history: {
      ...currentHistory,
      total_invoices: currentHistory.total_invoices + 1,
    },
  });

  return saved;
}
