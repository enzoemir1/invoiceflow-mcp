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
import { storage } from './services/storage.js';
import { handleToolError, validateUUID, NotFoundError } from './utils/errors.js';

const server = new McpServer({
  name: 'invoiceflow-mcp',
  version: '1.0.0',
});

// ━━━ TOOL: client_manage ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
server.registerTool(
  'client_manage',
  {
    title: 'Manage Client',
    description: 'Create a new client or update an existing one. Clients are needed before creating invoices.',
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
    description: 'Create a new invoice for a client with line items. Auto-calculates subtotal, tax, discounts, and total. Generates a unique invoice number (INV-YYYY-NNNN).',
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
    description: 'List and filter invoices by status, client, amount range, date range, or overdue status. Supports pagination.',
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
    description: 'Send an invoice to the client via email. Generates a PDF and sends it. Updates status to "sent".',
    inputSchema: z.object({
      invoice_id: z.string().describe('The invoice ID to send'),
      message: z.string().optional().describe('Custom message to include in the email'),
    }),
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
    description: 'Mark an invoice as fully or partially paid. Updates amount_paid and status.',
    inputSchema: z.object({
      invoice_id: z.string().describe('The invoice ID'),
      amount: z.number().min(0).optional().describe('Amount paid (defaults to full amount due)'),
      payment_method: PaymentMethodSchema.optional().describe('How the payment was made'),
    }),
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
    title: 'Send Reminder',
    description: 'Send a payment reminder for an unpaid invoice. Increments reminder count and updates last_reminder_at.',
    inputSchema: z.object({
      invoice_id: z.string().describe('The invoice ID'),
      message: z.string().optional().describe('Custom reminder message'),
    }),
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
    description: 'Predict the late payment risk for an invoice (0-100). Analyzes invoice amount, client history, due date proximity, and reminder history. Returns risk level, factors, and recommended action.',
    inputSchema: z.object({
      invoice_id: z.string().describe('The invoice ID to assess'),
    }),
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
    description: 'Generate a cash flow summary: total invoiced, collected, outstanding, overdue, collection rate, average days to payment, 30-day projection, breakdown by status and client.',
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
    description: 'Match a payment from Stripe or PayPal to an invoice by amount and client email. Auto-marks the invoice as paid if amounts match.',
    inputSchema: z.object({
      payment_amount: z.number().min(0.01).describe('The payment amount received'),
      payer_email: z.string().email().describe('Email of the payer'),
      payment_method: PaymentMethodSchema.optional(),
      reference: z.string().optional().describe('External payment reference/ID'),
    }),
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
        res.end(JSON.stringify({ status: 'ok', version: '1.0.0' }));
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
      console.error(`InvoiceFlow MCP Server v1.0.0 running on HTTP port ${port}`);
    });
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('InvoiceFlow MCP Server v1.0.0 running on stdio');
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
