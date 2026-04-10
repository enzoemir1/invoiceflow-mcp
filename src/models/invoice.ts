import { z } from 'zod/v4';

/** Supported currencies. */
export const CurrencySchema = z.enum([
  'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'TRY', 'BRL', 'INR',
]);
export type Currency = z.infer<typeof CurrencySchema>;

/** Invoice lifecycle states. */
export const InvoiceStatusSchema = z.enum([
  'draft', 'sent', 'viewed', 'paid', 'overdue', 'cancelled', 'refunded',
]);
export type InvoiceStatus = z.infer<typeof InvoiceStatusSchema>;

/** Accepted payment methods. */
export const PaymentMethodSchema = z.enum([
  'stripe', 'paypal', 'bank_transfer', 'cash', 'check', 'crypto', 'other',
]);
export type PaymentMethod = z.infer<typeof PaymentMethodSchema>;

/** A single line item on an invoice. */
export const LineItemSchema = z.object({
  description: z.string(),
  quantity: z.number().min(0.01),
  unit_price: z.number().min(0),
  tax_rate: z.number().min(0).max(100).default(0),
  discount_percent: z.number().min(0).max(100).default(0),
  amount: z.number(),
});
export type LineItem = z.infer<typeof LineItemSchema>;

/** Summary of a client's payment activity. */
export const PaymentHistorySchema = z.object({
  total_invoices: z.number().default(0),
  paid_invoices: z.number().default(0),
  avg_days_to_payment: z.number().nullable().default(null),
  late_payment_count: z.number().default(0),
  total_revenue: z.number().default(0),
});
export type PaymentHistory = z.infer<typeof PaymentHistorySchema>;

/** Client information. */
export const ClientSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  email: z.string().email(),
  company: z.string().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  country: z.string().optional(),
  tax_id: z.string().optional(),
  phone: z.string().optional(),
  default_currency: CurrencySchema.optional(),
  notes: z.string().optional(),
  payment_history: PaymentHistorySchema.optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type Client = z.infer<typeof ClientSchema>;

/**
 * Flexible date input: accepts either a date-only string (YYYY-MM-DD)
 * or a full ISO-8601 datetime. Normalises to a full datetime string so
 * downstream code can rely on the strict `.datetime()` format everywhere
 * else. This is deliberately permissive because humans (and LLMs)
 * typically think of invoice dates as "2026-04-15", not
 * "2026-04-15T00:00:00.000Z".
 */
export const FlexibleDateSchema = z
  .string()
  .refine(
    (val) => {
      if (/^\d{4}-\d{2}-\d{2}$/.test(val)) return true;
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(val)) {
        return !Number.isNaN(new Date(val).getTime());
      }
      return false;
    },
    'Expected YYYY-MM-DD date or full ISO-8601 datetime',
  )
  .transform((val) => {
    // Append T00:00:00.000Z for date-only strings; otherwise round-trip
    // the datetime through Date to normalise zero-offset / trailing Z.
    if (/^\d{4}-\d{2}-\d{2}$/.test(val)) {
      return `${val}T00:00:00.000Z`;
    }
    return new Date(val).toISOString();
  });

/** Full invoice representation. */
export const InvoiceSchema = z.object({
  id: z.string().uuid(),
  invoice_number: z.string(),
  client_id: z.string().uuid(),
  client_name: z.string(),
  client_email: z.string().email(),
  status: InvoiceStatusSchema.default('draft'),
  currency: CurrencySchema.default('USD'),
  line_items: z.array(LineItemSchema).min(1),
  subtotal: z.number(),
  tax_total: z.number(),
  discount_total: z.number(),
  total: z.number(),
  amount_paid: z.number().default(0),
  amount_due: z.number(),
  issue_date: z.string().datetime(),
  due_date: z.string().datetime(),
  paid_date: z.string().datetime().nullable(),
  notes: z.string().optional(),
  terms: z.string().optional(),
  payment_method: PaymentMethodSchema.nullable().default(null),
  risk_score: z.number().min(0).max(100).nullable().default(null),
  risk_action: z.string().nullable().default(null),
  reminder_count: z.number().default(0),
  last_reminder_at: z.string().datetime().nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type Invoice = z.infer<typeof InvoiceSchema>;

/** Input for creating a new invoice. */
export const InvoiceCreateInputSchema = z.object({
  client_id: z.string().uuid(),
  currency: CurrencySchema.optional(),
  line_items: z.array(
    z.object({
      description: z.string(),
      quantity: z.number().min(0.01),
      unit_price: z.number().min(0),
      tax_rate: z.number().min(0).max(100).optional(),
      discount_percent: z.number().min(0).max(100).optional(),
    })
  ).min(1),
  issue_date: FlexibleDateSchema.optional(),
  due_date: FlexibleDateSchema.optional(),
  notes: z.string().optional(),
  terms: z.string().optional(),
});
export type InvoiceCreateInput = z.infer<typeof InvoiceCreateInputSchema>;

/** Input for listing/filtering invoices. */
export const InvoiceListInputSchema = z.object({
  status: InvoiceStatusSchema.optional(),
  client_id: z.string().uuid().optional(),
  min_amount: z.number().optional(),
  max_amount: z.number().optional(),
  from_date: z.string().datetime().optional(),
  to_date: z.string().datetime().optional(),
  overdue_only: z.boolean().default(false),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0),
});
export type InvoiceListInput = z.infer<typeof InvoiceListInputSchema>;

/** Input for creating a new client. */
export const ClientCreateInputSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  company: z.string().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  country: z.string().optional(),
  tax_id: z.string().optional(),
  phone: z.string().optional(),
  default_currency: CurrencySchema.optional(),
  notes: z.string().optional(),
});
export type ClientCreateInput = z.infer<typeof ClientCreateInputSchema>;

/** Risk level classification. */
export const RiskLevelSchema = z.enum(['low', 'medium', 'high']);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

/** Individual risk factor detail. */
export const RiskFactorSchema = z.object({
  factor: z.string(),
  impact: z.number(),
  detail: z.string(),
});
export type RiskFactor = z.infer<typeof RiskFactorSchema>;

/** Risk assessment for an invoice. */
export const RiskAssessmentSchema = z.object({
  invoice_id: z.string().uuid(),
  risk_score: z.number().min(0).max(100),
  risk_level: RiskLevelSchema,
  factors: z.array(RiskFactorSchema),
  recommended_action: z.string(),
  next_reminder_date: z.string().datetime().nullable(),
});
export type RiskAssessment = z.infer<typeof RiskAssessmentSchema>;

/** Cash flow summary for a given period. */
export const CashflowReportSchema = z.object({
  period: z.string(),
  total_invoiced: z.number(),
  total_collected: z.number(),
  total_outstanding: z.number(),
  total_overdue: z.number(),
  collection_rate: z.number(),
  avg_days_to_payment: z.number().nullable(),
  projected_income_30d: z.number(),
  by_status: z.record(z.string(), z.object({ count: z.number(), total: z.number() })),
  by_client: z.array(z.object({
    client_name: z.string(),
    outstanding: z.number(),
    overdue: z.number(),
  })),
});
export type CashflowReport = z.infer<typeof CashflowReportSchema>;
