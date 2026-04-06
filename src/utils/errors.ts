import { z } from 'zod/v4';

export class InvoiceFlowError extends Error {
  constructor(
    message: string,
    public readonly userMessage: string,
    public readonly code: string
  ) {
    super(message);
    this.name = 'InvoiceFlowError';
  }
}

export class NotFoundError extends InvoiceFlowError {
  constructor(entity: string, id: string) {
    super(`${entity} not found: ${id}`, `${entity} with id "${id}" was not found.`, 'NOT_FOUND');
    this.name = 'NotFoundError';
  }
}

export class DuplicateError extends InvoiceFlowError {
  constructor(field: string, value: string) {
    super(`Duplicate ${field}: ${value}`, `A record with ${field} "${value}" already exists.`, 'DUPLICATE');
    this.name = 'DuplicateError';
  }
}

export class ValidationError extends InvoiceFlowError {
  constructor(details: string) {
    super(`Validation error: ${details}`, details, 'VALIDATION');
    this.name = 'ValidationError';
  }
}

export const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateUUID(id: string, entity: string): void {
  if (!RE_UUID.test(id)) throw new ValidationError(`Invalid ${entity} ID format: ${id}`);
}

export function handleToolError(error: unknown): { content: { type: 'text'; text: string }[]; isError: true } {
  if (error instanceof InvoiceFlowError) {
    return { content: [{ type: 'text' as const, text: error.userMessage }], isError: true };
  }
  if (error instanceof z.ZodError) {
    const msg = error.issues.map((i) => {
      const path = i.path.join('.');
      return path ? `${path}: ${i.message}` : i.message;
    }).join('; ');
    return { content: [{ type: 'text' as const, text: `Validation failed: ${msg}` }], isError: true };
  }
  console.error('[InvoiceFlow Error]', error);
  return { content: [{ type: 'text' as const, text: 'An unexpected error occurred.' }], isError: true };
}
