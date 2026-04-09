import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Invoice, InvoiceListInput, Client } from '../models/invoice.js';

class AsyncLock {
  private queue: Promise<void> = Promise.resolve();
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.queue;
    let resolve: () => void;
    this.queue = new Promise<void>((r) => (resolve = r));
    await prev;
    try { return await fn(); }
    finally { resolve!(); }
  }
}

/** JSON file-based storage with AsyncLock for concurrent write protection. Supports optional custom data directory for test isolation. */
export class Storage {
  private readonly dataDir: string;
  private readonly invoicesPath: string;
  private readonly clientsPath: string;
  private readonly counterPath: string;
  private readonly lock = new AsyncLock();
  private initialized = false;

  constructor(dataDir?: string) {
    this.dataDir = dataDir ?? path.join(process.cwd(), 'data');
    this.invoicesPath = path.join(this.dataDir, 'invoices.json');
    this.clientsPath = path.join(this.dataDir, 'clients.json');
    this.counterPath = path.join(this.dataDir, 'counter.json');
  }

  private async init(): Promise<void> {
    if (this.initialized) return;
    await fs.mkdir(this.dataDir, { recursive: true });
    for (const [p, def] of [
      [this.invoicesPath, '[]'],
      [this.clientsPath, '[]'],
      [this.counterPath, '{"year":2026,"counter":0}'],
    ] as const) {
      try { await fs.access(p); }
      catch { await fs.writeFile(p, def, 'utf-8'); }
    }
    this.initialized = true;
  }

  // ── Generic read/write ────────────────────────────────────────

  private async read<T>(filePath: string): Promise<T> {
    await this.init();
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  }

  private async write<T>(filePath: string, data: T): Promise<void> {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  // ── Invoice number ────────────────────────────────────────────

  async nextInvoiceNumber(): Promise<string> {
    return this.lock.run(async () => {
      const counter = await this.read<{ year: number; counter: number }>(this.counterPath);
      const currentYear = new Date().getFullYear();
      if (currentYear !== counter.year) {
        counter.year = currentYear;
        counter.counter = 0;
      }
      counter.counter++;
      await this.write(this.counterPath, counter);
      return `INV-${counter.year}-${String(counter.counter).padStart(4, '0')}`;
    });
  }

  // ── Invoice CRUD ──────────────────────────────────────────────

  async getAllInvoices(): Promise<Invoice[]> {
    return this.read<Invoice[]>(this.invoicesPath);
  }

  async getInvoiceById(id: string): Promise<Invoice | null> {
    const invoices = await this.read<Invoice[]>(this.invoicesPath);
    return invoices.find((i) => i.id === id) ?? null;
  }

  async addInvoice(invoice: Invoice): Promise<Invoice> {
    return this.lock.run(async () => {
      const invoices = await this.read<Invoice[]>(this.invoicesPath);
      invoices.push(invoice);
      await this.write(this.invoicesPath, invoices);
      return invoice;
    });
  }

  async updateInvoice(id: string, updates: Partial<Invoice>): Promise<Invoice | null> {
    return this.lock.run(async () => {
      const invoices = await this.read<Invoice[]>(this.invoicesPath);
      const idx = invoices.findIndex((i) => i.id === id);
      if (idx === -1) return null;
      invoices[idx] = { ...invoices[idx], ...updates, updated_at: new Date().toISOString() };
      await this.write(this.invoicesPath, invoices);
      return invoices[idx];
    });
  }

  async searchInvoices(filters: InvoiceListInput): Promise<{ invoices: Invoice[]; total: number }> {
    let invoices = await this.read<Invoice[]>(this.invoicesPath);
    const now = new Date();

    if (filters.status) invoices = invoices.filter((i) => i.status === filters.status);
    if (filters.client_id) invoices = invoices.filter((i) => i.client_id === filters.client_id);
    if (filters.min_amount != null) invoices = invoices.filter((i) => i.total >= filters.min_amount!);
    if (filters.max_amount != null) invoices = invoices.filter((i) => i.total <= filters.max_amount!);
    if (filters.from_date) invoices = invoices.filter((i) => new Date(i.issue_date) >= new Date(filters.from_date!));
    if (filters.to_date) invoices = invoices.filter((i) => new Date(i.issue_date) <= new Date(filters.to_date!));
    if (filters.overdue_only) {
      invoices = invoices.filter((i) =>
        i.status !== 'paid' && i.status !== 'cancelled' && i.status !== 'refunded' &&
        new Date(i.due_date) < now
      );
    }

    invoices.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    const total = invoices.length;
    const offset = filters.offset ?? 0;
    const limit = filters.limit ?? 20;
    return { invoices: invoices.slice(offset, offset + limit), total };
  }

  // ── Client CRUD ───────────────────────────────────────────────

  async getAllClients(): Promise<Client[]> {
    return this.read<Client[]>(this.clientsPath);
  }

  async getClientById(id: string): Promise<Client | null> {
    const clients = await this.read<Client[]>(this.clientsPath);
    return clients.find((c) => c.id === id) ?? null;
  }

  async getClientByEmail(email: string): Promise<Client | null> {
    const clients = await this.read<Client[]>(this.clientsPath);
    return clients.find((c) => c.email.toLowerCase() === email.toLowerCase()) ?? null;
  }

  async addClient(client: Client): Promise<Client> {
    return this.lock.run(async () => {
      const clients = await this.read<Client[]>(this.clientsPath);
      clients.push(client);
      await this.write(this.clientsPath, clients);
      return client;
    });
  }

  async updateClient(id: string, updates: Partial<Client>): Promise<Client | null> {
    return this.lock.run(async () => {
      const clients = await this.read<Client[]>(this.clientsPath);
      const idx = clients.findIndex((c) => c.id === id);
      if (idx === -1) return null;
      clients[idx] = { ...clients[idx], ...updates, updated_at: new Date().toISOString() };
      await this.write(this.clientsPath, clients);
      return clients[idx];
    });
  }
}

/** Default global storage instance using process.cwd()/data directory. */
export const storage = new Storage();
