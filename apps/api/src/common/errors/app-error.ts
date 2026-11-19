import { HttpStatus } from '@nestjs/common';

export interface ErrorDetail {
  field: string;
  issue: string;
}

/**
 * Domain error carrying the contract error code (dashboard/public OpenAPI `Error` schema).
 * Thrown by services; rendered by HttpExceptionFilter.
 */
export class AppError extends Error {
  constructor(
    readonly status: HttpStatus,
    readonly code: string,
    message: string,
    readonly details?: ErrorDetail[],
  ) {
    super(message);
    this.name = 'AppError';
  }

  static badRequest(message: string, details?: ErrorDetail[]) {
    return new AppError(HttpStatus.BAD_REQUEST, 'BAD_REQUEST', message, details);
  }
  static unauthorized(message = 'Not signed in or session expired') {
    return new AppError(HttpStatus.UNAUTHORIZED, 'UNAUTHORIZED', message);
  }
  static forbidden(message = 'Your role does not allow this action') {
    return new AppError(HttpStatus.FORBIDDEN, 'FORBIDDEN', message);
  }
  static notFound(message = 'Not found') {
    return new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND', message);
  }
  static conflict(message: string, code = 'CONFLICT') {
    return new AppError(HttpStatus.CONFLICT, code, message);
  }
  static validation(message: string, details?: ErrorDetail[], code = 'VALIDATION_FAILED') {
    return new AppError(HttpStatus.UNPROCESSABLE_ENTITY, code, message, details);
  }
  static tooManyRequests(message = 'Too many requests') {
    return new AppError(HttpStatus.TOO_MANY_REQUESTS, 'RATE_LIMITED', message);
  }
}
