import { v4 as uuidv4 } from 'uuid';
import type { Client, ClientCreateInput } from '../models/invoice.js';
import { storage as defaultStorage, Storage } from '../services/storage.js';

/**
 * Create a client or return the existing one if the email is already
 * known. This is an upsert-style operation so the tool is safe to call
 * repeatedly from agents — the description in index.ts promises this
 * contract and our callers rely on it (e.g. when ingesting bulk CSVs).
 */
export async function createClient(input: ClientCreateInput, store?: Storage): Promise<Client> {
  const storage = store ?? defaultStorage;
  const existing = await storage.getClientByEmail(input.email);
  if (existing) return existing;

  const now = new Date().toISOString();
  const client: Client = {
    id: uuidv4(),
    name: input.name,
    email: input.email,
    company: input.company,
    address: input.address,
    city: input.city,
    country: input.country,
    tax_id: input.tax_id,
    phone: input.phone,
    default_currency: input.default_currency,
    notes: input.notes,
    payment_history: {
      total_invoices: 0,
      paid_invoices: 0,
      avg_days_to_payment: null,
      late_payment_count: 0,
      total_revenue: 0,
    },
    created_at: now,
    updated_at: now,
  };

  return storage.addClient(client);
}
