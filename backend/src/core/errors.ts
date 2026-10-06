import { HttpException } from '@nestjs/common';
export class AppError extends HttpException {
  constructor(public readonly code: string, message: string, status = 400) { super({ code, message }, status); }
}
