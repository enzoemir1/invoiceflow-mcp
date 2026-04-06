import type { Invoice, Client, RiskAssessment, RiskFactor } from '../models/invoice.js';
import { storage } from './storage.js';
import { NotFoundError, validateUUID } from '../utils/errors.js';

// Industry-specific average payment delays (days)
const INDUSTRY_RISK: Record<string, number> = {
  construction: 25,
  government: 30,
  healthcare: 20,
  retail: 10,
  technology: 8,
  consulting: 12,
  manufacturing: 18,
  education: 22,
};

function assessAmountRisk(amount: number): { score: number; factor: RiskFactor } {
  let score: number;
  let detail: string;

  if (amount < 500) {
    score = 10;
    detail = 'Low invoice amount — minimal risk';
  } else if (amount < 2000) {
    score = 25;
    detail = 'Moderate invoice amount';
  } else if (amount < 10000) {
    score = 45;
    detail = 'Significant invoice amount — higher scrutiny';
  } else {
    score = 70;
    detail = 'High-value invoice — elevated risk';
  }

  return {
    score,
    factor: { factor: 'invoice_amount', impact: score, detail: `${detail} ($${amount.toFixed(2)})` },
  };
}

function assessClientHistory(client: Client): { score: number; factor: RiskFactor } {
  const history = client.payment_history;
  if (!history || history.total_invoices === 0) {
    return {
      score: 50,
      factor: { factor: 'client_history', impact: 50, detail: 'New client — no payment history available' },
    };
  }

  const payRate = history.paid_invoices / history.total_invoices;
  const lateRate = history.late_payment_count / history.total_invoices;
  const avgDays = history.avg_days_to_payment ?? 30;

  let score = 0;

  // Pay rate factor (0-40)
  if (payRate >= 0.95) score += 5;
  else if (payRate >= 0.8) score += 15;
  else if (payRate >= 0.6) score += 30;
  else score += 40;

  // Late rate factor (0-30)
  if (lateRate <= 0.05) score += 0;
  else if (lateRate <= 0.2) score += 10;
  else if (lateRate <= 0.5) score += 20;
  else score += 30;

  // Average days factor (0-30)
  if (avgDays <= 15) score += 0;
  else if (avgDays <= 30) score += 10;
  else if (avgDays <= 45) score += 20;
  else score += 30;

  return {
    score,
    factor: {
      factor: 'client_history',
      impact: score,
      detail: `${history.total_invoices} invoices, ${Math.round(payRate * 100)}% paid, ${Math.round(lateRate * 100)}% late, avg ${Math.round(avgDays)}d to pay`,
    },
  };
}

function assessDueDate(invoice: Invoice): { score: number; factor: RiskFactor } {
  const now = Date.now();
  const dueDate = new Date(invoice.due_date);
  const due = dueDate.getTime();

  // Guard against invalid dates
  if (!Number.isFinite(due)) {
    return {
      score: 90,
      factor: { factor: 'due_date', impact: 90, detail: 'Invalid or missing due date — treating as high risk' },
    };
  }

  const daysUntilDue = (due - now) / (1000 * 60 * 60 * 24);

  let score: number;
  let detail: string;

  if (daysUntilDue < -30) {
    score = 95;
    detail = `Overdue by ${Math.abs(Math.round(daysUntilDue))} days — critical`;
  } else if (daysUntilDue < -14) {
    score = 80;
    detail = `Overdue by ${Math.abs(Math.round(daysUntilDue))} days`;
  } else if (daysUntilDue < -7) {
    score = 65;
    detail = `Overdue by ${Math.abs(Math.round(daysUntilDue))} days`;
  } else if (daysUntilDue < 0) {
    score = 50;
    detail = `Overdue by ${Math.abs(Math.round(daysUntilDue))} days`;
  } else if (daysUntilDue < 7) {
    score = 30;
    detail = `Due in ${Math.round(daysUntilDue)} days — approaching deadline`;
  } else if (daysUntilDue < 14) {
    score = 15;
    detail = `Due in ${Math.round(daysUntilDue)} days`;
  } else {
    score = 5;
    detail = `Due in ${Math.round(daysUntilDue)} days — no urgency`;
  }

  return { score, factor: { factor: 'due_date', impact: score, detail } };
}

