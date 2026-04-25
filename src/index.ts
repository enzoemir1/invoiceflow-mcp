import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod/v4';
import {
  InvoiceCreateInputSchema,
  InvoiceListInputSchema,
  ClientCreateInputSchema,
  PaymentMethodSchema,
} from './models/invoice.js';
import { createInvoice } from './tools/create.js';
import { createClient } from './tools/client.js';
import { generateInvoicePDF } from './services/pdf-generator.js';
import { assessInvoiceRisk } from './services/risk-model.js';
import { generateCashflowReport } from './services/cashflow.js';
import { seedDemoData } from './services/demo-seed.js';
import { storage } from './services/storage.js';
import { handleToolError, validateUUID, NotFoundError } from './utils/errors.js';

const SERVER_VERSION = '1.4.1';

const server = new McpServer({
  name: 'invoiceflow-mcp',
  version: SERVER_VERSION,
});

// ━━━ TOOL: invoice_demo_seed ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
server.registerTool(
  'invoice_demo_seed',
  {
    title: 'Seed Demo Data',
    description: 'Populate the store with a realistic demo dataset: 8 clients across 5 archetypes (on-time, late-payer, high-value, new, chronic-late) and 25-45 invoices spanning the last 6 months (paid, sent, and overdue). Every invoice has line items, tax, payment history, and reminder metadata. Use this to evaluate InvoiceFlow via MCP Inspector without real Stripe, SendGrid, or PayPal credentials — invoice_list, cashflow_report, invoice_risk, and payment_reconcile all return meaningful results against the returned ids. Safe to call multiple times; each call appends a fresh batch with unique UUIDs. Returns counts plus sample_invoice_ids you can feed straight into invoice_risk or invoice_mark_paid.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async () => {
    try {
      const result = await seedDemoData();
      const lines = [
        `Seeded demo data:`,
        `  Clients: ${result.clients}`,
        `  Invoices: ${result.invoices} (${result.paid_invoices} paid, ${result.overdue_invoices} overdue)`,
        `  Total invoiced: ${result.total_invoiced.toFixed(2)}`,
        `  Total collected: ${result.total_collected.toFixed(2)}`,
        ``,
        `Sample invoice ids (use with invoice_risk, invoice_mark_paid):`,
        ...result.sample_invoice_ids.map((id) => `  - ${id}`),
      ];
      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    } catch (error) {
      return handleToolError(error);
    }
  }
);

