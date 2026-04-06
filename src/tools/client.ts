import { v4 as uuidv4 } from 'uuid';
import type { Client, ClientCreateInput } from '../models/invoice.js';
import { storage } from '../services/storage.js';
import { DuplicateError } from '../utils/errors.js';

export async function createClient(input: ClientCreateInput): Promise<Client> {
  const existing = await storage.getClientByEmail(input.email);
  if (existing) throw new DuplicateError('email', input.email);

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