function assessReminderHistory(invoice: Invoice): { score: number; factor: RiskFactor } {
  const count = invoice.reminder_count;

  if (count === 0) {
    return { score: 10, factor: { factor: 'reminders', impact: 10, detail: 'No reminders sent yet' } };
  }
  if (count <= 2) {
    return { score: 30, factor: { factor: 'reminders', impact: 30, detail: `${count} reminder(s) sent — normal follow-up` } };
  }
  if (count <= 4) {
    return { score: 60, factor: { factor: 'reminders', impact: 60, detail: `${count} reminders sent — client unresponsive` } };
  }

  return { score: 85, factor: { factor: 'reminders', impact: 85, detail: `${count} reminders sent — escalation needed` } };
}

function determineAction(score: number, invoice: Invoice): string {
  if (score <= 30) {
    return 'Low risk. Standard reminder 3 days before due date.';
  }
  if (score <= 60) {
    const daysOverdue = Math.max(0, (Date.now() - new Date(invoice.due_date).getTime()) / (1000 * 60 * 60 * 24));
    if (daysOverdue > 0) {
      return `Medium risk. Send a personalized follow-up email. Mention the invoice has been overdue for ${Math.round(daysOverdue)} days.`;
    }
    return 'Medium risk. Send an early reminder with a polite tone. Consider offering a payment link.';
  }
  if (score <= 80) {
    return 'High risk. Escalate: send a firm reminder, consider a phone call, and review payment terms.';
  }
  return 'Critical risk. Immediate action required: direct phone call, formal payment demand, consider pausing services.';
}

function calculateNextReminder(score: number, invoice: Invoice): string | null {
  if (invoice.status === 'paid' || invoice.status === 'cancelled') return null;

  const now = new Date();
  let daysUntilReminder: number;

  if (score <= 30) daysUntilReminder = 3;
  else if (score <= 60) daysUntilReminder = 1;
  else daysUntilReminder = 0; // immediate

  const next = new Date(now.getTime() + daysUntilReminder * 24 * 60 * 60 * 1000);
  return next.toISOString();
}

export async function assessInvoiceRisk(invoiceId: string): Promise<RiskAssessment> {
  validateUUID(invoiceId, 'invoice');

  const invoice = await storage.getInvoiceById(invoiceId);
  if (!invoice) throw new NotFoundError('Invoice', invoiceId);

  const client = await storage.getClientById(invoice.client_id);
  if (!client) throw new NotFoundError('Client', invoice.client_id);

  const amountResult = assessAmountRisk(invoice.total);
  const historyResult = assessClientHistory(client);
  const dueDateResult = assessDueDate(invoice);
  const reminderResult = assessReminderHistory(invoice);

  // Weighted score
  const weights = { amount: 0.2, history: 0.35, dueDate: 0.3, reminders: 0.15 };
  const totalScore = Math.round(
    amountResult.score * weights.amount +
    historyResult.score * weights.history +
    dueDateResult.score * weights.dueDate +
    reminderResult.score * weights.reminders
  );

  const riskLevel = totalScore <= 30 ? 'low' as const : totalScore <= 60 ? 'medium' as const : 'high' as const;
  const recommendedAction = determineAction(totalScore, invoice);
  const nextReminder = calculateNextReminder(totalScore, invoice);

  // Update invoice with risk data
  await storage.updateInvoice(invoiceId, {
    risk_score: totalScore,
    risk_action: recommendedAction,
  });

  return {
    invoice_id: invoiceId,
    risk_score: totalScore,
    risk_level: riskLevel,
    factors: [
      amountResult.factor,
      historyResult.factor,
      dueDateResult.factor,
      reminderResult.factor,
    ],
    recommended_action: recommendedAction,
    next_reminder_date: nextReminder,
  };
}