// ━━━ TOOL: client_manage ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
server.registerTool(
  'client_manage',
  {
    title: 'Manage Client',
    description: 'Create or upsert a client record used by invoice_create. Accepts name, email, company, address, city, country, tax_id, phone, default_currency ("USD"|"EUR"|"GBP"|...) and notes. Returns the stored client object including the generated id (UUID), an empty payment_history (populated as invoices are paid), and timestamps. Safe to call repeatedly: if a client with the same email already exists, the existing record is returned unchanged.',
    inputSchema: ClientCreateInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async (input) => {
    try {
      const client = await createClient(input);
      return {
        content: [{ type: 'text' as const, text: `Client created: ${client.name} (${client.email}, id: ${client.id})` }],
        structuredContent: client,
      };
    } catch (error) {
      return handleToolError(error);
    }
  }
);

// ━━━ TOOL: invoice_create ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
server.registerTool(
  'invoice_create',
  {
    title: 'Create Invoice',
    description: 'Create a new invoice for an existing client. Required: client_id (UUID) and line_items (non-empty array of {description, quantity, unit_price, tax_rate?, discount_percent?} — tax and discount are per-line). Optional: currency (defaults to the client\'s default_currency then USD), issue_date (YYYY-MM-DD or full ISO, defaults to today), due_date (same format, defaults to issue_date + 30 days), notes, and terms. Auto-calculates subtotal, discount_total, tax_total, and total; generates a sequential invoice_number in format INV-YYYY-NNNN; sets status="draft". Returns the full invoice object ready for invoice_send.',
    inputSchema: InvoiceCreateInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async (input) => {
    try {
      const invoice = await createInvoice(input);
      return {
        content: [{
          type: 'text' as const,
          text: `Invoice created: ${invoice.invoice_number} for ${invoice.client_name}\nTotal: ${invoice.currency} ${invoice.total.toFixed(2)}\nDue: ${new Date(invoice.due_date).toLocaleDateString()}`,
        }],
        structuredContent: invoice,
      };
    } catch (error) {
      return handleToolError(error);
    }
  }
);

// ━━━ TOOL: invoice_list ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
server.registerTool(
  'invoice_list',
  {
    title: 'List Invoices',
    description: 'Search and filter invoices. Optional filters: status ("draft"|"sent"|"viewed"|"paid"|"overdue"|"cancelled"|"refunded"), client_id, min_amount, max_amount, date_from/date_to (ISO dates), overdue_only (boolean). Pagination via limit (default 50, max 200) and offset. Returns {total, invoices[]} where each invoice includes full line_items and payment state. Use this to build dashboards or drive invoice_remind/invoice_risk workflows.',
    inputSchema: InvoiceListInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async (input) => {
    try {
      const result = await storage.searchInvoices(input);
      return {
        content: [{ type: 'text' as const, text: `Found ${result.total} invoices (showing ${result.invoices.length}).` }],
        structuredContent: result,
      };
    } catch (error) {
      return handleToolError(error);
    }
  }
);

// ━━━ TOOL: invoice_send ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
server.registerTool(
  'invoice_send',
  {
    title: 'Send Invoice',
    description: 'Generate the invoice PDF and deliver it to the client. Always generates the PDF and marks the invoice status="sent". Email delivery via SendGrid is attempted automatically when the SENDGRID_API_KEY environment variable is set; without it the PDF is still generated and the status still advances so the caller can handle delivery out-of-band. Returns a confirmation message with the PDF size.',
    inputSchema: z.object({
      invoice_id: z.string().uuid().describe('UUID of an existing invoice (from invoice_create or invoice_list)'),
      message: z.string().optional().describe('Custom body text for the email (default is a summary of amount and due date)'),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ invoice_id, message }) => {
    try {
      validateUUID(invoice_id, 'invoice');
      const invoice = await storage.getInvoiceById(invoice_id);
      if (!invoice) throw new NotFoundError('Invoice', invoice_id);

      const client = await storage.getClientById(invoice.client_id);
      const pdfBytes = await generateInvoicePDF(invoice, client ?? undefined);

      // Update status
      await storage.updateInvoice(invoice_id, { status: 'sent' });

      // Email sending (if SendGrid key available)
      const sendgridKey = process.env.SENDGRID_API_KEY;
      if (sendgridKey) {
        const pdfBase64 = Buffer.from(pdfBytes).toString('base64');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        try {
          await fetch('https://api.sendgrid.com/v3/mail/send', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${sendgridKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              personalizations: [{ to: [{ email: invoice.client_email }] }],
              from: { email: process.env.SENDGRID_FROM_EMAIL ?? 'noreply@invoiceflow.dev', name: process.env.SENDGRID_FROM_NAME ?? 'InvoiceFlow' },
              subject: `Invoice ${invoice.invoice_number} from ${invoice.client_name}`,
              content: [{
                type: 'text/plain',
                value: message ?? `Please find attached invoice ${invoice.invoice_number} for ${invoice.currency} ${invoice.total.toFixed(2)}. Due by ${new Date(invoice.due_date).toLocaleDateString()}.`,
              }],
              attachments: [{
                content: pdfBase64,
                filename: `${invoice.invoice_number}.pdf`,
                type: 'application/pdf',
                disposition: 'attachment',
              }],
            }),
            signal: controller.signal,
          }).finally(() => clearTimeout(timer));
        } catch (err) {
          console.error('[SendGrid error]', err instanceof Error ? err.message : err);
        }
      }

      return {
        content: [{
          type: 'text' as const,
          text: `Invoice ${invoice.invoice_number} ${sendgridKey ? 'sent to' : 'prepared for'} ${invoice.client_email}. Status updated to "sent". PDF generated (${pdfBytes.length} bytes).`,
        }],
      };
    } catch (error) {
      return handleToolError(error);
    }
  }
);

// ━━━ TOOL: invoice_mark_paid ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
server.registerTool(
  'invoice_mark_paid',
  {
    title: 'Mark Invoice Paid',
    description: 'Record a full or partial payment against an invoice. Updates amount_paid and amount_due; sets status="paid" only when the outstanding balance reaches zero. As a side effect, a fully-paid invoice updates the client payment_history (total_revenue, paid_invoices, avg_days_to_payment, late_payment_count) which invoice_risk then uses for future predictions. Returns a confirmation with the paid amount and remaining balance.',
    inputSchema: z.object({
      invoice_id: z.string().uuid().describe('UUID of the invoice to update'),
      amount: z.number().positive().optional().describe('Amount paid in invoice currency; omit to settle the full remaining balance'),
      payment_method: PaymentMethodSchema.optional().describe('How the payment was received (stripe|paypal|bank_transfer|credit_card|cash|check|crypto|other)'),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ invoice_id, amount, payment_method }) => {
    try {
      validateUUID(invoice_id, 'invoice');
      const invoice = await storage.getInvoiceById(invoice_id);
      if (!invoice) throw new NotFoundError('Invoice', invoice_id);

      const paidAmount = amount ?? invoice.amount_due;
      const newAmountPaid = invoice.amount_paid + paidAmount;
      const newAmountDue = Math.max(0, invoice.total - newAmountPaid);
      const isFullyPaid = newAmountDue <= 0;

      await storage.updateInvoice(invoice_id, {
        amount_paid: Math.round(newAmountPaid * 100) / 100,
        amount_due: Math.round(newAmountDue * 100) / 100,
        status: isFullyPaid ? 'paid' : invoice.status,
        paid_date: isFullyPaid ? new Date().toISOString() : invoice.paid_date,
        payment_method: payment_method ?? invoice.payment_method,
      });

      // Update client payment history
      if (isFullyPaid) {
        const client = await storage.getClientById(invoice.client_id);
        if (client) {
          const history = client.payment_history ?? {
            total_invoices: 0, paid_invoices: 0, avg_days_to_payment: null, late_payment_count: 0, total_revenue: 0,
          };
          const daysToPayment = (Date.now() - new Date(invoice.issue_date).getTime()) / (1000 * 60 * 60 * 24);
          const isLate = new Date() > new Date(invoice.due_date);

          const newPaidCount = history.paid_invoices + 1;
          const newAvgDays = history.avg_days_to_payment != null
            ? (history.avg_days_to_payment * history.paid_invoices + daysToPayment) / newPaidCount
            : daysToPayment;

          await storage.updateClient(invoice.client_id, {
            payment_history: {
              total_invoices: history.total_invoices,
              paid_invoices: newPaidCount,
              avg_days_to_payment: Math.round(newAvgDays * 10) / 10,
              late_payment_count: history.late_payment_count + (isLate ? 1 : 0),
              total_revenue: history.total_revenue + invoice.total,
            },
          });
        }
      }

      return {
        content: [{
          type: 'text' as const,
          text: `Invoice ${invoice.invoice_number}: paid ${invoice.currency} ${paidAmount.toFixed(2)}. ${isFullyPaid ? 'Fully paid.' : `Remaining: ${invoice.currency} ${newAmountDue.toFixed(2)}`}`,
        }],
      };
    } catch (error) {
      return handleToolError(error);
    }
  }
);

// ━━━ TOOL: invoice_remind ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
server.registerTool(
  'invoice_remind',
  {
    title: 'Record Payment Reminder',
    description: 'Record that a payment reminder has been issued for an unpaid invoice. Increments reminder_count, sets last_reminder_at, and advances draft → sent. Returns the generated reminder message (custom or default) so the caller can relay it through their preferred channel — this tool itself does not send email; use invoice_send for actual delivery. Safely refuses to remind on already-paid invoices.',
    inputSchema: z.object({
      invoice_id: z.string().uuid().describe('UUID of the invoice to remind'),
      message: z.string().optional().describe('Custom reminder body; default is a friendly message referencing invoice number, amount, and due date'),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ invoice_id, message }) => {
    try {
      validateUUID(invoice_id, 'invoice');
      const invoice = await storage.getInvoiceById(invoice_id);
      if (!invoice) throw new NotFoundError('Invoice', invoice_id);

      if (invoice.status === 'paid') {
        return { content: [{ type: 'text' as const, text: 'This invoice is already paid.' }] };
      }

      await storage.updateInvoice(invoice_id, {
        reminder_count: invoice.reminder_count + 1,
        last_reminder_at: new Date().toISOString(),
        status: invoice.status === 'draft' ? 'sent' : invoice.status,
      });

      const defaultMsg = `Friendly reminder: Invoice ${invoice.invoice_number} for ${invoice.currency} ${invoice.amount_due.toFixed(2)} is ${new Date(invoice.due_date) < new Date() ? 'overdue' : 'due'} on ${new Date(invoice.due_date).toLocaleDateString()}.`;

      return {
        content: [{
          type: 'text' as const,
          text: `Reminder #${invoice.reminder_count + 1} sent for ${invoice.invoice_number}. ${message ?? defaultMsg}`,
        }],
      };
    } catch (error) {
      return handleToolError(error);
    }
  }
);

// ━━━ TOOL: invoice_risk ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
server.registerTool(
  'invoice_risk',
  {
    title: 'Assess Payment Risk',
    description: 'Predict late-payment risk for a specific invoice on a 0-100 scale. The model combines invoice amount (relative to client average), client payment history (avg_days_to_payment, late_payment_count), days remaining until due date, and prior reminder_count. Returns {risk_score (0-100), risk_level ("low"|"medium"|"high"|"critical"), factors (array of {factor, impact, detail}), recommended_action (string), next_reminder_date (ISO string or null)}. Use for prioritizing collection effort on high-value invoices.',
    inputSchema: z.object({
      invoice_id: z.string().uuid().describe('UUID of the invoice to assess'),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ invoice_id }) => {
    try {
      const assessment = await assessInvoiceRisk(invoice_id);
      const lines = [
        `Risk Assessment: ${assessment.risk_score}/100 (${assessment.risk_level.toUpperCase()})`,
        '',
        'Factors:',
        ...assessment.factors.map((f) => `  ${f.factor}: ${f.impact}/100 — ${f.detail}`),
        '',
        `Action: ${assessment.recommended_action}`,
        assessment.next_reminder_date ? `Next reminder: ${new Date(assessment.next_reminder_date).toLocaleDateString()}` : '',
      ];
      return {
        content: [{ type: 'text' as const, text: lines.filter(Boolean).join('\n') }],
        structuredContent: assessment as unknown as Record<string, unknown>,
      };
    } catch (error) {
      return handleToolError(error);
    }
  }
);

// ━━━ TOOL: cashflow_report ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
server.registerTool(
  'cashflow_report',
  {
    title: 'Cash Flow Report',
    description: 'Generate a portfolio-wide cash flow summary across all invoices. Returns {period, total_invoiced, total_collected, total_outstanding, total_overdue, collection_rate (percent), avg_days_to_payment (or null if no paid history), projected_income_30d (forecast based on due dates and historical pay rate), breakdown_by_status, breakdown_by_client}. Takes no input — always reports on the current full dataset. Ideal for dashboards and monthly close.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () => {
    try {
      const report = await generateCashflowReport();
      const lines = [
        `Cash Flow Report — ${report.period}`,
        '',
        `Total Invoiced: $${report.total_invoiced.toFixed(2)}`,
        `Collected: $${report.total_collected.toFixed(2)}`,
        `Outstanding: $${report.total_outstanding.toFixed(2)}`,
        `Overdue: $${report.total_overdue.toFixed(2)}`,
        `Collection Rate: ${report.collection_rate}%`,
        `Avg Days to Payment: ${report.avg_days_to_payment ?? 'N/A'}`,
        `Projected Income (30d): $${report.projected_income_30d.toFixed(2)}`,
      ];
      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
        structuredContent: report as unknown as Record<string, unknown>,
      };
    } catch (error) {
      return handleToolError(error);
    }
  }
);

// ━━━ TOOL: payment_reconcile ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
server.registerTool(
  'payment_reconcile',
  {
    title: 'Reconcile Payment',
    description: 'Match an incoming external payment (e.g. Stripe webhook, PayPal IPN, bank transfer) to an open invoice. Matching rule: the payer_email must equal the invoice client_email (case-insensitive) AND the payment_amount must equal the invoice amount_due within one cent. On match the invoice is marked paid, amount_paid/amount_due are updated, and client payment_history is recomputed exactly like invoice_mark_paid. Returns a reconciliation message on match or a "no match" message otherwise (no error). If multiple invoices match, the first one is reconciled.',
    inputSchema: z.object({
      payment_amount: z.number().positive().describe('Amount received from the payer, in the invoice currency'),
      payer_email: z.string().email().describe('Email of the payer (matched against invoice client_email, case-insensitive)'),
      payment_method: PaymentMethodSchema.optional().describe('Payment channel (stripe|paypal|bank_transfer|etc.)'),
      reference: z.string().optional().describe('External payment reference or transaction ID for your records'),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ payment_amount, payer_email, payment_method, reference }) => {
    try {
      const invoices = await storage.getAllInvoices();
      const matches = invoices.filter((inv) =>
        inv.client_email.toLowerCase() === payer_email.toLowerCase() &&
        inv.status !== 'paid' && inv.status !== 'cancelled' && inv.status !== 'refunded' &&
        Math.abs(inv.amount_due - payment_amount) < 0.01
      );

      if (matches.length === 0) {
        return {
          content: [{ type: 'text' as const, text: `No matching unpaid invoice found for ${payer_email} with amount $${payment_amount.toFixed(2)}.` }],
        };
      }

      const invoice = matches[0];
      const now = new Date().toISOString();
      await storage.updateInvoice(invoice.id, {
        status: 'paid',
        amount_paid: invoice.total,
        amount_due: 0,
        paid_date: now,
        payment_method: payment_method ?? 'other',
      });

      // Update client payment history
      const client = await storage.getClientById(invoice.client_id);
      if (client) {
        const history = client.payment_history ?? {
          total_invoices: 0, paid_invoices: 0, avg_days_to_payment: null, late_payment_count: 0, total_revenue: 0,
        };
        const daysToPayment = (Date.now() - new Date(invoice.issue_date).getTime()) / (1000 * 60 * 60 * 24);
        const isLate = new Date() > new Date(invoice.due_date);
        const newPaidCount = history.paid_invoices + 1;
        const newAvgDays = history.avg_days_to_payment != null
          ? (history.avg_days_to_payment * history.paid_invoices + daysToPayment) / newPaidCount
          : daysToPayment;

        await storage.updateClient(invoice.client_id, {
          payment_history: {
            total_invoices: history.total_invoices,
            paid_invoices: newPaidCount,
            avg_days_to_payment: Math.round(newAvgDays * 10) / 10,
            late_payment_count: history.late_payment_count + (isLate ? 1 : 0),
            total_revenue: history.total_revenue + invoice.total,
          },
        });
      }

      return {
        content: [{
          type: 'text' as const,
          text: `Payment reconciled: ${invoice.invoice_number} (${invoice.currency} ${payment_amount.toFixed(2)}) from ${payer_email}. Invoice marked as paid.${reference ? ` Ref: ${reference}` : ''}`,
        }],
      };
    } catch (error) {
      return handleToolError(error);
    }
  }
);

// ━━━ RESOURCES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
server.registerResource(
  'pending-invoices',
  'invoices://pending',
  {
    title: 'Pending Invoices',
    description: 'All unpaid invoices (draft, sent, viewed, overdue)',
    mimeType: 'application/json',
  },
  async (uri) => {
    const result = await storage.searchInvoices({ overdue_only: false, limit: 100, offset: 0 });
    const pending = result.invoices.filter((i) =>
      !['paid', 'cancelled', 'refunded'].includes(i.status)
    );
    return {
      contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(pending, null, 2) }],
    };
  }
);

server.registerResource(
  'overdue-invoices',
  'invoices://overdue',
  {
    title: 'Overdue Invoices',
    description: 'Invoices past their due date that are still unpaid',
    mimeType: 'application/json',
  },
  async (uri) => {
    const result = await storage.searchInvoices({ overdue_only: true, limit: 100, offset: 0 });
    return {
      contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(result.invoices, null, 2) }],
    };
  }
);

server.registerResource(
  'invoice-stats',
  'invoices://stats',
  {
    title: 'Invoice Statistics',
    description: 'Monthly summary: total invoiced, collection rate, average days to payment',
    mimeType: 'application/json',
  },
  async (uri) => {
    const report = await generateCashflowReport();
    return {
      contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(report, null, 2) }],
    };
  }
);

