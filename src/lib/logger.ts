import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: [
      'password',
      'credentials.password',
      'credentials.PASSWORD',
      '*.password',
      'headers.authorization',
      '*.headers.authorization',
    ],
    censor: '[redacted]',
  },
});
