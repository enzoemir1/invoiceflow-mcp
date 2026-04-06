import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import type { Invoice, Client } from '../models/invoice.js';

const COLORS = {
  primary: rgb(0.1, 0.1, 0.4),
  secondary: rgb(0.4, 0.4, 0.4),
  accent: rgb(0.0, 0.47, 0.84),
  black: rgb(0, 0, 0),
  light: rgb(0.6, 0.6, 0.6),
  white: rgb(1, 1, 1),
  headerBg: rgb(0.95, 0.95, 0.98),
};

function formatCurrency(amount: number, currency: string): string {
  const symbols: Record<string, string> = {
    USD: '$', EUR: '\u20AC', GBP: '\u00A3', CAD: 'C$', AUD: 'A$',
    JPY: '\u00A5', CHF: 'CHF ', TRY: '\u20BA', BRL: 'R$', INR: '\u20B9',
  };
  const sym = symbols[currency] ?? currency + ' ';
  return `${sym}${amount.toFixed(2)}`;
}

export async function generateInvoicePDF(invoice: Invoice, client?: Client): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]); // A4
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

  const { width, height } = page.getSize();
  let y = height - 50;

  // ── Header ──────────────────────────────────────────────────
  page.drawText('INVOICE', {
    x: 50, y, size: 28, font: fontBold, color: COLORS.primary,
  });

  page.drawText(invoice.invoice_number, {
    x: 50, y: y - 30, size: 12, font, color: COLORS.accent,
  });

  // Status badge
  const statusText = invoice.status.toUpperCase();
  page.drawText(statusText, {
    x: width - 50 - font.widthOfTextAtSize(statusText, 11),
    y, size: 11, font: fontBold, color: COLORS.accent,
  });

  y -= 60;

  // ── Dates ───────────────────────────────────────────────────
  const issueDate = new Date(invoice.issue_date).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });
  const dueDate = new Date(invoice.due_date).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });

  page.drawText('Issue Date:', { x: 50, y, size: 9, font, color: COLORS.light });
  page.drawText(issueDate, { x: 120, y, size: 9, font: fontBold, color: COLORS.black });
  page.drawText('Due Date:', { x: 300, y, size: 9, font, color: COLORS.light });
  page.drawText(dueDate, { x: 360, y, size: 9, font: fontBold, color: COLORS.black });

  y -= 30;

  // ── Bill To ─────────────────────────────────────────────────
  page.drawText('BILL TO', { x: 50, y, size: 9, font: fontBold, color: COLORS.light });
  y -= 15;
  page.drawText(invoice.client_name, { x: 50, y, size: 11, font: fontBold, color: COLORS.black });
  y -= 14;
  page.drawText(invoice.client_email, { x: 50, y, size: 9, font, color: COLORS.secondary });
  y -= 14;

  if (client?.company) {
    page.drawText(client.company, { x: 50, y, size: 9, font, color: COLORS.secondary });
    y -= 14;
  }
  if (client?.address) {
    page.drawText(client.address, { x: 50, y, size: 9, font, color: COLORS.secondary });
    y -= 14;
  }
  if (client?.city || client?.country) {
    const location = [client.city, client.country].filter(Boolean).join(', ');
    page.drawText(location, { x: 50, y, size: 9, font, color: COLORS.secondary });
    y -= 14;
  }
  if (client?.tax_id) {
    page.drawText(`Tax ID: ${client.tax_id}`, { x: 50, y, size: 9, font, color: COLORS.secondary });
    y -= 14;
  }

  y -= 20;

  // ── Line Items Table ────────────────────────────────────────
  const colX = { desc: 50, qty: 320, price: 380, tax: 440, amount: 495 };

  // Table header
  page.drawRectangle({ x: 45, y: y - 5, width: width - 90, height: 20, color: COLORS.headerBg });
  page.drawText('Description', { x: colX.desc, y, size: 8, font: fontBold, color: COLORS.primary });
  page.drawText('Qty', { x: colX.qty, y, size: 8, font: fontBold, color: COLORS.primary });
  page.drawText('Price', { x: colX.price, y, size: 8, font: fontBold, color: COLORS.primary });
  page.drawText('Tax', { x: colX.tax, y, size: 8, font: fontBold, color: COLORS.primary });
  page.drawText('Amount', { x: colX.amount, y, size: 8, font: fontBold, color: COLORS.primary });

  y -= 20;

  for (const item of invoice.line_items) {
    const desc = item.description.length > 40 ? item.description.slice(0, 37) + '...' : item.description;
    page.drawText(desc, { x: colX.desc, y, size: 9, font, color: COLORS.black });
    page.drawText(item.quantity.toString(), { x: colX.qty, y, size: 9, font, color: COLORS.black });
    page.drawText(formatCurrency(item.unit_price, invoice.currency), { x: colX.price, y, size: 9, font, color: COLORS.black });
    page.drawText(`${item.tax_rate}%`, { x: colX.tax, y, size: 9, font, color: COLORS.black });
    page.drawText(formatCurrency(item.amount, invoice.currency), { x: colX.amount, y, size: 9, font: fontBold, color: COLORS.black });
    y -= 18;
  }

  // Separator
  y -= 5;
  page.drawLine({ start: { x: 350, y }, end: { x: width - 50, y }, thickness: 0.5, color: COLORS.light });
  y -= 15;

  // ── Totals ──────────────────────────────────────────────────
  const totalX = 400;
  const valX = 495;

  page.drawText('Subtotal:', { x: totalX, y, size: 9, font, color: COLORS.secondary });
  page.drawText(formatCurrency(invoice.subtotal, invoice.currency), { x: valX, y, size: 9, font, color: COLORS.black });
  y -= 16;

  if (invoice.discount_total > 0) {
    page.drawText('Discount:', { x: totalX, y, size: 9, font, color: COLORS.secondary });
    page.drawText(`-${formatCurrency(invoice.discount_total, invoice.currency)}`, { x: valX, y, size: 9, font, color: COLORS.accent });
    y -= 16;
  }

  if (invoice.tax_total > 0) {
    page.drawText('Tax:', { x: totalX, y, size: 9, font, color: COLORS.secondary });
    page.drawText(formatCurrency(invoice.tax_total, invoice.currency), { x: valX, y, size: 9, font, color: COLORS.black });
    y -= 16;
  }

  y -= 5;
  page.drawLine({ start: { x: 350, y }, end: { x: width - 50, y }, thickness: 1, color: COLORS.primary });
  y -= 18;

  page.drawText('TOTAL DUE:', { x: totalX, y, size: 12, font: fontBold, color: COLORS.primary });
  page.drawText(formatCurrency(invoice.amount_due, invoice.currency), { x: valX, y, size: 12, font: fontBold, color: COLORS.primary });

  y -= 40;

  // ── Notes / Terms ───────────────────────────────────────────
  if (invoice.notes) {
    page.drawText('Notes:', { x: 50, y, size: 9, font: fontBold, color: COLORS.secondary });
    y -= 14;
    page.drawText(invoice.notes.slice(0, 200), { x: 50, y, size: 9, font, color: COLORS.secondary });
    y -= 20;
  }

  if (invoice.terms) {
    page.drawText('Terms:', { x: 50, y, size: 9, font: fontBold, color: COLORS.secondary });
    y -= 14;
    page.drawText(invoice.terms.slice(0, 200), { x: 50, y, size: 9, font, color: COLORS.secondary });
    y -= 20;
  }

  // ── Footer ──────────────────────────────────────────────────
  page.drawText('Generated by InvoiceFlow MCP', {
    x: 50, y: 30, size: 7, font, color: COLORS.light,
  });
  page.drawText(`Currency: ${invoice.currency}`, {
    x: width - 130, y: 30, size: 7, font, color: COLORS.light,
  });

  return doc.save();
}