server.registerResource(
  'client-list',
  'clients://list',
  {
    title: 'Client List',
    description: 'All registered clients with payment history',
    mimeType: 'application/json',
  },
  async (uri) => {
    const clients = await storage.getAllClients();
    return {
      contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(clients, null, 2) }],
    };
  }
);

// ━━━ PROMPTS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

server.registerPrompt(
  'payment_followup',
  { title: 'Payment Follow-up', description: 'Review overdue invoices and generate a prioritized follow-up plan based on AI risk scores and payment history.' },
  async () => ({
    messages: [{
      role: 'assistant' as const,
      content: { type: 'text' as const, text: 'I\'ll help you follow up on overdue payments.\n\n1. First, I\'ll use `invoice_list` to find overdue invoices\n2. Run `invoice_risk` on each to assess payment probability\n3. Prioritize by amount and risk level\n4. Generate reminder messages for each\n\nShall I start the analysis?' },
    }],
  }),
);

server.registerPrompt(
  'cashflow_summary',
  { title: 'Cash Flow Summary', description: 'Generate a comprehensive cash flow report with collection rates, outstanding amounts, and 30-day projections.' },
  async () => ({
    messages: [{
      role: 'assistant' as const,
      content: { type: 'text' as const, text: 'Let me prepare your cash flow summary.\n\n1. I\'ll run `cashflow_report` for current period metrics\n2. Analyze collection rate trends\n3. Identify clients with highest outstanding balances\n4. Project next 30 days of expected income\n\nReady to generate the report?' },
    }],
  }),
);

