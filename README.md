# InvoiceFlow MCP

**AI-powered invoice automation for the Model Context Protocol**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6.svg)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-1.29-2A9D8F.svg)](https://modelcontextprotocol.io/)

InvoiceFlow creates professional PDF invoices, predicts late payment risk using AI, auto-sends reminders, reconciles payments from Stripe/PayPal, and tracks your cash flow -- all through the MCP protocol.

---

## Features

- **Professional PDF invoices** with line items, tax, discounts, multi-currency (10 currencies)
- **AI risk prediction** (0-100) based on invoice amount, client history, due date, reminder history
- **Smart reminders** with escalation based on risk level
- **Payment reconciliation** matching Stripe/PayPal payments to invoices by amount + email
- **Cash flow reporting** with collection rate, projected income, client breakdown
- **Client management** with automatic payment history tracking
- **Sequential invoice numbers** (INV-2026-0001, INV-2026-0002, ...)
- **10 MCP tools** + **4 MCP resources** covering the full invoicing lifecycle

---

## Quick Start

### Install from MCPize Marketplace

1. Search for **InvoiceFlow MCP** on [mcpize.com](https://mcpize.com)
2. Click **Install** and select your subscription tier
3. Tools and resources are automatically available in any MCP-compatible client

### Build from Source

```bash
git clone https://github.com/enzoemir1/invoiceflow-mcp.git
cd invoiceflow-mcp
npm ci
npm run build
```

Add to your MCP client config:

```json
{
  "mcpServers": {
    "invoiceflow": {
      "command": "node",
      "args": ["path/to/invoiceflow-mcp/dist/index.js"]
    }
  }
}
```

---

## Tools

### client_manage
Create a new client. Required before creating invoices.

### invoice_create
Create an invoice with line items. Auto-calculates subtotal, tax, discounts, and total. Generates sequential invoice numbers (INV-YYYY-NNNN).

### invoice_send
Send an invoice PDF via email (requires SENDGRID_API_KEY). Updates status to "sent".

### invoice_list
Filter invoices by status, client, amount range, date range, or overdue status. Supports pagination.

### invoice_mark_paid
Mark an invoice as paid (full or partial). Updates client payment history automatically.

### invoice_remind
Send a payment reminder. Increments reminder count. Supports custom messages.

### invoice_risk
AI-powered late payment risk prediction (0-100). Returns risk level, factor breakdown, recommended action, next reminder date.

### cashflow_report
Generate cash flow summary: total invoiced, collected, outstanding, overdue, collection rate, 30-day projection.

### payment_reconcile
Match incoming payment to invoice by amount and payer email. Auto-marks as paid.

---

## Resources

| Resource | Description |
|----------|-------------|
| `invoices://pending` | All unpaid invoices |
| `invoices://overdue` | Invoices past due date |
| `invoices://stats` | Monthly cash flow summary |
| `clients://list` | All clients with payment history |

---

## Risk Prediction Engine

Scores invoices 0-100 using 4 weighted factors:

| Factor | Weight | What It Measures |
|--------|--------|-----------------|
| Invoice Amount | 20% | Higher amounts = higher risk |
| Client History | 35% | Pay rate, late payments, avg days |
| Due Date | 30% | Days until/past due |
| Reminders | 15% | Reminders already sent |

**Risk Levels:** Low (0-30), Medium (31-60), High (61-100)

---

## Integrations

- **SendGrid** -- Set SENDGRID_API_KEY for email invoices/reminders
- **Stripe** -- Set STRIPE_API_KEY for payment reconciliation
- **PayPal** -- Set PAYPAL_CLIENT_ID + PAYPAL_CLIENT_SECRET

## Currencies

USD, EUR, GBP, CAD, AUD, JPY, CHF, TRY, BRL, INR

---

## Pricing

| Tier | Price | Invoices/month | Features |
|------|-------|----------------|----------|
| Free | $0 | 5 | Basic PDF invoices |
| Pro | $15/mo | 100 | AI risk, reminders, Stripe sync |
| Business | $30/mo | Unlimited | Multi-currency, reconciliation, cash flow |

Available on [MCPize Marketplace](https://mcpize.com).

---

## Development

```bash
npm run dev        # Hot reload
npm run build      # Production build
npm test           # Run tests
npm run inspect    # MCP Inspector
```

## License

MIT License. See [LICENSE](LICENSE) for details.

Built by [Automatia BCN](https://github.com/enzoemir1).
