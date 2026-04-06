import type { CashflowReport } from '../models/invoice.js';
import { storage } from './storage.js';

export async function generateCashflowReport(): Promise<CashflowReport> {
  const invoices = await storage.getAllInvoices();
  const clients = await storage.getAllClients();
  const now = new Date();

  let totalInvoiced = 0;
  let totalCollected = 0;
  let totalOutstanding = 0;
  let totalOverdue = 0;
  let paymentDaysSum = 0;
  let paymentDaysCount = 0;

  const byStatus: Record<string, { count: number; total: number }> = {};
  const clientMap: Record<string, { client_name: string; outstanding: number; overdue: number }> = {};

  for (const inv of invoices) {
    totalInvoiced += inv.total;

    // Status aggregation
    if (!byStatus[inv.status]) byStatus[inv.status] = { count: 0, total: 0 };
    byStatus[inv.status].count++;
    byStatus[inv.status].total += inv.total;

    // Client aggregation
    if (!clientMap[inv.client_id]) {
      clientMap[inv.client_id] = { client_name: inv.client_name, outstanding: 0, overdue: 0 };
    }

    if (inv.status === 'paid') {
      totalCollected += inv.total;

      // Calculate days to payment
      if (inv.paid_date) {
        const issued = new Date(inv.issue_date).getTime();
        const paid = new Date(inv.paid_date).getTime();
        const days = (paid - issued) / (1000 * 60 * 60 * 24);
        if (days >= 0) {
          paymentDaysSum += days;
          paymentDaysCount++;
        }
      }
    } else if (inv.status !== 'cancelled' && inv.status !== 'refunded') {
      totalOutstanding += inv.amount_due;
      clientMap[inv.client_id].outstanding += inv.amount_due;

      // Check overdue
      if (new Date(inv.due_date) < now) {
        totalOverdue += inv.amount_due;
        clientMap[inv.client_id].overdue += inv.amount_due;
      }
    }
  }

  const collectionRate = totalInvoiced > 0
    ? Math.round((totalCollected / totalInvoiced) * 1000) / 10
    : 0;

  const avgDaysToPayment = paymentDaysCount > 0
    ? Math.round((paymentDaysSum / paymentDaysCount) * 10) / 10
    : null;

  // Project income for next 30 days based on outstanding non-overdue invoices
  const projectedIncome = invoices
    .filter((inv) => {
      if (inv.status === 'paid' || inv.status === 'cancelled' || inv.status === 'refunded') return false;
      const due = new Date(inv.due_date);
      const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
      return due >= now && due <= thirtyDaysFromNow;
    })
    .reduce((sum, inv) => sum + inv.amount_due, 0);

  // Sort clients by outstanding amount
  const byClient = Object.values(clientMap)
    .filter((c) => c.outstanding > 0 || c.overdue > 0)
    .sort((a, b) => b.outstanding - a.outstanding);

  const currentMonth = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long' });

  return {
    period: currentMonth,
    total_invoiced: Math.round(totalInvoiced * 100) / 100,
    total_collected: Math.round(totalCollected * 100) / 100,
    total_outstanding: Math.round(totalOutstanding * 100) / 100,
    total_overdue: Math.round(totalOverdue * 100) / 100,
    collection_rate: collectionRate,
    avg_days_to_payment: avgDaysToPayment,
    projected_income_30d: Math.round(projectedIncome * 100) / 100,
    by_status: byStatus,
    by_client: byClient,
  };
}