server.registerPrompt(
  'new_invoice_workflow',
  { title: 'New Invoice Workflow', description: 'Guide through creating and sending a new invoice end-to-end — from client selection to payment risk assessment and delivery. Covers client_manage, invoice_create, invoice_risk, and invoice_send in a single coherent flow.' },
  async () => ({
    messages: [{
      role: 'assistant' as const,
      content: { type: 'text' as const, text: 'Let\'s create and send a new invoice.\n\n1. Identify the client — I\'ll check `clients_list` resource, or use `client_manage` to add a new one (upsert-safe by email)\n2. Build the invoice with `invoice_create` — provide line items (description, quantity, unit_price, optional tax_rate/discount_percent), currency will default to the client\'s default_currency, due_date defaults to issue_date + 30 days\n3. Assess payment risk with `invoice_risk` so we know whether to flag this one for proactive follow-up\n4. Deliver with `invoice_send` — generates the PDF and emails via SendGrid if SENDGRID_API_KEY is configured\n\nShare the client email and line items and I\'ll run the full flow.' },
    }],
  }),
);

// ━━━ SMITHERY SANDBOX ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
let _sandboxMode = false;
export function createSandboxServer() {
  _sandboxMode = true;
  return server;
}

// ━━━ START SERVER ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function main() {
  const isHTTP = process.env.PORT || process.env.MCPIZE;

  if (isHTTP) {
    const port = parseInt(process.env.PORT ?? '8080', 10);
    const httpServer = createServer(async (req, res) => {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', server: 'invoiceflow-mcp', version: SERVER_VERSION }));
        return;
      }
      if ((req.method === 'POST' || req.method === 'GET' || req.method === 'DELETE') && req.url === '/mcp') {
        try {
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
          try { await server.close(); } catch { /* not connected yet */ }
          await server.connect(transport);
          await transport.handleRequest(req, res);
        } catch (err) {
          console.error('[InvoiceFlow MCP] Request error:', err);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
          }
        }
        return;
      }
      res.writeHead(404);
      res.end('Not Found');
    });
    httpServer.listen(port, () => {
      console.error(`InvoiceFlow MCP Server v${SERVER_VERSION} running on HTTP port ${port}`);
    });
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`InvoiceFlow MCP Server v${SERVER_VERSION} running on stdio`);
  }
}

setTimeout(() => {
  if (!_sandboxMode) {
    main().catch((err) => {
      console.error('Fatal error:', err);
      process.exit(1);
    });
  }
}, 0);
